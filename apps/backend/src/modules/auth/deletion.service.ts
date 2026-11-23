import type {
  DeleteAccountRequest,
  DeleteAccountResponse,
  DeletionReceiptResponse,
} from '@minidrama/contracts';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { verifyPassword } from '../../services/password.js';
import { hashOpaqueToken } from '../../services/tokens.js';
import * as repo from './deletion.repository.js';
import { AccountDeletionSource } from './deletion.repository.js';
import * as authRepo from './auth.repository.js';

/**
 * Account deletion policy (M2.6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULES THIS FILE IS ORGANISED AROUND
 *
 * 1. THE ACCOUNT DELETED IS THE CALLER'S. `userId` comes from the access
 *    token and from nowhere else — the same rule the rest of this module
 *    follows, and the one that stops deletion from being a weapon.
 *
 * 2. A REFUSED PASSWORD IS 403, NOT 401. The caller IS authenticated; their
 *    access token verified. Answering a wrong re-authentication with 401
 *    makes it indistinguishable from "your session is gone" — and since a
 *    SUCCESSFUL deletion also produces 401 on the next request, collapsing
 *    the two leaves a client unable to tell "wrong password" from "already
 *    deleted". That ambiguity is the bug M2.6 R1 exists to remove.
 *
 *    ADR-39's enumeration resistance does not apply here: the endpoint is
 *    authenticated, so there is no account to discover.
 *
 * 3. DELETION IS IDEMPOTENT AND SAYS SO. A second call for an account already
 *    deleted succeeds with zero counts. Two devices racing, or one client
 *    retrying after a lost response, must both end up believing the account
 *    is gone, because it is.
 *
 * 4. THE PLAYBACK SWEEP CANNOT FAIL THE REQUEST. It runs after the
 *    transaction that actually deletes the account, and a failure there is
 *    recorded for the reconciler rather than reported to a viewer who has
 *    already been told, correctly, that their account is gone.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface DeleteAccountContext {
  /** The raw `Idempotency-Key` header, if the client sent one. */
  receiptId?: string | undefined;
  source?: AccountDeletionSource | undefined;
}

export async function deleteAccount(
  userId: string,
  input: DeleteAccountRequest,
  context: DeleteAccountContext,
): Promise<DeleteAccountResponse> {
  const user = await authRepo.findUserById(userId);
  if (!user) throw AppError.notFound('That account');

  /*
   * ALREADY DELETED IS NOT AN ERROR — but in practice this branch is nearly
   * unreachable, because the identity middleware refuses a token whose user
   * is not ACTIVE. It exists for the one path that can reach it: a request
   * admitted a moment before a concurrent deletion committed.
   */
  if (user.status !== 'DELETED' && user.deletedAt === null) {
    await requireReauthentication(user.passwordHash, input.password);
  }

  const outcome = await repo.deleteAccount({
    userId,
    source: context.source ?? AccountDeletionSource.IN_APP,
    receiptHash: context.receiptId ? hashOpaqueToken(context.receiptId) : null,
    receiptTtlDays: env.AUTH_DELETION_RECEIPT_TTL_DAYS,
  });

  if (outcome.alreadyDeleted) {
    logger.info(
      { event: 'deletion.already_deleted', userId },
      'Deletion requested for an account that was already deleted',
    );
  } else {
    /*
     * Counts and a pseudonymous id. Never an address, never a token, never
     * what was watched — the same rule the audit table is built to (§5).
     */
    logger.info(
      { event: 'deletion.completed', userId, removed: outcome.counts },
      'Account deleted',
    );

    /*
     * AWAITED, BUT ITS FAILURE IS SWALLOWED BY THE REPOSITORY. Awaiting keeps
     * the common case tidy — by the time the viewer's app tears down, the
     * events are already de-linked — while `anonymisePlaybackEvents` never
     * throws, so a slow or failing sweep cannot turn a completed deletion
     * into an error response. What it does instead is leave a row the
     * reconciler can find.
     */
    await repo.anonymisePlaybackEvents(userId);
  }

  return {
    accepted: true,
    deletedAt: outcome.deletedAt.toISOString(),
    removed: outcome.counts,
    receiptRecorded: outcome.receiptRecorded,
    message: 'Your account and viewing history have been deleted.',
  };
}

/**
 * Proves the person at the keyboard is the account holder, not just whoever
 * is holding the device.
 *
 * TWO CASES, AND THE SECOND IS A DELIBERATE ACCEPTANCE (D2):
 *
 *   a. The account has a password. It must be supplied and must match. A
 *      missing one is 403 with a message saying so, rather than a validation
 *      error about a field — the field is genuinely optional on the wire,
 *      because case (b) exists.
 *
 *   b. The account has no password: a guest, or a future Google or phone
 *      account. There is nothing to re-verify. The access token is the only
 *      credential that exists for such an account (ADR-41), and refusing to
 *      delete without a password would mean guests could never exercise
 *      deletion at all. The confirmation word and the app's two-screen flow
 *      are what stand in for it, and they are a speed bump, not a control.
 */
async function requireReauthentication(
  passwordHash: string | null,
  supplied: string | undefined,
): Promise<void> {
  if (!passwordHash) return;

  if (!supplied) {
    throw AppError.forbidden('Enter your password to delete this account.');
  }

  if (!(await verifyPassword(supplied, passwordHash))) {
    throw AppError.forbidden('That password is not correct.');
  }
}

// ────────────────────────────── Receipts ──────────────────────────────

/**
 * Answers "did the deletion I asked for actually happen?".
 *
 * WHY THIS ENDPOINT EXISTS. A successful deletion destroys the access token,
 * the refresh token and the session row — every credential that could have
 * asked the question. A client whose 200 was lost to a dropped connection is
 * left holding a dead token and no answer, and the two things it might do on
 * a guess are both wrong: wiping local data destroys unsynced progress for an
 * account that may still exist, and not wiping leaves a deleted account's
 * viewing history on the handset.
 *
 * WHY IT IS SAFE UNAUTHENTICATED. The only accepted input is 256 bits of
 * CSPRNG output that the client generated and persisted before asking for
 * deletion, and which the server holds only as a SHA-256 hash. We never issue
 * one, so it cannot be used to probe for an account; the answer is a boolean
 * and a timestamp, so there is nothing in it to leak.
 *
 * AN UNKNOWN RECEIPT ANSWERS `false`, NOT 404. "No deletion was recorded
 * under this id" is the answer, not an error — and a 404 would make a
 * guessed-id probe distinguishable from a real one for no benefit.
 */
export async function resolveReceipt(receiptId: string): Promise<DeletionReceiptResponse> {
  const completedAt = await repo.findDeletionByReceipt(hashOpaqueToken(receiptId));

  if (!completedAt) {
    return { deleted: false, deletedAt: null };
  }

  return { deleted: true, deletedAt: completedAt.toISOString() };
}
