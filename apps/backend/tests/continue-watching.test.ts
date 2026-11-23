import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  apiRequest,
  dataOf,
  DEV_TOKEN,
  prisma,
  resetTestData,
  startTestServer,
  stopTestServer,
  TEST_USER_ID,
} from './support/harness.js';
import { createDrama, createTestUser, episodeId, seedReferenceData } from './support/factories.js';

/**
 * Continue Watching after an episode finishes (M2.4 Issue C).
 *
 * The defect: `DramaProgress` records the furthest episode *watched*, and
 * nothing advanced past it or ever marked a drama finished. A viewer who
 * completed episode 3 of 10 saw the rail offer episode 3 at "0s left"
 * forever, and a viewer who completed the final episode kept the drama in
 * the rail permanently with nothing left to play.
 */

const DRAMA = 'drama_continue';
const EPISODES = 4;

interface ContinueItem {
  drama: { id: string };
  episodeId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
}

async function watch(episodeNumber: number, positionSec: number, durationSec = 30): Promise<void> {
  const response = await apiRequest(`/me/history/${episodeId(DRAMA, episodeNumber)}`, {
    method: 'PUT',
    token: DEV_TOKEN,
    body: {
      dramaId: DRAMA,
      episodeNumber,
      positionSec,
      durationSec,
      occurredAt: new Date().toISOString(),
    },
  });
  assert.ok(response.status < 400, `progress write failed: ${JSON.stringify(response.body)}`);
}

async function rail(): Promise<ContinueItem[]> {
  const response = await apiRequest<ContinueItem[]>('/me/continue-watching', { token: DEV_TOKEN });
  return dataOf(response);
}

describe('Continue Watching after completion', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetTestData();
    await seedReferenceData();
    await createTestUser();
    await createDrama({
      id: DRAMA,
      episodes: EPISODES,
      freeEpisodes: EPISODES,
      durations: [30, 30, 30, 30],
    });
  });

  it('offers the unfinished episode at the position reached', async () => {
    await watch(2, 12);

    const [item] = await rail();
    assert.ok(item);
    assert.equal(item.episodeNumber, 2);
    assert.equal(item.positionSec, 12);
  });

  it('advances to the next episode once the current one is finished', async () => {
    // 30 of 30 is past the 90% completion threshold.
    await watch(2, 30);

    const [item] = await rail();
    assert.ok(item, 'the drama is not finished, so it stays in the rail');
    assert.equal(item.episodeNumber, 3, 'the rail offers what to watch next, not what was watched');
    assert.equal(item.positionSec, 0, 'a fresh episode starts at zero');
    assert.equal(item.episodeId, episodeId(DRAMA, 3));
  });

  it('drops the drama entirely once the final episode is finished', async () => {
    await watch(EPISODES, 30);

    assert.deepEqual(await rail(), [], 'nothing left to continue');

    const head = await prisma.dramaProgress.findUnique({
      where: { userId_dramaId: { userId: TEST_USER_ID, dramaId: DRAMA } },
      select: { isCompleted: true },
    });
    assert.equal(head?.isCompleted, true, 'the drama is marked finished, not merely filtered');
  });

  it('preserves watch history when the drama leaves the rail', async () => {
    await watch(1, 30);
    await watch(EPISODES, 30);

    assert.deepEqual(await rail(), []);

    const history = await prisma.watchHistory.findMany({
      where: { userId: TEST_USER_ID },
      select: { episodeId: true, isCompleted: true },
      orderBy: { episodeId: 'asc' },
    });
    assert.equal(history.length, 2, 'history survives the drama dropping off');
    assert.ok(history.every((row) => row.isCompleted));
  });

  it('brings a finished drama back when a new episode is published', async () => {
    await watch(EPISODES, 30);
    assert.deepEqual(await rail(), [], 'finished');

    // A new episode lands. The viewer has something to continue again, so a
    // sticky completion flag would have stranded them here.
    await prisma.episode.create({
      data: {
        id: episodeId(DRAMA, EPISODES + 1),
        seasonId: `${DRAMA}_s1`,
        episodeNumber: EPISODES + 1,
        title: `Episode ${EPISODES + 1}`,
        durationSec: 30,
        accessType: 'FREE',
        status: 'PUBLISHED',
        publishedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });

    // Re-record the final episode; the head moves and recomputes completion.
    await watch(EPISODES, 30);

    const [item] = await rail();
    assert.ok(item, 'the drama is resumable again');
    assert.equal(item.episodeNumber, EPISODES + 1);
  });

  it('does not move the head backwards when an earlier episode is rewatched', async () => {
    await watch(3, 12);
    await watch(1, 30);

    const [item] = await rail();
    assert.ok(item);
    assert.equal(item.episodeNumber, 3, 'rewatching episode 1 does not reset the drama');
    assert.equal(item.positionSec, 12);
  });
});
