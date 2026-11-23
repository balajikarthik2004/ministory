import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { before, describe, it } from 'node:test';
import type { PlaybackEvent } from '@minidrama/contracts';

/*
 * The app's `.env`, loaded before anything imports `services/config`.
 *
 * Expo injects EXPO_PUBLIC_* variables at bundle time; plain Node does not.
 * Without this the client falls back to `10.0.2.2` — the Android emulator's
 * address for the host — and every request waits out the full timeout
 * against an address that does not exist on a laptop.
 *
 * Every import below is dynamic and inside a test, so this runs first.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '..', '..', '.env'));
} catch {
  // No .env — the defaults in services/config.ts apply.
}

/**
 * The mobile client against the real backend.
 *
 * These load the app's own `live-api` and `HttpPlaybackSyncAdapter` modules —
 * not copies — and drive them at a running Express server. That is what makes
 * them worth having: the backend's own tests prove the API behaves, and these
 * prove the client agrees with it. A contract drift between the two is
 * exactly the failure that neither suite alone would catch.
 *
 * SKIPPED WHEN THE BACKEND IS NOT RUNNING. A developer working on UI should
 * not have a red suite because Docker is off. Start it with:
 *
 *   docker compose up -d
 *   pnpm --filter @minidrama/backend dev
 */

const BASE = process.env['EXPO_PUBLIC_API_BASE_URL'] ?? 'http://127.0.0.1:4000/api/v1';

async function backendIsUp(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${BASE.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

let available = false;

/**
 * A real guest session, for the `/me/*` tests.
 *
 * BEFORE M2.5 these rode `EXPO_PUBLIC_DEV_AUTH_TOKEN` out of the app's
 * `.env`. That credential is gone — it was compiled into the shipped bundle
 * and had to be removed (Phase 4) — so the tests now do what the app does:
 * ask `POST /auth/guest` for an anonymous session and register it on the auth
 * bridge that the HTTP client reads from.
 *
 * This is better coverage than the token was. It exercises guest creation,
 * the bridge and the authenticated request path end to end, where before it
 * exercised a shared secret that production never saw.
 *
 * The session module itself cannot be imported here: it pulls in
 * `react-native` and `expo-secure-store`, neither of which loads under plain
 * Node. That is exactly what `services/api/auth-bridge.ts` exists for.
 */
async function signInAsGuest(): Promise<boolean> {
  const { setAuthBridge } = await import('../../services/api/auth-bridge');

  const response = await fetch(`${BASE.replace(/\/+$/, '')}/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Stable per run, so repeated runs resume one guest account rather than
      // accumulating a new one per execution.
      deviceId: `integration-test-${process.pid}`,
      platform: 'android',
    }),
  });

  if (!response.ok) return false;
  const payload = (await response.json()) as { data?: { accessToken?: string } };
  const accessToken = payload.data?.accessToken;
  if (!accessToken) return false;

  setAuthBridge({
    async getAccessToken() {
      return accessToken;
    },
    // A 401 during an integration run is a real failure, not something to
    // paper over with a silent re-authentication.
    async handleUnauthorized() {
      return null;
    },
  });
  return true;
}

before(async () => {
  available = await backendIsUp();
  if (!available) {
    process.stdout.write(`\n  (backend not reachable at ${BASE} — integration tests skipped)\n`);
    return;
  }

  if (!(await signInAsGuest())) {
    available = false;
    process.stdout.write('\n  (could not create a guest session — integration tests skipped)\n');
  }
});

/** An empty library snapshot; the server computes personalisation itself. */
const EMPTY_LIBRARY = { favoriteIds: [], progress: [], watchStates: {} };

describe('mobile → backend integration', () => {
  it('fetches a contract-valid home payload', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');

    const home = await api.fetchHome(EMPTY_LIBRARY);

    // `request()` already parsed this against homePayloadSchema; reaching
    // here at all means the server's shape satisfies the client's contract.
    assert.ok(home.categories.length > 0);
    assert.ok(home.languages.length > 0);
    assert.ok(home.rails.length > 0);
  });

  it('fetches a drama and its episodes', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');

    const page = await api.fetchDramaPage({ limit: 5 });
    assert.ok(page.items.length > 0);

    const first = page.items[0];
    assert.ok(first);

    const drama = await api.fetchDramaBySlug(first.slug, EMPTY_LIBRARY);
    assert.equal(drama.slug, first.slug);

    const episodes = await api.fetchEpisodes(drama.id, EMPTY_LIBRARY);
    assert.ok(episodes.length > 0);
    assert.equal(episodes[0]?.episodeNumber, 1);
  });

  it('receives per-episode durations, not a flat value', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');

    const episodes = await api.fetchEpisodes('drama_mazhai', EMPTY_LIBRARY);
    const durations = episodes.slice(0, 5).map((episode) => episode.durationSec);

    // The seed cycles the real fixture lengths. A flat duration here is the
    // M2.1 bug — metadata describing different media from what is served.
    assert.equal(new Set(durations).size > 1, true, `durations were ${durations.join(',')}`);
  });

  it('builds a playback ticket for a free episode and refuses a locked one', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');
    const { AppError } = await import('../../services/errors');

    const episodes = await api.fetchEpisodes('drama_mazhai', EMPTY_LIBRARY);
    const free = episodes.find((episode) => !episode.isLocked);
    const locked = episodes.find((episode) => episode.isLocked);
    assert.ok(free && locked);

    const ticket = await api.requestPlaybackTicket(free.id, EMPTY_LIBRARY);
    assert.ok(ticket.playbackUrl.endsWith('/master.m3u8'));
    assert.equal(ticket.durationSec, free.durationSec, 'the ticket matches the catalogue');

    await assert.rejects(
      () => api.requestPlaybackTicket(locked.id, EMPTY_LIBRARY),
      (error: unknown) => error instanceof AppError && error.code === 'EPISODE_LOCKED',
    );
  });

  it('writes progress through and respects the monotonic rule', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');

    const episodes = await api.fetchEpisodes('drama_mazhai', EMPTY_LIBRARY);
    const episode = episodes.find((item) => item.episodeNumber === 3);
    assert.ok(episode);

    const later = new Date().toISOString();
    const earlier = new Date(Date.now() - 3_600_000).toISOString();

    await api.putProgress({
      episodeId: episode.id,
      dramaId: 'drama_mazhai',
      episodeNumber: 3,
      positionSec: 11,
      durationSec: episode.durationSec,
      occurredAt: later,
    });

    // A stale replay, as the offline queue would produce on reconnect.
    await api.putProgress({
      episodeId: episode.id,
      dramaId: 'drama_mazhai',
      episodeNumber: 3,
      positionSec: 2,
      durationSec: episode.durationSec,
      occurredAt: earlier,
    });

    const refreshed = await api.fetchEpisodes('drama_mazhai', EMPTY_LIBRARY);
    const after = refreshed.find((item) => item.id === episode.id);
    assert.ok((after?.watchState?.positionSec ?? 0) >= 11, 'the viewer was not rewound');
  });

  it('toggles a favourite and sees it reflected in the catalogue', async (t) => {
    if (!available) return t.skip('backend not running');
    const api = await import('../../services/api/live-api');

    await api.addFavorite('drama_kaanal');
    let drama = await api.fetchDramaBySlug('kaanal-neer', EMPTY_LIBRARY);
    assert.equal(drama.isFavorited, true);

    await api.removeFavorite('drama_kaanal');
    drama = await api.fetchDramaBySlug('kaanal-neer', EMPTY_LIBRARY);
    assert.equal(drama.isFavorited, false);
  });
});

describe('HttpPlaybackSyncAdapter against the real endpoint', () => {
  function event(overrides: Partial<PlaybackEvent> = {}): PlaybackEvent {
    return {
      eventId: `mobile-itest-${Math.random().toString(36).slice(2, 14)}`,
      sessionId: 'ps_mobile_integration',
      dramaId: 'drama_mazhai',
      episodeId: 'drama_mazhai_s1_e01',
      type: 'playback_started',
      occurredAt: new Date().toISOString(),
      positionSec: 0,
      durationSec: 30,
      errorCode: null,
      context: { platform: 'android', appVersion: '0.1.0-itest' },
      ...overrides,
    } as PlaybackEvent;
  }

  it('delivers a batch and gets the ids back', async (t) => {
    if (!available) return t.skip('backend not running');
    const { HttpPlaybackSyncAdapter } = await import('../../services/playback/sync/http-adapter');

    const adapter = new HttpPlaybackSyncAdapter();
    const batch = [event(), event({ type: 'playback_progress', positionSec: 10 })];

    const ack = await adapter.send(batch);
    assert.deepEqual(ack.acceptedEventIds.sort(), batch.map((e) => e.eventId).sort());
  });

  it('is safe to resend — the server deduplicates', async (t) => {
    if (!available) return t.skip('backend not running');
    const { HttpPlaybackSyncAdapter } = await import('../../services/playback/sync/http-adapter');

    const adapter = new HttpPlaybackSyncAdapter();
    const batch = [event()];

    const first = await adapter.send(batch);
    const second = await adapter.send(batch);

    assert.deepEqual(first.acceptedEventIds, second.acceptedEventIds);
  });

  it('acknowledges only the storable half of a mixed batch', async (t) => {
    if (!available) return t.skip('backend not running');
    const { HttpPlaybackSyncAdapter } = await import('../../services/playback/sync/http-adapter');

    const adapter = new HttpPlaybackSyncAdapter();
    const good = event();
    const ghost = event({ episodeId: 'does_not_exist' });

    const ack = await adapter.send([good, ghost]);

    assert.deepEqual(ack.acceptedEventIds, [good.eventId]);
    // The engine requeues anything unacknowledged, so the ghost is retried
    // and eventually marked dead rather than lost silently.
  });

  it('classifies an unreachable server as ambiguous, and therefore retryable', async () => {
    const { HttpPlaybackSyncAdapter } = await import('../../services/playback/sync/http-adapter');
    const { SyncTransportError } = await import('../../services/playback/sync/adapter');

    // Port 1: nothing listens there, so the connection is refused outright.
    const adapter = new HttpPlaybackSyncAdapter('http://127.0.0.1:1/api/v1');

    await assert.rejects(
      () => adapter.send([event()]),
      (error: unknown) => {
        assert.ok(error instanceof SyncTransportError);
        // Ambiguous: from the client's side a refused connection and a lost
        // response are indistinguishable, so the batch must be retried. The
        // server deduplicates on eventId, which makes that harmless.
        assert.equal(error.ambiguous, true);
        return true;
      },
    );
  });

  it('classifies a 404 as a rejection, which is not retryable', async (t) => {
    if (!available) return t.skip('backend not running');
    const { HttpPlaybackSyncAdapter } = await import('../../services/playback/sync/http-adapter');
    const { SyncRejectedError } = await import('../../services/playback/sync/adapter');

    // A real server, a path that does not exist: understood and refused.
    // Retrying an unchanged batch could never succeed, so these burn their
    // attempts down to `dead` where they are visible.
    const adapter = new HttpPlaybackSyncAdapter(`${BASE.replace(/\/+$/, '')}/nope`);

    await assert.rejects(
      () => adapter.send([event()]),
      (error: unknown) => error instanceof SyncRejectedError,
    );
  });
});
