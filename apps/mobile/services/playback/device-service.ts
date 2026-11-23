import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import type { PlaybackEventContext } from '@minidrama/contracts';
import type { IdSource } from './events';
import { buildPlaybackService, type PlaybackService } from './playback-service';
import { openExpoSqliteDriver } from './db/expo-driver';
import { MockPlaybackSyncAdapter, type PlaybackSyncAdapter } from './sync/adapter';
import { HttpPlaybackSyncAdapter } from './sync/http-adapter';
import { ExpoConnectivitySource } from './sync/expo-connectivity';
import { API_BASE_URL, API_MODE } from '../config';
import { session } from '../auth/session';

/**
 * The device's playback service: the one place that knows which concrete
 * implementations run on a phone.
 *
 * Everything here imports React Native or Expo and therefore cannot be loaded
 * under Node. That is exactly why it is this small — the logic lives in
 * `playback-service.ts` and the repositories, which the test suite builds the
 * same way over `node:sqlite`.
 *
 * M2.3 added the HTTP adapter. Which one runs follows `EXPO_PUBLIC_API_MODE`,
 * the same switch the catalogue uses — so mock mode is genuinely offline from
 * end to end rather than mocking the catalogue while still posting telemetry
 * at a server that may not be running.
 */

/**
 * The sync adapter for this build.
 *
 * In mock mode the outbox still fills, drains and retries exactly as it does
 * against a server — which is what keeps those paths exercised when there is
 * no backend to talk to.
 */
function chooseSyncAdapter(): PlaybackSyncAdapter {
  if (API_MODE === 'mock') return new MockPlaybackSyncAdapter();
  // The session is injected rather than imported inside the adapter so the
  // adapter stays loadable under Node for its tests. See its constructor.
  return new HttpPlaybackSyncAdapter(API_BASE_URL, () => session.getAccessToken());
}

let instance: PlaybackService | null = null;
let pending: Promise<PlaybackService> | null = null;

/**
 * UUIDv4 from the platform's secure random source.
 *
 * The event id is the server's idempotency key, so a weak generator is a
 * correctness problem and not just a tidiness one: two devices minting the
 * same id would have one viewer's event silently discarded as a duplicate of
 * another's.
 */
const expoIds: IdSource = {
  newId: () => Crypto.randomUUID(),
};

function deviceContext(): PlaybackEventContext {
  const platform: PlaybackEventContext['platform'] =
    Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';
  return {
    platform,
    // The app's own version, not the OS build or the device. Enough to
    // attribute a regression to a release; nothing that identifies anyone.
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
  };
}

/**
 * Opens the service, once.
 *
 * Concurrent callers share one in-flight promise rather than each opening a
 * database — the bootstrap hook, the recorder and the sync panel all call
 * this during the first second of app life.
 */
export async function getPlaybackService(): Promise<PlaybackService> {
  if (instance) return instance;
  if (pending) return pending;

  pending = (async () => {
    const driver = await openExpoSqliteDriver();
    const service = await buildPlaybackService({
      driver,
      adapter: chooseSyncAdapter(),
      connectivity: new ExpoConnectivitySource(),
      ids: expoIds,
      context: deviceContext(),
    });
    instance = service;
    return service;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Non-suspending read, for callers that must not await. Null before init. */
export function peekPlaybackService(): PlaybackService | null {
  return instance;
}

/** Developer reset. Closes the database and forgets the singleton. */
export async function resetPlaybackService(): Promise<void> {
  if (instance) await instance.shutdown();
  instance = null;
  pending = null;
}

/**
 * Wipes the device's playback database (M2.6 D8).
 *
 * Opens the service first when nothing has opened it yet: the SQLite file
 * survives process restarts, so "no instance in memory" does not mean "no
 * rows on disk" — and the rows on disk are exactly what a deletion has to
 * remove.
 *
 * See `PlaybackService.purge` for why this is account deletion's business
 * and nobody else's.
 */
export async function purgeLocalPlaybackData(): Promise<void> {
  const service = await getPlaybackService();
  await service.purge();
}
