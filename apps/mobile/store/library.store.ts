import { create } from 'zustand';
import type { WatchState } from '@minidrama/contracts';
import { MOCK_SEEDED_FAVORITES, MOCK_SEEDED_PROGRESS, episodesFor } from '../data/catalogue.mock';
import { getPlaybackService } from '../services/playback/device-service';
import type { ProgressWrite } from '../services/playback/progress-repository';

/**
 * The viewer's own library: favourites and watch progress.
 *
 * WHY THIS IS A STORE AND NOT A QUERY
 * -----------------------------------
 * Favourites and playback position are written far more often than they are
 * read, and both need to be optimistic. Tapping a heart has to flip instantly
 * — a 400ms round trip before the icon changes reads as a broken button — and
 * the player writes a position every few seconds. Holding them in Zustand and
 * letting the query layer *read* from the store keeps writes synchronous while
 * the server stays the eventual source of truth.
 *
 * WATCH PROGRESS IS NOW DURABLE (M2.2)
 * ------------------------------------
 * The store is a read-through cache over SQLite, not the source of truth.
 * `hydrate()` loads what the database holds at startup, and `recordProgress`
 * updates the store synchronously (so the UI is instant) while the player's
 * recorder persists the same write. The store is therefore disposable: losing
 * it loses nothing, because the database still has the progress.
 *
 * Favourites are still in memory only. They belong behind the account
 * (`POST /me/favorites/:dramaId`), and a device-local copy would need
 * reconciling against the server in M2.3 for no benefit now. Progress is
 * different: it is written continuously during playback and is the thing a
 * viewer actually loses if the app is killed.
 */

export interface ProgressEntry {
  dramaId: string;
  episodeNumber: number;
  positionSec: number;
  lastWatchedAt: string;
}

/**
 * A plain, serialisable read of the store.
 *
 * The mock API takes one of these rather than importing the store, so the data
 * layer stays a pure function of its inputs — and so the same functions work
 * unchanged when M2.3 swaps them for `fetch`, where the server owns this state.
 */
export interface LibrarySnapshot {
  favoriteIds: readonly string[];
  progress: readonly ProgressEntry[];
  /** episodeId -> position, for merging into episode lists. */
  watchStates: Readonly<Record<string, WatchState>>;
}

interface LibraryState extends LibrarySnapshot {
  favoriteIds: string[];
  progress: ProgressEntry[];
  watchStates: Record<string, WatchState>;
  /** False until SQLite has been read, so the UI can avoid a flash of empty. */
  hydrated: boolean;

  toggleFavorite: (dramaId: string) => void;
  isFavorite: (dramaId: string) => boolean;
  recordProgress: (input: {
    dramaId: string;
    episodeId: string;
    episodeNumber: number;
    positionSec: number;
    durationSec: number;
  }) => void;
  /** Where Continue Watching should resume this drama, if anywhere. */
  resumePointFor: (dramaId: string) => ProgressEntry | undefined;
  snapshot: () => LibrarySnapshot;
  /** Replaces progress with what the database holds. */
  applyPersisted: (input: {
    progress: ProgressEntry[];
    watchStates: Record<string, WatchState>;
  }) => void;
}

/** PRD HIST-03. Mirrors `COMPLETION_THRESHOLD` in the progress repository. */
const COMPLETION_THRESHOLD = 0.9;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  favoriteIds: [...MOCK_SEEDED_FAVORITES],
  progress: [],
  watchStates: {},
  hydrated: false,

  toggleFavorite: (dramaId) =>
    set((state) => ({
      favoriteIds: state.favoriteIds.includes(dramaId)
        ? state.favoriteIds.filter((id) => id !== dramaId)
        : [dramaId, ...state.favoriteIds],
    })),

  isFavorite: (dramaId) => get().favoriteIds.includes(dramaId),

  recordProgress: ({ dramaId, episodeId, episodeNumber, positionSec, durationSec }) =>
    set((state) => {
      if (durationSec <= 0) return state;

      const existing = state.watchStates[episodeId];
      // Monotonic, matching both the server rule and the SQLite repository:
      // a replayed or out-of-order write must never rewind a viewer.
      const position = Math.max(existing?.positionSec ?? 0, Math.floor(positionSec));
      const isCompleted =
        (existing?.isCompleted ?? false) || position / durationSec >= COMPLETION_THRESHOLD;

      const others = state.progress.filter((entry) => entry.dramaId !== dramaId);
      const current = state.progress.find((entry) => entry.dramaId === dramaId);

      // Per-drama head: the furthest episode reached, and the position inside
      // it. Rewatching an earlier episode updates that episode but does not
      // move the head back.
      const headEpisode = Math.max(current?.episodeNumber ?? 0, episodeNumber);
      const headPosition = headEpisode === episodeNumber ? position : (current?.positionSec ?? 0);

      return {
        watchStates: { ...state.watchStates, [episodeId]: { positionSec: position, isCompleted } },
        progress: [
          {
            dramaId,
            episodeNumber: headEpisode,
            positionSec: headPosition,
            lastWatchedAt: new Date().toISOString(),
          },
          ...others,
        ],
      };
    }),

  resumePointFor: (dramaId) => get().progress.find((entry) => entry.dramaId === dramaId),

  snapshot: () => {
    const { favoriteIds, progress, watchStates } = get();
    return { favoriteIds, progress, watchStates };
  },

  applyPersisted: ({ progress, watchStates }) => set({ progress, watchStates, hydrated: true }),
}));

/**
 * Non-reactive read, for callers that need the current value without
 * subscribing — notably the query functions, which must not re-render anything
 * by reading state.
 */
export function librarySnapshot(): LibrarySnapshot {
  return useLibraryStore.getState().snapshot();
}

/**
 * Loads persisted progress into the store, seeding the sample data on a
 * genuinely fresh install.
 *
 * Idempotent and safe to call more than once: `seedIfAbsent` never overwrites
 * a row that exists, so a returning viewer's real progress is not replaced by
 * fixture values.
 */
export async function hydrateLibrary(): Promise<void> {
  const service = await getPlaybackService();

  await service.progress.seedIfAbsent(toSeedWrites());

  const [heads, episodes] = await Promise.all([
    service.progress.allDramaProgress(),
    service.progress.allEpisodeProgress(),
  ]);

  const watchStates: Record<string, WatchState> = {};
  for (const row of episodes) {
    watchStates[row.episodeId] = {
      positionSec: Math.floor(row.positionSec),
      isCompleted: row.isCompleted,
    };
  }

  useLibraryStore.getState().applyPersisted({
    progress: heads.map((head) => ({
      dramaId: head.dramaId,
      episodeNumber: head.episodeNumber,
      positionSec: Math.floor(head.positionSec),
      lastWatchedAt: head.lastWatchedAt,
    })),
    watchStates,
  });
}

/**
 * The M2.1 sample progress, as database writes.
 *
 * Still fixture data and still clearly marked as such — it exists so Continue
 * Watching is not empty on a fresh install, and it disappears the moment the
 * real catalogue arrives in M2.3.
 */
function toSeedWrites(): ProgressWrite[] {
  const writes: ProgressWrite[] = [];
  for (const entry of MOCK_SEEDED_PROGRESS) {
    const episode = episodesFor(entry.dramaId).find(
      (item) => item.episodeNumber === entry.episodeNumber,
    );
    if (!episode) continue;
    writes.push({
      dramaId: entry.dramaId,
      episodeId: episode.id,
      episodeNumber: entry.episodeNumber,
      positionSec: entry.positionSec,
      durationSec: episode.durationSec,
      occurredAtMs: Date.parse(entry.lastWatchedAt),
    });
  }
  return writes;
}
