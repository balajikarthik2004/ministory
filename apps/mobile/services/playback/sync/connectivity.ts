/**
 * Connectivity, behind an interface.
 *
 * `expo-network` is the implementation on the device. It is wrapped rather
 * than used directly for two reasons: the offline-to-online transition is one
 * of the behaviours M2.2 has to prove, and a test cannot unplug a network
 * adapter; and a "connected" flag that comes from one vendor's module tends to
 * leak that vendor's semantics into every caller.
 */

export interface ConnectivityStatus {
  /** The device has a network interface that claims to be usable. */
  isConnected: boolean;
  /**
   * The OS believes that interface actually reaches the internet.
   *
   * Distinct from `isConnected` on purpose: a captive portal, a hotel
   * Wi-Fi login page or a VPN that has dropped all look connected and carry
   * no traffic. Syncing gates on this, not on `isConnected`, because
   * attempting a send on a captive portal burns retry attempts against a
   * network that will never deliver.
   */
  isInternetReachable: boolean;
}

export type ConnectivityListener = (status: ConnectivityStatus) => void;

export interface ConnectivitySource {
  current(): ConnectivityStatus;
  /** @returns an unsubscribe function. */
  subscribe(listener: ConnectivityListener): () => void;
  /** Starts observation. Safe to call more than once. */
  start(): Promise<void>;
  stop(): void;
}

export const UNKNOWN_STATUS: ConnectivityStatus = {
  // Optimistic until proven otherwise. Starting "offline" would show the
  // offline banner for a moment on every cold start, on a device that is
  // almost always online.
  isConnected: true,
  isInternetReachable: true,
};

export function isOnline(status: ConnectivityStatus): boolean {
  return status.isConnected && status.isInternetReachable;
}

/**
 * An in-memory source, for tests and for any platform where network state is
 * not observable.
 */
export class FakeConnectivitySource implements ConnectivitySource {
  private status: ConnectivityStatus;
  private readonly listeners = new Set<ConnectivityListener>();

  constructor(initial: ConnectivityStatus = UNKNOWN_STATUS) {
    this.status = initial;
  }

  current(): ConnectivityStatus {
    return this.status;
  }

  subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    // Nothing to start.
  }

  stop(): void {
    this.listeners.clear();
  }

  /** Test control: change state and notify. */
  set(status: ConnectivityStatus): void {
    const changed =
      status.isConnected !== this.status.isConnected ||
      status.isInternetReachable !== this.status.isInternetReachable;
    this.status = status;
    if (!changed) return;
    for (const listener of [...this.listeners]) listener(status);
  }

  goOffline(): void {
    this.set({ isConnected: false, isInternetReachable: false });
  }

  goOnline(): void {
    this.set({ isConnected: true, isInternetReachable: true });
  }
}
