import { prisma } from '../../services/prisma.js';
import type { DramaSort } from '@minidrama/contracts';

/**
 * Catalogue queries. Module-private — callers use catalogue.service
 * (SYSTEM_ARCHITECTURE.md §2, lint-enforced).
 *
 * PUBLISHED-ONLY IS A REPOSITORY CONCERN, NOT A CALLER'S.
 * Every function here filters on `status: PUBLISHED` and `archivedAt: null`.
 * Making it the caller's job is how a draft drama reaches an endpoint nobody
 * thought to filter — the only way to be sure is for the query to be unable to
 * return one.
 */

/** Shared across every drama read, so one card shape has one query shape. */
const dramaCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  posterKey: true,
  coverKey: true,
  trailerPlaybackId: true,
  contentRating: true,
  releaseStatus: true,
  totalEpisodes: true,
  freeEpisodeCount: true,
  publishedAt: true,
  popularityScore: true,
  language: { select: { id: true, code: true, name: true, nativeName: true } },
  /*
   * Joined in one query rather than fetched per drama. This is the N+1 the
   * module would otherwise have: twenty cards, each needing its genres and
   * its English title, is forty extra round trips.
   */
  categories: { select: { category: { select: { name: true } } } },
  translations: {
    where: { language: { code: 'en' } },
    select: { title: true, description: true },
    take: 1,
  },
} as const;

const PUBLISHED_DRAMA = {
  status: 'PUBLISHED',
  archivedAt: null,
} as const;

/**
 * Cursor ordering.
 *
 * Every sort is tie-broken by `id`, which is what makes the cursor stable.
 * `popularityScore` and `publishedAt` are not unique — two dramas sharing a
 * score would otherwise page inconsistently, skipping one and repeating the
 * other.
 */
function orderFor(sort: DramaSort) {
  switch (sort) {
    case 'recent':
      return [{ publishedAt: 'desc' as const }, { id: 'asc' as const }];
    case 'title':
      return [{ title: 'asc' as const }, { id: 'asc' as const }];
    case 'popular':
    default:
      return [{ popularityScore: 'desc' as const }, { id: 'asc' as const }];
  }
}

export interface ListDramasParams {
  limit: number;
  cursor?: string | undefined;
  languageId?: string | undefined;
  categoryId?: string | undefined;
  sort: DramaSort;
  /** Free-text, already trimmed. Empty means "no text filter". */
  query?: string | undefined;
}

export async function listDramas(params: ListDramasParams) {
  const where = {
    ...PUBLISHED_DRAMA,
    ...(params.languageId ? { languageId: params.languageId } : {}),
    ...(params.categoryId ? { categories: { some: { categoryId: params.categoryId } } } : {}),
    ...(params.query
      ? {
          /*
           * Search across the drama's own title and its translations, so
           * "Rain Memories" finds a drama titled "Mazhai Ninaivugal".
           *
           * `contains` with `insensitive` is ILIKE. DISC-06 specifies trigram
           * search with a GIN index; that is an M6 concern and needs the
           * pg_trgm extension. At two-digit catalogue size ILIKE is correct
           * and costs nothing — adding an index for it now would be an index
           * sized for data that does not exist.
           */
          OR: [
            { title: { contains: params.query, mode: 'insensitive' as const } },
            {
              translations: {
                some: { title: { contains: params.query, mode: 'insensitive' as const } },
              },
            },
            {
              categories: {
                some: {
                  category: { name: { contains: params.query, mode: 'insensitive' as const } },
                },
              },
            },
          ],
        }
      : {}),
  };

  // One extra row decides `hasMore` without a second COUNT query.
  const rows = await prisma.drama.findMany({
    where,
    select: dramaCardSelect,
    orderBy: orderFor(params.sort),
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function findDramaBySlug(slug: string) {
  return prisma.drama.findFirst({
    where: { slug, ...PUBLISHED_DRAMA },
    select: {
      ...dramaCardSelect,
      seasons: {
        where: { status: 'PUBLISHED' },
        select: { id: true, seasonNumber: true },
        orderBy: { seasonNumber: 'asc' },
        take: 1,
      },
    },
  });
}

export async function findDramaById(id: string) {
  return prisma.drama.findFirst({
    where: { id, ...PUBLISHED_DRAMA },
    select: { id: true, slug: true },
  });
}

export interface ListEpisodesParams {
  dramaId: string;
  limit: number;
  cursor?: string | undefined;
}

export async function listEpisodes(params: ListEpisodesParams) {
  const rows = await prisma.episode.findMany({
    where: {
      status: 'PUBLISHED',
      season: {
        status: 'PUBLISHED',
        dramaId: params.dramaId,
        drama: PUBLISHED_DRAMA,
      },
    },
    select: {
      id: true,
      episodeNumber: true,
      title: true,
      description: true,
      thumbnailKey: true,
      durationSec: true,
      accessType: true,
      coinPrice: true,
      season: { select: { dramaId: true, drama: { select: { slug: true } } } },
    },
    orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

/** Published episode plus the drama it belongs to. Used by playback. */
export async function findPublishedEpisode(episodeId: string) {
  return prisma.episode.findFirst({
    where: {
      id: episodeId,
      status: 'PUBLISHED',
      season: { status: 'PUBLISHED', drama: PUBLISHED_DRAMA },
    },
    select: {
      id: true,
      episodeNumber: true,
      durationSec: true,
      accessType: true,
      videoPlaybackId: true,
      season: { select: { dramaId: true } },
    },
  });
}

export async function listCategories() {
  return prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, slug: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function listLanguages() {
  return prisma.language.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, nativeName: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/**
 * The caller's favourites among a given set of dramas.
 *
 * One query for a page of cards, rather than one per card. A guest skips it
 * entirely — see the early return in the service.
 */
export async function favoritedDramaIds(
  userId: string,
  dramaIds: readonly string[],
): Promise<Set<string>> {
  if (dramaIds.length === 0) return new Set();
  const rows = await prisma.favorite.findMany({
    where: { userId, dramaId: { in: [...dramaIds] } },
    select: { dramaId: true },
  });
  return new Set(rows.map((row) => row.dramaId));
}

/** Watch state for a page of episodes, keyed by episode id. */
export async function watchStatesFor(
  userId: string,
  episodeIds: readonly string[],
): Promise<Map<string, { positionSec: number; isCompleted: boolean }>> {
  if (episodeIds.length === 0) return new Map();
  const rows = await prisma.watchHistory.findMany({
    where: { userId, episodeId: { in: [...episodeIds] } },
    select: { episodeId: true, positionSec: true, isCompleted: true },
  });
  return new Map(
    rows.map((row) => [
      row.episodeId,
      { positionSec: row.positionSec, isCompleted: row.isCompleted },
    ]),
  );
}

/** Featured drama for the home banner, or the most popular one as a fallback. */
export async function findFeaturedDrama() {
  const featured = await prisma.drama.findFirst({
    where: { ...PUBLISHED_DRAMA, isFeatured: true },
    select: {
      ...dramaCardSelect,
      seasons: {
        where: { status: 'PUBLISHED' },
        select: { seasonNumber: true },
        orderBy: { seasonNumber: 'asc' },
        take: 1,
      },
    },
    orderBy: { popularityScore: 'desc' },
  });
  if (featured) return featured;

  return prisma.drama.findFirst({
    where: PUBLISHED_DRAMA,
    select: {
      ...dramaCardSelect,
      seasons: {
        where: { status: 'PUBLISHED' },
        select: { seasonNumber: true },
        orderBy: { seasonNumber: 'asc' },
        take: 1,
      },
    },
    orderBy: { popularityScore: 'desc' },
  });
}
