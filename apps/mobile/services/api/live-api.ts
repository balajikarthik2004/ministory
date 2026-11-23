import { z } from 'zod';
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
import {
  categoryListSchema,
  continueWatchingItemSchema,
  dramaCardSchema,
  dramaDetailSchema,
  dramaPageSchema,
  episodePageSchema,
  homePayloadSchema,
  languageListSchema,
  playbackTicketSchema,
  searchResultSchema,
  userProfileSchema,
  watchHistoryEntrySchema,
} from '@minidrama/contracts';
import { FIXTURE_BASE_URL } from '../config';
import { request } from './http-client';
import type { LibrarySnapshot } from '../../store/library.store';

/**
 * The live API.
 *
 * Signature-for-signature identical to `mock-api.ts`, so `services/api`
 * can hand either one to the query layer and no screen knows which is in
 * play. The `LibrarySnapshot` parameters are accepted and ignored: the mock
 * needs them to compute `isFavorited` locally, while the server computes it
 * from the caller's own favourites. Keeping the parameter is what makes the
 * two interchangeable without a wrapper per function.
 */

// ────────────────────────────── Catalogue ────────────────────────────────

export async function fetchHome(_library: LibrarySnapshot): Promise<HomePayload> {
  return request('/home', homePayloadSchema, { authenticated: true });
}

export async function fetchDramaBySlug(
  slug: string,
  _library: LibrarySnapshot,
): Promise<DramaDetail> {
  return request(`/dramas/${encodeURIComponent(slug)}`, dramaDetailSchema, {
    authenticated: true,
  });
}

export async function fetchEpisodes(
  dramaId: string,
  _library: LibrarySnapshot,
): Promise<EpisodeSummary[]> {
  const page = await request(`/dramas/${encodeURIComponent(dramaId)}/episodes`, episodePageSchema, {
    query: { limit: 100 },
    authenticated: true,
  });
  return page.items;
}

export async function searchDramas(
  params: { q: string; categoryId?: string; languageId?: string },
  _library: LibrarySnapshot,
): Promise<SearchResult> {
  return request('/search', searchResultSchema, {
    query: {
      q: params.q,
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.languageId ? { languageId: params.languageId } : {}),
    },
    authenticated: true,
  });
}

export async function fetchCategories() {
  return request('/categories', categoryListSchema);
}

export async function fetchLanguages() {
  return request('/languages', languageListSchema);
}

export async function fetchDramaPage(params: {
  limit?: number;
  cursor?: string;
  languageId?: string;
  categoryId?: string;
  sort?: 'popular' | 'recent' | 'title';
}) {
  return request('/dramas', dramaPageSchema, {
    query: {
      limit: params.limit ?? 20,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.languageId ? { languageId: params.languageId } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      sort: params.sort ?? 'popular',
    },
    authenticated: true,
  });
}

// ─────────────────────────────── Library ─────────────────────────────────

const favoritesPageSchema = z.object({
  items: z.array(dramaCardSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const historyPageSchema = z.object({
  items: z.array(watchHistoryEntrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export async function fetchFavorites(_library: LibrarySnapshot): Promise<DramaCard[]> {
  const page = await request('/me/favorites', favoritesPageSchema, {
    query: { limit: 50 },
    authenticated: true,
  });
  return page.items;
}

export async function fetchHistory(_library: LibrarySnapshot): Promise<WatchHistoryEntry[]> {
  const page = await request('/me/history', historyPageSchema, {
    query: { limit: 50 },
    authenticated: true,
  });
  return page.items;
}

export async function fetchContinueWatching(
  _library: LibrarySnapshot,
): Promise<ContinueWatchingItem[]> {
  return request('/me/continue-watching', z.array(continueWatchingItemSchema), {
    query: { limit: 20 },
    authenticated: true,
  });
}

export async function fetchProfile(): Promise<UserProfile> {
  return request('/me/profile', userProfileSchema, { authenticated: true });
}

const favoriteResultSchema = z.object({ dramaId: z.string(), isFavorited: z.boolean() });

export async function addFavorite(dramaId: string): Promise<void> {
  await request(`/me/favorites/${encodeURIComponent(dramaId)}`, favoriteResultSchema, {
    method: 'POST',
    authenticated: true,
  });
}

export async function removeFavorite(dramaId: string): Promise<void> {
  await request(`/me/favorites/${encodeURIComponent(dramaId)}`, favoriteResultSchema, {
    method: 'DELETE',
    authenticated: true,
  });
}

const progressResultSchema = z.object({
  episodeId: z.string(),
  positionSec: z.number(),
  isCompleted: z.boolean(),
  applied: z.boolean(),
});

export async function putProgress(input: {
  episodeId: string;
  dramaId: string;
  episodeNumber: number;
  positionSec: number;
  durationSec: number;
  occurredAt?: string;
}): Promise<void> {
  await request(`/me/history/${encodeURIComponent(input.episodeId)}`, progressResultSchema, {
    method: 'PUT',
    authenticated: true,
    body: {
      dramaId: input.dramaId,
      episodeNumber: input.episodeNumber,
      positionSec: input.positionSec,
      durationSec: input.durationSec,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
  });
}

// ────────────────────────────── Playback ─────────────────────────────────

/**
 * A playback ticket.
 *
 * NOT YET A SERVER ENDPOINT. `POST /playback/episodes/:id/token` is M4 — it
 * needs the signing key and the entitlement evaluation that come with the
 * real video provider, and CLAUDE.md §16.13 forbids inventing an endpoint.
 *
 * So the ticket is still assembled on the client from catalogue data the
 * server did return, pointed at the local FFmpeg fixtures. The lock is
 * enforced from the server's own `isLocked`, which is computed server-side —
 * the client is applying a decision, not making one. M4 replaces this
 * function body with the real call and the player does not change.
 */
export async function requestPlaybackTicket(
  episodeId: string,
  library: LibrarySnapshot,
): Promise<PlaybackTicket> {
  const { AppError, messageFor } = await import('../errors');

  // The episode's own drama, so the sibling list can be resolved.
  const dramaId = episodeId.split('_s1_')[0] ?? '';
  const episodes = await fetchEpisodes(dramaId, library);

  const episode = episodes.find((item) => item.id === episodeId);
  if (!episode) throw new AppError('NOT_FOUND', messageFor('NOT_FOUND'));

  if (episode.isLocked) {
    throw new AppError('EPISODE_LOCKED', messageFor('EPISODE_LOCKED'), {
      episodeId: episode.id,
      episodeNumber: episode.episodeNumber,
      unlockOptions: episode.unlockOptions,
      coinPrice: episode.coinPrice,
    });
  }

  const next = episodes.find((item) => item.episodeNumber === episode.episodeNumber + 1);
  const resume = episode.watchState;

  return playbackTicketSchema.parse({
    episodeId: episode.id,
    playbackUrl: `${FIXTURE_BASE_URL}/${fixtureNameFor(episode.episodeNumber)}/master.m3u8`,
    expiresAt: new Date(Date.now() + Math.max(episode.durationSec * 2, 300) * 1000).toISOString(),
    durationSec: episode.durationSec,
    startPositionSec: resume?.isCompleted ? 0 : (resume?.positionSec ?? 0),
    subtitles: [],
    nextEpisodeId: next?.id ?? null,
  });
}

/**
 * Which generated fixture backs an episode.
 *
 * The seed writes the same mapping into `Episode.videoPlaybackId`, but that
 * column is not exposed to clients: under a signed-playback policy a playback
 * id is never served directly (CLAUDE.md §12, DATABASE_SCHEMA.md). Deriving
 * it here keeps that rule intact while the fixtures stand in for a provider.
 */
const FIXTURE_COUNT = 5;

function fixtureNameFor(episodeNumber: number): string {
  return `ep0${((episodeNumber - 1) % FIXTURE_COUNT) + 1}`;
}
