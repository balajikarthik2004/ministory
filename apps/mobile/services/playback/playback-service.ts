import type { PlaybackEventContext } from '@minidrama/contracts';
import { systemClock, type Clock, type SqliteDriver } from './db/driver';
import { dropAll, migrate } from './db/schema';
import { PlaybackOutbox } from './outbox';
import { ProgressRepository } from './progress-repository';
import { ProgressHeartbeat, type IdSource } from './events';
import type { PlaybackSyncAdapter } from './sync/adapter';
import type { ConnectivitySource } from './sync/connectivity';
import { PlaybackSyncEngine } from './sync/sync-engine';

/**
 * The playback pipeline's object graph, assembled from injected parts.
 *
 * DELIBERATELY FREE OF REACT NATIVE AND EXPO IMPORTS. The device wiring —
 * `expo-sqlite`, `expo-network`, `expo-crypto`, `Platform` — lives in
 * `device-service.ts`. Keeping them apart is what lets the tests build this
 * exact graph under Node over `node:sqlite` and a fake network.
 *
 * An earlier version had both in one file, and the test suite could not load
 * it: importing `react-native` from Node fails on the first line. That was a
 * useful failure, because a composition root that cannot be constructed
 * outside a device is one that can only be verified on a device.
 */

export interface PlaybackService {
  readonly outbox: PlaybackOutbox;
  readonly progress: ProgressRepository;
  readonly sync: PlaybackSyncEngine;
  readonly adapter: PlaybackSyncAdapter;
  readonly connectivity: ConnectivitySource;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly context: PlaybackEventContext;
  newHeartbeat(): ProgressHeartbeat;
  /**
   * Destroys every local row — the outbox and both progress tables — and
   * leaves the database open and empty (M2.6 D8).
   *
   * THE ONLY LEGITIMATE CALLER IS ACCOUNT DELETION, and it is the one case
   * where losing undelivered events is the correct outcome rather than data
   * loss. After deletion those events belong to an account that no longer
   * exists: the server answers them with a 401, which
   * `HttpPlaybackSyncAdapter` classifies as non-retryable, so they would burn
   * eight attempts and sit in `dead` forever while still describing what
   * somebody watched.
   *
   * DELIBERATELY NOT WHAT SIGN-OUT DOES. `applyAccountChange()` preserves
   * this database on purpose, because a guest upgrading in place has
   * `pending_sync` rows that must survive the sign-in. That rule is
   * unchanged; this is the one path that overrides it.
   */
  purge(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BuildPlaybackServiceOptions {
  driver: SqliteDriver;
  adapter: PlaybackSyncAdapter;
  connectivity: ConnectivitySource;
  ids: IdSource;
  clock?: Clock;
  context: PlaybackEventContext;
}

/**
 * Migrates the database and wires everything together.
 *
 * Also starts the sync engine, which recovers any rows a previous process
 * left mid-send before it begins watching connectivity.
 */
export async function buildPlaybackService(
  options: BuildPlaybackServiceOptions,
): Promise<PlaybackService> {
  const clock = options.clock ?? systemClock;

  await migrate(options.driver);

  const outbox = new PlaybackOutbox(options.driver, clock);
  const progress = new ProgressRepository(options.driver, clock);
  const sync = new PlaybackSyncEngine(outbox, options.adapter, options.connectivity);

  await sync.start();

  return {
    outbox,
    progress,
    sync,
    adapter: options.adapter,
    connectivity: options.connectivity,
    ids: options.ids,
    clock,
    context: options.context,
    newHeartbeat: () => new ProgressHeartbeat(clock),
    /*
     * ORDER MATTERS AND IS NOT ARBITRARY.
     *
     * The engine is stopped FIRST. It drains on a connectivity change, so
     * leaving it running means a batch can be picked up between the drop and
     * the re-migrate — against a dead credential, into tables that are about
     * to vanish underneath it.
     *
     * It is restarted LAST, because the app keeps running after a deletion:
     * the viewer lands back on Home as a fresh guest, and the very next thing
     * they do produces progress that needs somewhere to go.
     */
    purge: async () => {
      sync.stop();
      await dropAll(options.driver);
      await migrate(options.driver);
      await sync.start();
    },
    shutdown: async () => {
      sync.stop();
      await options.driver.close();
    },
  };
}
