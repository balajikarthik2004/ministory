import * as Network from 'expo-network';
import {
  UNKNOWN_STATUS,
  type ConnectivityListener,
  type ConnectivitySource,
  type ConnectivityStatus,
} from './connectivity';

/**
 * `expo-network` behind the connectivity interface.
 *
 * `expo-network` reports `isInternetReachable` as `boolean | undefined`.
 * Undefined means "not determined yet", and treating that as offline would
 * flash the offline banner on every cold start. It is read as online until
 * the platform says otherwise.
 */
export class ExpoConnectivitySource implements ConnectivitySource {
  private status: ConnectivityStatus = UNKNOWN_STATUS;
  private readonly listeners = new Set<ConnectivityListener>();
  private subscription: { remove: () => void } | null = null;
  private started = false;

  current(): ConnectivityStatus {
    return this.status;
  }

  subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      const state = await Network.getNetworkStateAsync();
      this.apply(toStatus(state));
    } catch {
      // A failed probe is not evidence of being offline. Staying optimistic
      // means the worst case is a send that fails and is retried, which the
      // queue already handles — rather than suppressing sync entirely.
      this.apply(UNKNOWN_STATUS);
    }

    this.subscription = Network.addNetworkStateListener((state) => {
      this.apply(toStatus(state));
    });
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = null;
    this.listeners.clear();
    this.started = false;
  }

  private apply(next: ConnectivityStatus): void {
    const changed =
      next.isConnected !== this.status.isConnected ||
      next.isInternetReachable !== this.status.isInternetReachable;
    this.status = next;
    if (!changed) return;
    for (const listener of [...this.listeners]) listener(next);
  }
}

function toStatus(state: Network.NetworkState): ConnectivityStatus {
  return {
    isConnected: state.isConnected ?? true,
    isInternetReachable: state.isInternetReachable ?? true,
  };
}
