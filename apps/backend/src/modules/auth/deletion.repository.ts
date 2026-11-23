import type { AccountDeletion } from '../../generated/prisma/client.js';
import { AccountDeletionSource, PlaybackCleanupStatus } from '../../generated/prisma/enums.js';
import { prisma } from '../../services/prisma.js';
import { logger } from '../../utils/logger.js';

/**
 * Every database statement account deletion makes.
 *
 * Split out of `auth.repository.ts` rather than appended to it because
 * deletion is one long transaction with a precise order, and burying it among
 * the session reads would hide the one thing a reader needs to see: what
 * happens, in which order, inside which transaction boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF A DELETION
 *
 *   TX1  one transaction, everything that is personal. The account is dead
 *        the instant this commits, and nothing after it can bring any of it
 *        back. If it rolls back, nothing happened and the caller may retry.
 *
 *   then the `PlaybackEvent` sweep, outside TX1, because it is the only
 *        unbounded part of the work and the rows it touches are already
 *        unreachable from any account. It records its own progress so an
 *        interrupted run is visible rather than silent.
 * ─────────────────────────────────────────────────────────────────────────
 */

export { AccountDeletionSource, PlaybackCleanupStatus };

export interface DeletionCounts {
  watchHistory: number;
  dramaProgress: number;
  favorites: number;
  sessions: number;
  verificationTokens: number;
}

const NO_COUNTS: DeletionCounts = {
  watchHistory: 0,
  dramaProgress: 0,
  favorites: 0,
  sessions: 0,
  verificationTokens: 0,
};

export interface DeleteAccountInput {
  userId: string;
  source: AccountDeletionSource;
  /** SHA-256 of the client's receipt id, or null when none was sent. */
  receiptHash: string | null;
  receiptTtlDays: number;
  /** Injected by tests so the audit row's timestamps can be asserted. */
  now?: Date;
}

export interface DeleteAccountOutcome {
  /**
   * True when this call found the account already deleted and did nothing.
   *
   * NOT AN ERROR. Two requests racing, or one retried after a lost response,
   * must both end with the caller believing the account is gone — because it
   * is. The second one simply has no counts to report.
   */
  alreadyDeleted: boolean;
  deletedAt: Date;
  counts: DeletionCounts;
  receiptRecorded: boolean;
}

// ───────────────────────────────── TX1 ─────────────────────────────────

/**
 * Deletes everything personal about an account, in one transaction.
 *
 * THE FIRST STATEMENT IS THE GATE, AND IT IS ALSO THE LOCK. A conditional
 * `updateMany` on `status` does three jobs at once:
 *
 *   1. It takes a row-level write lock on the user. A second deletion
 *      arriving mid-flight blocks here rather than racing us, and when it
 *      unblocks the `WHERE` no longer matches, so it matches zero rows.
 *   2. It makes the operation idempotent without an extra read-then-check,
 *      which is the same pattern `consumeVerificationToken` uses and for the
 *      same reason: two callers both pass a read-then-check.
 *   3. It scrubs the identifiers in the same statement that claims the row,
 *      so there is no window in which the account is marked deleted but still
 *      has an address on it.
 *
 * EVERY DELETE BELOW IS EXPLICIT EVEN THOUGH THE SCHEMA CASCADES. The `User`
 * row survives (anonymised), so no cascade ever fires — and we would not want
 * one to, because the favourites delete has to decrement a denormalised
 * counter on the way past (DATABASE_SCHEMA.md §9.5). A cascade would take the
 * rows and leave `Drama.favoriteCount` permanently wrong, with nothing in the
 * system that recomputes it.
 */
export async function deleteAccount(input: DeleteAccountInput): Promise<DeleteAccountOutcome> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    // ── 1. Gate, lock and scrub, in one statement ──
    const claimed = await tx.user.updateMany({
      where: { id: input.userId, status: { not: 'DELETED' } },
      data: {
        status: 'DELETED',
        deletedAt: now,
        /*
         * Invalidates every access token already in circulation (ADR-40).
         * Deleting the session rows below is not enough on its own: an access
         * token is stateless and lives fifteen minutes, and "deleted in
         * fifteen minutes" is not deleted.
         */
        tokensValidFrom: now,
        // Direct identifiers. Nulling `email` also releases the unique index,
        // so the person may register again with the same address — and get a
        // genuinely new account, since nothing below survives.
        email: null,
        phone: null,
        firebaseUid: null,
        passwordHash: null,
        emailVerifiedAt: null,
        lastSeenAt: null,
      },
    });

    if (claimed.count === 0) {
      /*
       * Somebody else deleted this account — a concurrent request, or this
       * one retried. Report the original's timestamp rather than inventing a
       * new one, so two callers never disagree about when it happened.
       */
      const existing = await tx.accountDeletion.findUnique({
        where: { userId: input.userId },
      });

      return {
        alreadyDeleted: true,
        deletedAt: existing?.completedAt ?? now,
        counts: NO_COUNTS,
        receiptRecorded: existing?.receiptHash != null,
      };
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { isAnonymous: true },
    });

    // ── 2. Credentials and sign-in state ──
    const verificationTokens = await tx.verificationToken.deleteMany({
      where: { userId: input.userId },
    });
    const sessions = await tx.session.deleteMany({ where: { userId: input.userId } });

    // ── 3. Profile ──
    // `deleteMany`, not `delete`: a user with no profile row is not supposed
    // to exist, but a deletion must not fail because one does.
    await tx.userProfile.deleteMany({ where: { userId: input.userId } });

    // ── 4. Favourites, and the counter they are counted by ──
    const favoriteRows = await tx.favorite.findMany({
      where: { userId: input.userId },
      select: { dramaId: true },
    });

    const favorites = await tx.favorite.deleteMany({ where: { userId: input.userId } });

    if (favoriteRows.length > 0) {
      /*
       * One statement for every drama, because `Favorite` is keyed
       * `(userId, dramaId)` — this user held at most one row per drama, so
       * every affected counter moves by exactly one.
       */
      await tx.drama.updateMany({
        where: { id: { in: favoriteRows.map((row) => row.dramaId) } },
        data: { favoriteCount: { decrement: 1 } },
      });
    }

    // ── 5. Viewing history ──
    const dramaProgress = await tx.dramaProgress.deleteMany({
      where: { userId: input.userId },
    });
    const watchHistory = await tx.watchHistory.deleteMany({
      where: { userId: input.userId },
    });

    const counts: DeletionCounts = {
      watchHistory: watchHistory.count,
      dramaProgress: dramaProgress.count,
      favorites: favorites.count,
      sessions: sessions.count,
      verificationTokens: verificationTokens.count,
    };

    // ── 6. The audit record ──
    /*
     * A receipt id is 256 random bits, so a collision with another account's
     * is not a real event — but `receiptHash` is unique, and a unique
     * violation here would roll back a deletion the caller is entitled to.
     * Checking first costs one indexed read and turns an impossible crash
     * into a receipt that simply is not recorded.
     */
    let receiptHash = input.receiptHash;
    if (receiptHash) {
      const clash = await tx.accountDeletion.findUnique({
        where: { receiptHash },
        select: { userId: true },
      });
      if (clash) {
        logger.warn(
          { event: 'deletion.receipt_collision', userId: input.userId },
          'Deletion receipt key was already used; proceeding without a receipt',
        );
        receiptHash = null;
      }
    }

    await tx.accountDeletion.create({
      data: {
        userId: input.userId,
        source: input.source,
        wasAnonymous: user.isAnonymous,
        requestedAt: now,
        completedAt: now,
        removedWatchHistory: counts.watchHistory,
        removedDramaProgress: counts.dramaProgress,
        removedFavorites: counts.favorites,
        removedSessions: counts.sessions,
        removedVerificationTokens: counts.verificationTokens,
        playbackStatus: PlaybackCleanupStatus.PENDING,
        ...(receiptHash
          ? {
              receiptHash,
              receiptExpiresAt: new Date(
                now.getTime() + input.receiptTtlDays * 24 * 60 * 60 * 1000,
              ),
            }
          : {}),
      },
    });

    return {
      alreadyDeleted: false,
      deletedAt: now,
      counts,
      receiptRecorded: receiptHash !== null,
    };
  });
}

// ──────────────────── The playback de-linking sweep ────────────────────

/** Rows de-linked per statement. Short transactions, like ADR-35's sweep. */
export const PLAYBACK_SWEEP_BATCH_SIZE = 1_000;

/** Stops a wedged sweep from looping forever. */
const MAX_SWEEP_BATCHES = 10_000;

export interface PlaybackSweepResult {
  anonymised: number;
  batches: number;
  status: PlaybackCleanupStatus;
  /** Set only when the sweep failed. A stable code, never a driver message. */
  errorCode?: string;
}

/**
 * Nulls `PlaybackEvent.userId` for a deleted account, and records its own
 * progress while doing it.
 *
 * RUNS OUTSIDE TX1, ON PURPOSE. It is the only unbounded part of a deletion —
 * a heavy viewer accumulates tens of thousands of heartbeat rows inside the
 * 90-day window — and holding a transaction open across them would take a
 * long lock on the busiest table in the database for an account that is
 * already gone. Nothing here affects whether anyone can sign in.
 *
 * THE STATUS FIELDS ARE THE POINT (M2.6 §6). A sweep that dies mid-loop leaves
 * the row at `IN_PROGRESS` with a `playbackStartedAt` that never advanced,
 * which is precisely the signal `reconcileDeletions` looks for. Without them a
 * half-finished sweep would be invisible — rows carrying a deleted user's id
 * and nothing in the system able to say so.
 *
 * NEVER THROWS. A failure is recorded and returned, because the caller is an
 * HTTP handler whose account deletion has already committed: there is nothing
 * useful it could tell the viewer, and failing the response would suggest the
 * deletion did not happen when it did.
 */
export async function anonymisePlaybackEvents(
  userId: string,
  options: { batchSize?: number } = {},
): Promise<PlaybackSweepResult> {
  const batchSize = options.batchSize ?? PLAYBACK_SWEEP_BATCH_SIZE;

  await prisma.accountDeletion.updateMany({
    where: { userId },
    data: {
      playbackStatus: PlaybackCleanupStatus.IN_PROGRESS,
      playbackStartedAt: new Date(),
      playbackAttempts: { increment: 1 },
      playbackErrorCode: null,
    },
  });

  let anonymised = 0;
  let batches = 0;

  try {
    for (; batches < MAX_SWEEP_BATCHES; batches += 1) {
      /*
       * Same two-statement shape as the retention sweep, and for the same
       * reason: Postgres does not accept LIMIT on UPDATE, so the batch is a
       * bounded id selection followed by a primary-key update.
       */
      const batch = await prisma.playbackEvent.findMany({
        where: { userId },
        select: { eventId: true },
        take: batchSize,
      });

      if (batch.length === 0) break;

      const updated = await prisma.playbackEvent.updateMany({
        where: { eventId: { in: batch.map((row) => row.eventId) } },
        data: { userId: null },
      });

      anonymised += updated.count;

      if (batch.length < batchSize) {
        batches += 1;
        break;
      }
    }
  } catch (error) {
    const errorCode = 'PLAYBACK_SWEEP_FAILED';

    await prisma.accountDeletion.updateMany({
      where: { userId },
      data: {
        playbackStatus: PlaybackCleanupStatus.FAILED,
        playbackAnonymised: { increment: anonymised },
        playbackFinishedAt: new Date(),
        playbackErrorCode: errorCode,
      },
    });

    // The cause is logged, never stored: a driver error message can quote row
    // contents, and the audit table is the one place that must hold none.
    logger.error(
      { event: 'deletion.playback_sweep_failed', userId, anonymised, err: error },
      'Playback de-linking failed; the row is marked FAILED and reconcilable',
    );

    return { anonymised, batches, status: PlaybackCleanupStatus.FAILED, errorCode };
  }

  await prisma.accountDeletion.updateMany({
    where: { userId },
    data: {
      playbackStatus: PlaybackCleanupStatus.COMPLETED,
      playbackAnonymised: { increment: anonymised },
      playbackFinishedAt: new Date(),
      playbackErrorCode: null,
    },
  });

  logger.info(
    { event: 'deletion.playback_sweep_complete', userId, anonymised, batches },
    'Playback events de-linked',
  );

  return { anonymised, batches, status: PlaybackCleanupStatus.COMPLETED };
}

// ────────────────────────────── Receipts ──────────────────────────────

/**
 * Resolves a deletion receipt.
 *
 * Returns the completion time, or null when no deletion was recorded under
 * that hash. The caller turns it into a boolean; nothing about the account is
 * returned, and nothing can be — this row holds no identifier to return.
 */
export async function findDeletionByReceipt(
  receiptHash: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const record = await prisma.accountDeletion.findUnique({
    where: { receiptHash },
    select: { completedAt: true, receiptExpiresAt: true },
  });

  if (!record) return null;

  // An expired receipt answers as if it never existed. The deletion still
  // happened; the proof simply is not available any more, and a client that
  // has waited thirty days has long since torn down.
  if (record.receiptExpiresAt && record.receiptExpiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return record.completedAt;
}

// ─────────────────────── Reconciliation queries ───────────────────────

export function findUnfinishedDeletions(): Promise<AccountDeletion[]> {
  return prisma.accountDeletion.findMany({
    where: { playbackStatus: { not: PlaybackCleanupStatus.COMPLETED } },
    orderBy: { requestedAt: 'asc' },
  });
}

/**
 * Deletions marked `COMPLETED` that still have events carrying their user id.
 *
 * A STATUS THAT LIES IS WORSE THAN ONE THAT IS BEHIND. `COMPLETED` is what
 * tells an operator there is nothing left to do, so it is worth one grouped
 * count to check that it is true rather than trusting a flag written by the
 * process that may have been killed a moment later.
 */
export async function findCompletedWithResidue(): Promise<string[]> {
  const completed = await prisma.accountDeletion.findMany({
    where: { playbackStatus: PlaybackCleanupStatus.COMPLETED },
    select: { userId: true },
  });

  if (completed.length === 0) return [];

  const residue = await prisma.playbackEvent.groupBy({
    by: ['userId'],
    where: { userId: { in: completed.map((row) => row.userId) } },
  });

  return residue.map((row) => row.userId).filter((userId): userId is string => userId !== null);
}

/**
 * Playback events belonging to a `DELETED` user that has NO deletion record.
 *
 * REPORTED, NEVER TOUCHED. These are retired guest rows: `mergeGuestInto` sets
 * `status = 'DELETED'` on a guest it has folded into a registered account
 * (ADR-41), and it deliberately re-points that guest's events at the account
 * the person actually owns. Nulling them here would destroy attribution the
 * merge was careful to preserve. The command names them so an operator can
 * see them; it does not decide for them.
 */
export async function findOrphanedPlaybackUsers(): Promise<
  Array<{ userId: string; events: number }>
> {
  const deletedUsers = await prisma.user.findMany({
    where: { status: 'DELETED' },
    select: { id: true },
  });

  if (deletedUsers.length === 0) return [];

  const audited = await prisma.accountDeletion.findMany({
    where: { userId: { in: deletedUsers.map((row) => row.id) } },
    select: { userId: true },
  });
  const auditedIds = new Set(audited.map((row) => row.userId));

  const unaudited = deletedUsers.map((row) => row.id).filter((id) => !auditedIds.has(id));
  if (unaudited.length === 0) return [];

  const grouped = await prisma.playbackEvent.groupBy({
    by: ['userId'],
    where: { userId: { in: unaudited } },
    _count: { _all: true },
  });

  return grouped
    .filter((row): row is typeof row & { userId: string } => row.userId !== null)
    .map((row) => ({ userId: row.userId, events: row._count._all }));
}

export async function pruneReceipts(now: Date = new Date()): Promise<number> {
  const result = await prisma.accountDeletion.updateMany({
    where: { receiptExpiresAt: { lt: now }, receiptHash: { not: null } },
    data: { receiptHash: null, receiptExpiresAt: null },
  });
  return result.count;
}

export async function pruneAuditRows(cutoff: Date): Promise<number> {
  const result = await prisma.accountDeletion.deleteMany({
    where: { requestedAt: { lt: cutoff } },
  });
  return result.count;
}
