/**
 * Runtime configuration, read from `EXPO_PUBLIC_*` environment variables.
 *
 * CLAUDE.md §11 and apps/mobile/.env.example: `EXPO_PUBLIC_` values are
 * embedded in the JavaScript bundle and extractable from a shipped APK. They
 * are public. Nothing secret belongs here — only endpoints and feature
 * switches.
 */

function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.replace(/\/+$/, '') : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

/**
 * Where the FFmpeg-generated HLS fixtures are served from during development
 * (tools/video-fixtures/serve.mjs).
 *
 * The default assumes `adb reverse tcp:8787 tcp:8787`, which tunnels over USB
 * and so does not depend on the machine's LAN address — that address changes
 * between sessions and is a recurring source of "the player is broken" reports
 * that are really "the IP moved". With adb reverse in place, a failed fetch
 * means the fixture server is down, which is a far more useful signal.
 */
export const FIXTURE_BASE_URL = readString(
  process.env.EXPO_PUBLIC_FIXTURE_BASE_URL,
  'http://127.0.0.1:8787',
);

export const API_BASE_URL = readString(
  process.env.EXPO_PUBLIC_API_BASE_URL,
  'http://10.0.2.2:4000/api/v1',
);

/**
 * Simulated network latency for the mock data layer, in ms.
 *
 * Non-zero on purpose. A mock that resolves synchronously never renders its
 * own loading state, so the skeletons that UI_UX_GUIDELINES.md §5 requires
 * would be written but never seen — and would therefore never be reviewed.
 */
export const MOCK_LATENCY_MS = 420;

/**
 * Dev-only failure injection, so error and retry states can be exercised
 * without unplugging anything. Toggled from the Profile screen in development.
 */
export const MOCK_FAILURES_DEFAULT = readBoolean(process.env.EXPO_PUBLIC_MOCK_FAILURES, false);

// ───────────────────────────── API (M2.3) ────────────────────────────────

/**
 * Where the catalogue comes from.
 *
 * `mock` keeps the M2.1 in-memory dataset, so UI work does not need Postgres,
 * Docker and the backend running. `live` talks to the Express API.
 *
 * Both are kept deliberately. A screen that only works against one of them is
 * a screen whose failure states nobody can reproduce.
 */
export type ApiMode = 'mock' | 'live';

export const API_MODE: ApiMode =
  process.env.EXPO_PUBLIC_API_MODE?.trim().toLowerCase() === 'mock' ? 'mock' : 'live';

/**
 * Request deadline.
 *
 * A request with no timeout on a mobile network does not fail, it hangs, and
 * a hung query shows a spinner forever. Ten seconds is long enough for a cold
 * Express process on a laptop and short enough that a wrong LAN address reads
 * as an error rather than as the app being broken.
 */
export const API_TIMEOUT_MS = 10_000;

/**
 * THE DEVELOPMENT CREDENTIAL IS GONE (M2.5 Phase 4).
 *
 * Until M2.5 this module exported `DEV_AUTH_TOKEN`, read from
 * `EXPO_PUBLIC_DEV_AUTH_TOKEN`. It has been removed rather than disabled, and
 * the distinction matters: `EXPO_PUBLIC_` values are compiled into the
 * JavaScript bundle and are extractable from a shipped APK with a zip tool
 * and a text editor. A disabled-but-present credential ships anyway.
 *
 * Every request now carries a real session access token, held in memory and
 * backed by a refresh token in the device keystore — see
 * `services/auth/session-manager.ts` and `services/auth/credential-store.ts`.
 *
 * Nothing secret may be added to this file. Endpoints and feature switches
 * only, as the warning at the top says.
 */
