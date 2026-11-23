import type {
  ContinueWatchingItem,
  DramaCard,
  DramaDetail,
  EpisodeSummary,
  HomePayload,
  PlaybackTicket,
  SearchResult,
  UserProfile,
  WatchHistoryEntry,
} from '@minidrama/contracts';
import type { LibrarySnapshot } from '../../store/library.store';
import { API_MODE } from '../config';
import * as mock from '../mock-api';
import * as live from './live-api';

/**
 * The catalogue API, mock or live.
 *
 * The query layer imports this module and nothing else. Which implementation
 * is behind it is decided once, from `EXPO_PUBLIC_API_MODE`, and no screen or
 * hook branches on it.
 *
 * MOCK MODE IS NOT DEAD CODE. UI work on a train, on a laptop without Docker,
 * or on a screen whose backend endpoint does not exist yet, all need it — and
 * a failure state that can only be produced by stopping a real server is a
 * failure state nobody exercises. It stays.
 */

export interface CatalogueApi {
  fetchHome(library: LibrarySnapshot): Promise<HomePayload>;
  fetchDramaBySlug(slug: string, library: LibrarySnapshot): Promise<DramaDetail>;
  fetchEpisodes(dramaId: string, library: LibrarySnapshot): Promise<EpisodeSummary[]>;
  searchDramas(
    params: { q: string; categoryId?: string; languageId?: string },
    library: LibrarySnapshot,
  ): Promise<SearchResult>;
  fetchFavorites(library: LibrarySnapshot): Promise<DramaCard[]>;
  fetchHistory(library: LibrarySnapshot): Promise<WatchHistoryEntry[]>;
  fetchContinueWatching(library: LibrarySnapshot): Promise<ContinueWatchingItem[]>;
  fetchProfile(): Promise<UserProfile>;
  requestPlaybackTicket(episodeId: string, library: LibrarySnapshot): Promise<PlaybackTicket>;
  /**
   * Pushes a favourite change to the server.
   *
   * A no-op in mock mode, where the Zustand store is the only record. The
   * caller does not branch: it toggles locally for an instant UI and calls
   * this, and in mock mode "the server" has already agreed by definition.
   */
  syncFavorite(dramaId: string, favorited: boolean): Promise<void>;
  /** Pushes a position. A no-op in mock mode, for the same reason. */
  syncProgress(input: {
    episodeId: string;
    dramaId: string;
    episodeNumber: number;
    positionSec: number;
    durationSec: number;
    occurredAt?: string;
  }): Promise<void>;
}

const mockApi: CatalogueApi = {
  fetchHome: mock.fetchHome,
  fetchDramaBySlug: mock.fetchDramaBySlug,
  fetchEpisodes: mock.fetchEpisodes,
  searchDramas: mock.searchDramas,
  fetchFavorites: mock.fetchFavorites,
  fetchHistory: mock.fetchHistory,
  fetchContinueWatching: mock.fetchContinueWatching,
  fetchProfile: mock.fetchProfile,
  requestPlaybackTicket: mock.requestPlaybackTicket,
  syncFavorite: async () => undefined,
  syncProgress: async () => undefined,
};

const liveApi: CatalogueApi = {
  fetchHome: live.fetchHome,
  fetchDramaBySlug: live.fetchDramaBySlug,
  fetchEpisodes: live.fetchEpisodes,
  searchDramas: live.searchDramas,
  fetchFavorites: live.fetchFavorites,
  fetchHistory: live.fetchHistory,
  fetchContinueWatching: live.fetchContinueWatching,
  fetchProfile: live.fetchProfile,
  requestPlaybackTicket: live.requestPlaybackTicket,
  syncFavorite: async (dramaId, favorited) => {
    if (favorited) await live.addFavorite(dramaId);
    else await live.removeFavorite(dramaId);
  },
  syncProgress: live.putProgress,
};

export const api: CatalogueApi = API_MODE === 'mock' ? mockApi : liveApi;

export const isLiveMode = API_MODE === 'live';
