import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { getPlaybackService } from './device-service';
import { flushPendingProgress } from './progress-sync';
import { api } from '../api';
import { hydrateLibrary } from '../../store/library.store';
import { applyConnectivity, refreshSyncCounts, useSyncStore } from '../../store/sync.store';
import { queryClient, queryKeys } from '../query-client';

/**
 * Starts the playback pipeline, once, for the life of the app.
 *
 * Mounted from the root layout. Responsible for:
 *
 *  1. Opening and migrating the database.
 *  2. Recovering anything a previous process left mid-send.
 *  3. Hydrating watch progress into the library store.
 *  4. Mirroring connectivity and queue depth into the sync store.
 *  5. Draining the queue when the app foregrounds.
 *
 * Everything is best-effort. A failure here must not prevent the app from
 * starting — a viewer with a corrupt local database should still be able to
 * browse and watch, just without durable progress.
 */
/**
 * Replays progress rows the server has not acknowledged.
 *
 * Best-effort and never thrown from: a failed flush leaves the rows dirty,
 * which is exactly the state they were already in.
 */
async function flushProgress(): Promise<void> {
  try {
    const service = await getPlaybackService();
    await flushPendingProgress(service.progress, (input) => api.syncProgress(input));
  } catch {
    // Retried on the next startup, foreground or reconnect.
  }
}

export function usePlaybackBootstrap(): void {
  useEffect(() => {
    let cancelled = false;
    let unsubscribeConnectivity: (() => void) | null = null;
    let unsubscribeSync: (() => void) | null = null;

    void (async () => {
      try {
        const service = await getPlaybackService();
        if (cancelled) return;

        applyConnectivity(service.connectivity.current());
        unsubscribeConnectivity = service.connectivity.subscribe((status) => {
          applyConnectivity(status);
          // Progress owes the server writes too, not just the event queue.
          // The sync engine already reacts to this signal for events; this
          // is the same moment for the other half of the pipeline.
          if (status.isConnected) void flushProgress();
        });

        unsubscribeSync = service.sync.subscribe((outcome) => {
          const store = useSyncStore.getState();
          store.setSyncing(false);
          store.setOutcome(outcome);
          void refreshSyncCounts();
        });

        /*
         * Flush before hydrating, not after.
         *
         * Hydration reconciles local progress against the server. Sending
         * what we owe first means the server already holds the device's
         * latest positions when that comparison runs, so a write that was
         * stranded by a crash is reflected rather than being treated as the
         * server disagreeing with us.
         */
        await flushProgress();

        await hydrateLibrary();

        /*
         * Progress-dependent queries are refetched once the database has been
         * read.
         *
         * They derive Continue Watching and per-episode watch state from the
         * library snapshot, which is empty until this point. Without the
         * invalidation, a Home query that resolved during hydration would
         * cache a catalogue with no Continue Watching rail and keep showing
         * it until something else invalidated it.
         *
         * In practice hydration is a local read and finishes first, but
         * "usually wins the race" is not a guarantee, and the cost of being
         * wrong is a viewer's resume point vanishing from the home screen.
         */
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.home() }),
          queryClient.invalidateQueries({ queryKey: queryKeys.history() }),
          queryClient.invalidateQueries({ queryKey: queryKeys.continueWatching() }),
          queryClient.invalidateQueries({ queryKey: ['episodes'] }),
        ]);

        await refreshSyncCounts();

        // One drain at startup, for anything left over from last time.
        void service.sync.run();
      } catch {
        // Browsing and playback do not depend on this. Reported through the
        // sync indicator rather than as a blocking error.
      }
    })();

    /**
     * Foregrounding is the other moment worth draining.
     *
     * Android can suspend a backgrounded process for minutes; connectivity
     * may have returned while nothing was listening, so the subscription
     * alone is not enough.
     */
    const onAppStateChange = (next: AppStateStatus): void => {
      if (next !== 'active') return;
      void (async () => {
        try {
          const service = await getPlaybackService();
          await refreshSyncCounts();
          void service.sync.run();
          void flushProgress();
        } catch {
          // As above.
        }
      })();
    };

    const subscription = AppState.addEventListener('change', onAppStateChange);

    return () => {
      cancelled = true;
      unsubscribeConnectivity?.();
      unsubscribeSync?.();
      subscription.remove();
    };
  }, []);
}
