import { Platform } from 'react-native';
import { SessionManager } from './session-manager';
import { httpAuthGateway } from './auth-gateway';
import {
  clearCredentials,
  getOrCreateDeviceId,
  loadRefreshToken,
  saveRefreshToken,
} from './credential-store';
import { setAuthBridge } from '../api/auth-bridge';

/**
 * The app's session manager.
 *
 * The one place that pairs the pure `SessionManager` with the device's real
 * keystore and the real API — the same split as `device-service.ts` for
 * playback, so the lifecycle logic stays testable under Node while the
 * Expo-only imports live here and nowhere else.
 *
 * A module-level singleton rather than React context: the HTTP client and the
 * playback sync adapter both need a token, and neither is a component. A
 * context would force them through a hook they cannot call.
 */
export const session: SessionManager = new SessionManager({
  gateway: httpAuthGateway,
  storage: {
    loadRefreshToken,
    saveRefreshToken,
    clearCredentials,
    getOrCreateDeviceId,
  },
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android',
});

/*
 * Hands the HTTP client its credential source.
 *
 * Registered here, at module load, rather than passed into every call: the
 * client is used by query functions that have no access to a React tree, and
 * the arrow functions keep `this` bound to the manager. See
 * `services/api/auth-bridge.ts` for why the client cannot simply import this
 * module — in short, it must stay loadable under Node for the integration
 * tests, and this file is not.
 */
setAuthBridge({
  getAccessToken: () => session.getAccessToken(),
  handleUnauthorized: (usedToken) => session.handleUnauthorized(usedToken),
});

export { httpAuthGateway as authApi };
