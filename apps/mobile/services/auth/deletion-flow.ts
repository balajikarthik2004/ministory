import { DELETION_CONFIRMATION, type DeletionCounts } from '@minidrama/contracts';
import { AppError } from '../errors';
import type { AuthGateway } from './auth-gateway';

/**
 * Account deletion, as a decision procedure (M2.6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS FILE IS SHAPED AROUND
 *
 * A successful deletion destroys the access token, the refresh token and the
 * session row — every credential that could be used to ask whether it worked.
 * So the one error a client most needs to interpret, a 401, is produced by
 * FOUR different situations:
 *
 *   · the access token expired mid-flow, ordinarily, after fifteen minutes
 *   · the session was revoked elsewhere (a password change, a sign-out-all)
 *   · the deletion SUCCEEDED and the response was lost
 *   · the request never reached a server at all — not a 401, but just as
 *     ambiguous
 *
 * Guessing is unacceptable in either direction. Wiping local data on a guess
 * destroys unsynced progress for an account that may still exist; refusing to
 * wipe leaves a deleted account's viewing history on the handset.
 *
 * THE ANSWER IS A RECEIPT. A 256-bit id is generated and written to the
 * keystore BEFORE the request goes out, and travels as `Idempotency-Key`. The
 * server records its hash in the same transaction that deletes the account.
 * `POST /auth/deletion-receipt` then answers "was a deletion recorded under
 * this id?" with no credential at all — the only way the question can be
 * asked once the credentials are gone.
 *
 * NOTHING IS TORN DOWN UNTIL THE SERVER HAS CONFIRMED, with a 200 or with a
 * positive receipt. That is the invariant this module exists to hold.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PLAIN TYPESCRIPT, NO REACT, NO EXPO — every dependency is injected, for the
 * reason ADR-44 gives: `services/auth/session.ts` and `credential-store.ts`
 * pull in `react-native` and `expo-secure-store`, which cannot be imported
 * under plain Node at all. The branch table above is precisely the thing that
 * must not be wrong, and a device test cannot reach most of it reliably.
 * `services/auth/deletion.ts` wires the real implementations in.
 */

export type DeletionOutcome =
  /** Confirmed by the server. The caller tears down. */
  | { kind: 'deleted'; removed: DeletionCounts }
  /** Wrong or missing password. The session is fine; stay on the screen. */
  | { kind: 'reauth-failed'; message: string }
  /** Too many attempts. Temporary, and the account is untouched. */
  | { kind: 'rate-limited'; message: string }
  /**
   * The session is unusable AND the server confirmed no deletion happened.
   * The account still exists; the viewer signs in again to try.
   */
  | { kind: 'session-ended'; message: string }
  /**
   * Nothing could be established. The account may or may not be deleted.
   * NOTHING IS WIPED. The attempt stays pending and is resolved next launch.
   */
  | { kind: 'unconfirmed'; message: string }
  /** Anything else the server refused, in its own words. */
  | { kind: 'failed'; message: string };

export interface ReceiptStore {
  load(): Promise<string | null>;
  save(receiptId: string): Promise<boolean>;
  clear(): Promise<void>;
  create(): string;
}

export interface DeletionDeps {
  gateway: Pick<AuthGateway, 'deleteAccount' | 'resolveDeletionReceipt'>;
  receipts: ReceiptStore;
  getAccessToken(): Promise<string | null>;
  handleUnauthorized(usedToken: string | null): Promise<string | null>;
}

const UNCONFIRMED_MESSAGE =
  'We could not reach MiniDrama, so we cannot tell whether your account was deleted. ' +
  'Nothing on this device has been removed. Try again when you have a connection.';

const SESSION_ENDED_MESSAGE =
  'Your session has ended and your account was not deleted. Sign in and try again.';

/** What the receipt path can report, since the counts were in a lost response. */
const NO_COUNTS: DeletionCounts = {
  watchHistory: 0,
  dramaProgress: 0,
  favorites: 0,
  sessions: 0,
  verificationTokens: 0,
};

/**
 * Asks the server to delete the signed-in account.
 *
 * Does NOT tear down on success — the caller does, and the split is
 * deliberate: the screen shows a confirmation state between the two, and a
 * teardown running inside this function would pull the session out from under
 * the component rendering it.
 */
export async function requestAccountDeletion(
  deps: DeletionDeps,
  input: { password?: string },
): Promise<DeletionOutcome> {
  const receiptId = deps.receipts.create();

  /*
   * PERSISTED BEFORE THE REQUEST, NOT AFTER.
   *
   * If the app is killed between the call and the response — the exact case
   * the receipt exists for — an id written afterwards would never have been
   * written at all, and the deletion would be unresolvable forever.
   */
  await deps.receipts.save(receiptId);

  const body = {
    ...(input.password ? { password: input.password } : {}),
    confirm: DELETION_CONFIRMATION,
  };

  const accessToken = await deps.getAccessToken();
  if (!accessToken) {
    // No credential to delete with. The receipt cannot have been used, but
    // asking costs one request and removes the guess.
    return resolveOrGiveUp(deps, receiptId, 'session-ended');
  }

  try {
    const result = await deps.gateway.deleteAccount(accessToken, body, receiptId);
    await deps.receipts.clear();
    return { kind: 'deleted', removed: result.removed };
  } catch (error) {
    if (!(error instanceof AppError)) {
      return resolveOrGiveUp(deps, receiptId, 'unconfirmed');
    }

    switch (error.code) {
      /*
       * 403 IS WHY THE SERVER DISTINGUISHES IT FROM 401. The caller is
       * authenticated and the password was refused — the session is
       * untouched, nothing was deleted, and the viewer should simply try
       * again on the same screen.
       */
      case 'FORBIDDEN':
      case 'VALIDATION_ERROR':
        await deps.receipts.clear();
        return { kind: 'reauth-failed', message: error.message };

      case 'RATE_LIMITED':
        await deps.receipts.clear();
        return { kind: 'rate-limited', message: error.message };

      /*
       * An ordinary fifteen-minute expiry caught mid-flow. Refresh once and
       * retry once — the HTTP client's rule, for the same reason: a second
       * failure after a good token means something a new token cannot fix.
       */
      case 'TOKEN_EXPIRED': {
        const refreshed = await deps.handleUnauthorized(accessToken);
        if (!refreshed) return resolveOrGiveUp(deps, receiptId, 'session-ended');

        try {
          const retried = await deps.gateway.deleteAccount(refreshed, body, receiptId);
          await deps.receipts.clear();
          return { kind: 'deleted', removed: retried.removed };
        } catch (retryError) {
          if (
            retryError instanceof AppError &&
            (retryError.code === 'FORBIDDEN' || retryError.code === 'VALIDATION_ERROR')
          ) {
            await deps.receipts.clear();
            return { kind: 'reauth-failed', message: retryError.message };
          }
          return resolveOrGiveUp(deps, receiptId, 'session-ended');
        }
      }

      /*
       * THE AMBIGUOUS ONE. Either the session died, or the deletion worked
       * and we never saw the answer. Only the receipt tells them apart.
       */
      case 'UNAUTHENTICATED':
        return resolveOrGiveUp(deps, receiptId, 'session-ended');

      /*
       * `SERVICE_UNAVAILABLE` is what the gateway raises for a timeout, a DNS
       * failure or a refused connection, so the request may never have been
       * seen — or may have been processed with the response lost on the way
       * back. Ask.
       */
      case 'SERVICE_UNAVAILABLE':
        return resolveOrGiveUp(deps, receiptId, 'unconfirmed');

      default:
        await deps.receipts.clear();
        return { kind: 'failed', message: error.message };
    }
  }
}

/**
 * Asks whether the deletion behind `receiptId` actually happened, falling
 * back to what we knew about the original failure.
 *
 * The fallback carries a distinction the viewer acts on: `session-ended`
 * means "your account is still there, sign in and try again", while
 * `unconfirmed` means "we do not know, and we have deliberately changed
 * nothing".
 */
async function resolveOrGiveUp(
  deps: DeletionDeps,
  receiptId: string,
  fallback: 'session-ended' | 'unconfirmed',
): Promise<DeletionOutcome> {
  try {
    const receipt = await deps.gateway.resolveDeletionReceipt(receiptId);

    if (receipt.deleted) {
      await deps.receipts.clear();
      // The counts were in the response we never received. The deletion is
      // the fact that matters; reporting zeroes is honest about what we know.
      return { kind: 'deleted', removed: NO_COUNTS };
    }

    /*
     * A definitive "no deletion was recorded". The receipt is written in the
     * same transaction as the deletion, so this answer cannot be stale, and
     * the pending attempt is settled — clearing it stops the next launch
     * asking again about something already decided.
     */
    await deps.receipts.clear();

    return fallback === 'session-ended'
      ? { kind: 'session-ended', message: SESSION_ENDED_MESSAGE }
      : { kind: 'unconfirmed', message: UNCONFIRMED_MESSAGE };
  } catch {
    /*
     * The receipt lookup itself could not be answered. KEEP THE PENDING
     * RECEIPT — this is the one state where the next launch has work to do,
     * and discarding it would make the deletion permanently unresolvable.
     */
    return { kind: 'unconfirmed', message: UNCONFIRMED_MESSAGE };
  }
}

/**
 * Resolves a deletion left unfinished by a previous launch.
 *
 * A receipt in the keystore means an attempt was made and never resolved —
 * the app was killed, or the network died at exactly the wrong moment. This
 * turns that into an answer rather than a device that silently keeps a
 * deleted account's history.
 *
 * `teardown` is only ever called after the server has confirmed.
 */
export async function resolvePendingDeletion(
  deps: DeletionDeps,
  teardown: () => Promise<void>,
): Promise<boolean> {
  const receiptId = await deps.receipts.load();
  if (!receiptId) return false;

  let receipt;
  try {
    receipt = await deps.gateway.resolveDeletionReceipt(receiptId);
  } catch {
    // Still unreachable. Leave the receipt in place and ask again next time;
    // the device keeps working as it is in the meantime.
    return false;
  }

  if (!receipt.deleted) {
    // Settled: no deletion was recorded under this id, so the attempt failed
    // and there is nothing to clean up.
    await deps.receipts.clear();
    return false;
  }

  await deps.receipts.clear();
  await teardown();
  return true;
}
