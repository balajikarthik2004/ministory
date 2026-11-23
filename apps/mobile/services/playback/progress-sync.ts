import type { ProgressRepository } from './progress-repository';

/**
 * Pushes locally-recorded progress that the server has not acknowledged.
 *
 * THE GAP THIS CLOSES (M2.4 §5). `persistProgress` writes SQLite and then
 * fires a best-effort POST. The local write is durable; the push was not
 * retried by anything. A viewer who finished an episode just as their
 * connection dropped — or whose app was killed immediately after — kept
 * correct progress on the device while the server stayed behind
 * indefinitely, which is how Home and the drama detail page came to
 * disagree.
 *
 * WHY THIS IS NOT THE EVENT OUTBOX. Events are append-only analytics and
 * every one matters. Progress is last-write-wins state: only the newest
 * position per episode is worth sending, and the row in `watch_progress`
 * already *is* that newest value. Flushing from the table rather than from a
 * queue means a device offline for a week sends one write per episode
 * watched instead of one per five-second tick.
 *
 * SAFE TO REPLAY. Position is monotonic and completion sticky on the device
 * (ProgressRepository) and on the server (API_DOCUMENTATION.md §6), so a
 * flush that arrives out of order, twice, or long after the fact cannot
 * rewind a viewer. That is what makes a blind retry the correct design here.
 */

/** One server write. Matches `api.syncProgress`. */
export interface ProgressPush {
  episodeId: string;
  dramaId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
  occurredAt: string;
}

export interface ProgressSyncResult {
  attempted: number;
  synced: number;
  /** Rows left dirty: the push failed, or a newer write landed mid-flight. */
  remaining: number;
}

/**
 * How many rows one pass sends.
 *
 * Sequential, not parallel: these are small writes to one endpoint, and a
 * burst of concurrent requests from every reconnecting device is exactly the
 * shape of traffic the ingestion rate limit exists to discourage. A viewer
 * with more than this many dirty episodes gets the rest on the next pass.
 */
const FLUSH_BATCH = 25;

export async function flushPendingProgress(
  progress: ProgressRepository,
  push: (input: ProgressPush) => Promise<unknown>,
  limit = FLUSH_BATCH,
): Promise<ProgressSyncResult> {
  const pending = await progress.pendingSync(limit);
  if (pending.length === 0) return { attempted: 0, synced: 0, remaining: 0 };

  let synced = 0;

  for (const row of pending) {
    try {
      await push({
        episodeId: row.episodeId,
        dramaId: row.dramaId,
        episodeNumber: row.episodeNumber,
        positionSec: Math.floor(row.positionSec),
        durationSec: row.durationSec,
        // The time the position was *recorded*, not the time it is being
        // sent. The server's staleness check orders Continue Watching by
        // this, so sending "now" would reorder a viewer's rail to whatever
        // happened to flush last rather than what they actually watched
        // most recently.
        occurredAt: row.updatedAt,
      });

      // Guarded on `updatedAt`: a position written while this request was
      // in flight stays dirty rather than being marked delivered.
      if (await progress.markSynced(row.episodeId, row.updatedAt)) synced += 1;
    } catch {
      /*
       * Left dirty on purpose, and the loop continues.
       *
       * One unreachable episode — deleted upstream, say — must not block
       * every other episode's progress behind it. There is no attempt
       * counter and no dead state: unlike an event, a stale progress row
       * costs nothing to keep retrying and is superseded the moment the
       * viewer watches that episode again.
       */
    }
  }

  return {
    attempted: pending.length,
    synced,
    remaining: await progress.pendingSyncCount(),
  };
}
