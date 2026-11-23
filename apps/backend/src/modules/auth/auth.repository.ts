import type { Prisma, Session, User, VerificationToken } from '../../generated/prisma/client.js';
import { SessionRevocationReason, VerificationPurpose } from '../../generated/prisma/enums.js';
import { prisma } from '../../services/prisma.js';

/**
 * Every database statement the authentication module makes.
 *
 * The service above it holds the policy — what rotation means, when a family
 * is revoked, what counts as reuse. This file holds only the reads and writes,
 * so that the policy can be read in one place without Prisma in the way, and
 * so the transactional boundaries are visible rather than scattered.
 *
 * NOTHING HERE TAKES A USER ID FROM ANYWHERE BUT ITS CALLER, and the caller is
 * always a service that got it from a verified credential.
 */

export type SessionWithUser = Session & { user: User };

// ──────────────────────────────── Users ────────────────────────────────

export function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

/**
 * Creates a registered account and its profile in one statement.
 *
 * A nested create rather than two writes: a user row without a profile row is
 * a state every read path would then have to tolerate, and the only reason it
 * could exist is a crash between two statements.
 */
export function createUser(input: {
  email: string;
  passwordHash: string;
  displayName?: string | undefined;
}): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      passwordHash: input.passwordHash,
      isAnonymous: false,
      profile: {
        create: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
      },
    },
  });
}

/** An anonymous account. No email, no password — see `User.passwordHash`. */
export function createGuestUser(): Promise<User> {
  return prisma.user.create({
    data: {
      isAnonymous: true,
      profile: { create: {} },
    },
  });
}

/**
 * Turns an anonymous row into a registered one, in place.
 *
 * IN PLACE IS THE WHOLE POINT. The guest's watch history, progress and
 * favourites are already keyed to this `userId`, so promoting the row moves
 * nothing and therefore cannot lose anything. The alternative — create a new
 * user and copy — has a failure mode where half the rows moved.
 */
export function promoteGuestUser(
  userId: string,
  input: { email: string; passwordHash: string; displayName?: string | undefined },
): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: {
      email: input.email,
      passwordHash: input.passwordHash,
      isAnonymous: false,
      profile: {
        upsert: {
          create: {
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          },
          update: {
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          },
        },
      },
    },
  });
}

export function setPasswordHash(userId: string, passwordHash: string): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      /*
       * Invalidates every access token issued before now. Revoking the session
       * rows alone would leave up to 15 minutes in which a stolen access token
       * still worked — which is the window a password change exists to close.
       */
      tokensValidFrom: new Date(),
    },
  });
}

export function markEmailVerified(userId: string): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  });
}

export function touchLastSeen(userId: string): Promise<unknown> {
  return prisma.user.update({
    where: { id: userId },
    data: { lastSeenAt: new Date() },
  });
}

// ─────────────────────────────── Sessions ───────────────────────────────

export function createSession(input: {
  userId: string;
  familyId: string;
  refreshHash: string;
  expiresAt: Date;
  parentId?: string | undefined;
  deviceId?: string | undefined;
  platform?: string | undefined;
  userAgent?: string | undefined;
  ipHash?: string | null | undefined;
}): Promise<Session> {
  return prisma.session.create({
    data: {
      userId: input.userId,
      familyId: input.familyId,
      refreshHash: input.refreshHash,
      expiresAt: input.expiresAt,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    },
  });
}

/**
 * Finds a session by the hash of a presented refresh token.
 *
 * RETURNS REVOKED AND EXPIRED SESSIONS TOO, on purpose. The caller has to be
 * able to tell "no such token" from "a token that was already used", because
 * the second is a reuse event that revokes a whole family. Filtering revoked
 * rows out here would make a replay indistinguishable from a random string
 * and silently disable reuse detection.
 */
export function findSessionByRefreshHash(refreshHash: string): Promise<SessionWithUser | null> {
  return prisma.session.findUnique({
    where: { refreshHash },
    include: { user: true },
  });
}

export function findSessionById(id: string): Promise<Session | null> {
  return prisma.session.findUnique({ where: { id } });
}

/**
 * Rotates a session: revokes the presented one and issues its successor,
 * inside a single transaction.
 *
 * ATOMIC BECAUSE A PARTIAL ROTATION IS A LOCKOUT OR A DUPLICATE. If the
 * revoke committed and the insert failed, the client holds a token that is
 * now dead and has not been given a replacement — signed out mid-session
 * through no fault of theirs. If the insert committed and the revoke failed,
 * two live tokens share a family and the next refresh looks like reuse.
 */
export function rotateSession(input: {
  currentSessionId: string;
  userId: string;
  familyId: string;
  refreshHash: string;
  expiresAt: Date;
  deviceId?: string | undefined;
  platform?: string | undefined;
  userAgent?: string | undefined;
  ipHash?: string | null | undefined;
}): Promise<Session> {
  return prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: input.currentSessionId },
      data: {
        revokedAt: new Date(),
        revokedReason: SessionRevocationReason.ROTATED,
        lastUsedAt: new Date(),
      },
    });

    return tx.session.create({
      data: {
        userId: input.userId,
        familyId: input.familyId,
        refreshHash: input.refreshHash,
        expiresAt: input.expiresAt,
        parentId: input.currentSessionId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
        ...(input.ipHash ? { ipHash: input.ipHash } : {}),
      },
    });
  });
}

export function revokeSession(
  sessionId: string,
  reason: SessionRevocationReason,
): Promise<Prisma.BatchPayload> {
  return prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/**
 * Revokes every still-live session in a rotation chain.
 *
 * Called on reuse detection. The whole family goes, not just the replayed
 * token, because a replay means someone other than the legitimate holder has
 * a token from this chain — and there is no way to tell which of the two
 * current holders is which. Signing both out is the only safe answer, and the
 * legitimate one signs back in.
 */
export function revokeFamily(
  familyId: string,
  reason: SessionRevocationReason,
): Promise<Prisma.BatchPayload> {
  return prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export function revokeAllForUser(
  userId: string,
  reason: SessionRevocationReason,
): Promise<Prisma.BatchPayload> {
  return prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** The live guest session for an install, if there is one. Lets a returning
 *  guest resume their account instead of accumulating a new one per launch. */
export function findLiveGuestSession(deviceId: string): Promise<SessionWithUser | null> {
  return prisma.session.findFirst({
    where: {
      deviceId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { isAnonymous: true, status: 'ACTIVE', deletedAt: null },
    },
    orderBy: { createdAt: 'desc' },
    include: { user: true },
  });
}

export function markSessionUsed(sessionId: string): Promise<unknown> {
  return prisma.session.update({
    where: { id: sessionId },
    data: { lastUsedAt: new Date() },
  });
}

// ─────────────────────────── Verification tokens ───────────────────────────

export function createVerificationToken(input: {
  userId: string;
  purpose: VerificationPurpose;
  tokenHash: string;
  email: string;
  expiresAt: Date;
}): Promise<VerificationToken> {
  return prisma.verificationToken.create({ data: input });
}

export function findVerificationToken(tokenHash: string): Promise<VerificationToken | null> {
  return prisma.verificationToken.findUnique({ where: { tokenHash } });
}

/**
 * Consumes a token, and reports whether this call is the one that did it.
 *
 * `updateMany` with `consumedAt: null` in the WHERE clause, not a read
 * followed by a write: two requests presenting the same reset link at the
 * same moment would both pass a read-then-check and both reset the password.
 * Here the database decides, and exactly one of them sees `count === 1`.
 */
export async function consumeVerificationToken(tokenHash: string): Promise<boolean> {
  const result = await prisma.verificationToken.updateMany({
    where: { tokenHash, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}

/** Invalidates outstanding tokens of one purpose — a new reset request
 *  should not leave the previous link working. */
export function consumeOutstandingTokens(
  userId: string,
  purpose: VerificationPurpose,
): Promise<Prisma.BatchPayload> {
  return prisma.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

// ───────────────────────────── Guest merge ─────────────────────────────

export interface MergeCounts {
  watchHistory: number;
  dramaProgress: number;
  favorites: number;
  playbackEvents: number;
}

/**
 * Moves a guest account's activity onto a registered account, then retires
 * the guest row. One transaction (AUTH-06).
 *
 * THE CONFLICT RULE: the guest's row wins only where the target has nothing.
 *
 * Every table here is keyed `(userId, somethingId)`, so a straight UPDATE of
 * `userId` would hit a unique violation the moment the target account has
 * already watched the same episode or favourited the same drama. Rather than
 * failing the merge, or clobbering the target's own progress, rows that would
 * collide are dropped and the target's existing row is kept.
 *
 * WHY THE TARGET WINS. The target is the account the person just signed into,
 * carrying whatever they did on a previous install. The guest row is this
 * device's anonymous history. Where the two disagree about one episode, the
 * registered account's record is the one with an owner, and the alternative —
 * taking the larger position — would silently rewind a viewer who had watched
 * further on another device.
 *
 * `updateMany` + `deleteMany`, not `update`: if the guest has no rows at all,
 * which is the common case for someone who registered immediately, the merge
 * must still succeed and report zero rather than throw.
 */
export function mergeGuestInto(guestUserId: string, targetUserId: string): Promise<MergeCounts> {
  return prisma.$transaction(async (tx) => {
    // Episodes and dramas the target already has a row for. Fetched first so
    // the moves below can exclude exactly those and nothing else.
    const [targetHistory, targetProgress, targetFavorites] = await Promise.all([
      tx.watchHistory.findMany({ where: { userId: targetUserId }, select: { episodeId: true } }),
      tx.dramaProgress.findMany({ where: { userId: targetUserId }, select: { dramaId: true } }),
      tx.favorite.findMany({ where: { userId: targetUserId }, select: { dramaId: true } }),
    ]);

    const heldEpisodes = targetHistory.map((row) => row.episodeId);
    const heldProgressDramas = targetProgress.map((row) => row.dramaId);
    const heldFavoriteDramas = targetFavorites.map((row) => row.dramaId);

    const watchHistory = await tx.watchHistory.updateMany({
      where: { userId: guestUserId, episodeId: { notIn: heldEpisodes } },
      data: { userId: targetUserId },
    });
    const dramaProgress = await tx.dramaProgress.updateMany({
      where: { userId: guestUserId, dramaId: { notIn: heldProgressDramas } },
      data: { userId: targetUserId },
    });
    const favorites = await tx.favorite.updateMany({
      where: { userId: guestUserId, dramaId: { notIn: heldFavoriteDramas } },
      data: { userId: targetUserId },
    });

    /*
     * Analytics follows the person, not the account. `PlaybackEvent.userId`
     * has no foreign key (see the schema note), so this is a plain update and
     * there is no uniqueness to collide with — the primary key is the client's
     * event UUID.
     */
    const playbackEvents = await tx.playbackEvent.updateMany({
      where: { userId: guestUserId },
      data: { userId: targetUserId },
    });

    // Whatever would have collided stays behind and goes with the guest row.
    await tx.watchHistory.deleteMany({ where: { userId: guestUserId } });
    await tx.dramaProgress.deleteMany({ where: { userId: guestUserId } });
    await tx.favorite.deleteMany({ where: { userId: guestUserId } });

    await tx.session.updateMany({
      where: { userId: guestUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: SessionRevocationReason.MERGED },
    });

    /*
     * The guest row is retired, not deleted.
     *
     * DELETED rather than dropped so that any row elsewhere still pointing at
     * it — a PlaybackEvent that arrived from the outbox a second after the
     * merge, for instance — keeps a valid reference. This matches the account
     * deletion rule in DATABASE_SCHEMA.md §6.
     */
    await tx.user.update({
      where: { id: guestUserId },
      data: { status: 'DELETED', deletedAt: new Date(), isAnonymous: true },
    });

    return {
      watchHistory: watchHistory.count,
      dramaProgress: dramaProgress.count,
      favorites: favorites.count,
      playbackEvents: playbackEvents.count,
    };
  });
}

export { SessionRevocationReason, VerificationPurpose };
