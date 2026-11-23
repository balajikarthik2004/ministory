/**
 * How the HTTP client gets a credential, without importing the session.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THIS INDIRECTION EXISTS, BECAUSE IT LOOKS LIKE CEREMONY AND IS NOT.
 *
 * `services/auth/session.ts` imports `react-native` (for `Platform`) and
 * `expo-secure-store`. Both are fine in a bundle and neither is loadable
 * under plain Node: React Native ships Flow-typed source, so importing it
 * outside Metro fails with `SyntaxError: Unexpected token 'typeof'`.
 *
 * `tests/integration/backend.test.ts` loads the app's REAL `live-api` and
 * drives it at a running Express server — that is the whole value of those
 * tests, since they are what catches the client and the API disagreeing about
 * a contract. A static `import { session } from '../auth/session'` inside
 * `http-client.ts` would make that impossible, and did: it broke six
 * integration tests the moment it was added.
 *
 * So the client depends on this module, which depends on nothing. The device
 * registers the real implementation at startup; Node gets the default, which
 * is "no credential", which is exactly right for a guest-mode integration
 * test. The playback sync adapter solves the same problem the same way, by
 * taking its token getter as a constructor argument.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface AuthBridge {
  /** A valid access token, refreshing first if needed. Null when signed out. */
  getAccessToken(): Promise<string | null>;
  /**
   * Called when a request came back 401. Returns a fresh token to retry with,
   * or null if the session is finished.
   *
   * @param usedToken the token the failed request carried, so the
   *   implementation can tell "my token is stale" from "another request has
   *   already refreshed and I should just use the new one".
   */
  handleUnauthorized(usedToken: string | null): Promise<string | null>;
}

/**
 * The default: no credential, and no recovery.
 *
 * Used under Node, and in place until the app registers the real session.
 * It is not a failure mode — a request with no token is a guest request, and
 * the catalogue serves those (PRD AUTH-03).
 */
const anonymousBridge: AuthBridge = {
  async getAccessToken() {
    return null;
  },
  async handleUnauthorized() {
    return null;
  },
};

let bridge: AuthBridge = anonymousBridge;

/** Called once at app startup, from `services/auth/session.ts`. */
export function setAuthBridge(next: AuthBridge): void {
  bridge = next;
}

export function getAuthBridge(): AuthBridge {
  return bridge;
}
