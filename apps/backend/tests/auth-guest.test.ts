import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSession, CurrentUser, MergeResult } from '@minidrama/contracts';
import { apiRequest, dataOf, prisma, resetTestData, stopTestServer } from './support/harness.js';
import { createDrama, episodeId, seedReferenceData } from './support/factories.js';

/**
 * Guest accounts, the upgrade to a registered one, and user-data continuity.
 * M2.5 Phases 3 and 5.
 *
 * THE REQUIREMENT BEING TESTED, in the milestone's own words: "Do not
 * silently discard local progress during authentication." Everything below is
 * some version of that — a guest's watch history, progress and favourites
 * must survive becoming an account, and must never leak into somebody else's.
 *
 * `src/` is imported dynamically for the reason documented at the top of
 * auth.test.ts: `support/harness.ts` repoints `DATABASE_URL` behind a
 * top-level await, and a static import here would be evaluated first.
 */

const { MemoryMailProvider, setMailProvider } = await import('../src/services/mail.js');

const mail = new MemoryMailProvider();
const PASSWORD = 'a-perfectly-fine-password';

async function guestSession(deviceId: string): Promise<AuthSession> {
  return dataOf(
    await apiRequest<AuthSession>('/auth/guest', {
      method: 'POST',
      body: { deviceId, platform: 'android' },
    }),
  );
}

const DRAMA_ID = 'drama_guest';

/**
 * The factory's episode lengths, cycled: episode 1 is 30s, 2 is 45s, 3 is 20s.
 *
 * SPELLED OUT BECAUSE THE SERVER IGNORES THE CLIENT'S CLAIMED DURATION and
 * uses the catalogue's (`library.service.ts`), clamping the position to it. A
 * test that writes position 250 against a 30-second episode is not testing
 * what it looks like it is testing — it reads back 30, and an assertion about
 * which of two positions survived a merge then compares two clamped values
 * that are equal by accident.
 */
const DURATIONS = [30, 45, 20] as const;

/**
 * Gives the caller some activity worth preserving.
 *
 * Episode numbers rather than ids, because `episodeId()` derives one from the
 * other and a test that spells out both can disagree with itself.
 */
async function watchSomething(
  token: string,
  episodeNumber: number,
  positionSec: number,
): Promise<void> {
  const durationSec = DURATIONS[episodeNumber - 1] ?? 30;
  assert.ok(
    positionSec < durationSec,
    `position ${positionSec} must be inside the episode's ${durationSec}s`,
  );

  const response = await apiRequest(`/me/history/${episodeId(DRAMA_ID, episodeNumber)}`, {
    method: 'PUT',
    token,
    body: { dramaId: DRAMA_ID, episodeNumber, positionSec, durationSec },
  });
  assert.equal(response.status, 200, 'the progress write should succeed');
}

before(async () => {
  setMailProvider(mail);
  await resetTestData();
  await seedReferenceData();
});

beforeEach(async () => {
  await prisma.playbackEvent.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.dramaProgress.deleteMany();
  await prisma.watchHistory.deleteMany();
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.userProfile.deleteMany();
  await prisma.user.deleteMany();
  mail.clear();

  await prisma.subtitle.deleteMany();
  await prisma.episode.deleteMany();
  await prisma.season.deleteMany();
  await prisma.dramaTranslation.deleteMany();
  await prisma.dramaCategory.deleteMany();
  await prisma.drama.deleteMany();
  // All three episodes free: this suite is about identity, not entitlement.
  await createDrama({ id: DRAMA_ID, title: 'Guest Drama', episodes: 3, freeEpisodes: 3 });
});

after(async () => {
  await stopTestServer();
});

// ─────────────────────────────── Guest accounts ───────────────────────────────

describe('guest accounts', () => {
  it('creates a real, anonymous account', async () => {
    const session = await guestSession('device-aaaaaaaa-0001');

    assert.ok(session.accessToken);
    assert.equal(session.user.isAnonymous, true);
    assert.equal(session.user.email, null);

    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    assert.equal(user?.isAnonymous, true);
    assert.equal(user?.passwordHash, null, 'a guest has no password');
  });

  /**
   * The point of binding to a device: a guest who closes the app and comes
   * back must be the SAME guest, or Continue Watching resets on every launch
   * and their history is orphaned one row at a time.
   */
  it('resumes the same account for the same install', async () => {
    const first = await guestSession('device-aaaaaaaa-0002');
    const second = await guestSession('device-aaaaaaaa-0002');

    assert.equal(second.user.id, first.user.id, 'same account');
    assert.notEqual(second.refreshToken, first.refreshToken, 'but a rotated token');

    assert.equal(
      await prisma.user.count({ where: { isAnonymous: true } }),
      1,
      'one row, not one per launch',
    );
  });

  it('gives a different install a different account', async () => {
    const a = await guestSession('device-aaaaaaaa-0003');
    const b = await guestSession('device-bbbbbbbb-0004');
    assert.notEqual(a.user.id, b.user.id);
  });

  /**
   * A device id is a label, not a credential. Someone who learns another
   * install's id must not inherit that account — the resume path requires a
   * live, unrevoked session row bound to it, so a revoked one starts fresh.
   */
  it('does not resume a revoked guest session', async () => {
    const first = await guestSession('device-aaaaaaaa-0005');
    await prisma.session.updateMany({ data: { revokedAt: new Date() } });

    const second = await guestSession('device-aaaaaaaa-0005');
    assert.notEqual(second.user.id, first.user.id, 'a new account, not the old one');
  });

  it('can read and write its own library', async () => {
    const guest = await guestSession('device-aaaaaaaa-0006');
    await watchSomething(guest.accessToken, 1, 12);

    const me = dataOf(await apiRequest<CurrentUser>('/auth/me', { token: guest.accessToken }));
    assert.equal(me.isGuest, true);

    const history = await prisma.watchHistory.findMany({ where: { userId: guest.user.id } });
    assert.equal(history.length, 1, 'guest activity is stored against the guest account');
  });
});

// ──────────────────────────── Upgrade: promotion ────────────────────────────

describe('guest upgrade — new address', () => {
  /**
   * The common case: a guest who has been watching registers for the first
   * time. The row is promoted in place, so nothing moves and nothing can be
   * lost in the moving.
   */
  it('promotes the guest row in place, keeping everything', async () => {
    const guest = await guestSession('device-cccccccc-0001');
    await watchSomething(guest.accessToken, 2, 20);
    await apiRequest(`/me/favorites/${DRAMA_ID}`, { method: 'POST', token: guest.accessToken });

    const result = dataOf(
      await apiRequest<MergeResult>('/auth/merge', {
        method: 'POST',
        token: guest.accessToken,
        body: { email: 'promoted@example.com', password: PASSWORD, displayName: 'Promoted' },
      }),
    );

    assert.equal(result.session.user.id, guest.user.id, 'the SAME account id');
    assert.equal(result.session.user.isAnonymous, false);
    assert.equal(result.session.user.email, 'promoted@example.com');

    // Nothing moved, because nothing had to.
    assert.deepEqual(result.moved, {
      watchHistory: 0,
      dramaProgress: 0,
      favorites: 0,
      playbackEvents: 0,
    });

    // And the activity is still there, under the same id.
    const history = await prisma.watchHistory.findMany({ where: { userId: guest.user.id } });
    const favorites = await prisma.favorite.findMany({ where: { userId: guest.user.id } });
    assert.equal(history.length, 1);
    assert.equal(favorites.length, 1);

    // The new password works.
    const signIn = dataOf(
      await apiRequest<AuthSession>('/auth/login', {
        method: 'POST',
        body: { email: 'promoted@example.com', password: PASSWORD },
      }),
    );
    assert.equal(signIn.user.id, guest.user.id);
  });

  it('refuses to upgrade an account that is already registered', async () => {
    const guest = await guestSession('device-cccccccc-0002');
    await apiRequest('/auth/merge', {
      method: 'POST',
      token: guest.accessToken,
      body: { email: 'first@example.com', password: PASSWORD },
    });

    const again = await apiRequest('/auth/merge', {
      method: 'POST',
      token: guest.accessToken,
      body: { email: 'second@example.com', password: PASSWORD },
    });
    assert.equal(again.status, 401, 'the old guest session was revoked by the first merge');
  });

  it('requires a session — there is no guestUserId parameter to supply', async () => {
    const response = await apiRequest('/auth/merge', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: PASSWORD },
    });
    assert.equal(response.status, 401);
  });
});

// ──────────────────────────── Upgrade: folding in ────────────────────────────

describe('guest upgrade — existing account', () => {
  /**
   * The returning-user case: they already have an account from another
   * device, and this handset has been browsing as a guest. The guest's
   * activity folds into the real account.
   */
  it('moves guest activity into the existing account', async () => {
    // An established account with its own history.
    await apiRequest('/auth/register', {
      method: 'POST',
      body: { email: 'returning@example.com', password: PASSWORD },
    });
    const owner = dataOf(
      await apiRequest<AuthSession>('/auth/login', {
        method: 'POST',
        body: { email: 'returning@example.com', password: PASSWORD },
      }),
    );
    await watchSomething(owner.accessToken, 1, 6);

    // A guest on this device watches a DIFFERENT episode.
    const guest = await guestSession('device-dddddddd-0001');
    await watchSomething(guest.accessToken, 3, 8);
    await apiRequest(`/me/favorites/${DRAMA_ID}`, { method: 'POST', token: guest.accessToken });

    const result = dataOf(
      await apiRequest<MergeResult>('/auth/merge', {
        method: 'POST',
        token: guest.accessToken,
        body: { email: 'returning@example.com', password: PASSWORD },
      }),
    );

    assert.equal(result.session.user.id, owner.user.id, 'signed in as the real account');
    assert.equal(result.moved.watchHistory, 1, 'the guest episode came across');
    assert.equal(result.moved.favorites, 1);

    const history = await prisma.watchHistory.findMany({ where: { userId: owner.user.id } });
    assert.equal(history.length, 2, 'both episodes, under one account');

    // The guest row is retired rather than dropped, so anything still
    // referencing it keeps a valid reference (DATABASE_SCHEMA.md §6).
    const retired = await prisma.user.findUnique({ where: { id: guest.user.id } });
    assert.equal(retired?.status, 'DELETED');
    assert.equal(await prisma.watchHistory.count({ where: { userId: guest.user.id } }), 0);
  });

  /**
   * THE PASSWORD IS REQUIRED. Without it, merge would be a way to sign into
   * any account by naming its address — a complete authentication bypass
   * wearing the clothes of a convenience feature.
   */
  it('refuses to fold into an account without its password', async () => {
    await apiRequest('/auth/register', {
      method: 'POST',
      body: { email: 'protected@example.com', password: PASSWORD },
    });
    const guest = await guestSession('device-dddddddd-0002');

    const response = await apiRequest('/auth/merge', {
      method: 'POST',
      token: guest.accessToken,
      body: { email: 'protected@example.com', password: 'not-the-real-password' },
    });

    assert.equal(response.status, 401);
    assert.equal(
      await prisma.watchHistory.count({ where: { userId: guest.user.id } }),
      0,
      'and nothing moved',
    );
  });

  /**
   * When both accounts have watched the same episode, the target's row wins
   * and the merge still succeeds. The naive implementation — UPDATE the
   * userId — hits a unique violation on `(userId, episodeId)` and fails the
   * whole merge, losing everything.
   */
  it('keeps the existing account’s row when both watched the same episode', async () => {
    await apiRequest('/auth/register', {
      method: 'POST',
      body: { email: 'overlap@example.com', password: PASSWORD },
    });
    const owner = dataOf(
      await apiRequest<AuthSession>('/auth/login', {
        method: 'POST',
        body: { email: 'overlap@example.com', password: PASSWORD },
      }),
    );

    const SHARED = 1;
    const GUEST_ONLY = 2;

    await watchSomething(owner.accessToken, SHARED, 25);

    const guest = await guestSession('device-dddddddd-0003');
    await watchSomething(guest.accessToken, SHARED, 5);
    await watchSomething(guest.accessToken, GUEST_ONLY, 9);

    const result = dataOf(
      await apiRequest<MergeResult>('/auth/merge', {
        method: 'POST',
        token: guest.accessToken,
        body: { email: 'overlap@example.com', password: PASSWORD },
      }),
    );

    assert.equal(result.moved.watchHistory, 1, 'only the non-conflicting episode moved');

    const rows = await prisma.watchHistory.findMany({ where: { userId: owner.user.id } });
    assert.equal(rows.length, 2);

    const sharedRow = rows.find((row) => row.episodeId === episodeId(DRAMA_ID, SHARED));
    assert.equal(
      sharedRow?.positionSec,
      25,
      "the account's own further position is not rewound by the guest's",
    );
  });
});

// ──────────────────────────── Ownership enforcement ────────────────────────────

describe('ownership', () => {
  /**
   * The structural guarantee from ADR-27, re-checked now that identity is
   * real: a service takes a `userId` from the verified caller, never from a
   * payload. The progress body carries a `dramaId` but no `userId`, so there
   * is nothing to spoof — this test proves the absence is load-bearing.
   */
  it('writes progress against the caller, not anything in the body', async () => {
    const a = await guestSession('device-eeeeeeee-0001');
    const b = await guestSession('device-eeeeeeee-0002');

    await watchSomething(a.accessToken, 1, 15);

    assert.equal(await prisma.watchHistory.count({ where: { userId: a.user.id } }), 1);
    assert.equal(
      await prisma.watchHistory.count({ where: { userId: b.user.id } }),
      0,
      "one caller's write must never land on another account",
    );
  });

  it('never returns another account’s library', async () => {
    const a = await guestSession('device-eeeeeeee-0003');
    const b = await guestSession('device-eeeeeeee-0004');

    await apiRequest(`/me/favorites/${DRAMA_ID}`, { method: 'POST', token: a.accessToken });

    const theirs = dataOf(
      await apiRequest<{ items: unknown[] }>('/me/favorites', { token: b.accessToken }),
    );
    assert.equal(theirs.items.length, 0);

    const mine = dataOf(
      await apiRequest<{ items: unknown[] }>('/me/favorites', { token: a.accessToken }),
    );
    assert.equal(mine.items.length, 1);
  });

  /**
   * Progress survives the upgrade and is readable afterwards — the end-to-end
   * version of "do not silently discard local progress during
   * authentication".
   */
  it('keeps Continue Watching across the upgrade', async () => {
    const guest = await guestSession('device-eeeeeeee-0005');
    await watchSomething(guest.accessToken, 2, 14);

    const before = dataOf(
      await apiRequest<unknown[]>('/me/continue-watching', { token: guest.accessToken }),
    );
    assert.equal(before.length, 1);

    const result = dataOf(
      await apiRequest<MergeResult>('/auth/merge', {
        method: 'POST',
        token: guest.accessToken,
        body: { email: 'continuity@example.com', password: PASSWORD },
      }),
    );

    const after = dataOf(
      await apiRequest<unknown[]>('/me/continue-watching', {
        token: result.session.accessToken,
      }),
    );
    assert.equal(after.length, 1, 'still there, under the registered account');
    assert.deepEqual(after, before);
  });
});
