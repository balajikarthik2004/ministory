import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type {
  AuthSession,
  DeleteAccountResponse,
  DeletionReceiptResponse,
  RegisterResponse,
} from '@minidrama/contracts';
import { apiRequest, dataOf, prisma, resetTestData, stopTestServer } from './support/harness.js';
import { createDrama, episodeId, seedReferenceData } from './support/factories.js';

/**
 * Account deletion — M2.6.
 *
 * Driven over HTTP for the reason auth.test.ts gives: a service-level test
 * proves the service works and says nothing about whether the route is
 * mounted, the guard applied, the body validated or the error mapped to the
 * right status. The database is read only to assert what was *stored* — which
 * for this milestone is the whole point, since deletion's contract is about
 * what is no longer there.
 *
 * `src/` is imported dynamically, after the harness's top-level await has
 * repointed `DATABASE_URL`. See the long note in auth.test.ts.
 */

const { MemoryMailProvider, setMailProvider } = await import('../src/services/mail.js');

const mail = new MemoryMailProvider();
const PASSWORD = 'a-perfectly-fine-password';

async function register(email: string, password = PASSWORD): Promise<RegisterResponse> {
  return dataOf(
    await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: { email, password },
    }),
  );
}

async function signedInUser(email: string, password = PASSWORD): Promise<AuthSession> {
  await register(email, password);
  return dataOf(
    await apiRequest<AuthSession>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  );
}

async function guestSession(deviceId: string): Promise<AuthSession> {
  return dataOf(
    await apiRequest<AuthSession>('/auth/guest', {
      method: 'POST',
      body: { deviceId, platform: 'android' },
    }),
  );
}

function deleteAccount(
  token: string,
  body: Record<string, unknown> = { confirm: 'DELETE', password: PASSWORD },
  receiptId?: string,
) {
  return apiRequest<DeleteAccountResponse>('/auth/account', {
    method: 'DELETE',
    token,
    body,
    ...(receiptId ? { headers: { 'Idempotency-Key': receiptId } } : {}),
  });
}

function newReceiptId(): string {
  return randomBytes(32).toString('base64url');
}

/** Gives a user something to lose: history, progress and a favourite. */
async function seedActivity(userId: string, dramaId: string): Promise<void> {
  await prisma.watchHistory.create({
    data: { userId, episodeId: episodeId(dramaId, 1), positionSec: 12, watchedSec: 12 },
  });
  await prisma.dramaProgress.create({
    data: { userId, dramaId, lastEpisodeId: episodeId(dramaId, 1), positionSec: 12 },
  });
  await prisma.favorite.create({ data: { userId, dramaId } });
  await prisma.drama.update({
    where: { id: dramaId },
    data: { favoriteCount: { increment: 1 } },
  });
}

before(async () => {
  setMailProvider(mail);
  await resetTestData();
  await seedReferenceData();
  await createDrama({ id: 'drama_del', episodes: 3, freeEpisodes: 3 });
});

beforeEach(async () => {
  await prisma.accountDeletion.deleteMany();
  await prisma.playbackEvent.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.dramaProgress.deleteMany();
  await prisma.watchHistory.deleteMany();
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.drama.update({ where: { id: 'drama_del' }, data: { favoriteCount: 0 } });
  mail.clear();
});

after(async () => {
  await stopTestServer();
});

// ───────────────────────────── The happy path ─────────────────────────────

describe('DELETE /auth/account', () => {
  it('removes everything personal and anonymises the user row', async () => {
    const session = await signedInUser('gone@test.local');
    await seedActivity(session.user.id, 'drama_del');

    const response = await deleteAccount(session.accessToken);
    assert.equal(response.status, 200);
    const body = dataOf(response);

    assert.equal(body.accepted, true);
    assert.deepEqual(body.removed, {
      watchHistory: 1,
      dramaProgress: 1,
      favorites: 1,
      sessions: 1,
      // Registration issued an email-verification token, and it is still
      // outstanding — which is exactly the kind of row that must not survive
      // the account, since it holds the address we just nulled.
      verificationTokens: 1,
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'DELETED');
    assert.ok(user.deletedAt);
    assert.ok(user.tokensValidFrom);
    // Every direct identifier is gone.
    assert.equal(user.email, null);
    assert.equal(user.phone, null);
    assert.equal(user.firebaseUid, null);
    assert.equal(user.passwordHash, null);
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(user.lastSeenAt, null);

    // And every child row with it.
    assert.equal(await prisma.userProfile.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.watchHistory.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.dramaProgress.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.favorite.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.verificationToken.count({ where: { userId: user.id } }), 0);
  });

  /**
   * THE REGRESSION THIS WHOLE TEST FILE EXISTS FOR.
   *
   * `Drama.favoriteCount` is denormalised and maintained transactionally by
   * add/remove (DATABASE_SCHEMA.md §9.5). Nothing recomputes it. A bulk
   * delete of a user's favourites that forgets the counter inflates it
   * permanently, and the symptom — a drama claiming more saves than it has —
   * is invisible until someone counts by hand.
   */
  it('decrements Drama.favoriteCount for every favourite it removes', async () => {
    const keeper = await signedInUser('keeper@test.local');
    const leaver = await signedInUser('leaver@test.local');

    await prisma.favorite.create({ data: { userId: keeper.user.id, dramaId: 'drama_del' } });
    await prisma.favorite.create({ data: { userId: leaver.user.id, dramaId: 'drama_del' } });
    await prisma.drama.update({
      where: { id: 'drama_del' },
      data: { favoriteCount: 2 },
    });

    dataOf(await deleteAccount(leaver.accessToken));

    const drama = await prisma.drama.findUniqueOrThrow({ where: { id: 'drama_del' } });
    assert.equal(drama.favoriteCount, 1, 'the surviving favourite must still be counted');
    assert.equal(await prisma.favorite.count({ where: { dramaId: 'drama_del' } }), 1);
  });

  it('writes an audit row that carries no identifier', async () => {
    const session = await signedInUser('audited@test.local');
    await seedActivity(session.user.id, 'drama_del');

    dataOf(await deleteAccount(session.accessToken));

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });

    assert.equal(audit.source, 'IN_APP');
    assert.equal(audit.wasAnonymous, false);
    assert.equal(audit.removedFavorites, 1);
    assert.equal(audit.removedWatchHistory, 1);
    assert.ok(audit.completedAt);

    /*
     * The audit row must not reconstitute the account it records. Serialising
     * the whole row and searching it is deliberately blunt: a future column
     * that quietly holds an address fails here without anyone remembering to
     * add an assertion for it.
     */
    const serialised = JSON.stringify(audit).toLowerCase();
    assert.ok(!serialised.includes('audited@test.local'), 'audit row leaked the email');
    assert.ok(!serialised.includes('test.local'), 'audit row leaked a domain');
    assert.ok(!serialised.includes(PASSWORD), 'audit row leaked a password');
  });

  it('reports nothing about the account in its response', async () => {
    const session = await signedInUser('quiet@test.local');
    const body = dataOf(await deleteAccount(session.accessToken));
    assert.ok(!JSON.stringify(body).includes('quiet@test.local'));
  });
});

// ─────────────────────────── Sessions die at once ───────────────────────────

describe('deletion and sessions', () => {
  it('kills the access token used to delete, immediately', async () => {
    const session = await signedInUser('token@test.local');
    dataOf(await deleteAccount(session.accessToken));

    const me = await apiRequest('/auth/me', { token: session.accessToken });
    assert.equal(me.status, 401);
  });

  it('kills a second device signed into the same account', async () => {
    await register('two@test.local');
    const phone = dataOf(
      await apiRequest<AuthSession>('/auth/login', {
        method: 'POST',
        body: { email: 'two@test.local', password: PASSWORD, deviceId: 'device-phone-aaa' },
      }),
    );
    const tablet = dataOf(
      await apiRequest<AuthSession>('/auth/login', {
        method: 'POST',
        body: { email: 'two@test.local', password: PASSWORD, deviceId: 'device-tablet-bb' },
      }),
    );

    dataOf(await deleteAccount(phone.accessToken));

    const fromTablet = await apiRequest('/auth/me', { token: tablet.accessToken });
    assert.equal(fromTablet.status, 401, 'the other device must be signed out too');

    const refreshed = await apiRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: tablet.refreshToken },
    });
    assert.equal(refreshed.status, 401, 'its refresh token must not mint a new session');
  });

  it('refuses an unauthenticated deletion and changes nothing', async () => {
    const session = await signedInUser('safe@test.local');

    const response = await apiRequest('/auth/account', {
      method: 'DELETE',
      body: { confirm: 'DELETE', password: PASSWORD },
    });
    assert.equal(response.status, 401);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'ACTIVE');
    assert.equal(user.email, 'safe@test.local');
  });
});

// ────────────────────────── Re-authentication (R1) ──────────────────────────

describe('re-authentication', () => {
  /**
   * 403, NOT 401 — the distinction M2.6 R1 turns on.
   *
   * The caller's access token verified, so they ARE authenticated; what was
   * refused is the password. Answering 401 would make a wrong password
   * indistinguishable from "your session has ended" — and since a SUCCESSFUL
   * deletion also produces 401 on every later request, a client could not
   * tell "I typed it wrong" from "it already worked".
   */
  it('answers a wrong password with 403 and leaves the account intact', async () => {
    const session = await signedInUser('wrongpw@test.local');

    const response = await deleteAccount(session.accessToken, {
      confirm: 'DELETE',
      password: 'not-the-right-password',
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.success, false);
    if (response.body.success === false) {
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'ACTIVE');
    assert.equal(user.email, 'wrongpw@test.local');

    // And the session that failed is still usable — it was never the problem.
    const me = await apiRequest('/auth/me', { token: session.accessToken });
    assert.equal(me.status, 200);
  });

  it('answers a missing password with 403 when the account has one', async () => {
    const session = await signedInUser('nopw@test.local');

    const response = await deleteAccount(session.accessToken, { confirm: 'DELETE' });
    assert.equal(response.status, 403);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'ACTIVE');
  });

  it('refuses without the confirmation word', async () => {
    const session = await signedInUser('noconfirm@test.local');

    const response = await deleteAccount(session.accessToken, {
      confirm: 'delete',
      password: PASSWORD,
    });
    assert.equal(response.status, 400);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'ACTIVE');
  });

  /** D2: a guest has no password, and the access token is all that exists. */
  it('lets a guest delete with no password at all', async () => {
    const guest = await guestSession('device-guest-delete-01');
    await seedActivity(guest.user.id, 'drama_del');

    const body = dataOf(await deleteAccount(guest.accessToken, { confirm: 'DELETE' }));
    assert.equal(body.removed.watchHistory, 1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: guest.user.id } });
    assert.equal(user.status, 'DELETED');

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: guest.user.id },
    });
    assert.equal(audit.wasAnonymous, true);
  });

  it('rate limits repeated password attempts', async () => {
    const session = await signedInUser('bruteforce@test.local');
    const wrong = { confirm: 'DELETE', password: 'still-not-the-password' };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await deleteAccount(session.accessToken, wrong)).status);
    }

    assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`);
    // And the account survived every one of them.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    assert.equal(user.status, 'ACTIVE');
  });
});

// ───────────────────────── Idempotency and racing ─────────────────────────

describe('idempotency', () => {
  it('treats two concurrent deletions as one, without erroring', async () => {
    const session = await signedInUser('race@test.local');
    await seedActivity(session.user.id, 'drama_del');

    const [first, second] = await Promise.all([
      deleteAccount(session.accessToken),
      deleteAccount(session.accessToken),
    ]);

    /*
     * Both callers must end up believing the account is gone, because it is.
     * One of them did the work and reports the counts; the other may be
     * refused by the identity middleware (the user is no longer ACTIVE) or
     * may reach the service and find nothing to do. Either is correct; what
     * must NOT happen is a 500, or two audit rows.
     */
    const outcomes = [first.status, second.status].sort();
    assert.ok(
      outcomes.every((status) => status === 200 || status === 401),
      `unexpected statuses ${outcomes.join(',')}`,
    );
    assert.ok(outcomes.includes(200), 'at least one call must have done the work');

    assert.equal(await prisma.accountDeletion.count({ where: { userId: session.user.id } }), 1);
    assert.equal(await prisma.watchHistory.count({ where: { userId: session.user.id } }), 0);

    const drama = await prisma.drama.findUniqueOrThrow({ where: { id: 'drama_del' } });
    assert.equal(drama.favoriteCount, 0, 'the counter must not be decremented twice');
  });

  it('refuses to sign in afterwards, without saying why', async () => {
    const session = await signedInUser('signin@test.local');
    dataOf(await deleteAccount(session.accessToken));

    const response = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'signin@test.local', password: PASSWORD },
    });

    assert.equal(response.status, 401);
    if (response.body.success === false) {
      // The generic credentials sentence, not "this account was deleted".
      assert.match(response.body.error.message, /do not match an account/i);
    }
  });

  it('frees the email address for a genuinely new account', async () => {
    const first = await signedInUser('reuse@test.local');
    const firstId = first.user.id;
    await seedActivity(firstId, 'drama_del');
    dataOf(await deleteAccount(first.accessToken));

    const second = await signedInUser('reuse@test.local');

    assert.notEqual(second.user.id, firstId, 'must be a new account, not the old one revived');
    assert.equal(await prisma.watchHistory.count({ where: { userId: second.user.id } }), 0);
    assert.equal(await prisma.favorite.count({ where: { userId: second.user.id } }), 0);
  });

  /**
   * A guest using a deleted account's old address gets a NEW account, and
   * inherits nothing.
   *
   * WHY THERE IS NOTHING TO MERGE INTO. Deletion nulls `User.email` in the
   * same statement that marks the row deleted, so `findUserByEmail` cannot
   * find it and `mergeGuest` takes its promote-in-place branch — the same
   * branch any unused address takes. There is no reachable state in which an
   * account is `DELETED` and still owns an address, so a merge can never
   * target one.
   *
   * This is the merge-shaped version of "the address is freed", and the thing
   * worth proving is the negative: none of the deleted account's activity
   * follows the address to its new owner.
   */
  it('lets a guest claim a deleted account’s freed address as a new account', async () => {
    const target = await signedInUser('mergetarget@test.local');
    const deletedId = target.user.id;
    await seedActivity(deletedId, 'drama_del');
    dataOf(await deleteAccount(target.accessToken));

    const guest = await guestSession('device-merge-into-deleted');
    const response = await apiRequest<{ session: AuthSession }>('/auth/merge', {
      method: 'POST',
      token: guest.accessToken,
      body: { email: 'mergetarget@test.local', password: PASSWORD },
    });

    assert.equal(response.status, 200);
    const promoted = dataOf(response).session;

    assert.equal(promoted.user.id, guest.user.id, 'the guest row is promoted in place');
    assert.notEqual(promoted.user.id, deletedId, 'and it is not the deleted account revived');

    // Nothing crossed over from the account that was deleted.
    assert.equal(await prisma.watchHistory.count({ where: { userId: promoted.user.id } }), 0);
    assert.equal(await prisma.favorite.count({ where: { userId: promoted.user.id } }), 0);

    const deleted = await prisma.user.findUniqueOrThrow({ where: { id: deletedId } });
    assert.equal(deleted.status, 'DELETED');
    assert.equal(deleted.email, null);
  });
});

// ──────────────────────── Playback events (R3) ────────────────────────

describe('playback de-linking', () => {
  async function seedEvents(userId: string, count: number): Promise<void> {
    await prisma.playbackEvent.createMany({
      data: Array.from({ length: count }, (_unused, index) => ({
        eventId: `evt-del-${userId}-${index}`,
        sessionId: 'ps_delete_test',
        userId,
        dramaId: 'drama_del',
        episodeId: episodeId('drama_del', 1),
        type: 'playback_progress' as const,
        positionSec: index,
        durationSec: 60,
        occurredAt: new Date(),
        platform: 'android',
        appVersion: '0.1.0-test',
      })),
    });
  }

  it('nulls the user id without deleting the rows', async () => {
    const session = await signedInUser('events@test.local');
    await seedEvents(session.user.id, 25);

    dataOf(await deleteAccount(session.accessToken));

    assert.equal(
      await prisma.playbackEvent.count({ where: { userId: session.user.id } }),
      0,
      'no event may still carry the deleted user id',
    );
    assert.equal(
      await prisma.playbackEvent.count({ where: { sessionId: 'ps_delete_test' } }),
      25,
      'the rows themselves are retained, de-linked, under the 90-day window',
    );
  });

  it('records the sweep as COMPLETED, with a count', async () => {
    const session = await signedInUser('sweep@test.local');
    await seedEvents(session.user.id, 10);

    dataOf(await deleteAccount(session.accessToken));

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(audit.playbackStatus, 'COMPLETED');
    assert.equal(audit.playbackAnonymised, 10);
    assert.equal(audit.playbackAttempts, 1);
    assert.ok(audit.playbackStartedAt);
    assert.ok(audit.playbackFinishedAt);
    assert.equal(audit.playbackErrorCode, null);
  });

  it('completes cleanly when there is nothing to de-link', async () => {
    const session = await signedInUser('noevents@test.local');
    dataOf(await deleteAccount(session.accessToken));

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(audit.playbackStatus, 'COMPLETED');
    assert.equal(audit.playbackAnonymised, 0);
  });
});

// ───────────────────────── Deletion receipts (R1) ─────────────────────────

describe('deletion receipts', () => {
  function resolveReceipt(receiptId: string) {
    return apiRequest<DeletionReceiptResponse>('/auth/deletion-receipt', {
      method: 'POST',
      body: { receiptId },
    });
  }

  /**
   * THE WHOLE POINT OF THE RECEIPT. The credential that would ask "did my
   * deletion go through?" is destroyed by the deletion itself, so the answer
   * has to be reachable without one.
   */
  it('confirms a deletion after every credential is gone', async () => {
    const receiptId = newReceiptId();
    const session = await signedInUser('receipt@test.local');

    const body = dataOf(await deleteAccount(session.accessToken, undefined, receiptId));
    assert.equal(body.receiptRecorded, true);

    // The token is dead — this is exactly the client's position after a lost
    // response.
    assert.equal((await apiRequest('/auth/me', { token: session.accessToken })).status, 401);

    const receipt = dataOf(await resolveReceipt(receiptId));
    assert.equal(receipt.deleted, true);
    assert.ok(receipt.deletedAt);
    assert.equal(receipt.deletedAt, body.deletedAt);
  });

  it('answers false for a receipt that was never used', async () => {
    const receipt = dataOf(await resolveReceipt(newReceiptId()));
    assert.equal(receipt.deleted, false);
    assert.equal(receipt.deletedAt, null);
  });

  /**
   * A 403 is not a deletion, and the receipt must not claim otherwise — this
   * is the case that decides whether a client wipes a live account's local
   * data.
   */
  it('answers false when the deletion was refused', async () => {
    const receiptId = newReceiptId();
    const session = await signedInUser('refused@test.local');

    const response = await deleteAccount(
      session.accessToken,
      { confirm: 'DELETE', password: 'wrong-password-entirely' },
      receiptId,
    );
    assert.equal(response.status, 403);

    const receipt = dataOf(await resolveReceipt(receiptId));
    assert.equal(receipt.deleted, false, 'a refused attempt must never look like a deletion');
  });

  it('stores only a hash of the receipt id', async () => {
    const receiptId = newReceiptId();
    const session = await signedInUser('hashed@test.local');
    dataOf(await deleteAccount(session.accessToken, undefined, receiptId));

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.ok(audit.receiptHash);
    assert.notEqual(audit.receiptHash, receiptId);
    assert.match(audit.receiptHash, /^[0-9a-f]{64}$/);
    assert.ok(audit.receiptExpiresAt);
  });

  it('says plainly when no receipt was recorded', async () => {
    const session = await signedInUser('noreceipt@test.local');
    const body = dataOf(await deleteAccount(session.accessToken));
    assert.equal(body.receiptRecorded, false, 'a client with no recovery path must be told');
  });
});
