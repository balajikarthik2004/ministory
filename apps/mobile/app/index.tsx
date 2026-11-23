import { useCallback, useEffect, useState, type JSX } from 'react';
import { Redirect } from 'expo-router';
import { SplashScreen } from '../features/splash/SplashScreen';
import { initialiseSession, useSessionStore } from '../store/session.store';
import { hasSeenOnboarding } from '../services/auth/onboarding';

/**
 * Entry route — the splash, the session, then the app.
 *
 * AUTH-01 ASKS FOR AUTH STATE RESOLVED AND ROUTED WITHIN 1.5 SECONDS ON A
 * COLD START, and the shape of this component is what makes that achievable:
 * the restore runs CONCURRENTLY with the splash animation rather than after
 * it. Both have to finish, so the cost is the slower of the two rather than
 * their sum — and on a warm network the restore finishes well inside the
 * animation, making it free.
 *
 * THERE IS NO SIGNED-OUT DEAD END. Guest browsing is P0 (PRD AUTH-03), so a
 * viewer with no account, a failed restore, or no network at all still lands
 * on Home. The authentication screens are reached deliberately from Profile
 * or from a locked episode — never as a wall in front of the catalogue.
 *
 * Which is why this file routes on ONBOARDING, not on sign-in state.
 */
export default function Entry(): JSX.Element {
  const [splashDone, setSplashDone] = useState(false);
  const initialising = useSessionStore((state) => state.initialising);
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  const handleFinish = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    /*
     * Both run on mount, in parallel. `initialiseSession` resolves the stored
     * refresh token or creates a guest session; `hasSeenOnboarding` reads one
     * key from the keystore. Neither blocks the other, and neither blocks the
     * splash.
     */
    void initialiseSession();
    void hasSeenOnboarding().then((seen) => setNeedsOnboarding(!seen));
  }, []);

  const ready = splashDone && !initialising && needsOnboarding !== null;

  if (!ready) return <SplashScreen onFinish={handleFinish} />;
  if (needsOnboarding) return <Redirect href="/onboarding" />;
  return <Redirect href="/home" />;
}
