import type {
  ContinueWatchingItem,
  DramaCard,
  DramaDetail,
  EpisodeSummary,
  HomePayload,
  HomeRail,
  PlaybackTicket,
  SearchResult,
  UserProfile,
  WatchHistoryEntry,
} from '@minidrama/contracts';
import { homePayloadSchema, playbackTicketSchema } from '@minidrama/contracts';
import {
  MOCK_CATALOGUE,
  MOCK_CATEGORIES,
  MOCK_LANGUAGES,
  MOCK_PROFILE,
  MOCK_TRENDING_SEARCHES,
  episodesFor,
  findDramaById,
  findDramaBySlug,
  fixtureForEpisode,
} from '../data/catalogue.mock';
import { FIXTURE_BASE_URL, MOCK_FAILURES_DEFAULT, MOCK_LATENCY_MS } from './config';
import { AppError, messageFor } from './errors';
import type { LibrarySnapshot } from '../store/library.store';

/**
 * MOCK API — M2.1 only.
 * ═════════════════════
 *
 * This module is the single boundary between the UI and "the server". Every
 * screen reaches data through a TanStack Query hook that calls one of these
 * functions, and no component imports `catalogue.mock` directly.
 *
 * That matters for M3. Replacing this file with real `fetch` calls against
 * `API_BASE_URL` changes nothing above it: the function signatures are the
 * endpoint shapes from docs/API_DOCUMENTATION.md §4–§6, and the return types
 * come from `@minidrama/contracts` rather than from the mock dataset.
 *
 * CLAUDE.md §16.12 — this is a clearly identified temporary implementation.
 * It is not wired to any production integration and must not ship.
 */

// ───────────────────────────── Plumbing ──────────────────────────────────

/**
 * Per-session failure switch, flipped from the Profile screen in development.
 *
 * Error and retry states that cannot be triggered do not get reviewed, and
 * "turn off Wi-Fi" is not a repeatable test. Module-level rather than in a
 * store because it is a property of the fake transport, not app state.
 */
let failureMode = MOCK_FAILURES_DEFAULT;

export function setMockFailureMode(enabled: boolean): void {
  failureMode = enabled;
}

export function getMockFailureMode(): boolean {
  return failureMode;
}

async function transport<T>(produce: () => T, latencyMs = MOCK_LATENCY_MS): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  if (failureMode) {
    throw new AppError('SERVICE_UNAVAILABLE', messageFor('SERVICE_UNAVAILABLE'));
  }
  return produce();
}

// ───────────────────────────── Projection ────────────────────────────────

/**
 * Projects a stored drama into the card shape, applying this viewer's state.
 *
 * In production the server does this: `isFavorited` is per-caller and is
 * resolved from the Favorite table. Here it is read from the local library
 * snapshot that the caller passes in — the UI never patches the field itself
 * after the fact, because that is how a list and its source drift apart.
 */
function toCard(drama: DramaDetail, library: LibrarySnapshot): DramaCard {
  return {
    id: drama.id,
    slug: drama.slug,
    title: drama.title,
    englishTitle: drama.englishTitle,
    posterUrl: drama.posterUrl,
    language: drama.language,
    categories: drama.categories,
    contentRating: drama.contentRating,
    releaseStatus: drama.releaseStatus,
    totalEpisodes: drama.totalEpisodes,
    freeEpisodeCount: drama.freeEpisodeCount,
    isFavorited: library.favoriteIds.includes(drama.id),
  };
}

function byPopularity(a: DramaDetail, b: DramaDetail): number {
  return (MOCK_CATALOGUE.popularity.get(b.id) ?? 0) - (MOCK_CATALOGUE.popularity.get(a.id) ?? 0);
}

function byRecency(a: DramaDetail, b: DramaDetail): number {
  const left = MOCK_CATALOGUE.publishedAt.get(a.id) ?? '';
  const right = MOCK_CATALOGUE.publishedAt.get(b.id) ?? '';
  return right.localeCompare(left);
}

function buildContinueWatching(library: LibrarySnapshot): ContinueWatchingItem[] {
  return library.progress
    .map((entry): ContinueWatchingItem | null => {
      const drama = findDramaById(entry.dramaId);
      if (!drama) return null;
      const episodes = episodesFor(entry.dramaId);
      const episode = episodes.find((item) => item.episodeNumber === entry.episodeNumber);
      if (!episode) return null;
      return {
        drama: toCard(drama, library),
        episodeId: episode.id,
        episodeNumber: episode.episodeNumber,
        positionSec: Math.min(entry.positionSec, episode.durationSec),
        durationSec: episode.durationSec,
        lastWatchedAt: entry.lastWatchedAt,
      };
    })
    .filter((item): item is ContinueWatchingItem => item !== null)
    .sort((a, b) => b.lastWatchedAt.localeCompare(a.lastWatchedAt));
}

// ────────────────────────────── Catalogue ────────────────────────────────

/** GET /home — the composed home payload, one round trip. */
export async function fetchHome(library: LibrarySnapshot): Promise<HomePayload> {
  return transport(() => {
    const dramas = [...MOCK_CATALOGUE.dramas];
    const featured =
      dramas.find((drama) => drama.id === MOCK_CATALOGUE.featuredId) ?? dramas[0] ?? null;

    const rails: HomeRail[] = [];

    const continueItems = buildContinueWatching(library);
    if (continueItems.length > 0) {
      rails.push({
        key: 'continue_watching',
        title: 'Continue Watching',
        items: continueItems,
      });
    }

    rails.push({
      key: 'trending',
      title: 'Trending Now',
      items: [...dramas].sort(byPopularity).map((drama) => toCard(drama, library)),
    });

    rails.push({
      key: 'popular_tamil',
      title: 'Popular Tamil Dramas',
      items: [...dramas]
        .filter((drama) => drama.language.code === 'ta')
        .sort(byPopularity)
        .map((drama) => toCard(drama, library)),
    });

    rails.push({
      key: 'new',
      title: 'Recently Added',
      items: [...dramas]
        .sort(byRecency)
        .slice(0, 6)
        .map((drama) => toCard(drama, library)),
    });

    // Rule-based stand-in for ADR-08's recommender: dramas matching a genre
    // the viewer has watched, minus the ones already in progress.
    const watchedGenres = new Set(
      library.progress
        .map((entry) => findDramaById(entry.dramaId))
        .flatMap((drama) => drama?.categories ?? []),
    );
    const inProgress = new Set(library.progress.map((entry) => entry.dramaId));
    const recommended = dramas
      .filter(
        (drama) =>
          !inProgress.has(drama.id) &&
          drama.categories.some((category) => watchedGenres.has(category)),
      )
      .sort(byPopularity);

    if (recommended.length > 0) {
      rails.push({
        key: 'recommended',
        title: 'For You',
        items: recommended.map((drama) => toCard(drama, library)),
      });
    }

    // Parsed, not cast. The mock is held to the same contract the real
    // endpoint will be, so a shape mistake here fails now instead of in M3.
    return homePayloadSchema.parse({
      featured: featured
        ? { ...featured, isFavorited: library.favoriteIds.includes(featured.id) }
        : null,
      rails,
      categories: [...MOCK_CATEGORIES],
      languages: [...MOCK_LANGUAGES],
    });
  });
}

/** GET /dramas/:idOrSlug */
export async function fetchDramaBySlug(
  slug: string,
  library: LibrarySnapshot,
): Promise<DramaDetail> {
  return transport(() => {
    const drama = findDramaBySlug(slug);
    if (!drama) throw new AppError('NOT_FOUND', messageFor('NOT_FOUND'));
    return { ...drama, isFavorited: library.favoriteIds.includes(drama.id) };
  });
}

/**
 * GET /dramas/:id/episodes
 *
 * Returns the viewer's watch state merged in, exactly as the real endpoint
 * does, so the episode list needs no second call.
 */
export async function fetchEpisodes(
  dramaId: string,
  library: LibrarySnapshot,
): Promise<EpisodeSummary[]> {
  return transport(() => {
    const episodes = episodesFor(dramaId);
    if (episodes.length === 0) throw new AppError('NOT_FOUND', messageFor('NOT_FOUND'));
    return episodes.map((episode) => {
      const watched = library.watchStates[episode.id];
      return { ...episode, watchState: watched ?? null };
    });
  });
}

/** GET /search */
export async function searchDramas(
  params: { q: string; categoryId?: string; languageId?: string },
  library: LibrarySnapshot,
): Promise<SearchResult> {
  return transport(() => {
    const needle = params.q.trim().toLowerCase();
    const categoryName = params.categoryId
      ? MOCK_CATEGORIES.find((category) => category.id === params.categoryId)?.name
      : undefined;
    const languageCode = params.languageId
      ? MOCK_LANGUAGES.find((language) => language.id === params.languageId)?.code
      : undefined;

    const results = MOCK_CATALOGUE.dramas
      .filter((drama) => {
        if (categoryName && !drama.categories.includes(categoryName)) return false;
        if (languageCode && drama.language.code !== languageCode) return false;
        if (needle.length === 0) return true;
        // Title in both scripts, plus genre, so "thriller" finds a thriller
        // and "Rain" finds "Mazhai Ninaivugal" by its English title.
        const haystack = [
          drama.title,
          drama.englishTitle ?? '',
          ...drama.categories,
          drama.language.name,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort(byPopularity)
      .map((drama) => toCard(drama, library));

    return {
      query: params.q,
      results,
      trending: [...MOCK_TRENDING_SEARCHES],
    };
  }, 260);
}

// ─────────────────────────────── Library ─────────────────────────────────

/** GET /me/favorites */
export async function fetchFavorites(library: LibrarySnapshot): Promise<DramaCard[]> {
  return transport(() =>
    library.favoriteIds
      .map((id) => findDramaById(id))
      .filter((drama): drama is DramaDetail => drama !== undefined)
      .map((drama) => toCard(drama, library)),
  );
}

/** GET /me/history */
export async function fetchHistory(library: LibrarySnapshot): Promise<WatchHistoryEntry[]> {
  return transport(() =>
    buildContinueWatching(library).map((item) => ({
      drama: item.drama,
      episodeId: item.episodeId,
      episodeNumber: item.episodeNumber,
      positionSec: item.positionSec,
      durationSec: item.durationSec,
      isCompleted: library.watchStates[item.episodeId]?.isCompleted ?? false,
      lastWatchedAt: item.lastWatchedAt,
    })),
  );
}

/** GET /me/continue-watching */
export async function fetchContinueWatching(
  library: LibrarySnapshot,
): Promise<ContinueWatchingItem[]> {
  return transport(() => buildContinueWatching(library));
}

/** GET /me/profile */
export async function fetchProfile(): Promise<UserProfile> {
  return transport(() => MOCK_PROFILE);
}

// ────────────────────────────── Playback ─────────────────────────────────

/**
 * The generated ABR fixtures, assigned to episodes round-robin.
 *
 * tools/video-fixtures/out-abr holds ep01..ep05, each a multi-variant HLS
 * ladder. There is no sixth fixture, so a ten-episode drama cycles through
 * them. The point is to exercise the player against a real adaptive manifest,
 * not to pretend each episode has unique footage.
 *
 * The mapping comes from `fixtureForEpisode` in the mock dataset, which is the
 * same function that decides each episode's reported `durationSec`. One table,
 * so the metadata cannot describe different media from the media served.
 */
function fixtureUrlFor(episodeNumber: number): string {
  return `${FIXTURE_BASE_URL}/${fixtureForEpisode(episodeNumber).id}/master.m3u8`;
}

/**
 * POST /playback/episodes/:id/token
 *
 * The security-critical path (API_DOCUMENTATION.md §5). Even in the mock, the
 * lock is enforced *here* rather than in the player: the player asks for a
 * ticket and is refused, which is exactly the control flow M4 will have when
 * the backend evaluates entitlement against the database. A player that
 * checked `episode.isLocked` itself would be a client-side entitlement
 * decision, and CLAUDE.md §11 forbids trusting one.
 */
export async function requestPlaybackTicket(
  episodeId: string,
  library: LibrarySnapshot,
): Promise<PlaybackTicket> {
  return transport(() => {
    let found: EpisodeSummary | undefined;
    let siblings: readonly EpisodeSummary[] = [];

    for (const [dramaId, episodes] of MOCK_CATALOGUE.episodesByDrama) {
      const match = episodes.find((episode) => episode.id === episodeId);
      if (match) {
        found = match;
        siblings = MOCK_CATALOGUE.episodesByDrama.get(dramaId) ?? [];
        break;
      }
    }

    if (!found) throw new AppError('NOT_FOUND', messageFor('NOT_FOUND'));

    if (found.isLocked) {
      throw new AppError('EPISODE_LOCKED', messageFor('EPISODE_LOCKED'), {
        episodeId: found.id,
        episodeNumber: found.episodeNumber,
        unlockOptions: found.unlockOptions,
        coinPrice: found.coinPrice,
      });
    }

    const next = siblings.find((episode) => episode.episodeNumber === found.episodeNumber + 1);
    const resume = library.watchStates[found.id];

    return playbackTicketSchema.parse({
      episodeId: found.id,
      playbackUrl: fixtureUrlFor(found.episodeNumber),
      // Mirrors the production rule: expiry is at least twice the episode
      // duration, so a ticket cannot expire mid-stream.
      expiresAt: new Date(Date.now() + Math.max(found.durationSec * 2, 300) * 1000).toISOString(),
      durationSec: found.durationSec,
      startPositionSec: resume?.isCompleted ? 0 : (resume?.positionSec ?? 0),
      // The fixture generator emits a WebVTT rendition inside master.m3u8, so
      // the track is selected through the manifest rather than listed here.
      // An invented subtitle URL would be a fabricated API value.
      subtitles: [],
      nextEpisodeId: next?.id ?? null,
    });
  }, 180);
}
