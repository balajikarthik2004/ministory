import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ContinueWatchingItem,
  DramaCard,
  DramaDetail,
  EpisodeSummary,
  HomePayload,
  SearchResult,
  UserProfile,
  WatchHistoryEntry,
} from '@minidrama/contracts';
import { useLibraryStore, librarySnapshot } from '../store/library.store';
import { queryKeys } from './query-client';
import { api } from './api';

/**
 * The data access layer for every screen.
 *
 * Screens call these hooks and nothing else — no screen imports `mock-api`,
 * and no screen imports the mock dataset. When M3 replaces the mock
 * implementation with HTTP, this file is the only one that needs to know.
 */

export function useHome(): UseQueryResult<HomePayload> {
  return useQuery({
    queryKey: queryKeys.home(),
    queryFn: () => api.fetchHome(librarySnapshot()),
  });
}

export function useDrama(slug: string): UseQueryResult<DramaDetail> {
  return useQuery({
    queryKey: queryKeys.drama(slug),
    queryFn: () => api.fetchDramaBySlug(slug, librarySnapshot()),
    enabled: slug.length > 0,
  });
}

export function useEpisodes(dramaId: string | undefined): UseQueryResult<EpisodeSummary[]> {
  return useQuery({
    queryKey: queryKeys.episodes(dramaId ?? ''),
    queryFn: () => api.fetchEpisodes(dramaId ?? '', librarySnapshot()),
    enabled: Boolean(dramaId),
  });
}

export function useSearch(params: {
  q: string;
  categoryId?: string;
  languageId?: string;
}): UseQueryResult<SearchResult> {
  return useQuery({
    queryKey: queryKeys.search(params.q, params.categoryId, params.languageId),
    queryFn: () => api.searchDramas(params, librarySnapshot()),
    // Keeps the previous results on screen while a new query is in flight, so
    // typing does not flash an empty list between keystrokes.
    placeholderData: (previous) => previous,
  });
}

export function useFavorites(): UseQueryResult<DramaCard[]> {
  return useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.fetchFavorites(librarySnapshot()),
  });
}

export function useHistory(): UseQueryResult<WatchHistoryEntry[]> {
  return useQuery({
    queryKey: queryKeys.history(),
    queryFn: () => api.fetchHistory(librarySnapshot()),
  });
}

export function useContinueWatching(): UseQueryResult<ContinueWatchingItem[]> {
  return useQuery({
    queryKey: queryKeys.continueWatching(),
    queryFn: () => api.fetchContinueWatching(librarySnapshot()),
  });
}

export function useProfile(): UseQueryResult<UserProfile> {
  return useQuery({
    queryKey: queryKeys.profile(),
    queryFn: () => api.fetchProfile(),
  });
}

/**
 * Favourite toggle.
 *
 * The store flips first so the heart responds on the same frame as the tap;
 * the affected queries are then invalidated so every list carrying that drama
 * re-derives `isFavorited` from one source rather than each screen patching
 * its own copy.
 *
 * In M3 this gains `POST`/`DELETE /me/favorites/:dramaId` and a rollback on
 * failure. The optimistic update and the invalidation set do not change.
 */
export function useToggleFavorite(): (dramaId: string) => void {
  const queryClient = useQueryClient();
  const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);

  const mutation = useMutation({
    mutationFn: async (dramaId: string) => {
      // Flipped locally first so the heart responds on the same frame as the
      // tap, then pushed. `isFavorite` is read before the toggle so the call
      // sends the state the viewer just asked for.
      const willBeFavorited = !useLibraryStore.getState().isFavorite(dramaId);
      toggleFavorite(dramaId);
      await api.syncFavorite(dramaId, willBeFavorited);
      return dramaId;
    },
    onError: (_error, dramaId) => {
      // The server refused. Put the heart back rather than leaving the UI
      // claiming something that did not happen.
      toggleFavorite(dramaId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
      void queryClient.invalidateQueries({ queryKey: ['drama'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  return useCallback(
    (dramaId: string) => {
      mutation.mutate(dramaId);
    },
    [mutation],
  );
}

/**
 * Refreshes everything that depends on watch progress.
 *
 * Called when the player closes rather than on every position tick: the player
 * writes to the store continuously, and invalidating Continue Watching sixty
 * times an episode would refetch the home screen behind the video for no
 * visible benefit.
 */
export function useRefreshProgressViews(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.history() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.continueWatching() });
    void queryClient.invalidateQueries({ queryKey: ['episodes'] });
  }, [queryClient]);
}
