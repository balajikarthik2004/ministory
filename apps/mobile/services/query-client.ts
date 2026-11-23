import { QueryClient } from '@tanstack/react-query';
import { AppError } from './errors';

/**
 * The app's single QueryClient.
 *
 * Defaults are tuned for a mobile catalogue on an unreliable connection
 * (CLAUDE.md §13): cached data is shown immediately and refreshed in the
 * background rather than replaced by a spinner, and retries back off instead
 * of hammering a link that is already struggling.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A drama catalogue does not change minute to minute. Thirty seconds
      // keeps a tab switch instant without serving genuinely stale rails.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        // Retrying a 404 or a locked episode just delays the message the user
        // needs to see. Only transport-shaped failures are worth another go.
        if (error instanceof AppError) {
          if (error.code !== 'SERVICE_UNAVAILABLE' && error.code !== 'INTERNAL_ERROR') {
            return false;
          }
        }
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      // React Native has no window focus event in the web sense, and
      // refetching on every app foreground costs data on a metered connection.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

/**
 * Query keys in one place.
 *
 * Keys that include the library snapshot's identity would invalidate on every
 * favourite toggle, so they deliberately do not. The library store drives
 * invalidation explicitly instead — see `useToggleFavorite`.
 */
export const queryKeys = {
  home: () => ['home'] as const,
  drama: (slug: string) => ['drama', slug] as const,
  episodes: (dramaId: string) => ['episodes', dramaId] as const,
  search: (q: string, categoryId?: string, languageId?: string) =>
    ['search', q, categoryId ?? null, languageId ?? null] as const,
  favorites: () => ['favorites'] as const,
  history: () => ['history'] as const,
  continueWatching: () => ['continue-watching'] as const,
  profile: () => ['profile'] as const,
  playbackTicket: (episodeId: string) => ['playback-ticket', episodeId] as const,
} as const;
