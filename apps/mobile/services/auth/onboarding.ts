import * as SecureStore from 'expo-secure-store';

/**
 * Whether this install has been through onboarding (PRD AUTH-02).
 *
 * A PER-INSTALL UI FLAG, NOT ACCOUNT STATE. It answers "has this device shown
 * the introduction", which is why it is not on `UserProfile`: a returning
 * viewer signing in on a handset that has already seen it should go straight
 * to the catalogue, and a fresh install should show it even for an account
 * that has seen it elsewhere.
 *
 * STORED IN SECURESTORE RATHER THAN ASYNCSTORAGE ONLY BECAUSE THE APP DOES
 * NOT HAVE ASYNCSTORAGE. There is nothing sensitive here — it is a boolean
 * about a screen — and the keystore is simply the key-value store already
 * present. If a general preferences store is ever added, this belongs there,
 * not here.
 *
 * Every call is wrapped, and a failure reads as "not seen". Showing the
 * introduction a second time is a minor annoyance; crashing on launch because
 * the keystore was unavailable is not.
 */

const ONBOARDING_KEY = 'minidrama.onboardingSeen';

export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ONBOARDING_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function markOnboardingSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(ONBOARDING_KEY, 'true', {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  } catch {
    // The viewer sees onboarding once more next launch. Not worth failing for.
  }
}
