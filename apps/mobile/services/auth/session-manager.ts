import type { AuthSession, UserProfile } from '@minidrama/contracts';
import type { AuthGateway } from './auth-gateway';
import { AppError, messageFor } from '../errors';

/**
 * The session: who is signed in, and the tokens that prove it.
 *
 * PLAIN TYPESCRIPT, NO REACT, NO EXPO. Every dependency is injected, so the
 * whole lifecycle — restore, refresh, concurrent refresh, revocation, sign
 * out — is testable under `node:test` without a simulator. The same shape the
 * playback service uses, and for the same reason: the parts that must not
 * break are the parts a device test cannot reach reliably.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE THREE PROBLEMS THIS CLASS EXISTS TO SOLVE
 *
 * 1. CONCURRENT REFRESH. The home screen fires four queries at once. If the
 *    access token has expired, all four get a 401 and all four try to
 *    refresh. The server rotates on first use, so the first succeeds and the
 *    other three present a token that was just revoked — which the backend
 *    correctly reads as REUSE and revokes the entire family. The user is
 *    signed out by their own app opening a screen.
 *
 *    THE FIX IS THE SINGLE-FLIGHT PROMISE BELOW. Every caller awaits the
 *    same refresh. There is exactly one rotation.
 *
 * 2. A REVOKED SESSION. The refresh token is valid-looking but the server
 *    has revoked it — a password change elsewhere, or reuse detection. There
 *    is no recovering: the credentials are cleared and the app returns to a
 *    signed-out state, once, rather than retrying.
 *
 * 3. BEING OFFLINE IS NOT BEING SIGNED OUT. A refresh that fails because the
 *    network is unreachable must leave the session exactly as it was. Losing
 *    a session on a train, and with it the ability to sync a full outbox when
 *    signal returns, is the worst outcome available here — it is data loss
 *    dressed up as a security measure.
 * ────────────────────────────────────────────────────────────────────────
 */

export type SessionStatus =
  /** Nothing has been attempted yet. The splash is showing. */
  | 'restoring'
  /** No credential. Browsing is still allowed (PRD AUTH-03). */
  | 'signed-out'
  /** Signed in as an anonymous account. */
  | 'guest'
  /** Signed in as a registered account. */
  | 'authenticated';

export interface SessionState {
  status: SessionStatus;
  user: UserProfile | null;
  /** True when the account is anonymous and can be upgraded (AUTH-06). */
  canUpgrade: boolean;
  /**
   * Whether the account's address is confirmed.
   *
   * Defaults to true while signed out or a guest, so that a screen asking
   * "should I nag about verification?" gets `false` for everyone who has no
   * address to verify, without having to check the status as well.
   */
  emailVerified: boolean;
}

export interface CredentialStorage {
  loadRefreshToken(): Promise<string | null>;
  saveRefreshToken(token: string): Promise<boolean>;
  clearCredentials(): Promise<void>;
  getOrCreateDeviceId(): Promise<string>;
}

export interface SessionManagerOptions {
  gateway: AuthGateway;
  storage: CredentialStorage;
  platform?: string;
  /** Injected for tests. */
  now?: () => number;
  /**
   * Refresh this many milliseconds before the access token actually expires.
   *
   * Without a margin, a token that passes the check and is then used on a slow
   * connection arrives at the server already expired — a request that fails
   * for no reason the user can see. Thirty seconds covers a bad mobile round
   * trip and costs one extra refresh per session at most.
   */
  expiryMarginMs?: number;
}

const DEFAULT_EXPIRY_MARGIN_MS = 30_000;

/** One object, so every path that reaches signed-out produces the same state. */
const SIGNED_OUT: SessionState = {
  status: 'signed-out',
  user: null,
  canUpgrade: false,
  emailVerified: true,
};

export class SessionManager {
  private readonly gateway: AuthGateway;
  private readonly storage: CredentialStorage;
  private readonly platform: string | undefined;
  private readonly now: () => number;
  private readonly expiryMarginMs: number;

  /** In memory only, never persisted — see credential-store.ts. */
  private accessToken: string | null = null;
  private accessTokenExpiresAtMs = 0;
  private refreshToken: string | null = null;

  private state: SessionState = {
    status: 'restoring',
    user: null,
    canUpgrade: false,
    emailVerified: true,
  };
  private readonly listeners = new Set<(state: SessionState) => void>();

  /** The single-flight refresh. Non-null while one is in progress. */
  private refreshInFlight: Promise<string> | null = null;

  /**
   * The single-flight BOOTSTRAP — `restore()` and `startGuestSession()`.
   *
   * ADDED AFTER A DEVICE RUN CAUGHT THE BUG IT PREVENTS. Two startup
   * bootstraps ran 194ms apart on a real handset; one restored the signed-in
   * account from the keystore, the other fell through to guest creation and,
   * because it adopted last, won. The viewer force-stopped the app signed in
   * and reopened it as a brand-new anonymous user with an empty My List.
   *
   * `refreshInFlight` did not help: `restore()` calls `performRefresh`
   * directly rather than going through `refreshAccessToken()`, so it never
   * touched that guard, and `startGuestSession()` had no guard at all.
   *
   * The internal callers deliberately use the `perform*` methods, which are
   * unguarded — a guarded call from inside the guarded promise would await
   * itself.
   */
  private bootstrapInFlight: Promise<SessionState> | null = null;

  constructor(options: SessionManagerOptions) {
    this.gateway = options.gateway;
    this.storage = options.storage;
    this.platform = options.platform;
    this.now = options.now ?? Date.now;
    this.expiryMarginMs = options.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  }

  // ───────────────────────────── Observation ─────────────────────────────

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: SessionState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  // ─────────────────────────────── Restore ───────────────────────────────

  /**
   * Restores a session at launch (AUTH-01).
   *
   * THE ORDER OF THE BRANCHES IS THE DESIGN. A stored refresh token is tried
   * first; only if there is none do we fall back to a guest session, and only
   * if guest creation also fails do we end up signed out. A signed-out state
   * is the last resort, not the default, because the catalogue, Continue
   * Watching and the playback outbox all work better with an account behind
   * them.
   */
  async restore(): Promise<SessionState> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;

    const attempt = this.performRestore().finally(() => {
      this.bootstrapInFlight = null;
    });
    this.bootstrapInFlight = attempt;
    return attempt;
  }

  private async performRestore(): Promise<SessionState> {
    const stored = await this.storage.loadRefreshToken();

    if (stored) {
      this.refreshToken = stored;
      try {
        /*
         * THROUGH `refreshAccessToken()`, NOT `performRefresh()` DIRECTLY.
         *
         * This one line is the difference between a working restore and
         * signing the viewer out. An earlier version called `performRefresh`
         * here, which bypasses the `refreshInFlight` single-flight guard — so
         * while the restore was in the air, the first screen's queries called
         * `getAccessToken()`, found a refresh token and no access token, and
         * started a SECOND refresh with the same stored value.
         *
         * The server rotates on first use, so the second request presented an
         * already-rotated token, which is precisely the signature of a stolen
         * token being replayed. Reuse detection did its job and revoked the
         * whole family; the app fell back to a guest session; the viewer
         * force-stopped the app signed in and reopened it as a stranger with
         * an empty My List.
         *
         * Caught on a Motorola Edge 70 Fusion, with `REFRESH_REUSE` sitting
         * in the `Session` table naming exactly what happened.
         *
         * Going through the guard means a concurrent `getAccessToken()` joins
         * this refresh instead of racing it. The `bootstrapInFlight` guard
         * above is still needed — it stops two *restores* from each creating
         * a guest account — but it cannot help here, because the competing
         * call is a refresh, not a restore.
         */
        await this.refreshAccessToken();
        return this.state;
      } catch (error) {
        /*
         * A transport failure here must NOT clear the credential. The token
         * may be perfectly good and the user simply opened the app in a lift.
         * Reporting signed-out while keeping the token means the next
         * successful request restores the session rather than demanding a
         * sign-in that would also have failed.
         */
        if (isTransportFailure(error)) {
          this.setState(SIGNED_OUT);
          return this.state;
        }
        // The server rejected it. It will never work again.
        await this.forgetCredentials();
      }
    }

    // The unguarded form: this call is already inside the bootstrap guard,
    // and going through `startGuestSession()` would await the very promise
    // this function is producing.
    return this.performGuestSession();
  }

  /**
   * Creates or resumes the anonymous account for this install.
   *
   * Called on first launch and after a sign-out, so that the app is never in
   * a state where watch progress has nowhere to go.
   */
  async startGuestSession(): Promise<SessionState> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;

    const attempt = this.performGuestSession().finally(() => {
      this.bootstrapInFlight = null;
    });
    this.bootstrapInFlight = attempt;
    return attempt;
  }

  private async performGuestSession(): Promise<SessionState> {
    try {
      const deviceId = await this.storage.getOrCreateDeviceId();
      const session = await this.gateway.guest({
        deviceId,
        ...(this.platform ? { platform: this.platform } : {}),
      });
      await this.adopt(session);
    } catch {
      /*
       * Guest creation failed — almost always because the API is unreachable.
       * Signed-out is a working state: the catalogue serves guests, mock mode
       * needs no server at all, and `restore()` will be tried again on the
       * next launch.
       */
      this.setState(SIGNED_OUT);
    }
    return this.state;
  }

  // ──────────────────────────────── Tokens ────────────────────────────────

  /**
   * An access token that is valid now, refreshing first if it is about to
   * expire. Null when there is no session at all.
   *
   * THE PROACTIVE REFRESH MATTERS MORE THAN IT LOOKS. Waiting for a 401
   * instead would mean every expiry costs a failed request, and a request
   * that fails is one the caller has to be written to retry — including the
   * playback sync engine, which would otherwise classify it and back off.
   */
  async getAccessToken(): Promise<string | null> {
    /*
     * If the session is still being established, wait for it.
     *
     * The first screen's queries fire while `restore()` is in the air. Without
     * this, `this.refreshToken` is not set yet — it is assigned after the
     * keystore read — so this method would return null and the caller would
     * make an ANONYMOUS request. On `/me/*` that is a 401 on every launch,
     * recovered only by the retry path, which is a lot of machinery to undo a
     * race we can simply wait out.
     *
     * Waiting is safe: the bootstrap always settles, including on a dead
     * network, where it resolves to a signed-out state rather than hanging.
     */
    if (this.bootstrapInFlight) {
      await this.bootstrapInFlight.catch(() => undefined);
    }

    if (this.accessToken && this.now() < this.accessTokenExpiresAtMs - this.expiryMarginMs) {
      return this.accessToken;
    }
    if (!this.refreshToken) return this.accessToken;

    try {
      return await this.refreshAccessToken();
    } catch (error) {
      /*
       * Offline: hand back whatever we have. It may still be valid — the
       * margin above is a precaution, not an expiry — and a request that
       * fails with a 401 is recoverable, where returning null here makes the
       * caller behave as if the user were signed out.
       */
      if (isTransportFailure(error)) return this.accessToken;
      return null;
    }
  }

  /**
   * Refreshes, collapsing concurrent callers onto one request.
   *
   * THE SINGLE-FLIGHT PROMISE IS THE WHOLE POINT OF THIS METHOD — see
   * problem 1 at the top of the file. Note that the promise is stored BEFORE
   * it is awaited, so a second caller arriving during the first `await`
   * inside `performRefresh` still finds it.
   */
  async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const token = this.refreshToken;
    if (!token) throw new AppError('UNAUTHENTICATED', messageFor('UNAUTHENTICATED'));

    const attempt = this.performRefresh(token).finally(() => {
      this.refreshInFlight = null;
    });

    this.refreshInFlight = attempt;
    return attempt;
  }

  private async performRefresh(refreshToken: string): Promise<string> {
    try {
      const session = await this.gateway.refresh(refreshToken);
      await this.adopt(session);
      return session.accessToken;
    } catch (error) {
      if (isTransportFailure(error)) throw error;

      /*
       * The server refused the refresh token: revoked, expired, or part of a
       * family that reuse detection killed. Nothing to retry. The credentials
       * go, and the app falls back to a guest session so browsing and the
       * outbox keep working rather than stranding both.
       */
      await this.forgetCredentials();
      await this.performGuestSession();
      throw error;
    }
  }

  /**
   * Called by the HTTP client when a request comes back 401.
   *
   * Returns a fresh access token to retry with, or null if the session is
   * genuinely finished. THE CALLER MUST RETRY AT MOST ONCE: a second 401
   * after a successful refresh means the request is unauthorised for a reason
   * a new token cannot fix, and retrying again is a loop.
   */
  async handleUnauthorized(usedToken: string | null): Promise<string | null> {
    /*
     * If the token has already moved on, another request's refresh beat us to
     * it. Hand back the current one rather than rotating again — otherwise a
     * screen with four parallel queries rotates four times, and three of
     * those rotations race.
     */
    if (this.accessToken && this.accessToken !== usedToken) return this.accessToken;
    if (!this.refreshToken) return null;

    try {
      return await this.refreshAccessToken();
    } catch {
      return null;
    }
  }

  // ───────────────────────────── Sign in / out ─────────────────────────────

  async signIn(email: string, password: string): Promise<SessionState> {
    const deviceId = await this.storage.getOrCreateDeviceId();
    const session = await this.gateway.login({
      email,
      password,
      deviceId,
      ...(this.platform ? { platform: this.platform } : {}),
    });
    await this.adopt(session);
    return this.state;
  }

  /**
   * Upgrades the current guest account into a registered one, keeping its
   * activity (AUTH-06).
   *
   * Requires a live guest session, because the backend identifies the guest
   * from the access token. With no session there is nothing to merge, and
   * ordinary registration is the right path.
   */
  async upgradeGuest(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ state: SessionState; moved: number }> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new AppError('UNAUTHENTICATED', messageFor('UNAUTHENTICATED'));

    const deviceId = await this.storage.getOrCreateDeviceId();
    const result = await this.gateway.merge(accessToken, { ...input, deviceId });
    await this.adopt(result.session);

    const moved = result.moved.watchHistory + result.moved.dramaProgress + result.moved.favorites;
    return { state: this.state, moved };
  }

  /**
   * Signs out, then immediately becomes a guest again.
   *
   * AUTH-08 requires every local credential to be cleared, and the order
   * matters: the server is told first so the session is revoked even if the
   * app is killed a moment later, but a failure to reach it does NOT stop the
   * local clear. A logout that refuses to work offline is a logout that
   * leaves credentials on a handset someone is about to hand over.
   */
  async signOut(): Promise<SessionState> {
    const accessToken = this.accessToken;
    const refreshToken = this.refreshToken;

    if (accessToken) {
      try {
        await this.gateway.logout(accessToken, refreshToken);
      } catch {
        // Best effort. The local clear below is the part that must happen.
      }
    }

    await this.forgetCredentials();
    return this.startGuestSession();
  }

  /**
   * Drops every local credential without telling the server anything.
   *
   * FOR ACCOUNT DELETION, AND NOTHING ELSE (M2.6). `signOut()` is the wrong
   * tool there twice over: it calls `POST /auth/logout` with a token the
   * server has already destroyed, which can only fail, and it then starts a
   * guest session — while the caller still has local data to wipe, so the new
   * session would be live during the teardown that is about to run.
   *
   * Deletion's teardown sequences those steps itself, so what it needs from
   * the session manager is exactly this and no more.
   */
  async forgetSession(): Promise<SessionState> {
    await this.forgetCredentials();
    return this.state;
  }

  /** Re-reads the current user, after a profile change or a verification. */
  async reload(): Promise<SessionState> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return this.state;

    try {
      const current = await this.gateway.me(accessToken);
      this.setState({
        status: current.isGuest ? 'guest' : 'authenticated',
        user: current.user,
        canUpgrade: current.isGuest,
        emailVerified: current.isGuest || current.emailVerified,
      });
    } catch {
      // A failed reload leaves the last known state. It is a refresh of
      // display data, not a statement about whether the session is valid.
    }
    return this.state;
  }

  // ──────────────────────────────── Internals ────────────────────────────────

  private async adopt(session: AuthSession): Promise<void> {
    this.accessToken = session.accessToken;
    this.accessTokenExpiresAtMs = this.now() + session.expiresIn * 1000;
    this.refreshToken = session.refreshToken;

    await this.storage.saveRefreshToken(session.refreshToken);

    this.setState({
      status: session.user.isAnonymous ? 'guest' : 'authenticated',
      user: session.user,
      canUpgrade: session.user.isAnonymous,
      emailVerified: session.user.isAnonymous || session.emailVerified,
    });
  }

  private async forgetCredentials(): Promise<void> {
    this.accessToken = null;
    this.accessTokenExpiresAtMs = 0;
    this.refreshToken = null;
    await this.storage.clearCredentials();
    this.setState(SIGNED_OUT);
  }
}

/**
 * Whether a failure means "we could not reach the server" rather than "the
 * server said no".
 *
 * THIS PREDICATE DECIDES WHETHER A CREDENTIAL SURVIVES, which makes it the
 * most consequential six lines in the file. `SERVICE_UNAVAILABLE` is what
 * `auth-gateway.ts` raises for a timeout, a DNS failure or a refused
 * connection, and `RATE_LIMITED` is explicitly temporary. Everything else —
 * 401 above all — is a decision the server made and will make again.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.code === 'SERVICE_UNAVAILABLE' || error.code === 'RATE_LIMITED';
  }
  // An unrecognised throw is treated as transport: keeping a credential that
  // should have gone is recoverable on the next request, where discarding one
  // that was fine signs out a working session.
  return true;
}
