import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  prisma,
  resetTestData,
  startTestServer,
  stopTestServer,
  TEST_USER_ID,
} from './support/harness.js';
import { createDrama, createTestUser, episodeId, seedReferenceData } from './support/factories.js';

/**
 * The 90-day retention sweep.
 *
 * ALWAYS AGAINST `minidrama_test`. The harness refuses to connect anywhere
 * else and re-checks with `SELECT current_database()` after connecting, which
 * matters more here than anywhere: this is the one suite whose entire purpose
 * is deleting rows, and the brief is explicit that it must never run against
 * the development database.
 *
 * `receivedAt` is database-generated (`@default(now())`), so placing rows on
 * either side of the boundary needs an explicit update after insert — the
 * tests below do that rather than trusting an insert-time value.
 */

const DRAMA = 'drama_retention';

async function seedCatalogue(): Promise<void> {
  await seedReferenceData();
  await createTestUser();
  await createDrama({ id: DRAMA, episodes: 3, freeEpisodes: 3 });
}

/** Inserts one event and forces its `receivedAt`. */
async function eventReceivedAt(eventId: string, receivedAt: Date): Promise<void> {
  await prisma.playbackEvent.create({
    data: {
      eventId,
      sessionId: 'ps_retention_suite',
      userId: TEST_USER_ID,
      dramaId: DRAMA,
      episodeId: episodeId(DRAMA, 1),
      type: 'playback_started',
      positionSec: 0,
      durationSec: 30,
      occurredAt: receivedAt,
      platform: 'android',
      appVersion: '0.1.0-test',
    },
  });
  await prisma.playbackEvent.update({ where: { eventId }, data: { receivedAt } });
}

function daysAgo(days: number, fromMs = Date.now()): Date {
  return new Date(fromMs - days * 24 * 60 * 60 * 1000);
}

describe('playback event retention', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetTestData();
    await seedCatalogue();
  });

  describe('the boundary', () => {
    it('deletes events older than the window and keeps the rest', async () => {
      const { purgeExpiredPlaybackEvents } =
        await import('../src/modules/playback/playback.retention.js');

      await eventReceivedAt('evt-retention-ancient', daysAgo(365));
      await eventReceivedAt('evt-retention-old', daysAgo(120));
      await eventReceivedAt('evt-retention-recent', daysAgo(30));
      await eventReceivedAt('evt-retention-today', daysAgo(0));

      const result = await purgeExpiredPlaybackEvents({ retentionDays: 90 });

      assert.equal(result.deleted, 2, 'only the two beyond 90 days');

      const survivors = (
        await prisma.playbackEvent.findMany({
          select: { eventId: true },
          orderBy: { eventId: 'asc' },
        })
      ).map((row) => row.eventId);
      assert.deepEqual(survivors, ['evt-retention-recent', 'evt-retention-today']);
    });

    it('keeps an event one hour inside the boundary and drops one an hour outside', async () => {
      const { purgeExpiredPlaybackEvents } =
        await import('../src/modules/playback/playback.retention.js');

      const now = Date.now();
      const hour = 60 * 60 * 1000;
      const boundary = now - 90 * 24 * hour;

      await eventReceivedAt('evt-retention-inside', new Date(boundary + hour));
      await eventReceivedAt('evt-retention-outside', new Date(boundary - hour));

      await purgeExpiredPlaybackEvents({ retentionDays: 90, now: new Date(now) });

      const survivors = await prisma.playbackEvent.findMany({ select: { eventId: true } });
      assert.deepEqual(
        survivors.map((row) => row.eventId),
        ['evt-retention-inside'],
        'the boundary is exclusive on the old side only',
      );
    });

    it('never touches recent events, even when everything else expires', async () => {
      const { purgeExpiredPlaybackEvents } =
        await import('../src/modules/playback/playback.retention.js');

      for (let index = 0; index < 5; index += 1) {
        await eventReceivedAt(`evt-retention-fresh-${index}`, daysAgo(index));
      }

      const result = await purgeExpiredPlaybackEvents({ retentionDays: 90 });

      assert.equal(result.deleted, 0);
      assert.equal(await prisma.playbackEvent.count(), 5);
    });
  });

  describe('idempotency and batching', () => {
    it('is safe to rerun — the second sweep finds nothing', async () => {
      const { purgeExpiredPlaybackEvents } =
        await import('../src/modules/playback/playback.retention.js');

      await eventReceivedAt('evt-retention-rerun-a', daysAgo(200));
      await eventReceivedAt('evt-retention-rerun-b', daysAgo(200));

      const first = await purgeExpiredPlaybackEvents({ retentionDays: 90 });
      const second = await purgeExpiredPlaybackEvents({ retentionDays: 90 });

      assert.equal(first.deleted, 2);
      assert.equal(second.deleted, 0, 'a rerun is a no-op, not a double-delete or an error');
      assert.equal(await prisma.playbackEvent.count(), 0);
    });

    it('deletes in bounded batches rather than one statement', async () => {
      const { purgeExpiredPlaybackEvents } =
        await import('../src/modules/playback/playback.retention.js');

      for (let index = 0; index < 10; index += 1) {
        await eventReceivedAt(`evt-retention-batch-${index}`, daysAgo(200));
      }

      // A batch size below the row count forces more than one round.
      const result = await purgeExpiredPlaybackEvents({ retentionDays: 90, batchSize: 3 });

      assert.equal(result.deleted, 10);
      assert.ok(result.batches > 1, `expected several batches, got ${result.batches}`);
      assert.equal(result.reachedLimit, false);
      assert.equal(await prisma.playbackEvent.count(), 0);
    });

    it('reports the cutoff it used, so an operator can check it', async () => {
      const { purgeExpiredPlaybackEvents, cutoffFor } =
        await import('../src/modules/playback/playback.retention.js');

      const now = new Date('2026-06-01T00:00:00.000Z');
      const result = await purgeExpiredPlaybackEvents({ retentionDays: 90, now });

      assert.equal(result.cutoff.toISOString(), cutoffFor(90, now).toISOString());
      assert.equal(result.cutoff.toISOString(), '2026-03-03T00:00:00.000Z');
    });
  });
});
