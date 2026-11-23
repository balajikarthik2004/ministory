import { queryClient } from '../query-client';
import { purgeLocalPlaybackData } from '../playback/device-service';
import { useLibraryStore, hydrateLibrary } from '../../store/library.store';
import { httpAuthGateway } from './auth-gateway';
import { session } from './session';
import {
  clearDeletionReceiptId,
  loadDeletionReceiptId,
  newDeletionReceiptId,
  saveDeletionReceiptId,
} from './credential-store';
import {
  requestAccountDeletion as runDeletion,
  resolvePendingDeletion as runPendingResolution,
  type DeletionDeps,
  type DeletionOutcome,
} from './deletion-flow';

export type { DeletionOutcome } from './deletion-flow';

/**
 * Account deletion, wired to the device (M2.6).
 *
 * The decision procedure lives in `deletion-flow.ts`, which has no React
 * Native or Expo imports and is therefore testable under plain Node — the
 * same split as `session-manager.ts` / `session.ts`, and for the same reason
 * (ADR-44). This file is the composition root, and holds only what genuinely
 * needs the device.
 */

const deps: DeletionDeps = {
  gateway: httpAuthGateway,
  receipts: {
    load: loadDeletionReceiptId,
    save: saveDeletionReceiptId,
    clear: clearDeletionReceiptId,
    create: newDeletionReceiptId,
  },
  getAccessToken: () => session.getAccessToken(),
  handleUnauthorized: (used) => session.handleUnauthorized(used),
};

export function requestAccountDeletion(input: { password?: string }): Promise<DeletionOutcome> {
  return runDeletion(deps, input);
}

/**
 * Tears the device down after a CONFIRMED deletion.
 *
 * THE ORDER IS NOT ARBITRARY, and each step is here because leaving it out
 * breaks something specific:
 *
 *   1. Local playback data first, and `purge()` stops the sync engine before
 *      it touches anything. Clearing credentials first would leave the engine
 *      draining a batch against a token the server has already destroyed.
 *   2. In-memory favourites are account-scoped state that no query owns, so
 *      nothing else would clear them.
 *   3. Credentials go, so nothing can authenticate as the deleted account.
 *   4. The query cache is CLEARED, not invalidated. Invalidation refetches,
 *      and there is nothing left to refetch for; clearing drops the previous
 *      account's rails at once rather than after a stale window.
 *   5. A fresh guest session, so the app is never in a state where watching
 *      has nowhere to record.
 *   6. Re-hydrate the library store from the now-empty local database.
 */
export async function completeAccountDeletion(): Promise<void> {
  await purgeLocalPlaybackData();

  useLibraryStore.setState({ favoriteIds: [] });

  await session.forgetSession();

  queryClient.clear();

  await session.startGuestSession();

  await hydrateLibrary();
}

/** Settles a deletion a previous launch never saw the outcome of. */
export function resolvePendingDeletion(): Promise<boolean> {
  return runPendingResolution(deps, completeAccountDeletion);
}
