import { create } from 'zustand';
import type { UserProfile } from '@minidrama/contracts';
import { session } from '../services/auth/session';
import { resolvePendingDeletion } from '../services/auth/deletion';
import type { SessionState, SessionStatus } from '../services/auth/session-manager';

/**
 * Session state, for components.
 *
 * A PROJECTION, NOT THE SOURCE OF TRUTH. `SessionManager` owns the tokens and
 * the lifecycle; this store mirrors what it publishes so a screen can read it
 * synchronously and re-render on change. The same relationship `sync.store`
 * has with the playback engine.
 *
 * The subscription is set up once at module load rather than in a provider's
 * effect, because the manager can change state before any component mounts —
 * `restore()` runs from the splash screen, and a listener attached afterwards
 * would miss the transition it exists to observe.
 */

interface SessionStore extends SessionState {
  /** True until `restore()` has resolved once. Gates the splash (AUTH-01). */
  initialising: boolean;
}

export const useSessionStore = create<SessionStore>(() => ({
  status: 'restoring' as SessionStatus,
  user: null,
  canUpgrade: false,
  emailVerified: true,
  initialising: true,
}));

session.subscribe((state) => {
  useSessionStore.setState({ ...state, initialising: false });
});

/** Runs the restore, once, and flips `initialising` whatever the outcome. */
export async function initialiseSession(): Promise<void> {
  try {
    /*
     * AN UNRESOLVED DELETION IS SETTLED BEFORE ANYTHING ELSE (M2.6 §9).
     *
     * A receipt left in the keystore means a deletion was requested and its
     * outcome was never learnt — the app was killed, or the network died
     * between the request and the response. Restoring the session first would
     * mean restoring an account that may no longer exist and re-hydrating a
     * deleted viewer's history onto the screen.
     *
     * When it confirms a deletion it runs the teardown and starts a fresh
     * guest session itself, so the restore below finds the state it left.
     * When it cannot reach the server it changes nothing and the app opens
     * exactly as it did before — the question is simply asked again next
     * launch.
     */
    await resolvePendingDeletion();

    await session.restore();
  } finally {
    // Even a total failure must end the splash. A restore that throws and
    // leaves `initialising` true is an app that never gets past its logo.
    useSessionStore.setState({ initialising: false });
  }
}

// ──────────────────────────── Selectors ────────────────────────────
//
// Exported as functions so components subscribe to one field rather than the
// whole object — a screen that only needs `isSignedIn` should not re-render
// when the display name changes.

export const selectIsSignedIn = (state: SessionStore): boolean => state.status === 'authenticated';

/** A guest counts as "has an account" — it is a real server-side user. */
export const selectHasAccount = (state: SessionStore): boolean =>
  state.status === 'authenticated' || state.status === 'guest';

export const selectUser = (state: SessionStore): UserProfile | null => state.user;

export const selectCanUpgrade = (state: SessionStore): boolean => state.canUpgrade;
