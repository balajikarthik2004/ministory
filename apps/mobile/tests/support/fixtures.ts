import type { PlaybackEventContext } from '@minidrama/contracts';
import { createPlaybackEvent, type PlaybackEventInput } from '../../services/playback/events';
import { PlaybackOutbox } from '../../services/playback/outbox';
import { ProgressRepository } from '../../services/playback/progress-repository';
import { migrate } from '../../services/playback/db/schema';
import { FakeConnectivitySource } from '../../services/playback/sync/connectivity';
import { MockPlaybackSyncAdapter } from '../../services/playback/sync/adapter';
import { PlaybackSyncEngine } from '../../services/playback/sync/sync-engine';
import { FakeClock, NodeSqliteDriver, SequentialIds, fixedRandom } from './node-sqlite-driver';

/** Shared setup, so each test states only what it is actually about. */

export const TEST_CONTEXT: PlaybackEventContext = {
  platform: 'android',
  appVersion: '0.1.0-test',
};

export interface Harness {
  driver: NodeSqliteDriver;
  clock: FakeClock;
  ids: SequentialIds;
  outbox: PlaybackOutbox;
  progress: ProgressRepository;
  adapter: MockPlaybackSyncAdapter;
  connectivity: FakeConnectivitySource;
  sync: PlaybackSyncEngine;
  /** Builds a valid event with sensible defaults. */
  event(
    overrides?: Partial<PlaybackEventInput> & { sessionId?: string },
  ): ReturnType<typeof createPlaybackEvent>;
  close(): Promise<void>;
}

export async function createHarness(
  options: { batchSize?: number; adapterLatencyMs?: number } = {},
): Promise<Harness> {
  const driver = new NodeSqliteDriver();
  const clock = new FakeClock();
  const ids = new SequentialIds();

  await migrate(driver);

  const outbox = new PlaybackOutbox(driver, clock, fixedRandom);
  const progress = new ProgressRepository(driver, clock);
  const adapter = new MockPlaybackSyncAdapter(options.adapterLatencyMs ?? 0);
  const connectivity = new FakeConnectivitySource();
  const sync = new PlaybackSyncEngine(outbox, adapter, connectivity, {
    batchSize: options.batchSize ?? 25,
  });

  return {
    driver,
    clock,
    ids,
    outbox,
    progress,
    adapter,
    connectivity,
    sync,
    event: (overrides = {}) => {
      const { sessionId, ...input } = overrides;
      return createPlaybackEvent(
        {
          type: 'playback_progress',
          dramaId: 'drama_mazhai',
          episodeId: 'drama_mazhai_ep01',
          positionSec: 10,
          durationSec: 30,
          ...input,
        },
        {
          sessionId: sessionId ?? 'session-test-0001',
          context: TEST_CONTEXT,
          ids,
          clock,
        },
      );
    },
    close: async () => {
      sync.stop();
      await driver.close();
    },
  };
}
