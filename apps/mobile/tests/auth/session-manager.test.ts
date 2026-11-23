import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSession, CurrentUser, UserProfile } from '@minidrama/contracts';
import { SessionManager, type CredentialStorage } from '../../services/auth/session-manager';
import type { AuthGateway } from '../../services/auth/auth-gateway';
import { AppError } from '../../services/errors';

/**
 * The mobile session lifecycle.
 *
 * RUNS UNDER NODE, WITH NO SIMULATOR. `SessionManager` takes its gateway and
 * its storage as dependencies precisely so that the behaviour that must not
 * break — concurrent refresh, reuse-triggered revocation, surviving a dead
 * network — is testable deterministically. On a device these paths need a
 * flaky connection and an expired token to reproduce, which means in practice
 * they are never tested at all.
 *
 * The three cases below map to the three problems documented at the top of
 * `session-manager.ts`.
 */

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'user_1',
    displayName: 'Test',
    email: 'test@example.com',
    phone: null,
    isAnonymous: false,
    avatarUrl: null,
    preferredLanguage: null,
    preferredGenres: [],
    autoplayNext: true,
    notificationsOptIn: true,
    subscriptionStatus: 'NONE',
    memberSince: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sessionResponse(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 900,
    user: profile(),
    emailVerified: true,
    ...overrides,
  };
}

/** An in-memory keystore. */
function memoryStorage(
  initial: string | null = null,
): CredentialStorage & { token: string | null } {
  return {
    token: initial,
    async loadRefreshToken() {
      return this.token;
    },
    async saveRefreshToken(value: string) {
      this.token = value;
      return true;
    },
    async clearCredentials() {
      this.token = null;
    },
    async getOrCreateDeviceId() {
      return 'device-test-0001';
    },
  };
}

/** A gateway whose methods are stubs unless a test overrides them. */
function stubGateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  const notImplemented = async (): Promise<never> => {
    throw new Error('not stubbed for this test');
  };
  return {
    register: notImplemented,
    login: notImplemented,
    guest: notImplemented,
    refresh: notImplemented,
    logout: async () => undefined,
    me: notImplemented,
    changePassword: notImplemented,
    forgotPassword: notImplemented,
    resetPassword: notImplemented,
    verifyEmail: notImplemented,
    resendVerification: notImplemented,
    merge: notImplemented,
    deleteAccount: notImplemented,
    resolveDeletionReceipt: notImplemented,
    ...overrides,
  };
}

const offline = (): never => {
  throw new AppError('SERVICE_UNAVAILABLE', 'offline');
};
const rejected = (): never => {
  throw new AppError('UNAUTHENTICATED', 'Your session has ended.');
};

describe('session restoration', () => {
  it('restores a stored refresh token into a live session', async () => {
    const storage = memoryStorage('stored-refresh');
    let presented: string | null = null;

    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        refresh: async (token) => {
          presented = token;
          return sessionResponse({ refreshToken: 'rotated-refresh' });
        },
      }),
    });

    const state = await manager.restore();

    assert.equal(presented, 'stored-refresh');
    assert.equal(state.status, 'authenticated');
    assert.equal(state.user?.email, 'test@example.com');
    assert.equal(
      storage.token,
      'rotated-refresh',
      'the rotated token replaces the stored one, or the next launch replays a dead one',
    );
  });

  it('falls back to a guest session when there is no stored token', async () => {
    const storage = memoryStorage(null);
    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        guest: async () =>
          sessionResponse({
            user: profile({ isAnonymous: true, email: null }),
            refreshToken: 'guest-refresh',
          }),
      }),
    });

    const state = await manager.restore();

    assert.equal(state.status, 'guest');
    assert.equal(state.canUpgrade, true);
    assert.equal(storage.token, 'guest-refresh');
  });

  /**
   * PROBLEM 3 FROM THE HEADER COMMENT: being offline is not being signed out.
   *
   * A refresh that fails because the network is unreachable must leave the
   * credential alone. Clearing it would sign out a viewer on a train and,
   * worse, orphan whatever the playback outbox had not yet uploaded.
   */
  it('keeps the credential when the restore fails on a dead network', async () => {
    const storage = memoryStorage('stored-refresh');
    const manager = new SessionManager({
      storage,
      gateway: stubGateway({ refresh: offline }),
    });

    const state = await manager.restore();

    assert.equal(state.status, 'signed-out', 'reported as signed out for the UI');
    assert.equal(
      storage.token,
      'stored-refresh',
      'but the credential survives, so the next launch can recover',
    );
  });

  /** A server-side rejection is different: the token will never work again. */
  it('discards the credential when the server rejects it', async () => {
    const storage = memoryStorage('revoked-refresh');
    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        refresh: rejected,
        guest: async () =>
          sessionResponse({ user: profile({ isAnonymous: true }), refreshToken: 'guest-refresh' }),
      }),
    });

    const state = await manager.restore();

    assert.equal(state.status, 'guest', 'falls back to guest rather than stranding the app');
    assert.notEqual(storage.token, 'revoked-refresh', 'the dead token is gone');
  });

  it('ends in a usable state when even guest creation fails', async () => {
    const manager = new SessionManager({
      storage: memoryStorage(null),
      gateway: stubGateway({ guest: offline }),
    });

    const state = await manager.restore();
    assert.equal(state.status, 'signed-out', 'the app still starts; browsing still works');
  });
});

describe('concurrent bootstrap', () => {
  /**
   * THE REGRESSION TEST FOR THE BUG A DEVICE RUN FOUND.
   *
   * On a Motorola Edge 70 Fusion, force-stopping the app while signed in and
   * reopening it left the viewer as a BRAND-NEW GUEST with an empty My List.
   * The session table showed two startup bootstraps 194ms apart: one restored
   * the account from the keystore, the other created an anonymous account and,
   * adopting last, won.
   *
   * `refreshInFlight` never applied, because `restore()` calls `performRefresh`
   * directly rather than going through `refreshAccessToken()`.
   *
   * Two concurrent restores must produce ONE account and ONE refresh.
   */
  it('collapses concurrent restores and never falls through to a guest', async () => {
    let refreshCalls = 0;
    let guestCalls = 0;

    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return sessionResponse({ refreshToken: `rotated-${refreshCalls}` });
        },
        guest: async () => {
          guestCalls += 1;
          return sessionResponse({ user: profile({ isAnonymous: true }) });
        },
      }),
    });

    const [a, b] = await Promise.all([manager.restore(), manager.restore()]);

    assert.equal(refreshCalls, 1, 'one rotation, not one per caller');
    assert.equal(guestCalls, 0, 'and NO guest account — the account was restored');
    assert.equal(a.status, 'authenticated');
    assert.equal(b.status, 'authenticated');
    assert.equal(manager.getState().status, 'authenticated');
  });

  /**
   * THE EXACT FAILURE A DEVICE RUN REPRODUCED, with `REFRESH_REUSE` in the
   * session table.
   *
   * A restore is in the air. Before it finishes, the first screen's queries
   * ask for an access token — there is a refresh token but no access token
   * yet, so `getAccessToken()` starts its own refresh. If the restore did not
   * go through the same single-flight guard, BOTH present the same stored
   * token, the server rotates on first use, and the second one looks exactly
   * like a replayed stolen token. Reuse detection revokes the family and the
   * viewer is signed out of their own account on app launch.
   *
   * The refresh token must be presented to the server exactly once.
   */
  it('does not race a concurrent getAccessToken into refresh-token reuse', async () => {
    const presented: string[] = [];

    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async (token) => {
          presented.push(token);
          await new Promise((resolve) => setTimeout(resolve, 15));
          return sessionResponse({ accessToken: 'access-1', refreshToken: 'rotated-1' });
        },
        guest: async () => sessionResponse({ user: profile({ isAnonymous: true }) }),
      }),
    });

    // The restore and a screen's token request, overlapping — which is what
    // actually happens on launch.
    const [, token] = await Promise.all([manager.restore(), manager.getAccessToken()]);

    assert.deepEqual(
      presented,
      ['stored-refresh'],
      'the stored token must reach the server exactly once, or it reads as reuse',
    );
    assert.equal(token, 'access-1');
    assert.equal(manager.getState().status, 'authenticated', 'still signed in');
  });

  /** The same guard covers guest creation, or a cold start makes two rows. */
  it('collapses concurrent guest bootstraps into one account', async () => {
    let guestCalls = 0;

    const manager = new SessionManager({
      storage: memoryStorage(null),
      gateway: stubGateway({
        guest: async () => {
          guestCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return sessionResponse({
            user: profile({ id: `guest_${guestCalls}`, isAnonymous: true }),
          });
        },
      }),
    });

    const states = await Promise.all([
      manager.restore(),
      manager.restore(),
      manager.startGuestSession(),
    ]);

    assert.equal(guestCalls, 1, 'one anonymous account per install, not three');
    assert.equal(new Set(states.map((state) => state.user?.id)).size, 1);
  });

  /** A later restore is a real one — the guard must not latch. */
  it('allows a restore after the first has settled', async () => {
    let refreshCalls = 0;
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          refreshCalls += 1;
          return sessionResponse();
        },
      }),
    });

    await manager.restore();
    await manager.restore();

    assert.equal(refreshCalls, 2);
  });
});

describe('concurrent refresh', () => {
  /**
   * PROBLEM 1, AND THE REASON THE SINGLE-FLIGHT PROMISE EXISTS.
   *
   * The home screen fires several queries at once. If the access token has
   * expired they all refresh, the server rotates on first use, and the rest
   * present a token that was just revoked — which the backend correctly reads
   * as REUSE and answers by revoking the whole family. The user is signed out
   * by their own app opening a screen.
   *
   * Exactly one network refresh must happen.
   */
  it('collapses parallel refreshes into one request', async () => {
    let calls = 0;
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          calls += 1;
          // A real round trip; the second caller must arrive during it.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return sessionResponse({ accessToken: `access-${calls}` });
        },
      }),
    });

    await manager.restore();
    assert.equal(calls, 1, 'the restore itself refreshed once');

    const tokens = await Promise.all([
      manager.refreshAccessToken(),
      manager.refreshAccessToken(),
      manager.refreshAccessToken(),
      manager.refreshAccessToken(),
    ]);

    assert.equal(calls, 2, 'four callers, one rotation');
    assert.equal(new Set(tokens).size, 1, 'and they all got the same token');
  });

  /** A later refresh, after the first has settled, is a real one. */
  it('refreshes again once the in-flight one has finished', async () => {
    let calls = 0;
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          calls += 1;
          return sessionResponse({ accessToken: `access-${calls}` });
        },
      }),
    });

    await manager.restore();
    await manager.refreshAccessToken();
    await manager.refreshAccessToken();

    assert.equal(calls, 3, 'the single-flight guard must not latch');
  });

  /**
   * The 401-retry path. A request that raced another request's refresh must
   * take the new token rather than rotating again — four parallel queries
   * hitting a 401 would otherwise produce four rotations, three of them
   * racing.
   */
  it('hands back the current token when another request already refreshed', async () => {
    let calls = 0;
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          calls += 1;
          return sessionResponse({ accessToken: `access-${calls}` });
        },
      }),
    });

    await manager.restore();
    const current = await manager.getAccessToken();
    const callsAfterRestore = calls;

    // A request that was sent with a token from before the restore's refresh.
    const replacement = await manager.handleUnauthorized('an-older-access-token');

    assert.equal(replacement, current, 'given the token that is already current');
    assert.equal(calls, callsAfterRestore, 'and no extra rotation happened');
  });

  /**
   * A revoked refresh token normally lands the app in a GUEST session, which
   * is a working state with a real token — so `handleUnauthorized` correctly
   * hands that one back rather than null.
   *
   * Null is reserved for the case where there is genuinely nothing left to
   * try: no refresh token and no guest session either. That is the signal the
   * HTTP client needs in order to stop, and the reason it retries at most
   * once (see `http-client.ts`).
   */
  it('returns null when there is nothing left to refresh with', async () => {
    const manager = new SessionManager({
      storage: memoryStorage('revoked'),
      gateway: stubGateway({
        refresh: rejected,
        // The fallback fails too, so the app ends with no credential at all.
        guest: rejected,
      }),
    });

    await manager.restore();
    assert.equal(manager.getState().status, 'signed-out');

    const replacement = await manager.handleUnauthorized('whatever-we-sent');
    assert.equal(replacement, null, 'null tells the caller to stop, not to try again');
  });

  /**
   * The ordinary revocation path, for contrast: a rejected refresh token
   * drops the app to a guest session rather than stranding it, and the retry
   * is given that session's token.
   */
  it('falls back to a guest token when the refresh token is revoked', async () => {
    const manager = new SessionManager({
      storage: memoryStorage('revoked'),
      gateway: stubGateway({
        refresh: rejected,
        guest: async () =>
          sessionResponse({
            user: profile({ isAnonymous: true }),
            accessToken: 'guest-access',
            refreshToken: 'guest-refresh',
          }),
      }),
    });

    await manager.restore();
    assert.equal(manager.getState().status, 'guest');

    const replacement = await manager.handleUnauthorized('the-dead-token');
    assert.equal(replacement, 'guest-access', 'the retry uses the new guest session');
  });
});

describe('access tokens', () => {
  it('reuses a token that is still comfortably valid', async () => {
    let calls = 0;
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => {
          calls += 1;
          return sessionResponse({ accessToken: 'access-1', expiresIn: 900 });
        },
      }),
    });

    await manager.restore();
    const first = await manager.getAccessToken();
    const second = await manager.getAccessToken();

    assert.equal(first, 'access-1');
    assert.equal(second, 'access-1');
    assert.equal(calls, 1, 'no refresh while the token is good');
  });

  /**
   * The expiry margin. A token that passes a bare `now < expiresAt` check and
   * is then used on a slow connection arrives at the server already expired —
   * a request that fails for no reason the viewer can see.
   */
  it('refreshes before expiry rather than at it', async () => {
    let now = 1_000_000;
    let calls = 0;

    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      now: () => now,
      expiryMarginMs: 30_000,
      gateway: stubGateway({
        refresh: async () => {
          calls += 1;
          return sessionResponse({ accessToken: `access-${calls}`, expiresIn: 900 });
        },
      }),
    });

    await manager.restore();
    assert.equal(calls, 1);

    // 880 seconds later: 20 seconds of life left, inside the 30-second margin.
    now += 880_000;
    const token = await manager.getAccessToken();

    assert.equal(calls, 2, 'refreshed early');
    assert.equal(token, 'access-2');
  });

  /**
   * Offline, with a token that may well still be valid: hand it back. The
   * server is the authority on whether it works, and a 401 is recoverable
   * where pretending to be signed out is not.
   */
  it('returns the existing token when a pre-emptive refresh cannot reach the server', async () => {
    let now = 1_000_000;
    let online = true;

    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      now: () => now,
      gateway: stubGateway({
        refresh: async () => {
          if (!online) offline();
          return sessionResponse({ accessToken: 'access-1', expiresIn: 900 });
        },
      }),
    });

    await manager.restore();
    online = false;
    now += 880_000;

    assert.equal(await manager.getAccessToken(), 'access-1');
  });
});

describe('sign out', () => {
  it('clears the credential and becomes a guest', async () => {
    const storage = memoryStorage('stored-refresh');
    let loggedOut = false;

    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        refresh: async () => sessionResponse(),
        logout: async () => {
          loggedOut = true;
        },
        guest: async () =>
          sessionResponse({ user: profile({ isAnonymous: true }), refreshToken: 'guest-refresh' }),
      }),
    });

    await manager.restore();
    const state = await manager.signOut();

    assert.equal(loggedOut, true, 'the server is told, so the session is revoked');
    assert.equal(state.status, 'guest');
    assert.equal(storage.token, 'guest-refresh', 'the old credential is gone');
  });

  /**
   * AUTH-08: logout clears all local credential state. A logout that refuses
   * to work offline leaves credentials on a handset someone is about to hand
   * over, which is the one case where it matters most.
   */
  it('clears the credential even when the server cannot be reached', async () => {
    const storage = memoryStorage('stored-refresh');
    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        refresh: async () => sessionResponse(),
        logout: offline,
        guest: offline,
      }),
    });

    await manager.restore();
    const state = await manager.signOut();

    assert.equal(state.status, 'signed-out');
    assert.equal(storage.token, null, 'cleared regardless');
  });
});

describe('guest upgrade', () => {
  it('adopts the merged session and reports what moved', async () => {
    const storage = memoryStorage(null);
    const manager = new SessionManager({
      storage,
      gateway: stubGateway({
        guest: async () =>
          sessionResponse({ user: profile({ isAnonymous: true, email: null }), refreshToken: 'g' }),
        merge: async () => ({
          session: sessionResponse({ refreshToken: 'upgraded-refresh' }),
          moved: { watchHistory: 3, dramaProgress: 1, favorites: 2, playbackEvents: 40 },
        }),
      }),
    });

    await manager.restore();
    assert.equal(manager.getState().status, 'guest');

    const { state, moved } = await manager.upgradeGuest({
      email: 'new@example.com',
      password: 'a-long-enough-password',
    });

    assert.equal(state.status, 'authenticated');
    assert.equal(state.canUpgrade, false);
    assert.equal(storage.token, 'upgraded-refresh');
    assert.equal(moved, 6, 'history + progress + favourites, excluding raw analytics rows');
  });
});

describe('observers', () => {
  it('notifies subscribers on every transition', async () => {
    const seen: string[] = [];
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => sessionResponse(),
        logout: async () => undefined,
        guest: async () => sessionResponse({ user: profile({ isAnonymous: true }) }),
      }),
    });

    manager.subscribe((state) => seen.push(state.status));

    await manager.restore();
    await manager.signOut();

    assert.deepEqual(seen, ['authenticated', 'signed-out', 'guest']);
  });

  it('reports emailVerified from the session, defaulting safely for guests', async () => {
    const manager = new SessionManager({
      storage: memoryStorage(null),
      gateway: stubGateway({
        guest: async () =>
          sessionResponse({ user: profile({ isAnonymous: true }), emailVerified: false }),
      }),
    });

    await manager.restore();
    assert.equal(
      manager.getState().emailVerified,
      true,
      'a guest has no address to verify, so nothing should nag them',
    );
  });

  it('reloads the current user without disturbing the tokens', async () => {
    const manager = new SessionManager({
      storage: memoryStorage('stored-refresh'),
      gateway: stubGateway({
        refresh: async () => sessionResponse({ emailVerified: false }),
        me: async (): Promise<CurrentUser> => ({
          user: profile({ displayName: 'Renamed' }),
          emailVerified: true,
          isGuest: false,
        }),
      }),
    });

    await manager.restore();
    assert.equal(manager.getState().emailVerified, false);

    const state = await manager.reload();
    assert.equal(state.user?.displayName, 'Renamed');
    assert.equal(state.emailVerified, true);
  });
});
