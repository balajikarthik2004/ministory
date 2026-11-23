import { playbackEventSchema, type PlaybackEvent } from '@minidrama/contracts';
import type { Clock, SqliteDriver } from './db/driver';
import { OUTBOX_STATUS } from './db/schema';

/**
 * The playback event outbox.
 *
 * THE GUARANTEE. An event that has been enqueued is delivered at least once,
 * or ends up visibly dead. It is never silently dropped, and it is never
 * deleted before the sync adapter has confirmed the server durably accepted
 * it. Everything below follows from that one sentence.
 *
 * AT LEAST ONCE, NOT EXACTLY ONCE. When a send fails ambiguously — the
 * request went out and the response never came back — the only safe
 * assumption is that it may have arrived. The client retries, and the server
 * deduplicates on `eventId`. Trying to achieve exactly-once on the client
 * means guessing, and guessing wrong loses data.
 */

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export interface OutboxRecord {
  event: PlaybackEvent;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
}

interface OutboxRow {
  event_id: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  last_attempt_at: string | null;
}

export interface OutboxCounts {
  pending: number;
  inFlight: number;
  dead: number;
}

/**
 * Backoff schedule.
 *
 * Exponential from 2s, capped at 5 minutes, with jitter. The cap matters more
 * than the growth rate: an uncapped exponential reaches hours, and a viewer
 * who was offline on a train should not wait hours after reconnecting for
 * their watch history to catch up.
 *
 * Jitter is not decoration. Without it every queued event on every device
 * that lost connectivity at the same moment retries at the same moment.
 */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 8;

export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
  // Full jitter over the lower half, so the delay is between 50% and 100% of
  // the nominal window rather than clustering at the window's edge.
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export class PlaybackOutbox {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Queues an event.
   *
   * `ON CONFLICT DO NOTHING` on the primary key makes this idempotent: an
   * event that is already queued stays exactly as it is, including its
   * attempt count and backoff. Without that clause a caller retrying an
   * enqueue would reset a row that is mid-backoff and defeat the schedule.
   *
   * @returns true when a new row was written, false when it already existed.
   */
  async enqueue(event: PlaybackEvent): Promise<boolean> {
    // Validated again on the way in. Enqueue is the boundary between code
    // that builds events and durable storage; anything malformed must be
    // rejected before it is persisted, not after.
    const valid = playbackEventSchema.parse(event);
    const nowIso = new Date(this.clock.now()).toISOString();

    const before = await this.countRows();
    await this.driver.run(
      `INSERT INTO playback_event_outbox (
         event_id, session_id, drama_id, episode_id, type, occurred_at,
         position_sec, duration_sec, payload, status, attempts,
         next_attempt_at, last_error, created_at, last_attempt_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL)
       ON CONFLICT(event_id) DO NOTHING`,
      [
        valid.eventId,
        valid.sessionId,
        valid.dramaId,
        valid.episodeId,
        valid.type,
        valid.occurredAt,
        valid.positionSec,
        valid.durationSec,
        JSON.stringify(valid),
        OUTBOX_STATUS.pending,
        nowIso,
        nowIso,
      ],
    );
    const after = await this.countRows();
    return after > before;
  }

  /** Queues many events in one transaction. */
  async enqueueMany(events: readonly PlaybackEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    return this.driver.transaction(async () => {
      let written = 0;
      for (const event of events) {
        if (await this.enqueue(event)) written += 1;
      }
      return written;
    });
  }

  /**
   * Claims up to `limit` events that are due, marking them in flight.
   *
   * Claiming and reading happen in one transaction so that two sync runs
   * cannot take the same row. The sync engine also holds a mutex, so this is
   * belt and braces — but the mutex only protects one process's own runs,
   * and the database is the thing that actually owns the rows.
   */
  async claimBatch(limit: number): Promise<PlaybackEvent[]> {
    const nowIso = new Date(this.clock.now()).toISOString();

    return this.driver.transaction(async () => {
      const rows = await this.driver.all<OutboxRow>(
        `SELECT * FROM playback_event_outbox
          WHERE status = ? AND next_attempt_at <= ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`,
        [OUTBOX_STATUS.pending, nowIso, limit],
      );
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.event_id);
      await this.driver.run(
        `UPDATE playback_event_outbox
            SET status = ?, last_attempt_at = ?
          WHERE event_id IN (${placeholders(ids.length)})`,
        [OUTBOX_STATUS.inFlight, nowIso, ...ids],
      );

      return rows.map(parsePayload).filter((event): event is PlaybackEvent => event !== null);
    });
  }

  /**
   * Deletes events the server confirmed it stored.
   *
   * Only ever called with ids the adapter named in its acknowledgement.
   * An event that was sent but not acknowledged stays queued and is retried,
   * which is the whole reason the acknowledgement names ids rather than
   * returning a bare success.
   */
  async acknowledge(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length === 0) return 0;
    return this.driver.transaction(async () => {
      const before = await this.countRows();
      await this.driver.run(
        `DELETE FROM playback_event_outbox WHERE event_id IN (${placeholders(eventIds.length)})`,
        [...eventIds],
      );
      return before - (await this.countRows());
    });
  }

  /**
   * Returns claimed-but-unacknowledged events to the queue with a backoff.
   *
   * Rows that have exhausted `MAX_ATTEMPTS` become `dead` rather than being
   * deleted. A deleted row is indistinguishable from one that was delivered;
   * a dead row can be counted, shown and investigated.
   */
  async markFailed(eventIds: readonly string[], error: string): Promise<void> {
    if (eventIds.length === 0) return;
    const now = this.clock.now();
    const nowIso = new Date(now).toISOString();
    // Truncated: a provider error can be a whole HTML page, and this column
    // is for diagnosis, not archival.
    const reason = error.slice(0, 300);

    await this.driver.transaction(async () => {
      const rows = await this.driver.all<OutboxRow>(
        `SELECT * FROM playback_event_outbox WHERE event_id IN (${placeholders(eventIds.length)})`,
        [...eventIds],
      );

      for (const row of rows) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.driver.run(
            `UPDATE playback_event_outbox
                SET status = ?, attempts = ?, last_error = ?, last_attempt_at = ?
              WHERE event_id = ?`,
            [OUTBOX_STATUS.dead, attempts, reason, nowIso, row.event_id],
          );
          continue;
        }
        const nextAttemptAt = new Date(now + backoffDelayMs(attempts, this.random)).toISOString();
        await this.driver.run(
          `UPDATE playback_event_outbox
              SET status = ?, attempts = ?, last_error = ?, last_attempt_at = ?, next_attempt_at = ?
            WHERE event_id = ?`,
          [OUTBOX_STATUS.pending, attempts, reason, nowIso, nextAttemptAt, row.event_id],
        );
      }
    });
  }

  /**
   * Returns any row left `in_flight` to `pending`.
   *
   * Called once at startup. A row is `in_flight` only while a sync run holds
   * it; if the process died mid-send — the app was killed, the device ran out
   * of memory — nothing else will ever release it, and the event would sit
   * invisible and undelivered forever.
   *
   * These rows are made due immediately rather than backed off: the previous
   * attempt may never have reached the network at all, and the app has just
   * started, which is a reasonable moment to try.
   *
   * @returns how many rows were recovered.
   */
  async recoverInFlight(): Promise<number> {
    const nowIso = new Date(this.clock.now()).toISOString();
    return this.driver.transaction(async () => {
      const stuck = await this.driver.all<{ event_id: string }>(
        `SELECT event_id FROM playback_event_outbox WHERE status = ?`,
        [OUTBOX_STATUS.inFlight],
      );
      if (stuck.length === 0) return 0;
      await this.driver.run(
        `UPDATE playback_event_outbox
            SET status = ?, next_attempt_at = ?
          WHERE status = ?`,
        [OUTBOX_STATUS.pending, nowIso, OUTBOX_STATUS.inFlight],
      );
      return stuck.length;
    });
  }

  async counts(): Promise<OutboxCounts> {
    const rows = await this.driver.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM playback_event_outbox GROUP BY status`,
    );
    const counts: OutboxCounts = { pending: 0, inFlight: 0, dead: 0 };
    for (const row of rows) {
      if (row.status === OUTBOX_STATUS.pending) counts.pending = row.n;
      else if (row.status === OUTBOX_STATUS.inFlight) counts.inFlight = row.n;
      else if (row.status === OUTBOX_STATUS.dead) counts.dead = row.n;
    }
    return counts;
  }

  /** Whole rows, for tests and the developer inspector. */
  async list(limit = 100): Promise<OutboxRecord[]> {
    const rows = await this.driver.all<OutboxRow>(
      `SELECT * FROM playback_event_outbox ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      [limit],
    );
    return rows.flatMap((row) => {
      const event = parsePayload(row);
      if (!event) return [];
      return [
        {
          event,
          status: row.status as OutboxStatus,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at,
          lastError: row.last_error,
          createdAt: row.created_at,
          lastAttemptAt: row.last_attempt_at,
        },
      ];
    });
  }

  /** Clears dead rows. The one deletion a user action may trigger. */
  async discardDead(): Promise<number> {
    return this.driver.transaction(async () => {
      const before = await this.countRows();
      await this.driver.run(`DELETE FROM playback_event_outbox WHERE status = ?`, [
        OUTBOX_STATUS.dead,
      ]);
      return before - (await this.countRows());
    });
  }

  private async countRows(): Promise<number> {
    const row = await this.driver.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM playback_event_outbox`,
    );
    return row?.n ?? 0;
  }
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * Rehydrates a stored event.
 *
 * A row whose payload no longer parses is skipped rather than throwing. It
 * would otherwise poison every batch it appears in and block the queue behind
 * it — one unreadable row must not stop a viewer's other events from being
 * delivered.
 */
function parsePayload(row: OutboxRow): PlaybackEvent | null {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    const result = playbackEventSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
