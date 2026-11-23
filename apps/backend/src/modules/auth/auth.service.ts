import { randomUUID } from 'node:crypto';
import type {
  Acknowledgement,
  AuthSession,
  ChangePasswordRequest,
  CurrentUser,
  GuestRequest,
  LoginRequest,
  MergeGuestRequest,
  MergeResult,
  RegisterRequest,
  RegisterResponse,
  ResetPasswordRequest,
} from '@minidrama/contracts';
import type { User } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { hashPassword, verifyPassword } from '../../services/password.js';
import {
  generateOpaqueToken,
  hashIp,
  hashOpaqueToken,
  signAccessToken,
} from '../../services/tokens.js';
import { isMailDeliveryAvailable } from '../../services/mail.js';
import { getProfile } from '../library/library.service.js';
import * as repo from './auth.repository.js';
import { SessionRevocationReason, VerificationPurpose } from './auth.repository.js';
import {
  sendAccountExistsEmail,
  sendEmailVerification,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from './auth.mailer.js';

/**
 * Authentication policy.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FOUR RULES THIS FILE IS ORGANISED AROUND
 *
 * 1. A CALLER'S IDENTITY NEVER COMES FROM A REQUEST BODY. Every function here
 *    that acts on an existing account takes a `userId` parameter, and the only
 *    thing that may supply it is the identity middleware. There is no code
 *    path from a JSON field to a `userId`.
 *
 * 2. NO RESPONSE REVEALS WHETHER AN ACCOUNT EXISTS. Registration, login and
 *    password-reset all answer identically whatever the truth is, and the
 *    login path spends the same CPU on a missing account as on a real one.
 *
 * 3. A REFRESH TOKEN IS USED EXACTLY ONCE. Every refresh rotates. Presenting
 *    a token that has already been rotated means two parties hold tokens from
 *    one chain, so the chain is finished — the whole family is revoked.
 *
 * 4. REVOCATION IS IMMEDIATE, NOT EVENTUAL. Access tokens are stateless and
 *    live 15 minutes, so revoking session rows alone would leave a window.
 *    `User.tokensValidFrom` closes it: any access token issued before that
 *    instant stops verifying at once.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** What the HTTP layer knows about a request that the policy needs. Supplied
 *  by the controller from the request itself — never from the body. */
export interface RequestContext {
  deviceId?: string | undefined;
  platform?: string | undefined;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/**
 * One message for every outcome that must not be distinguishable.
 *
 * Used by registration (both paths) and forgot-password (both paths). Written
 * so that it is true in all of them: "if there is an account, we have sent
 * something to it" makes no claim about whether there is one.
 */
const NEUTRAL_EMAIL_ACK =
  'If that email address can receive mail, we have sent a message to it. Check your inbox.';

const INVALID_CREDENTIALS = 'That email address and password do not match an account.';

// ─────────────────────────────── Registration ───────────────────────────────

export async function register(
  input: RegisterRequest,
  context: RequestContext,
): Promise<RegisterResponse> {
  const existing = await repo.findUserByEmail(input.email);

  if (existing) {
    /*
     * THE DUPLICATE PATH, AND WHY IT LOOKS LIKE SUCCESS.
     *
     * A 409 here would turn registration into an account-existence oracle:
     * submit a list of addresses, keep the ones that conflict. So nothing is
     * created, the real owner is told someone tried, and the caller receives
     * the identical body a successful registration returns.
     *
     * The work either path does is also comparable — one mail send — so the
     * timing does not give it away either.
     */
    await sendAccountExistsEmail(input.email);
    logger.info(
      { event: 'register.duplicate' },
      'Registration attempted for an existing address; owner notified',
    );
    return { accepted: true, message: NEUTRAL_EMAIL_ACK };
  }

  const passwordHash = await hashPassword(input.password);
  const user = await repo.createUser({
    email: input.email,
    passwordHash,
    displayName: input.displayName,
  });

  await issueEmailVerification(user.id, input.email);

  logger.info({ event: 'register.created', userId: user.id }, 'Account created');
  void context; // registration issues no session; see the contract note.

  return { accepted: true, message: NEUTRAL_EMAIL_ACK };
}

// ────────────────────────────────── Login ──────────────────────────────────

export async function login(input: LoginRequest, context: RequestContext): Promise<AuthSession> {
  const user = await repo.findUserByEmail(input.email);

  /*
   * THE PASSWORD IS VERIFIED EVEN WHEN THERE IS NO USER.
   *
   * `verifyPassword(plaintext, null)` hashes against a dummy and returns
   * false, which costs the same ~50ms a real verification costs. Returning
   * early here instead would answer an unknown address in under a
   * millisecond, and the difference is measurable over the network — a
   * stopwatch is as good as an error message to someone enumerating accounts.
   */
  const matches = await verifyPassword(input.password, user?.passwordHash ?? null);

  if (!user || !matches) {
    throw AppError.unauthenticated(INVALID_CREDENTIALS);
  }

  /*
   * A suspended or deleted account fails with the SAME message, deliberately.
   * "This account is suspended" confirms the account exists, and tells someone
   * probing it that they found a real one.
   */
  assertUsable(user, INVALID_CREDENTIALS);

  const session = await startSession(user, context);
  await repo.touchLastSeen(user.id);

  logger.info({ event: 'login.success', userId: user.id }, 'Signed in');
  return session;
}

// ─────────────────────────────── Guest access ───────────────────────────────

/**
 * Creates or resumes an anonymous account for an install (PRD AUTH-03).
 *
 * WHY A SERVER-SIDE ACCOUNT RATHER THAN DEVICE-LOCAL STATE: PD-6 settled
 * this. A real `User` row makes the eventual merge an UPDATE instead of an
 * upload-and-reconcile, and gives guest viewing honest analytics.
 *
 * THE DEVICE ID IS NOT A CREDENTIAL. It resumes an existing guest session
 * only when that session is still live and unrevoked, and it grants nothing
 * on its own — the access token issued here is what authorises anything.
 * Someone who guesses another install's device id gets a *new* guest account,
 * not that one, because the lookup requires a live session row bound to it.
 */
export async function guest(input: GuestRequest, context: RequestContext): Promise<AuthSession> {
  const existing = await repo.findLiveGuestSession(input.deviceId);

  if (existing) {
    /*
     * A returning guest resumes rather than accumulating accounts. Without
     * this, every cold start would orphan the previous guest's watch history
     * and Continue Watching would reset on each launch.
     *
     * The session is rotated rather than reused: the client gets a fresh
     * refresh token, and the old one stops working, so this path obeys
     * single-use like every other refresh.
     */
    const rotated = await rotateInto(existing, context);
    return rotated;
  }

  const user = await repo.createGuestUser();
  const session = await startSession(user, { ...context, deviceId: input.deviceId });

  logger.info({ event: 'guest.created', userId: user.id }, 'Guest account created');
  return session;
}

// ───────────────────────────────── Refresh ─────────────────────────────────

/**
 * Rotates a refresh token.
 *
 * THE REUSE BRANCH IS THE POINT OF THIS FUNCTION. A token that is found but
 * already revoked means the chain has two holders. We cannot tell which one
 * is the thief — the legitimate client and an attacker present identical
 * requests — so both lose the chain and the real user signs in again. The
 * alternative, ignoring it, means a stolen refresh token works indefinitely
 * because every use mints the attacker a fresh one.
 */
export async function refresh(rawToken: string, context: RequestContext): Promise<AuthSession> {
  const session = await repo.findSessionByRefreshHash(hashOpaqueToken(rawToken));

  if (!session) {
    throw AppError.unauthenticated('Your session has ended. Please sign in again.');
  }

  if (session.revokedAt) {
    await repo.revokeFamily(session.familyId, SessionRevocationReason.REFRESH_REUSE);
    logger.warn(
      { event: 'refresh.reuse_detected', userId: session.userId, familyId: session.familyId },
      'Refresh token reuse detected; the whole session family was revoked',
    );
    throw AppError.unauthenticated('Your session has ended. Please sign in again.');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthenticated('Your session has ended. Please sign in again.');
  }

  assertUsable(session.user, 'Your session has ended. Please sign in again.');

  return rotateInto(session, context);
}

// ───────────────────────────────── Logout ─────────────────────────────────

/**
 * Ends a session, or every session for the user.
 *
 * TAKES A `userId` FROM THE ACCESS TOKEN AND A REFRESH TOKEN FROM THE BODY,
 * and the pairing is checked: a refresh token belonging to someone else is
 * ignored rather than revoked. Otherwise logout would be a way to sign other
 * people out by presenting a token you had stolen but could not use.
 */
export async function logout(
  userId: string,
  options: { refreshToken?: string | undefined; allDevices?: boolean | undefined },
): Promise<void> {
  if (options.allDevices) {
    await repo.revokeAllForUser(userId, SessionRevocationReason.LOGOUT_ALL);
    logger.info({ event: 'logout.all', userId }, 'All sessions revoked');
    return;
  }

  if (!options.refreshToken) {
    /*
     * No refresh token supplied — the client could not produce one, which
     * happens when secure storage was already cleared. There is nothing
     * precise to revoke, so this is a no-op rather than an error: logout must
     * never fail, or the client is stuck holding credentials it wants rid of.
     */
    logger.info({ event: 'logout.no_token', userId }, 'Logout with no refresh token');
    return;
  }

  const session = await repo.findSessionByRefreshHash(hashOpaqueToken(options.refreshToken));

  if (!session || session.userId !== userId) {
    // Someone else's token, or none. Say nothing, do nothing, answer 200.
    logger.warn({ event: 'logout.mismatch', userId }, 'Logout presented an unrelated token');
    return;
  }

  await repo.revokeSession(session.id, SessionRevocationReason.LOGOUT);
  logger.info({ event: 'logout.session', userId }, 'Session revoked');
}

// ─────────────────────────────── Current user ───────────────────────────────

export async function currentUser(userId: string): Promise<CurrentUser> {
  const user = await repo.findUserById(userId);
  if (!user) throw AppError.notFound('That account');
  assertUsable(user);

  return {
    user: await getProfile(userId),
    emailVerified: user.emailVerifiedAt !== null,
    isGuest: user.isAnonymous,
  };
}

// ────────────────────────────── Password change ──────────────────────────────

export async function changePassword(
  userId: string,
  input: ChangePasswordRequest,
): Promise<Acknowledgement> {
  const user = await repo.findUserById(userId);
  if (!user) throw AppError.notFound('That account');
  assertUsable(user);

  /*
   * A guest has no password to change. Offering them the endpoint and then
   * failing on a null hash comparison would read as "wrong current password",
   * which is confusing rather than wrong; this says what is actually true.
   */
  if (!user.passwordHash) {
    throw new AppError(
      'FORBIDDEN',
      'This account has no password yet. Create an account to set one.',
    );
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw AppError.unauthenticated('Your current password is not correct.');
  }

  await repo.setPasswordHash(userId, await hashPassword(input.newPassword));

  /*
   * EVERY SESSION GOES, INCLUDING THIS ONE.
   *
   * The reason to change a password is usually that someone else may know the
   * old one, and leaving their sessions alive defeats the exercise. The client
   * signs straight back in with the new password, which is one extra step for
   * the owner and a closed door for everyone else.
   */
  await repo.revokeAllForUser(userId, SessionRevocationReason.PASSWORD_CHANGED);

  if (user.email) await sendPasswordChangedEmail(user.email);

  logger.info({ event: 'password.changed', userId }, 'Password changed; all sessions revoked');
  return { accepted: true, message: 'Your password has been changed. Please sign in again.' };
}

// ─────────────────────────────── Password reset ───────────────────────────────

export async function forgotPassword(email: string): Promise<Acknowledgement> {
  /*
   * REFUSE RATHER THAN LIE.
   *
   * With no real sender configured, the neutral acknowledgement below would
   * be a promise we cannot keep: the viewer waits for a link that was written
   * to a directory on the server. A 503 says the feature is unavailable,
   * which is both true and actionable.
   *
   * It leaks nothing — the answer is identical for a registered address and
   * an unknown one, which is the property this endpoint is built around.
   */
  if (!isMailDeliveryAvailable()) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Password reset is temporarily unavailable. Please try again later.',
    );
  }

  const user = await repo.findUserByEmail(email);

  /*
   * THE NO-ACCOUNT PATH DOES NOTHING AND SAYS THE SAME THING. This is the
   * textbook enumeration leak and the textbook fix. A guest account, or one
   * with no password, takes the same path for the same reason.
   */
  if (user && user.email && !user.isAnonymous && user.status === 'ACTIVE' && !user.deletedAt) {
    await repo.consumeOutstandingTokens(user.id, VerificationPurpose.PASSWORD_RESET);

    const token = generateOpaqueToken();
    await repo.createVerificationToken({
      userId: user.id,
      purpose: VerificationPurpose.PASSWORD_RESET,
      tokenHash: hashOpaqueToken(token),
      email: user.email,
      expiresAt: new Date(Date.now() + env.AUTH_RESET_TTL_MIN * 60_000),
    });

    await sendPasswordResetEmail(user.email, token);
    logger.info({ event: 'password.reset_requested', userId: user.id }, 'Reset link issued');
  } else {
    logger.info({ event: 'password.reset_unknown' }, 'Reset requested for an unknown address');
  }

  return { accepted: true, message: NEUTRAL_EMAIL_ACK };
}

export async function resetPassword(input: ResetPasswordRequest): Promise<Acknowledgement> {
  const record = await repo.findVerificationToken(hashOpaqueToken(input.token));

  const invalid = new AppError(
    'VALIDATION_ERROR',
    'That reset link is no longer valid. Request a new one.',
  );

  if (
    !record ||
    record.purpose !== VerificationPurpose.PASSWORD_RESET ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw invalid;
  }

  const user = await repo.findUserById(record.userId);
  if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw invalid;

  /*
   * The address the link was issued to must still be the account's address.
   * Without this, a link emailed before an address change would still reset
   * the account — which is precisely the path someone who had briefly taken
   * over an account would use to take it back.
   */
  if (user.email !== record.email) throw invalid;

  // The database decides who consumed it. Two tabs opening the same link race
  // here, and exactly one wins.
  if (!(await repo.consumeVerificationToken(record.tokenHash))) throw invalid;

  await repo.setPasswordHash(user.id, await hashPassword(input.newPassword));
  await repo.revokeAllForUser(user.id, SessionRevocationReason.PASSWORD_RESET);

  /*
   * A completed reset also proves control of the mailbox, so it verifies the
   * address if it was not verified already. Making someone click a second
   * link to prove what they just proved is ceremony, not security.
   */
  if (!user.emailVerifiedAt) await repo.markEmailVerified(user.id);

  logger.info({ event: 'password.reset_completed', userId: user.id }, 'Password reset');
  return { accepted: true, message: 'Your password has been reset. Please sign in.' };
}

// ────────────────────────────── Email verification ──────────────────────────────

export async function verifyEmail(rawToken: string): Promise<Acknowledgement> {
  const record = await repo.findVerificationToken(hashOpaqueToken(rawToken));

  const invalid = new AppError(
    'VALIDATION_ERROR',
    'That confirmation link is no longer valid. Request a new one.',
  );

  if (
    !record ||
    record.purpose !== VerificationPurpose.EMAIL_VERIFICATION ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw invalid;
  }

  const user = await repo.findUserById(record.userId);
  if (!user || user.email !== record.email) throw invalid;

  if (!(await repo.consumeVerificationToken(record.tokenHash))) throw invalid;

  await repo.markEmailVerified(user.id);
  logger.info({ event: 'email.verified', userId: user.id }, 'Email verified');

  return { accepted: true, message: 'Your email address is confirmed.' };
}

export async function resendVerification(userId: string): Promise<Acknowledgement> {
  const user = await repo.findUserById(userId);
  if (!user) throw AppError.notFound('That account');
  assertUsable(user);

  // Already verified, or no address to verify. Both answer the same way: the
  // endpoint is authenticated, so there is nothing to enumerate, but there is
  // also nothing useful to report.
  if (user.email && !user.emailVerifiedAt) {
    await issueEmailVerification(user.id, user.email);
  }

  return { accepted: true, message: NEUTRAL_EMAIL_ACK };
}

// ──────────────────────────────── Guest merge ────────────────────────────────

/**
 * Turns the calling guest into a registered account, keeping their activity
 * (PRD AUTH-06).
 *
 * THE GUEST IS THE CALLER. `guestUserId` comes from the access token, never
 * from the body — a `guestUserId` parameter would let anyone adopt anyone
 * else's anonymous account along with its history.
 *
 * TWO CASES, AND THE SECOND IS THE ONE THAT MATTERS:
 *
 *   a. The address is free. The guest row is promoted in place: it gains an
 *      email and a password and stops being anonymous. Nothing moves, so
 *      nothing can be lost.
 *
 *   b. The address already has an account. The person is returning to an
 *      account they already had, on a device that has been browsing as a
 *      guest. Their guest activity is folded into the existing account and
 *      the guest row is retired. THIS REQUIRES THE PASSWORD: without it,
 *      anyone could merge into — and therefore sign into — any account by
 *      claiming its address.
 */
export async function mergeGuest(
  guestUserId: string,
  input: MergeGuestRequest,
  context: RequestContext,
): Promise<MergeResult> {
  const guestUser = await repo.findUserById(guestUserId);
  if (!guestUser) throw AppError.notFound('That account');

  if (!guestUser.isAnonymous) {
    throw new AppError('RESOURCE_CONFLICT', 'This account is already registered.');
  }

  const existing = await repo.findUserByEmail(input.email);

  // ── Case (a): promote the guest row in place ──
  if (!existing) {
    const passwordHash = await hashPassword(input.password);
    const promoted = await repo.promoteGuestUser(guestUserId, {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });

    await issueEmailVerification(promoted.id, input.email);
    await repo.revokeAllForUser(promoted.id, SessionRevocationReason.MERGED);

    const session = await startSession(promoted, context);
    logger.info({ event: 'merge.promoted', userId: promoted.id }, 'Guest promoted to an account');

    return {
      session,
      moved: { watchHistory: 0, dramaProgress: 0, favorites: 0, playbackEvents: 0 },
    };
  }

  // ── Case (b): fold into the existing account, password required ──
  const matches = await verifyPassword(input.password, existing.passwordHash);
  if (!matches) throw AppError.unauthenticated(INVALID_CREDENTIALS);
  assertUsable(existing, INVALID_CREDENTIALS);

  const moved = await repo.mergeGuestInto(guestUserId, existing.id);
  const session = await startSession(existing, context);

  logger.info(
    { event: 'merge.folded', userId: existing.id, moved },
    'Guest activity merged into an existing account',
  );

  return { session, moved };
}

// ──────────────────────────────── Internals ────────────────────────────────

/**
 * Refuses a user who should not be getting a session.
 *
 * The message defaults to a generic one and callers on an unauthenticated
 * path pass the same text they use for a wrong password, so that account
 * status is never observable from outside.
 */
function assertUsable(user: User, message?: string): void {
  if (user.deletedAt || user.status === 'DELETED') {
    throw AppError.unauthenticated(message ?? 'That account is no longer available.');
  }
  if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
    throw AppError.unauthenticated(message ?? 'That account is not available right now.');
  }
}

/** Mints a brand-new session family. Login, guest creation and merge. */
async function startSession(user: User, context: RequestContext): Promise<AuthSession> {
  const refreshToken = generateOpaqueToken();

  const session = await repo.createSession({
    userId: user.id,
    familyId: randomUUID(),
    refreshHash: hashOpaqueToken(refreshToken),
    expiresAt: refreshExpiry(),
    deviceId: context.deviceId,
    platform: context.platform,
    userAgent: context.userAgent,
    ipHash: hashIp(context.ip),
  });

  return buildSession(user, session.id, refreshToken);
}

/** Rotates an existing session, keeping its family. Refresh and guest resume. */
async function rotateInto(
  session: repo.SessionWithUser,
  context: RequestContext,
): Promise<AuthSession> {
  const refreshToken = generateOpaqueToken();

  const next = await repo.rotateSession({
    currentSessionId: session.id,
    userId: session.userId,
    familyId: session.familyId,
    refreshHash: hashOpaqueToken(refreshToken),
    expiresAt: refreshExpiry(),
    // The device binding follows the chain, so a resumed guest session stays
    // bound to the install that created it.
    deviceId: context.deviceId ?? session.deviceId ?? undefined,
    platform: context.platform ?? session.platform ?? undefined,
    userAgent: context.userAgent,
    ipHash: hashIp(context.ip),
  });

  return buildSession(session.user, next.id, refreshToken);
}

async function buildSession(
  user: User,
  sessionId: string,
  refreshToken: string,
): Promise<AuthSession> {
  const { token, expiresInSec } = await signAccessToken({
    userId: user.id,
    sessionId,
    isAnonymous: user.isAnonymous,
  });

  return {
    accessToken: token,
    refreshToken,
    expiresIn: expiresInSec,
    user: await getProfile(user.id),
    emailVerified: user.emailVerifiedAt !== null,
  };
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function issueEmailVerification(userId: string, email: string): Promise<void> {
  /*
   * SKIPPED, NOT FAILED, WHEN THERE IS NO SENDER.
   *
   * Unlike a password reset, verification is not the point of the request
   * that triggers it — registration is. An unverified address still signs in
   * and still watches (see `User.emailVerifiedAt`), so failing a registration
   * because the confirmation email cannot be sent would turn a missing
   * integration into an outage of the one flow that brings new users in.
   *
   * No token is minted either: an unsent token is a row that can only expire.
   */
  if (!isMailDeliveryAvailable()) {
    logger.warn(
      { userId, event: 'email.verification_skipped' },
      'No mail delivery configured; verification email not sent',
    );
    return;
  }

  await repo.consumeOutstandingTokens(userId, VerificationPurpose.EMAIL_VERIFICATION);

  const token = generateOpaqueToken();
  await repo.createVerificationToken({
    userId,
    purpose: VerificationPurpose.EMAIL_VERIFICATION,
    tokenHash: hashOpaqueToken(token),
    email,
    expiresAt: new Date(Date.now() + env.AUTH_VERIFY_TTL_HOURS * 60 * 60 * 1000),
  });

  await sendEmailVerification(email, token);
}
