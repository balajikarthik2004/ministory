import { create } from 'zustand';
import { getPlaybackService } from '../services/playback/device-service';
import { isOnline, type ConnectivityStatus } from '../services/playback/sync/connectivity';
import type { SyncOutcome } from '../services/playback/sync/sync-engine';
import { MockPlaybackSyncAdapter, type MockFailureMode } from '../services/playback/sync/adapter';

/**
 * Connectivity and sync state, for the UI.
 *
 * Separate from the library store because the offline banner subscribes to it
 * and must not re-render on every favourite toggle or progress tick.
 *
 * Nothing here is the source of truth. The connectivity source owns network
 * state and the outbox owns the queue; this is a projection of both, kept so
 * components can read them synchronously.
 */

export interface SyncState {
  online: boolean;
  /** Pending plus in-flight. What the viewer would lose if they uninstalled. */
  pendingCount: number;
  /** Events that exhausted their retries. Surfaced, never silently dropped. */
  deadCount: number;
  syncing: boolean;
  lastOutcome: SyncOutcome | null;
  lastSyncedAt: string | null;
  /**
   * True briefly after coming back online, so the UI can confirm recovery.
   * A banner that only ever appears on failure leaves the viewer unsure
   * whether it worked.
   */
  justReconnected: boolean;

  /**
   * A projection of the live adapter, so the sync panel can be a pure
   * reader. Keeping it here rather than fetching it in a component effect is
   * what stops the panel calling setState from an effect body on every
   * render — the store is the external system, and it is updated from the
   * engine's own outcome subscription.
   */
  adapterName: string;
  deliveredThisSession: number;
  failureMode: MockFailureMode;
  /** False once the real HTTP adapter replaces the mock in M2.3. */
  adapterIsMock: boolean;

  setOnline: (online: boolean) => void;
  setCounts: (counts: { pending: number; dead: number }) => void;
  setAdapterInfo: (info: {
    adapterName: string;
    deliveredThisSession: number;
    failureMode: MockFailureMode;
    adapterIsMock: boolean;
  }) => void;
  setSyncing: (syncing: boolean) => void;
  setOutcome: (outcome: SyncOutcome) => void;
  clearReconnected: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  // Optimistic until the platform says otherwise, so the banner does not
  // flash on every cold start.
  online: true,
  pendingCount: 0,
  deadCount: 0,
  syncing: false,
  lastOutcome: null,
  lastSyncedAt: null,
  justReconnected: false,
  adapterName: 'not started',
  deliveredThisSession: 0,
  failureMode: 'none',
  adapterIsMock: false,

  setOnline: (online) =>
    set((state) => ({
      online,
      justReconnected: online && !state.online ? true : state.justReconnected,
    })),

  setCounts: ({ pending, dead }) => set({ pendingCount: pending, deadCount: dead }),

  setAdapterInfo: (info) => set(info),

  setSyncing: (syncing) => set({ syncing }),

  setOutcome: (outcome) =>
    set({
      lastOutcome: outcome,
      lastSyncedAt: outcome.kind === 'synced' ? new Date().toISOString() : null,
    }),

  clearReconnected: () => set({ justReconnected: false }),
}));

/** Reads the outbox and the adapter, and publishes both. Safe to call often. */
export async function refreshSyncCounts(): Promise<void> {
  try {
    const service = await getPlaybackService();
    const counts = await service.outbox.counts();
    const store = useSyncStore.getState();

    store.setCounts({
      pending: counts.pending + counts.inFlight,
      dead: counts.dead,
    });

    const adapter = service.adapter;
    const isMock = adapter instanceof MockPlaybackSyncAdapter;
    store.setAdapterInfo({
      adapterName: adapter.name,
      deliveredThisSession: isMock ? adapter.acceptedCount() : 0,
      failureMode: isMock ? adapter.getFailureMode() : 'none',
      adapterIsMock: isMock,
    });
  } catch {
    // The counts are an indicator, not a feature. Failing to read them must
    // not surface an error to a viewer who is only trying to watch a drama.
  }
}

/** Switches the mock adapter's behaviour. Development builds only. */
export async function setSyncFailureMode(mode: MockFailureMode): Promise<void> {
  const service = await getPlaybackService();
  if (!(service.adapter instanceof MockPlaybackSyncAdapter)) return;
  service.adapter.setFailureMode(mode);
  await refreshSyncCounts();
}

/** Drains the queue now. Resolves when the run finishes. */
export async function syncNow(): Promise<void> {
  const store = useSyncStore.getState();
  store.setSyncing(true);
  try {
    const service = await getPlaybackService();
    await service.sync.run();
  } finally {
    useSyncStore.getState().setSyncing(false);
    await refreshSyncCounts();
  }
}

/** Clears events that exhausted their retries. */
export async function discardDeadEvents(): Promise<void> {
  const service = await getPlaybackService();
  await service.outbox.discardDead();
  await refreshSyncCounts();
}

/** Mirrors a connectivity change into the store. */
export function applyConnectivity(status: ConnectivityStatus): void {
  useSyncStore.getState().setOnline(isOnline(status));
}
