/**
 * Where credentials live on the device.
 *
 * EXPO SECURE STORE, NEVER ASYNCSTORAGE (CLAUDE.md §11, M2.5 Phase 3).
 * AsyncStorage is an unencrypted SQLite file in the app's sandbox: readable
 * on a rooted device, readable from an `adb backup` on anything that allows
 * one, and readable by anyone with the handset unlocked and the right tool.
 * SecureStore puts the value in the iOS Keychain or the Android Keystore,
 * where it is encrypted with a key held by hardware the app cannot export.
 *
 * WHAT IS STORED HERE AND WHAT IS NOT:
 *
 *   refresh token   stored — it is the long-lived credential, and the whole
 *                   point of session restoration is that it survives a
 *                   restart.
 *   access token    NOT stored. It lives 15 minutes and lives in memory. A
 *                   persisted copy would be a second credential at rest
 *                   buying nothing, since it has usually expired before the
 *                   app is opened again.
 *   device id       stored, but it is not a credential — it labels the
 *                   install so a guest account can be resumed, and grants
 *                   nothing on its own.
 *
 * EVERY CALL IS WRAPPED. SecureStore throws rather than returning null when
 * the keystore is unavailable — a device with no screen lock on some Android
 * builds, a keystore invalidated by a biometric change, a value written by a
 * previous install. None of those should crash the app on launch; all of them
 * mean the same thing to us, which is "there is no session", and the app
 * handles that already.
 */
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const REFRESH_TOKEN_KEY = 'minidrama.refreshToken';
const DEVICE_ID_KEY = 'minidrama.deviceId';

/**
 * Android requires keys to be alphanumeric plus `.`, `-` and `_`, which the
 * two above satisfy. Keeping them as named constants rather than literals is
 * what makes `clear()` provably remove everything `save()` can write.
 */
const ALL_CREDENTIAL_KEYS = [REFRESH_TOKEN_KEY] as const;

async function readSafely(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeSafely(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value, {
      /*
       * Available once the device has been unlocked after boot, and not
       * synced to another device.
       *
       * NOT `WHEN_UNLOCKED`: the sync engine drains the playback outbox on
       * reconnect, which can happen while the screen is locked. A credential
       * that is unreadable with the screen off would turn every background
       * sync into a spurious sign-out.
       */
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteSafely(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Already gone, or the store is unavailable. Both are the desired state.
  }
}

export async function loadRefreshToken(): Promise<string | null> {
  return readSafely(REFRESH_TOKEN_KEY);
}

export async function saveRefreshToken(token: string): Promise<boolean> {
  return writeSafely(REFRESH_TOKEN_KEY, token);
}

/**
 * Removes every stored credential.
 *
 * AUTH-08 requires logout to clear all local credential state, and this is
 * the half of it that lives in the keystore. Iterating the key list rather
 * than deleting one known key means a credential added later cannot be left
 * behind by a logout nobody remembered to update.
 *
 * The device id is deliberately NOT cleared: it identifies the install, not
 * the person, and keeping it means a guest who signs out does not fragment
 * into a new anonymous account on the same handset.
 */
export async function clearCredentials(): Promise<void> {
  await Promise.all(ALL_CREDENTIAL_KEYS.map(deleteSafely));
}

/**
 * The install's device id, generated once and then stable.
 *
 * Used to bind a guest session so an anonymous account survives a restart
 * (PRD AUTH-03). If the keystore refuses to persist it, a fresh id is
 * returned for this launch rather than throwing: the consequence is a guest
 * who gets a new anonymous account next time, which is a degraded experience
 * and not a broken one.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await readSafely(DEVICE_ID_KEY);
  if (existing) return existing;

  const created = Crypto.randomUUID();
  await writeSafely(DEVICE_ID_KEY, created);
  return created;
}

// ──────────────────────── Deletion receipt (M2.6) ────────────────────────

const DELETION_RECEIPT_KEY = 'minidrama.deletionReceipt';

/**
 * The pending deletion receipt, if an attempt is unresolved.
 *
 * WHY THIS IS STORED AT ALL. A successful deletion destroys the access token,
 * the refresh token and the session row — every credential that could ask
 * "did it work?". If the response is lost to a dropped connection or the app
 * being killed, the client is left with no way to find out, and both guesses
 * are wrong: wiping local data destroys unsynced progress for an account that
 * may still exist, and not wiping leaves a deleted account's viewing history
 * on the handset.
 *
 * So the id is generated and written HERE BEFORE the request goes out, and is
 * removed only once the outcome is known. Its presence at launch means
 * exactly one thing: an attempt was made and never resolved.
 *
 * IT IS A SECRET, NOT A FLAG. Presenting it is what proves to the server that
 * this install is the one that asked, which is why it lives in the keystore
 * next to the refresh token rather than in AsyncStorage.
 */
export async function loadDeletionReceiptId(): Promise<string | null> {
  return readSafely(DELETION_RECEIPT_KEY);
}

export async function saveDeletionReceiptId(receiptId: string): Promise<boolean> {
  return writeSafely(DELETION_RECEIPT_KEY, receiptId);
}

export async function clearDeletionReceiptId(): Promise<void> {
  await deleteSafely(DELETION_RECEIPT_KEY);
}

/**
 * A fresh receipt id: 32 bytes of CSPRNG output, hex.
 *
 * The same size and source as the server's own opaque tokens, because it does
 * the same job — it has to be unguessable, since anyone who could guess one
 * could learn that some account was deleted. 256 bits makes that a non-event.
 *
 * HEX RATHER THAN BASE64URL, which is what the server uses for its own
 * tokens. The server only ever hashes this value, so the encoding is ours to
 * choose, and hex needs nothing but `toString(16)`. Base64 would mean relying
 * on a global `btoa` being present in the JS runtime — probably true, and
 * exactly the kind of "probably" that turns into a crash on the one screen
 * where a crash means a viewer cannot delete their account. 64 characters sits
 * well inside the contract's 16–256 bound.
 */
export function newDeletionReceiptId(): string {
  return Array.from(Crypto.getRandomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
