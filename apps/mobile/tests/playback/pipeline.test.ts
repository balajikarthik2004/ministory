import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildPlaybackService } from '../../services/playback/playback-service';
import { SCHEMA_VERSION } from '../../services/playback/db/schema';
import { createPlaybackEvent } from '../../services/playback/events';
import { MockPlaybackSyncAdapter } from '../../services/playback/sync/adapter';
import { FakeConnectivitySource } from '../../services/playback/sync/connectivity';
import { FakeClock, NodeSqliteDriver, SequentialIds } from '../support/node-sqlite-driver';
import { TEST_CONTEXT } from '../support/fixtures';

/**
 * End-to-end over the real object graph.
 *
 * These build the service with `buildPlaybackService` — the same function the
 * app uses — so a wiring mistake in the composition root is caught here and
 * not only on a device.
 */

async function withTempDatabase<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'minidrama-pipeline-'));
  try {
    return await fn(join(dir, 'playback.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildOver(driver: NodeSqliteDriver, clock: FakeClock, adapter: MockPlaybackSyncAdapter) {
  return buildPlaybackService({
    driver,
    adapter,
    connectivity: new FakeConnectivitySource(),
    ids: new SequentialIds(),
    clock,
    context: TEST_CONTEXT,
  });
}

describe('playback pipeline — a complete session', () => {
  it('queues a full session and delivers it in order', async () => {
    const driver = new NodeSqliteDriver();
    const clock = new FakeClock();
    const adapter = new MockPlaybackSyncAdapter(0);
    const service = await buildOver(driver, clock, adapter);

    const session = 'ps_session_0001';
    const episode = {
      dramaId: 'drama_mazhai',
      episodeId: 'drama_mazhai_ep01',
      durationSec: 30,
    };

    const sequence = [
      'playback_started',
      'playback_progress',
      'playback_paused',
      'playback_resumed',
      'playback_progress',
      'playback_completed',
      'episode_changed',
    ] as const;

    for (const type of sequence) {
      await service.outbox.enqueue(
        createPlaybackEvent(
          { type, ...episode, positionSec: 5, durationSec: episode.durationSec },
          { sessionId: session, context: TEST_CONTEXT, ids: service.ids, clock },
        ),
      );
      clock.advanceSeconds(5);
    }

    const outcome = await service.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.deepEqual(
      adapter.acceptedEvents().map((event) => event.type),
      [...sequence],
    );
    // Every event in one session shares a session id, which is what makes a
    // drop-off curve computable.
    assert.equal(new Set(adapter.acceptedEvents().map((e) => e.sessionId)).size, 1);

    await service.shutdown();
  });

  it('records progress and surfaces it as Continue Watching', async () => {
    const driver = new NodeSqliteDriver();
    const clock = new FakeClock();
    const service = await buildOver(driver, clock, new MockPlaybackSyncAdapter(0));

    await service.progress.record({
      dramaId: 'drama_mazhai',
      episodeId: 'drama_mazhai_ep02',
      episodeNumber: 2,
      positionSec: 18,
      durationSec: 45,
    });

    const rail = await service.progress.continueWatching();

    assert.equal(rail.length, 1);
    assert.equal(rail[0]?.episodeNumber, 2);
    assert.equal(rail[0]?.positionSec, 18);
    await service.shutdown();
  });
});

describe('playback pipeline — offline and recovery', () => {
  it('loses nothing across an offline session, a restart, and reconnecting', async () => {
    await withTempDatabase(async (file) => {
      const clock = new FakeClock();
      const adapter = new MockPlaybackSyncAdapter(0);

      // ── Launch one: offline, watching. ──────────────────────────────
      const firstDriver = new NodeSqliteDriver(file);
      const first = await buildPlaybackService({
        driver: firstDriver,
        adapter,
        connectivity: new FakeConnectivitySource({
          isConnected: false,
          isInternetReachable: false,
        }),
        ids: new SequentialIds('a'),
        clock,
        context: TEST_CONTEXT,
      });

      for (let i = 0; i < 4; i += 1) {
        await first.outbox.enqueue(
          createPlaybackEvent(
            {
              type: 'playback_progress',
              dramaId: 'drama_mazhai',
              episodeId: 'drama_mazhai_ep01',
              positionSec: i * 5,
              durationSec: 30,
            },
            { sessionId: 'ps_offline', context: TEST_CONTEXT, ids: first.ids, clock },
          ),
        );
      }
      await first.progress.record({
        dramaId: 'drama_mazhai',
        episodeId: 'drama_mazhai_ep01',
        episodeNumber: 1,
        positionSec: 20,
        durationSec: 30,
      });

      // Draining while offline must not consume anything.
      assert.deepEqual(await first.sync.run(), { kind: 'idle', reason: 'offline' });
      // One batch gets claimed then the app dies mid-send.
      await first.outbox.claimBatch(2);
      await firstDriver.close();

      // ── Launch two: same database, now online. ──────────────────────
      const secondDriver = new NodeSqliteDriver(file);
      const connectivity = new FakeConnectivitySource();
      const second = await buildPlaybackService({
        driver: secondDriver,
        adapter,
        connectivity,
        ids: new SequentialIds('b'),
        clock,
        context: TEST_CONTEXT,
      });

      // Progress survived the restart.
      const resumed = await second.progress.episodeProgress('drama_mazhai_ep01');
      assert.equal(resumed?.positionSec, 20);

      // All four events survived, including the two left in flight.
      assert.equal((await second.outbox.counts()).pending, 4);

      const outcome = await second.sync.run();
      assert.equal(outcome.kind, 'synced');
      assert.equal(adapter.acceptedCount(), 4);
      assert.deepEqual(await second.outbox.counts(), { pending: 0, inFlight: 0, dead: 0 });

      await second.shutdown();
    });
  });

  it("keeps the viewer's furthest position when a stale queued write is replayed late", async () => {
    const driver = new NodeSqliteDriver();
    const clock = new FakeClock();
    const service = await buildOver(driver, clock, new MockPlaybackSyncAdapter(0));
    const base = clock.now();

    // What actually happened, in order.
    await service.progress.record({
      dramaId: 'd',
      episodeId: 'e',
      episodeNumber: 1,
      positionSec: 25,
      durationSec: 30,
      occurredAtMs: base + 30_000,
    });

    // An older write arriving after it, flushed from the queue on reconnect.
    await service.progress.record({
      dramaId: 'd',
      episodeId: 'e',
      episodeNumber: 1,
      positionSec: 8,
      durationSec: 30,
      occurredAtMs: base,
    });

    const stored = await service.progress.episodeProgress('e');
    assert.equal(stored?.positionSec, 25, 'the viewer is not rewound');
    await service.shutdown();
  });
});

describe('playback pipeline — migrations', () => {
  it('brings a fresh database to the current schema version', async () => {
    const driver = new NodeSqliteDriver();
    const clock = new FakeClock();
    const service = await buildOver(driver, clock, new MockPlaybackSyncAdapter(0));

    const row = await driver.get<{ user_version: number }>('PRAGMA user_version;');
    // Against the constant, not a literal: the assertion is "fully migrated",
    // and pinning a number means editing this test on every migration for no
    // added coverage.
    assert.equal(row?.user_version, SCHEMA_VERSION);
    await service.shutdown();
  });

  it('is a no-op on an already-migrated database', async () => {
    await withTempDatabase(async (file) => {
      const clock = new FakeClock();

      const firstDriver = new NodeSqliteDriver(file);
      const first = await buildOver(firstDriver, clock, new MockPlaybackSyncAdapter(0));
      await first.progress.record({
        dramaId: 'd',
        episodeId: 'e',
        episodeNumber: 1,
        positionSec: 9,
        durationSec: 30,
      });
      await firstDriver.close();

      // Second launch runs migrate() again. Data must survive.
      const secondDriver = new NodeSqliteDriver(file);
      const second = await buildOver(secondDriver, clock, new MockPlaybackSyncAdapter(0));

      assert.equal((await second.progress.episodeProgress('e'))?.positionSec, 9);
      await second.shutdown();
    });
  });

  it('stores nothing that looks like a credential', async () => {
    // CLAUDE.md §11. A rooted device can read this file; the schema is
    // asserted to carry only playback facts.
    const driver = new NodeSqliteDriver();
    const clock = new FakeClock();
    const service = await buildOver(driver, clock, new MockPlaybackSyncAdapter(0));

    const columns = await driver.all<{ name: string }>(
      `SELECT name FROM pragma_table_info('playback_event_outbox')
       UNION ALL
       SELECT name FROM pragma_table_info('watch_progress')
       UNION ALL
       SELECT name FROM pragma_table_info('drama_progress')`,
    );
    const forbidden = /token|secret|password|credential|auth|key$/i;
    const offenders = columns.map((c) => c.name).filter((name) => forbidden.test(name));

    assert.deepEqual(offenders, []);
    await service.shutdown();
  });
});
