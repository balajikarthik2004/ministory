import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeleteAccountResponse, DeletionReceiptResponse } from '@minidrama/contracts';
import { AppError } from '../../services/errors';
import {
  requestAccountDeletion,
  resolvePendingDeletion,
  type DeletionDeps,
  type ReceiptStore,
} from '../../services/auth/deletion-flow';

/**
 * The deletion decision procedure — M2.6 R1.
 *
 * WHAT IS ACTUALLY BEING TESTED. Deleting an account destroys the credential
 * that would be used to ask whether it worked, so a 401 afterwards is
 * genuinely ambiguous: it could be an expired token, a revoked session, or a
 * deletion that succeeded with its response lost. The rule these tests pin is
 * that NOTHING LOCAL IS DESTROYED until the server has confirmed — and the
 * only way to confirm, once the credentials are gone, is the receipt.
 *
 * Getting this wrong in either direction is a real harm: wiping on a guess
 * destroys unsynced progress for a live account, and not wiping leaves a
 * deleted viewer's history on the handset.
 */

const COUNTS = {
  watchHistory: 3,
  dramaProgress: 1,
  favorites: 2,
  sessions: 1,
  verificationTokens: 0,
};

function deletionResponse(): DeleteAccountResponse {
  return {
    accepted: true,
    deletedAt: '2026-11-18T10:00:00.000Z',
    removed: COUNTS,
    receiptRecorded: true,
    message: 'Your account and viewing history have been deleted.',
  };
}

/** An in-memory keystore that records every write, so ordering is assertable. */
function memoryReceipts(initial: string | null = null): ReceiptStore & {
  value: string | null;
  saved: string[];
  cleared: number;
} {
  return {
    value: initial,
    saved: [],
    cleared: 0,
    create() {
      return 'receipt-generated-0001';
    },
    async load() {
      return this.value;
    },
    async save(receiptId: string) {
      this.value = receiptId;
      this.saved.push(receiptId);
      return true;
    },
    async clear() {
      this.value = null;
      this.cleared += 1;
    },
  };
}

function deps(overrides: Partial<DeletionDeps> = {}): DeletionDeps {
  const notStubbed = async (): Promise<never> => {
    throw new Error('not stubbed for this test');
  };
  return {
    gateway: {
      deleteAccount: notStubbed,
      resolveDeletionReceipt: notStubbed,
    },
    receipts: memoryReceipts(),
    getAccessToken: async () => 'access-token-1',
    handleUnauthorized: async () => null,
    ...overrides,
  };
}

function receipt(deleted: boolean): DeletionReceiptResponse {
  return deleted
    ? { deleted: true, deletedAt: '2026-11-18T10:00:00.000Z' }
    : { deleted: false, deletedAt: null };
}

describe('requestAccountDeletion', () => {
  it('persists the receipt id before the request goes out', async () => {
    const receipts = memoryReceipts();
    let receiptAtCallTime: string | null = null;

    const outcome = await requestAccountDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => {
            // The app could be killed on this line. The id must already be
            // on disk, or the deletion becomes unresolvable forever.
            receiptAtCallTime = receipts.value;
            return deletionResponse();
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'deleted');
    assert.equal(receiptAtCallTime, 'receipt-generated-0001');
  });

  it('reports the counts on a clean 200', async () => {
    const outcome = await requestAccountDeletion(
      deps({
        gateway: {
          deleteAccount: async () => deletionResponse(),
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'deleted');
    if (outcome.kind === 'deleted') assert.deepEqual(outcome.removed, COUNTS);
  });

  /**
   * 403 IS THE DISTINCTION THE SERVER WAS CHANGED TO MAKE. A wrong password
   * leaves the session perfectly good, so the viewer stays on the screen and
   * tries again — and critically, nothing is torn down.
   */
  it('treats 403 as a re-authentication failure, not a deletion', async () => {
    const receipts = memoryReceipts();

    const outcome = await requestAccountDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => {
            throw new AppError('FORBIDDEN', 'That password is not correct.');
          },
          resolveDeletionReceipt: async () => {
            throw new Error('the receipt must not be consulted for a 403');
          },
        },
      }),
      { password: 'wrong' },
    );

    assert.equal(outcome.kind, 'reauth-failed');
    assert.equal(receipts.value, null, 'a settled attempt leaves no pending receipt');
  });

  it('passes a rate limit through as temporary', async () => {
    const outcome = await requestAccountDeletion(
      deps({
        gateway: {
          deleteAccount: async () => {
            throw new AppError('RATE_LIMITED', 'Too many attempts. Try again shortly.');
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'rate-limited');
  });

  /**
   * THE CASE THE RECEIPT EXISTS FOR. The deletion committed; the response
   * never arrived. Every credential is now dead, so the 401 on the retry
   * looks exactly like a revoked session — and the receipt is the only thing
   * that can tell the difference.
   */
  it('confirms a deletion whose response was lost', async () => {
    const receipts = memoryReceipts();

    const outcome = await requestAccountDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => {
            throw new AppError('UNAUTHENTICATED', 'Your session has ended.');
          },
          resolveDeletionReceipt: async () => receipt(true),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'deleted', 'the receipt proves it happened');
    assert.equal(receipts.value, null);
  });

  /**
   * The mirror image, and the one that protects a live account: the session
   * died and nothing was deleted. Reporting `deleted` here would wipe a
   * working account's local data.
   */
  it('reports a revoked session as session-ended, never as deleted', async () => {
    const outcome = await requestAccountDeletion(
      deps({
        gateway: {
          deleteAccount: async () => {
            throw new AppError('UNAUTHENTICATED', 'Your session has ended.');
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'session-ended');
  });

  it('refreshes once and retries when the access token merely expired', async () => {
    let attempts = 0;

    const outcome = await requestAccountDeletion(
      deps({
        handleUnauthorized: async () => 'access-token-2',
        gateway: {
          deleteAccount: async (token) => {
            attempts += 1;
            if (token === 'access-token-1') {
              throw new AppError('TOKEN_EXPIRED', 'Your session has expired.');
            }
            return deletionResponse();
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'deleted');
    assert.equal(attempts, 2, 'exactly one retry, with the refreshed token');
  });

  it('does not retry forever when the refresh cannot help', async () => {
    let attempts = 0;

    const outcome = await requestAccountDeletion(
      deps({
        handleUnauthorized: async () => 'access-token-2',
        gateway: {
          deleteAccount: async () => {
            attempts += 1;
            throw new AppError('TOKEN_EXPIRED', 'Your session has expired.');
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(attempts, 2, 'at most one retry');
    assert.equal(outcome.kind, 'session-ended');
  });

  /**
   * THE INVARIANT, STATED AS A TEST. The server could not be reached, so
   * nothing is known — and the receipt stays on disk so the next launch can
   * find out. An outcome of `deleted` here would destroy a live account's
   * unsynced progress because of a train tunnel.
   */
  it('reports unconfirmed and KEEPS the receipt when nothing can be reached', async () => {
    const receipts = memoryReceipts();

    const outcome = await requestAccountDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => {
            throw new AppError('SERVICE_UNAVAILABLE', 'That took too long.');
          },
          resolveDeletionReceipt: async () => {
            throw new AppError('SERVICE_UNAVAILABLE', 'That took too long.');
          },
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'unconfirmed');
    assert.equal(
      receipts.value,
      'receipt-generated-0001',
      'the pending attempt must survive for the next launch',
    );
  });

  it('confirms through the receipt when only the response was lost', async () => {
    const outcome = await requestAccountDeletion(
      deps({
        gateway: {
          deleteAccount: async () => {
            throw new AppError('SERVICE_UNAVAILABLE', 'That took too long.');
          },
          resolveDeletionReceipt: async () => receipt(true),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'deleted');
  });

  it('checks the receipt even with no access token at all', async () => {
    const outcome = await requestAccountDeletion(
      deps({
        getAccessToken: async () => null,
        gateway: {
          deleteAccount: async () => {
            throw new Error('must not be called without a credential');
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      { password: 'correct-horse-battery' },
    );

    assert.equal(outcome.kind, 'session-ended');
  });

  it('sends no password for a guest', async () => {
    let sent: { password?: string } | null = null;

    await requestAccountDeletion(
      deps({
        gateway: {
          deleteAccount: async (_token, body) => {
            sent = body;
            return deletionResponse();
          },
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      {},
    );

    assert.ok(sent);
    assert.equal((sent as { password?: string }).password, undefined);
    assert.equal((sent as { confirm: string }).confirm, 'DELETE');
  });
});

describe('resolvePendingDeletion', () => {
  it('does nothing when there is no pending receipt', async () => {
    let tornDown = false;
    const resolved = await resolvePendingDeletion(
      deps({ receipts: memoryReceipts(null) }),
      async () => {
        tornDown = true;
      },
    );

    assert.equal(resolved, false);
    assert.equal(tornDown, false);
  });

  it('tears down when the server confirms the deletion happened', async () => {
    const receipts = memoryReceipts('receipt-from-last-launch');
    let tornDown = false;

    const resolved = await resolvePendingDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => deletionResponse(),
          resolveDeletionReceipt: async () => receipt(true),
        },
      }),
      async () => {
        tornDown = true;
      },
    );

    assert.equal(resolved, true);
    assert.equal(tornDown, true);
    assert.equal(receipts.value, null);
  });

  it('clears the receipt and tears down nothing when the deletion never happened', async () => {
    const receipts = memoryReceipts('receipt-from-last-launch');
    let tornDown = false;

    const resolved = await resolvePendingDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => deletionResponse(),
          resolveDeletionReceipt: async () => receipt(false),
        },
      }),
      async () => {
        tornDown = true;
      },
    );

    assert.equal(resolved, false);
    assert.equal(tornDown, false);
    assert.equal(receipts.value, null, 'a settled attempt is not asked about again');
  });

  /**
   * Still offline at launch. The question is simply postponed — and crucially
   * the receipt survives, because this is the one state where a later launch
   * genuinely has work to do.
   */
  it('keeps the receipt when the server still cannot be reached', async () => {
    const receipts = memoryReceipts('receipt-from-last-launch');
    let tornDown = false;

    const resolved = await resolvePendingDeletion(
      deps({
        receipts,
        gateway: {
          deleteAccount: async () => deletionResponse(),
          resolveDeletionReceipt: async () => {
            throw new AppError('SERVICE_UNAVAILABLE', 'offline');
          },
        },
      }),
      async () => {
        tornDown = true;
      },
    );

    assert.equal(resolved, false);
    assert.equal(tornDown, false);
    assert.equal(receipts.value, 'receipt-from-last-launch');
  });
});
