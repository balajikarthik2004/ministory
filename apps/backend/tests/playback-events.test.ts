import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEV_TOKEN,
  apiRequest,
  dataOf,
  prisma,
  resetTestData,
  stopTestServer,
} from './support/harness.js';
import {
  createDrama,
  createTestUser,
  episodeId,
  playbackEvent,
  seedReferenceData,
} from './support/factories.js';

after(async () => {
  await resetTestData();
  await stopTestServer();
});

interface Ack {
  acceptedEventIds: string[];
}

const EP1 = episodeId('drama_test', 1);
const EP2 = episodeId('drama_test', 2);

async function post(events: unknown[], token: string | null = DEV_TOKEN) {
  return apiRequest<Ack>('/playback/events', { method: 'POST', body: { events }, token });
}

describe('playback event ingestion', () => {
  before(async () => {
    await resetTestData();
    await seedReferenceData();
    await createTestUser();
    await createDrama({ id: 'drama_test', slug: 'test-drama', episodes: 3, freeEpisodes: 2 });
    await createDrama({ id: 'drama_other', slug: 'other-drama', episodes: 2 });
    await createDrama({ id: 'drama_hidden', slug: 'hidden-drama', status: 'DRAFT', episodes: 2 });
  });

  beforeEach(async () => {
    await prisma.playbackEvent.deleteMany();
  });

  describe('storage', () => {
    it('stores a batch and names every accepted id', async () => {
      const events = [
        playbackEvent({ eventId: 'evt-test-e-001', type: 'playback_started' }),
        playbackEvent({ eventId: 'evt-test-e-002', type: 'playback_progress', positionSec: 15 }),
      ];

      const response = await post(events);
      assert.equal(response.status, 202);
      assert.deepEqual(dataOf(response).acceptedEventIds.sort(), [
        'evt-test-e-001',
        'evt-test-e-002',
      ]);
      assert.equal(await prisma.playbackEvent.count(), 2);
    });

    it('stores every event type the contract defines', async () => {
      const types = [
        'playback_started',
        'playback_paused',
        'playback_resumed',
        'playback_progress',
        'playback_completed',
        'playback_failed',
        'episode_changed',
        'playback_abandoned',
      ] as const;

      await post(
        types.map((type, index) =>
          playbackEvent({
            eventId: `evt-test-type-${index}`,
            type,
            ...(type === 'playback_failed' ? { errorCode: 'network' } : {}),
          }),
        ),
      );

      const stored = await prisma.playbackEvent.findMany({ select: { type: true } });
      assert.deepEqual(stored.map((row) => row.type).sort(), [...types].sort());
    });

    it('records the client occurredAt and its own receivedAt', async () => {
      const occurredAt = '2026-11-16T08:00:00.000Z';
      await post([playbackEvent({ eventId: 'evt-test-e-time', occurredAt })]);

      const row = await prisma.playbackEvent.findUnique({ where: { eventId: 'evt-test-e-time' } });
      assert.ok(row);
      assert.equal(row.occurredAt.toISOString(), occurredAt);
      // Server time, not the client's. The device clock is not trusted for
      // ordering, so the two must be independent values.
      assert.notEqual(row.receivedAt.toISOString(), occurredAt);
      assert.ok(row.receivedAt.getTime() > row.occurredAt.getTime());
    });

    it('accepts a device clock set far in the future without using it as receipt time', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await post([playbackEvent({ eventId: 'evt-test-e-future', occurredAt: future })]);

      const row = await prisma.playbackEvent.findUnique({
        where: { eventId: 'evt-test-e-future' },
      });
      assert.ok(row);
      assert.ok(row.receivedAt.getTime() < row.occurredAt.getTime(), 'occurredAt is kept as sent');
      assert.ok(row.receivedAt.getTime() <= Date.now() + 1000, 'receivedAt is server-now');
    });
  });

  describe('idempotency', () => {
    it('does not duplicate on an exact retry', async () => {
      const events = [
        playbackEvent({ eventId: 'evt-test-dup-1' }),
        playbackEvent({ eventId: 'evt-test-dup-2' }),
      ];

      await post(events);
      const second = await post(events);

      assert.equal(second.status, 202);
      assert.deepEqual(dataOf(second).acceptedEventIds.sort(), [
        'evt-test-dup-1',
        'evt-test-dup-2',
      ]);
      assert.equal(await prisma.playbackEvent.count(), 2, 'no second copy was written');
    });

    it('acknowledges an already-stored event rather than refusing it', async () => {
      // Refusing would strand the row in the client's outbox, retried until
      // it died, for an event we already hold.
      await post([playbackEvent({ eventId: 'evt-test-known' })]);
      const again = await post([playbackEvent({ eventId: 'evt-test-known', positionSec: 99 })]);

      assert.deepEqual(dataOf(again).acceptedEventIds, ['evt-test-known']);
      const row = await prisma.playbackEvent.findUnique({ where: { eventId: 'evt-test-known' } });
      assert.equal(row?.positionSec, 0, 'the first write wins; a retry does not overwrite');
    });

    it('handles a batch that mixes new and already-stored events', async () => {
      await post([playbackEvent({ eventId: 'evt-test-mix-1' })]);

      const response = await post([
        playbackEvent({ eventId: 'evt-test-mix-1' }),
        playbackEvent({ eventId: 'evt-test-mix-2' }),
      ]);

      assert.deepEqual(dataOf(response).acceptedEventIds.sort(), [
        'evt-test-mix-1',
        'evt-test-mix-2',
      ]);
      assert.equal(await prisma.playbackEvent.count(), 2);
    });

    it('survives two concurrent deliveries of the same batch', async () => {
      const events = [
        playbackEvent({ eventId: 'evt-test-race-1' }),
        playbackEvent({ eventId: 'evt-test-race-2' }),
      ];

      const [a, b] = await Promise.all([post(events), post(events)]);

      assert.equal(a.status, 202);
      assert.equal(b.status, 202);
      assert.equal(await prisma.playbackEvent.count(), 2);
    });
  });

  describe('partial acceptance', () => {
    it('stores the good events in a batch containing a malformed one', async () => {
      const response = await post([
        playbackEvent({ eventId: 'evt-test-good-1' }),
        { eventId: 'evt-test-bad-1', nonsense: true },
        playbackEvent({ eventId: 'evt-test-good-2' }),
      ]);

      assert.equal(response.status, 202);
      assert.deepEqual(dataOf(response).acceptedEventIds.sort(), [
        'evt-test-good-1',
        'evt-test-good-2',
      ]);
      assert.equal(await prisma.playbackEvent.count(), 2);
    });

    it('does not acknowledge a malformed event', async () => {
      const response = await post([{ eventId: 'evt-test-bad-only', nonsense: true }]);
      assert.deepEqual(dataOf(response).acceptedEventIds, []);
      assert.equal(await prisma.playbackEvent.count(), 0);
    });

    it('does not acknowledge an event naming an unknown episode', async () => {
      const response = await post([
        playbackEvent({ eventId: 'evt-test-ok-1' }),
        playbackEvent({ eventId: 'evt-test-ghost', episodeId: 'does_not_exist' }),
      ]);

      assert.deepEqual(dataOf(response).acceptedEventIds, ['evt-test-ok-1']);
    });

    it('does not acknowledge an event for an unpublished episode', async () => {
      const response = await post([
        playbackEvent({ eventId: 'evt-test-hidden', episodeId: episodeId('drama_hidden', 1) }),
      ]);
      assert.deepEqual(dataOf(response).acceptedEventIds, []);
    });

    it('returns an empty acknowledgement, not an error, when nothing is storable', async () => {
      // The client must be able to act on this: an error would be retried
      // forever, an empty acknowledgement lets the rows age out to dead.
      const response = await post([{ garbage: true }, { more: 'garbage' }]);
      assert.equal(response.status, 202);
      assert.deepEqual(dataOf(response).acceptedEventIds, []);
    });
  });

  describe('ownership and trust', () => {
    it('attributes events to the authenticated caller', async () => {
      await post([playbackEvent({ eventId: 'evt-test-owned' })]);
      const row = await prisma.playbackEvent.findUnique({ where: { eventId: 'evt-test-owned' } });
      assert.equal(row?.userId, 'user_test_harness');
    });

    it('stores a guest batch with a null user', async () => {
      // Guest telemetry is most of the funnel. Requiring auth would discard it.
      const response = await post([playbackEvent({ eventId: 'evt-test-guest' })], null);
      assert.equal(response.status, 202);

      const row = await prisma.playbackEvent.findUnique({ where: { eventId: 'evt-test-guest' } });
      assert.equal(row?.userId, null);
    });

    it('ignores a userId supplied in the payload', async () => {
      await post([playbackEvent({ eventId: 'evt-test-claim', userId: 'somebody_else' })]);
      const row = await prisma.playbackEvent.findUnique({ where: { eventId: 'evt-test-claim' } });
      assert.equal(row?.userId, 'user_test_harness', 'the caller, not the claim');
    });

    it('corrects a dramaId that does not own the episode', async () => {
      await post([
        playbackEvent({ eventId: 'evt-test-wrong-drama', episodeId: EP1, dramaId: 'drama_other' }),
      ]);

      const row = await prisma.playbackEvent.findUnique({
        where: { eventId: 'evt-test-wrong-drama' },
      });
      assert.equal(row?.dramaId, 'drama_test', 'taken from the episode, not the payload');
    });
  });

  describe('limits and malformed requests', () => {
    it('rejects an empty batch', async () => {
      const response = await post([]);
      assert.equal(response.status, 400);
    });

    it('rejects a batch above the server cap', async () => {
      const events = Array.from({ length: 101 }, (_, index) =>
        playbackEvent({ eventId: `evt-test-bulk-${index}` }),
      );
      const response = await post(events);
      assert.equal(response.status, 400);
      assert.equal(await prisma.playbackEvent.count(), 0, 'nothing is written on rejection');
    });

    it('accepts a batch at exactly the cap', async () => {
      const events = Array.from({ length: 100 }, (_, index) =>
        playbackEvent({ eventId: `evt-test-cap-${index}` }),
      );
      const response = await post(events);
      assert.equal(response.status, 202);
      assert.equal(await prisma.playbackEvent.count(), 100);
    });

    it('rejects a body with no events field', async () => {
      const response = await apiRequest('/playback/events', {
        method: 'POST',
        body: { nope: true },
        token: DEV_TOKEN,
      });
      assert.equal(response.status, 400);
    });

    it('rejects a body that is not an object', async () => {
      const response = await apiRequest('/playback/events', {
        method: 'POST',
        body: 'a string',
        token: DEV_TOKEN,
      });
      assert.equal(response.status, 400);
    });

    it('never echoes a rejected payload back to the caller', async () => {
      const response = await post([{ eventId: 'evt-test-leak', secret: 'do-not-echo' }]);
      assert.equal(JSON.stringify(response.body).includes('do-not-echo'), false);
    });
  });

  describe('session grouping', () => {
    it('keeps every event of a session under one id', async () => {
      await post([
        playbackEvent({ eventId: 'evt-test-s-1', sessionId: 'ps_session_abc', episodeId: EP1 }),
        playbackEvent({ eventId: 'evt-test-s-2', sessionId: 'ps_session_abc', episodeId: EP2 }),
        playbackEvent({ eventId: 'evt-test-s-3', sessionId: 'ps_session_xyz', episodeId: EP1 }),
      ]);

      assert.equal(await prisma.playbackEvent.count({ where: { sessionId: 'ps_session_abc' } }), 2);
      assert.equal(await prisma.playbackEvent.count({ where: { sessionId: 'ps_session_xyz' } }), 1);
    });
  });
});
