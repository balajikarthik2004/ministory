import { prisma } from '../../services/prisma.js';
import { logger } from '../../utils/logger.js';

/**
 * The 90-day retention sweep for raw playback events.
 *
 * POLICY SOURCE: SYSTEM_ARCHITECTURE.md §8 and DATABASE_SCHEMA.md §6 both
 * state 90 days for `PlaybackEvent`. Risk R-7 explains why it is not
 * optional — 15-second heartbeats across an audience make this the
 * highest-volume table in the system, and nothing else trims it.
 *
 * WHY BOUNDED BATCHES AND NOT ONE `DELETE`. A single statement over a
 * quarter of accumulated heartbeats takes a long-lived row lock and a
 * transaction large enough to bloat WAL. Deleting in capped batches keeps
 * every transaction short, lets ingestion continue between batches, and
 * means an interrupted run has still made progress rather than rolling all
 * of it back.
 *
 * WHY `receivedAt` AND NOT `occurredAt`. `occurredAt` is client-supplied and
 * therefore attacker-controlled and clock-skew-prone; a device with a wrong
 * date could present events that look months old and have them deleted, or
 * look future-dated and never be deleted. `receivedAt` is set by Postgres
 * when the row lands, so the retention window is measured against our own
 * clock and cannot be influenced from outside.
 *
 * SAFE TO RERUN. The cutoff is computed from the current time and the delete
 * is `WHERE receivedAt < cutoff`, so a second run finds nothing left to do
 * and reports zero. There is no state to reconcile and no partial-run marker
 * to clean up.
 */

/** Rows removed per statement. Small enough that each transaction is brief. */
export const RETENTION_BATCH_SIZE = 1_000;

/** Stops a wedged run from looping forever; one sweep removes at most this. */
const MAX_BATCHES_PER_RUN = 10_000;

export interface RetentionResult {
  /** The boundary. Everything strictly older than this was eligible. */
  cutoff: Date;
  deleted: number;
  batches: number;
  /** True when the per-run ceiling stopped the sweep before it finished. */
  reachedLimit: boolean;
}

export interface RetentionOptions {
  retentionDays: number;
  /** Defaults to now. Injected by tests to place the boundary precisely. */
  now?: Date;
  batchSize?: number;
}

export function cutoffFor(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Deletes playback events older than the retention window.
 *
 * Returns what it did rather than logging and discarding it, so a caller —
 * the CLI, or a test asserting the boundary — can check the outcome.
 */
export async function purgeExpiredPlaybackEvents(
  options: RetentionOptions,
): Promise<RetentionResult> {
  const cutoff = cutoffFor(options.retentionDays, options.now);
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;

  let deleted = 0;
  let batches = 0;

  for (; batches < MAX_BATCHES_PER_RUN; batches += 1) {
    /*
     * `deleteMany` has no `take`, so the batch is expressed as a subquery:
     * pick at most `batchSize` expired ids, then delete exactly those. Two
     * statements, but each one is short and the second is a primary-key
     * delete. Raw SQL with `DELETE ... LIMIT` would be shorter and is not
     * portable — Postgres does not accept LIMIT on DELETE.
     */
    const expiring = await prisma.playbackEvent.findMany({
      where: { receivedAt: { lt: cutoff } },
      select: { eventId: true },
      take: batchSize,
    });

    if (expiring.length === 0) break;

    const result = await prisma.playbackEvent.deleteMany({
      where: { eventId: { in: expiring.map((row) => row.eventId) } },
    });

    deleted += result.count;

    // A short batch means the table had fewer than `batchSize` expired rows
    // left; there is no point paying for another round trip to learn that.
    if (expiring.length < batchSize) {
      batches += 1;
      break;
    }
  }

  const reachedLimit = batches >= MAX_BATCHES_PER_RUN;

  logger.info(
    {
      cutoff: cutoff.toISOString(),
      retentionDays: options.retentionDays,
      deleted,
      batches,
      reachedLimit,
    },
    'playback event retention sweep complete',
  );

  return { cutoff, deleted, batches, reachedLimit };
}
