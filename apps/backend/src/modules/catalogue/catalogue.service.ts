import type {
  Category,
  DramaDetail,
  DramaListQuery,
  DramaPage,
  EpisodePage,
  HomePayload,
  HomeRail,
  Language,
  SearchResult,
} from '@minidrama/contracts';
import * as library from '../library/library.service.js';
import { AppError } from '../../utils/app-error.js';
import * as repo from './catalogue.repository.js';
import {
  toCategory,
  toDramaCard,
  toDramaDetail,
  toEpisodeSummary,
  toLanguage,
} from './catalogue.mapper.js';

/**
 * Catalogue business logic. The only entry point other modules may use.
 *
 * `userId` is always a parameter and never read from a request — services do
 * not know what HTTP is. A null userId is a guest, which is a supported state
 * rather than an error (PRD AUTH-03).
 */

const EMPTY_FAVORITES: ReadonlySet<string> = new Set();

/** Favourites for a page of dramas, or an empty set for a guest. */
async function favoritesFor(
  userId: string | null,
  dramaIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!userId) return EMPTY_FAVORITES;
  return repo.favoritedDramaIds(userId, dramaIds);
}

export async function listDramas(query: DramaListQuery, userId: string | null): Promise<DramaPage> {
  const page = await repo.listDramas({
    limit: query.limit,
    cursor: query.cursor,
    languageId: query.languageId,
    categoryId: query.categoryId,
    sort: query.sort,
  });

  const favorites = await favoritesFor(
    userId,
    page.items.map((row) => row.id),
  );

  return {
    items: page.items.map((row) => toDramaCard(row, favorites)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getDramaBySlug(slug: string, userId: string | null): Promise<DramaDetail> {
  const row = await repo.findDramaBySlug(slug);
  if (!row) throw AppError.notFound('That drama');

  const favorites = await favoritesFor(userId, [row.id]);
  return toDramaDetail(row, row.seasons[0]?.seasonNumber ?? 1, favorites);
}

export async function listEpisodes(
  dramaId: string,
  query: { limit: number; cursor?: string | undefined },
  userId: string | null,
): Promise<EpisodePage> {
  // Confirms the drama exists and is published before listing anything, so an
  // unpublished id returns 404 rather than an empty list — an empty list would
  // be indistinguishable from a drama with no episodes.
  const drama = await repo.findDramaById(dramaId);
  if (!drama) throw AppError.notFound('That drama');

  const page = await repo.listEpisodes({
    dramaId,
    limit: query.limit,
    cursor: query.cursor,
  });

  // One query for the whole page's watch state, not one per episode.
  const watchStates = userId
    ? await repo.watchStatesFor(
        userId,
        page.items.map((row) => row.id),
      )
    : new Map();

  return {
    items: page.items.map((row) => toEpisodeSummary(row, watchStates.get(row.id) ?? null)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function search(
  params: { q: string; languageId?: string | undefined; categoryId?: string | undefined },
  userId: string | null,
): Promise<SearchResult> {
  const trimmed = params.q.trim();

  const page = await repo.listDramas({
    limit: 50,
    sort: 'popular',
    languageId: params.languageId,
    categoryId: params.categoryId,
    query: trimmed.length > 0 ? trimmed : undefined,
  });

  const favorites = await favoritesFor(
    userId,
    page.items.map((row) => row.id),
  );

  return {
    query: trimmed,
    results: page.items.map((row) => toDramaCard(row, favorites)),
    trending: await trendingTerms(),
  };
}

/**
 * Trending search terms.
 *
 * DISC-07 specifies these come from recorded `SearchQuery` rows. That model is
 * deferred (DATABASE_SCHEMA.md §9.2) and no search has ever been recorded, so
 * there is nothing to rank. Derived from the catalogue instead — the most
 * popular dramas' titles and the active genres — which is honest about being
 * a stand-in rather than inventing engagement data.
 */
async function trendingTerms(): Promise<string[]> {
  const [popular, categories] = await Promise.all([
    repo.listDramas({ limit: 3, sort: 'popular' }),
    repo.listCategories(),
  ]);

  const terms = [
    ...popular.items.map((row) => row.title.split(' ')[0] ?? row.title),
    ...categories.slice(0, 2).map((category) => category.name),
  ];

  return [...new Set(terms)].slice(0, 5);
}

export async function listCategories(): Promise<Category[]> {
  return (await repo.listCategories()).map(toCategory);
}

export async function listLanguages(): Promise<Language[]> {
  return (await repo.listLanguages()).map(toLanguage);
}

/** Resolves a published episode for playback, or throws. */
export async function getPublishedEpisode(episodeId: string) {
  const episode = await repo.findPublishedEpisode(episodeId);
  if (!episode) throw AppError.notFound('That episode');
  return episode;
}

/** The home banner's drama, or null when the catalogue is empty. */
export async function getFeaturedDrama(userId: string | null): Promise<DramaDetail | null> {
  const row = await repo.findFeaturedDrama();
  if (!row) return null;
  const favorites = await favoritesFor(userId, [row.id]);
  return toDramaDetail(row, row.seasons[0]?.seasonNumber ?? 1, favorites);
}

/**
 * The composed home payload.
 *
 * Built from parallel queries rather than sequentially: the rails are
 * independent, and awaiting them one after another turns four fast queries
 * into one slow response.
 *
 * Empty rails are omitted rather than returned empty (API_DOCUMENTATION.md
 * §4). The client renders what it is given and does not decide which rails
 * exist, which is what lets the rail set change without an app release.
 */
export async function getHome(userId: string | null): Promise<HomePayload> {
  const [featured, trending, recent, categories, languages, continueItems] = await Promise.all([
    getFeaturedDrama(userId),
    listDramas({ limit: 12, sort: 'popular' }, userId),
    listDramas({ limit: 12, sort: 'recent' }, userId),
    listCategories(),
    listLanguages(),
    userId ? library.continueWatching(userId, 12) : Promise.resolve([]),
  ]);

  const rails: HomeRail[] = [];

  if (continueItems.length > 0) {
    rails.push({ key: 'continue_watching', title: 'Continue Watching', items: continueItems });
  }
  if (trending.items.length > 0) {
    rails.push({ key: 'trending', title: 'Trending Now', items: trending.items });
  }

  // The launch catalogue is Tamil-first (PRD §1). The rail is driven by the
  // language's own id rather than a hard-coded list, so adding Telugu content
  // does not require a code change here.
  const tamil = languages.find((language) => language.code === 'ta');
  if (tamil) {
    const popularTamil = await listDramas(
      { limit: 12, sort: 'popular', languageId: tamil.id },
      userId,
    );
    if (popularTamil.items.length > 0) {
      rails.push({
        key: 'popular_tamil',
        title: 'Popular Tamil Dramas',
        items: popularTamil.items,
      });
    }
  }

  if (recent.items.length > 0) {
    rails.push({ key: 'new', title: 'Recently Added', items: recent.items });
  }

  return { featured, rails, categories, languages };
}
