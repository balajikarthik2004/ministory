import { queryClient } from '../query-client';
import { useLibraryStore } from '../../store/library.store';
import { hydrateLibrary } from '../../store/library.store';

/**
 * What has to happen when the signed-in account changes.
 *
 * THE BUG THIS PREVENTS: sign in on a handset that has been browsing as a
 * guest, and without this the previous account's favourites are still in the
 * Zustand store and its rails are still in the TanStack Query cache. The new
 * account's My List shows the old one's dramas until something happens to
 * refetch — which, with a 30-second `staleTime`, may be half a minute later,
 * or never if the viewer does not leave the screen. It looks exactly like the
 * server returning the wrong user's data.
 *
 * THE ORDER MATTERS AND IS NOT ARBITRARY:
 *
 *   1. Clear the in-memory favourites FIRST. They are the one piece of
 *      account-scoped state the store holds that no query owns, so anything
 *      that reads the store between steps must not see the old account's.
 *   2. Invalidate every query. The catalogue is not account-scoped, but
 *      `isFavorited` on each card is, and so is every `/me/*` response.
 *   3. Re-hydrate progress from SQLite.
 *
 * ON STEP 3, AND WHY THE LOCAL DATABASE IS NOT WIPED: M2.5 Phase 5 is
 * explicit that local progress must not be silently discarded during
 * authentication. The device's SQLite holds positions that may not have
 * reached the server yet, flagged `pending_sync` (ADR-32). Clearing it on
 * sign-in would delete exactly the writes that were waiting to be uploaded.
 * They are kept, and the sync engine pushes them under the new account —
 * which is the same account, in the overwhelmingly common case of a guest
 * upgrading in place.
 */
export async function applyAccountChange(): Promise<void> {
  useLibraryStore.setState({ favoriteIds: [] });

  await queryClient.invalidateQueries();

  // Re-read the durable copy. Never a delete: see the note above.
  await hydrateLibrary();
}
