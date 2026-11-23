import type { Clock, SqliteDriver } from './db/driver';

/**
 * Durable watch progress.
 *
 * Two tables, for the same reason the server has two
 * (DATABASE_SCHEMA.md §3): `watch_progress` is per-episode and answers "how
 * far into episode 7 am I", while `drama_progress` is the per-drama head and
 * answers "where do I resume this drama". Continue Watching reads the second
 * one, and must not scan the first.
 *
 * PRD HIST-03 defines complete as ≥90% watched.
 */

/** HIST-03. The credits are not the episode. */
export const COMPLETION_THRESHOLD = 0.9;

export interface EpisodeProgress {
  episodeId: string;
  dramaId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
  isCompleted: boolean;
  updatedAt: string;
}

export interface DramaProgress {
  dramaId: string;
  episodeId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
  isCompleted: boolean;
  lastWatchedAt: string;
}

export interface ProgressWrite {
  dramaId: string;
  episodeId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
  /** Defaults to now. Supplied explicitly when replaying a queued write. */
  occurredAtMs?: number;
}

interface EpisodeRow {
  episode_id: string;
  drama_id: string;
  episode_number: number;
  position_sec: number;
  duration_sec: number;
  is_completed: number;
  updated_at: string;
  /** 1 while this row still owes the server a write. */
  pending_sync: number;
}

interface DramaRow {
  drama_id: string;
  episode_id: string;
  episode_number: number;
  position_sec: number;
  duration_sec: number;
  is_completed: number;
  last_watched_at: string;
}

export class ProgressRepository {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly clock: Clock,
  ) {}

  /**
   * Records a position.
   *
   * THE RULES, all of which exist because writes arrive out of order:
   *
   * 1. **Position is monotonic within an episode.** The stored position only
   *    ever moves forward. This matches the server rule in
   *    API_DOCUMENTATION.md §6 — "the server takes the maximum position,
   *    never a lower one" — so a queued write replayed after a newer one
   *    cannot rewind a viewer's progress. It is also what makes the whole
   *    offline queue safe to retry.
   *
   * 2. **Completion is sticky.** Once an episode is complete it stays
   *    complete, even if the viewer later scrubs back to the start. "I have
   *    seen this" is not undone by rewatching.
   *
   * 3. **A stale write cannot move the drama head backwards in time.** The
   *    head carries `last_watched_at`, and a write whose timestamp is older
   *    than the stored one is ignored for the head. Without this, flushing a
   *    queue after reconnecting would reorder Continue Watching to whatever
   *    happened to be flushed last rather than what was actually watched most
   *    recently.
   *
   * 4. **The head only advances episodes.** Rewatching episode 2 after
   *    reaching episode 5 updates episode 2's own position but leaves the
   *    drama resuming at 5.
   *
   * All of it runs in one transaction: a crash between the two tables would
   * leave Continue Watching pointing at a position the episode table does not
   * have.
   */
  async record(write: ProgressWrite): Promise<void> {
    if (write.durationSec <= 0) return;

    const occurredAtMs = write.occurredAtMs ?? this.clock.now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const incoming = clamp(write.positionSec, 0, write.durationSec);

    await this.driver.transaction(async () => {
      const existing = await this.driver.get<EpisodeRow>(
        `SELECT * FROM watch_progress WHERE episode_id = ?`,
        [write.episodeId],
      );

      // Rule 1 and rule 2.
      const position = Math.max(existing?.position_sec ?? 0, incoming);
      const completed =
        (existing?.is_completed ?? 0) === 1 || position / write.durationSec >= COMPLETION_THRESHOLD;

      await this.driver.run(
        // `pending_sync = 1` on both paths: every write owes the server a
        // push until one succeeds. See `pendingSync`/`markSynced`.
        `INSERT INTO watch_progress (
           episode_id, drama_id, episode_number, position_sec, duration_sec,
           is_completed, updated_at, pending_sync
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(episode_id) DO UPDATE SET
           position_sec = excluded.position_sec,
           duration_sec = excluded.duration_sec,
           is_completed = excluded.is_completed,
           updated_at   = excluded.updated_at,
           pending_sync = 1`,
        [
          write.episodeId,
          write.dramaId,
          write.episodeNumber,
          position,
          write.durationSec,
          completed ? 1 : 0,
          occurredAt,
        ],
      );

      const head = await this.driver.get<DramaRow>(
        `SELECT * FROM drama_progress WHERE drama_id = ?`,
        [write.dramaId],
      );

      // Rule 3.
      if (head && head.last_watched_at > occurredAt) return;

      // Rule 4.
      const headIsNewerEpisode = head !== null && head.episode_number > write.episodeNumber;
      if (headIsNewerEpisode) return;

      await this.driver.run(
        `INSERT INTO drama_progress (
           drama_id, episode_id, episode_number, position_sec, duration_sec,
           is_completed, last_watched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drama_id) DO UPDATE SET
           episode_id      = excluded.episode_id,
           episode_number  = excluded.episode_number,
           position_sec    = excluded.position_sec,
           duration_sec    = excluded.duration_sec,
           is_completed    = excluded.is_completed,
           last_watched_at = excluded.last_watched_at`,
        [
          write.dramaId,
          write.episodeId,
          write.episodeNumber,
          position,
          write.durationSec,
          completed ? 1 : 0,
          occurredAt,
        ],
      );
    });
  }

  /**
   * Progress rows that still owe the server a write, oldest first.
   *
   * Bounded by episodes watched, not by time: each row holds only that
   * episode's latest position, so a device offline for a week returns one
   * row per episode it played, not one per heartbeat.
   */
  async pendingSync(limit = 50): Promise<EpisodeProgress[]> {
    const rows = await this.driver.all<EpisodeRow>(
      `SELECT * FROM watch_progress
        WHERE pending_sync = 1
        ORDER BY updated_at ASC
        LIMIT ?`,
      [limit],
    );
    return rows.map(toEpisodeProgress);
  }

  /**
   * Clears the pending flag after the server accepted this row.
   *
   * GUARDED ON `updated_at`. A newer position may have been written while
   * the request was in flight; clearing unconditionally would mark that
   * newer value as delivered when it never was, and it would be lost on the
   * next restart. Matching the timestamp we actually sent means a racing
   * write simply stays dirty and is flushed on the following pass.
   *
   * Returns whether a row was cleared, so a caller can tell the two apart.
   */
  async markSynced(episodeId: string, updatedAt: string): Promise<boolean> {
    return this.driver.transaction(async () => {
      const row = await this.driver.get<Pick<EpisodeRow, 'updated_at' | 'pending_sync'>>(
        `SELECT updated_at, pending_sync FROM watch_progress WHERE episode_id = ?`,
        [episodeId],
      );

      // Gone, already clean, or superseded by a newer write while the
      // request was in flight. In every case there is nothing to clear.
      if (!row || row.pending_sync !== 1 || row.updated_at !== updatedAt) return false;

      await this.driver.run(`UPDATE watch_progress SET pending_sync = 0 WHERE episode_id = ?`, [
        episodeId,
      ]);
      return true;
    });
  }

  /** How many rows are waiting. For the sync indicator and for tests. */
  async pendingSyncCount(): Promise<number> {
    const row = await this.driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM watch_progress WHERE pending_sync = 1`,
    );
    return row?.count ?? 0;
  }

  async episodeProgress(episodeId: string): Promise<EpisodeProgress | null> {
    const row = await this.driver.get<EpisodeRow>(
      `SELECT * FROM watch_progress WHERE episode_id = ?`,
      [episodeId],
    );
    return row ? toEpisodeProgress(row) : null;
  }

  async allEpisodeProgress(): Promise<EpisodeProgress[]> {
    const rows = await this.driver.all<EpisodeRow>(`SELECT * FROM watch_progress`);
    return rows.map(toEpisodeProgress);
  }

  async dramaProgress(dramaId: string): Promise<DramaProgress | null> {
    const row = await this.driver.get<DramaRow>(`SELECT * FROM drama_progress WHERE drama_id = ?`, [
      dramaId,
    ]);
    return row ? toDramaProgress(row) : null;
  }

  /**
   * Continue Watching, most recent first.
   *
   * HIST-04: finished dramas drop off. A viewer who completed the last
   * episode has nothing to continue, and leaving it in the rail is clutter
   * that pushes the thing they do want below the fold.
   */
  async continueWatching(limit = 20): Promise<DramaProgress[]> {
    const rows = await this.driver.all<DramaRow>(
      `SELECT * FROM drama_progress
        WHERE is_completed = 0
        ORDER BY last_watched_at DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map(toDramaProgress);
  }

  /** Every head, including completed dramas — watch history shows both. */
  async allDramaProgress(limit = 100): Promise<DramaProgress[]> {
    const rows = await this.driver.all<DramaRow>(
      `SELECT * FROM drama_progress ORDER BY last_watched_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toDramaProgress);
  }

  /**
   * Seeds progress that is not already present.
   *
   * Used once, to put the M2.1 sample progress into the database on a fresh
   * install so Continue Watching is not empty on first run. Existing rows are
   * left alone: a returning viewer's real progress must never be overwritten
   * by fixture data.
   */
  async seedIfAbsent(writes: readonly ProgressWrite[]): Promise<number> {
    let seeded = 0;
    for (const write of writes) {
      const existing = await this.episodeProgress(write.episodeId);
      if (existing) continue;
      await this.record(write);
      seeded += 1;
    }
    return seeded;
  }

  async clear(): Promise<void> {
    await this.driver.transaction(async () => {
      await this.driver.run(`DELETE FROM watch_progress`);
      await this.driver.run(`DELETE FROM drama_progress`);
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function toEpisodeProgress(row: EpisodeRow): EpisodeProgress {
  return {
    episodeId: row.episode_id,
    dramaId: row.drama_id,
    episodeNumber: row.episode_number,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    isCompleted: row.is_completed === 1,
    updatedAt: row.updated_at,
  };
}

function toDramaProgress(row: DramaRow): DramaProgress {
  return {
    dramaId: row.drama_id,
    episodeId: row.episode_id,
    episodeNumber: row.episode_number,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    isCompleted: row.is_completed === 1,
    lastWatchedAt: row.last_watched_at,
  };
}
