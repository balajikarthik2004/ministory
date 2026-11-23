import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import * as repo from './deletion.repository.js';
import { PlaybackCleanupStatus } from './deletion.repository.js';

/**
 * The deletion reconciler (M2.6 §6, R3).
 *
 * WHAT IT IS FOR. Account deletion commits everything personal in one
 * transaction and then de-links `PlaybackEvent` rows outside it, because that
 * is the only unbounded part of the work. If the process dies mid-sweep —
 * deploy, crash, OOM — those rows still carry a deleted user's id and nothing
 * in a running system would ever notice. This finds them.
 *
 * A COMMAND, NOT A SCHEDULER, for the reason ADR-35 gives: CLAUDE.md §18
 * rules out paid infrastructure, and a cron container that usually finds
 * nothing is infrastructure maintained for no benefit. It is idempotent and
 * parameterised, so scheduling it is one line in whatever runs the deployment
 * on the day there is one.
 *
 * IT DERIVES ITS WORK FROM STATE, NOT FROM A QUEUE. Everything it repairs is
 * discoverable from the `AccountDeletion` row and the events themselves, so
 * there is no marker to go stale, nothing to replay, and a run interrupted
 * halfway simply leaves work for the next one.
 */

export interface ReconcileOptions {
  dryRun?: boolean;
  prune?: boolean;
  now?: Date;
  batchSize?: number;
}

export interface RepairedDeletion {
  userId: string;
  previousStatus: PlaybackCleanupStatus;
  anonymised: number;
  status: PlaybackCleanupStatus;
}

export interface ReconcileReport {
  /** Rows whose sweep had not finished, before anything was done. */
  unfinished: number;
  /** Rows marked COMPLETED that still had events carrying their user id. */
  lyingCompleted: number;
  repaired: RepairedDeletion[];
  /** Still not COMPLETED after the run. Non-zero means something is wrong. */
  stillFailing: number;
  /**
   * `DELETED` users with playback events but NO deletion record — retired
   * guests from `mergeGuestInto`. Reported, never modified: see
   * `findOrphanedPlaybackUsers`.
   */
  orphans: Array<{ userId: string; events: number }>;
  receiptsPruned: number;
  auditRowsPruned: number;
  dryRun: boolean;
}

export async function reconcileDeletions(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  const unfinished = await repo.findUnfinishedDeletions();
  const lyingCompleted = await repo.findCompletedWithResidue();
  const orphans = await repo.findOrphanedPlaybackUsers();

  /*
   * A `COMPLETED` row with events still carrying its user id is treated
   * exactly like an unfinished one. A status that lies is worse than one that
   * is behind: `COMPLETED` is what tells an operator there is nothing left to
   * do, so it has to be true rather than merely written.
   */
  const targets = [
    ...unfinished.map((row) => ({
      userId: row.userId,
      previousStatus: row.playbackStatus,
    })),
    ...lyingCompleted.map((userId) => ({
      userId,
      previousStatus: PlaybackCleanupStatus.COMPLETED,
    })),
  ];

  const repaired: RepairedDeletion[] = [];

  if (!dryRun) {
    for (const target of targets) {
      const result = await repo.anonymisePlaybackEvents(target.userId, {
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      });

      repaired.push({
        userId: target.userId,
        previousStatus: target.previousStatus,
        anonymised: result.anonymised,
        status: result.status,
      });
    }
  }

  const stillFailing = repaired.filter(
    (row) => row.status !== PlaybackCleanupStatus.COMPLETED,
  ).length;

  let receiptsPruned = 0;
  let auditRowsPruned = 0;

  if (options.prune && !dryRun) {
    receiptsPruned = await repo.pruneReceipts(now);
    auditRowsPruned = await repo.pruneAuditRows(
      new Date(now.getTime() - env.ACCOUNT_DELETION_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
  }

  const report: ReconcileReport = {
    unfinished: unfinished.length,
    lyingCompleted: lyingCompleted.length,
    repaired,
    stillFailing,
    orphans,
    receiptsPruned,
    auditRowsPruned,
    dryRun,
  };

  logger.info(
    {
      event: 'deletion.reconcile',
      unfinished: report.unfinished,
      lyingCompleted: report.lyingCompleted,
      repaired: repaired.length,
      stillFailing,
      orphans: orphans.length,
      dryRun,
    },
    'Deletion reconciliation complete',
  );

  return report;
}
