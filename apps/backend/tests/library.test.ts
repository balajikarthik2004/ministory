import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ContinueWatchingItem, DramaCard, UserProfile } from '@minidrama/contracts';
import {
  DEV_TOKEN,
  TEST_USER_ID,
  apiRequest,
  dataOf,
  prisma,
  resetTestData,
  stopTestServer,
} from './support/harness.js';
import { createDrama, createTestUser, episodeId, seedReferenceData } from './support/factories.js';

after(async () => {
  await resetTestData();
  await stopTestServer();
});

const DRAMA = 'drama_lib';
const EP1 = episodeId(DRAMA, 1); // 30s
const EP2 = episodeId(DRAMA, 2); // 45s
const EP3 = episodeId(DRAMA, 3); // 20s

interface ProgressResult {
  positionSec: number;
  isCompleted: boolean;
  applied: boolean;
}

async function putProgress(
  episode: string,
  body: Record<string, unknown>,
  token: string | null = DEV_TOKEN,
) {
  return apiRequest<ProgressResult>(`/me/history/${episode}`, {
    method: 'PUT',
    body,
    token,
  });
}

describe('library API', () => {
  before(async () => {
    await resetTestData();
    await seedReferenceData();
    await createTestUser();
    await createDrama({ id: DRAMA, slug: 'lib-drama', episodes: 4, freeEpisodes: 4 });
    await createDrama({ id: 'drama_other', slug: 'other-lib', episodes: 2 });
  });

  beforeEach(async () => {
    await prisma.dramaProgress.deleteMany();
    await prisma.watchHistory.deleteMany();
    await prisma.favorite.deleteMany();
    await prisma.drama.updateMany({ data: { favoriteCount: 0 } });
  });

  describe('authentication boundary', () => {
    const protectedRoutes: Array<[string, string]> = [
      ['GET', '/me/profile'],
      ['GET', '/me/continue-watching'],
      ['GET', '/me/history'],
      ['GET', '/me/favorites'],
      ['POST', `/me/favorites/${DRAMA}`],
      ['DELETE', `/me/favorites/${DRAMA}`],
      ['PUT', `/me/history/${EP1}`],
    ];

    for (const [method, path] of protectedRoutes) {
      it(`401s ${method} ${path} without a credential`, async () => {
        // `fetch` refuses a GET carrying a body, so only the mutating
        // methods get one.
        const response = await apiRequest(path, {
          method,
          token: null,
          ...(method === 'GET' ? {} : { body: {} }),
        });
        assert.equal(response.status, 401);
      });
    }

    it('401s a wrong token rather than treating it as anonymous', async () => {
      // A presented-and-wrong credential is an error; an absent one is a
      // guest. Collapsing the two would make a typo look like a sign-out.
      const response = await apiRequest('/me/profile', { token: 'not-the-token' });
      assert.equal(response.status, 401);
    });

    it('serves the catalogue without a credential', async () => {
      const response = await apiRequest('/dramas');
      assert.equal(response.status, 200);
    });
  });

  describe('favourites', () => {
    it('adds a favourite', async () => {
      const result = dataOf<{ isFavorited: boolean }>(
        await apiRequest(`/me/favorites/${DRAMA}`, { method: 'POST', token: DEV_TOKEN }),
      );
      assert.equal(result.isFavorited, true);
      assert.equal(await prisma.favorite.count(), 1);
    });

    it('is idempotent on repeated adds', async () => {
      for (let i = 0; i < 3; i += 1) {
        const response = await apiRequest(`/me/favorites/${DRAMA}`, {
          method: 'POST',
          token: DEV_TOKEN,
        });
        assert.equal(response.status, 200, 'a repeat is success, not a conflict');
      }
      assert.equal(await prisma.favorite.count(), 1);
    });

    it('is idempotent on repeated removes', async () => {
      await apiRequest(`/me/favorites/${DRAMA}`, { method: 'POST', token: DEV_TOKEN });
      for (let i = 0; i < 3; i += 1) {
        const response = await apiRequest(`/me/favorites/${DRAMA}`, {
          method: 'DELETE',
          token: DEV_TOKEN,
        });
        assert.equal(response.status, 200);
      }
      assert.equal(await prisma.favorite.count(), 0);
    });

    it('keeps the denormalised counter correct across repeats', async () => {
      // The counter is what the catalogue reads; drifting it is invisible
      // until a popularity sort looks wrong weeks later.
      for (let i = 0; i < 3; i += 1) {
        await apiRequest(`/me/favorites/${DRAMA}`, { method: 'POST', token: DEV_TOKEN });
      }
      let drama = await prisma.drama.findUnique({ where: { id: DRAMA } });
      assert.equal(drama?.favoriteCount, 1);

      for (let i = 0; i < 3; i += 1) {
        await apiRequest(`/me/favorites/${DRAMA}`, { method: 'DELETE', token: DEV_TOKEN });
      }
      drama = await prisma.drama.findUnique({ where: { id: DRAMA } });
      assert.equal(drama?.favoriteCount, 0);
    });

    it('reflects the favourite in the catalogue for that caller only', async () => {
      await apiRequest(`/me/favorites/${DRAMA}`, { method: 'POST', token: DEV_TOKEN });

      const asCaller = dataOf<{ isFavorited: boolean }>(
        await apiRequest('/dramas/lib-drama', { token: DEV_TOKEN }),
      );
      const asGuest = dataOf<{ isFavorited: boolean }>(await apiRequest('/dramas/lib-drama'));

      assert.equal(asCaller.isFavorited, true);
      assert.equal(asGuest.isFavorited, false);
    });

    it('lists favourites', async () => {
      await apiRequest(`/me/favorites/${DRAMA}`, { method: 'POST', token: DEV_TOKEN });
      const page = dataOf<{ items: DramaCard[] }>(
        await apiRequest('/me/favorites', { token: DEV_TOKEN }),
      );
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.isFavorited, true);
    });
  });

  describe('progress — the monotonic rule', () => {
    const body = (positionSec: number, occurredAt?: string, episodeNumber = 1) => ({
      dramaId: DRAMA,
      episodeNumber,
      positionSec,
      durationSec: 30,
      ...(occurredAt ? { occurredAt } : {}),
    });

    it('records a position', async () => {
      const result = dataOf(await putProgress(EP1, body(12)));
      assert.equal(result.positionSec, 12);
      assert.equal(result.isCompleted, false);
      assert.equal(result.applied, true);
    });

    it('never moves a stored position backwards', async () => {
      await putProgress(EP1, body(25, '2026-11-16T10:00:00.000Z'));
      const result = dataOf(await putProgress(EP1, body(5, '2026-11-16T10:01:00.000Z')));

      assert.equal(result.positionSec, 25, 'the maximum wins');
    });

    it('reports a stale write as not applied', async () => {
      await putProgress(EP1, body(25, '2026-11-16T10:00:00.000Z'));
      const result = dataOf(await putProgress(EP1, body(10, '2026-11-16T09:00:00.000Z')));

      assert.equal(result.applied, false);
      assert.equal(result.positionSec, 25);
    });

    it('marks an episode complete at 90% (PRD HIST-03)', async () => {
      const justUnder = dataOf(await putProgress(EP1, body(26)));
      assert.equal(justUnder.isCompleted, false, '26/30 is under 90%');

      const justOver = dataOf(await putProgress(EP1, body(27)));
      assert.equal(justOver.isCompleted, true, '27/30 is exactly 90%');
    });

    it('keeps completion sticky when the viewer rewatches', async () => {
      await putProgress(EP1, body(30));
      const result = dataOf(await putProgress(EP1, body(0)));
      assert.equal(result.isCompleted, true);
    });

    it('uses the catalogue duration, not the one the client claims', async () => {
      // A client reporting a huge duration would otherwise make the
      // completion threshold unreachable.
      const result = dataOf(await putProgress(EP1, { ...body(29), durationSec: 100_000 }));
      assert.equal(result.isCompleted, true, 'measured against the real 30s episode');
    });

    it('clamps a position past the end of the episode', async () => {
      const result = dataOf(await putProgress(EP1, body(99_999)));
      assert.equal(result.positionSec, 30);
    });

    it('rejects an episode that does not belong to the claimed drama', async () => {
      const response = await putProgress(EP1, { ...body(5), dramaId: 'drama_other' });
      assert.equal(response.status, 400);
    });

    it('404s an unknown episode', async () => {
      const response = await putProgress('no_such_episode', body(5));
      assert.equal(response.status, 404);
    });

    it('rejects a negative position', async () => {
      const response = await putProgress(EP1, body(-5));
      assert.equal(response.status, 400);
    });
  });

  describe('progress — the drama head', () => {
    const at = (episodeNumber: number, positionSec: number, minute: number) => ({
      dramaId: DRAMA,
      episodeNumber,
      positionSec,
      durationSec: 45,
      occurredAt: `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`,
    });

    it('advances to a later episode', async () => {
      await putProgress(EP1, at(1, 10, 0));
      await putProgress(EP2, at(2, 5, 1));

      const head = await prisma.dramaProgress.findUnique({
        where: { userId_dramaId: { userId: TEST_USER_ID, dramaId: DRAMA } },
      });
      assert.equal(head?.lastEpisodeId, EP2);
    });

    it('does not move back when an earlier episode is rewatched', async () => {
      await putProgress(EP3, at(3, 10, 0));
      await putProgress(EP1, at(1, 8, 1));

      const head = await prisma.dramaProgress.findUnique({
        where: { userId_dramaId: { userId: TEST_USER_ID, dramaId: DRAMA } },
      });
      assert.equal(head?.lastEpisodeId, EP3, 'the drama still resumes at episode 3');

      // The rewatched episode's own position is still recorded.
      const history = await prisma.watchHistory.findUnique({
        where: { userId_episodeId: { userId: TEST_USER_ID, episodeId: EP1 } },
      });
      assert.equal(history?.positionSec, 8);
    });

    it('surfaces the head as Continue Watching', async () => {
      await putProgress(EP2, at(2, 18, 0));

      const items = dataOf<ContinueWatchingItem[]>(
        await apiRequest('/me/continue-watching', { token: DEV_TOKEN }),
      );
      assert.equal(items.length, 1);
      assert.equal(items[0]?.episodeNumber, 2);
      assert.equal(items[0]?.positionSec, 18);
      assert.equal(items[0]?.durationSec, 45, "the episode's real duration");
    });

    it('returns nothing for a guest', async () => {
      await putProgress(EP2, at(2, 18, 0));
      const response = await apiRequest('/me/continue-watching', { token: null });
      assert.equal(response.status, 401);
    });
  });

  describe('history', () => {
    it('lists watched episodes newest first', async () => {
      await putProgress(EP1, {
        dramaId: DRAMA,
        episodeNumber: 1,
        positionSec: 10,
        durationSec: 30,
        occurredAt: '2026-11-16T10:00:00.000Z',
      });
      await putProgress(EP2, {
        dramaId: DRAMA,
        episodeNumber: 2,
        positionSec: 10,
        durationSec: 45,
        occurredAt: '2026-11-16T11:00:00.000Z',
      });

      const page = dataOf<{ items: Array<{ episodeNumber: number }> }>(
        await apiRequest('/me/history', { token: DEV_TOKEN }),
      );
      assert.deepEqual(
        page.items.map((item) => item.episodeNumber),
        [2, 1],
      );
    });

    it('merges watch state into the episode list', async () => {
      await putProgress(EP1, {
        dramaId: DRAMA,
        episodeNumber: 1,
        positionSec: 12,
        durationSec: 30,
      });

      const page = dataOf<{ items: Array<{ watchState: { positionSec: number } | null }> }>(
        await apiRequest(`/dramas/${DRAMA}/episodes`, { token: DEV_TOKEN }),
      );
      assert.equal(page.items[0]?.watchState?.positionSec, 12);
      assert.equal(page.items[1]?.watchState, null);
    });
  });

  describe('profile', () => {
    it("returns the caller's own profile", async () => {
      const profile = dataOf<UserProfile>(await apiRequest('/me/profile', { token: DEV_TOKEN }));
      assert.equal(profile.id, TEST_USER_ID);
      assert.equal(profile.subscriptionStatus, 'NONE', 'monetisation is M7');
    });
  });
});
