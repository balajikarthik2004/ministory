import { z } from 'zod';

/**
 * Catalogue contract — the shapes behind API_DOCUMENTATION.md §4.
 *
 * These are *response* shapes, not database models. The distinction matters:
 * `Drama` in prisma/schema.prisma carries `posterKey` (a storage key) and
 * denormalised counters the client has no business seeing, while `DramaCard`
 * below carries `posterUrl` because resolving a storage key to a CDN URL is a
 * backend concern (API_DOCUMENTATION.md §4). One is the row; the other is what
 * a viewer is allowed to know about it.
 *
 * The mobile app's M2.1 mock data is validated against these schemas at module
 * load, so a mock that drifts from the contract fails loudly in development
 * rather than quietly shaping a screen that the real API will not fit.
 */

// ───────────────────────────── Enum mirrors ──────────────────────────────
// Mirrors of the Prisma enums. Declared here rather than imported because
// `@minidrama/contracts` is consumed by the mobile app, and the mobile app
// must never depend on the backend's generated Prisma client.

export const contentRatingSchema = z.enum(['U', 'UA_7', 'UA_13', 'UA_16', 'A']);
export type ContentRating = z.infer<typeof contentRatingSchema>;

export const releaseStatusSchema = z.enum(['UPCOMING', 'ONGOING', 'COMPLETED']);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const accessTypeSchema = z.enum(['FREE', 'PREMIUM']);
export type AccessType = z.infer<typeof accessTypeSchema>;

/** PRD PD-1. Which routes out of a lock the backend is offering this caller. */
export const unlockOptionSchema = z.enum(['SUBSCRIPTION', 'COIN', 'REWARDED_AD']);
export type UnlockOption = z.infer<typeof unlockOptionSchema>;

// ──────────────────────────── Reference data ─────────────────────────────

export const languageSchema = z.object({
  id: z.string(),
  /** ISO 639-1. */
  code: z.string().min(2).max(5),
  name: z.string(),
  /** "தமிழ்" — shown in the language picker so a user finds their own
   *  language without first reading English. */
  nativeName: z.string(),
});
export type Language = z.infer<typeof languageSchema>;

export const categorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type Category = z.infer<typeof categorySchema>;

/** The language stub embedded in a card, rather than the full record. */
export const languageRefSchema = languageSchema.pick({ code: true, name: true });
export type LanguageRef = z.infer<typeof languageRefSchema>;

// ──────────────────────────────── Dramas ─────────────────────────────────

/**
 * The one shape used everywhere a drama appears in a list.
 *
 * Keeping a single card shape is what lets `DramaRail` render Trending,
 * Recently Added and search results without a variant per rail.
 */
export const dramaCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  /** Localised title where one exists, else null. PRD PD-4. */
  englishTitle: z.string().nullable(),
  posterUrl: z.string(),
  language: languageRefSchema,
  categories: z.array(z.string()),
  contentRating: contentRatingSchema,
  releaseStatus: releaseStatusSchema,
  totalEpisodes: z.number().int().nonnegative(),
  freeEpisodeCount: z.number().int().nonnegative(),
  /** Per-caller. A guest always gets false. */
  isFavorited: z.boolean(),
});
export type DramaCard = z.infer<typeof dramaCardSchema>;

export const dramaDetailSchema = dramaCardSchema.extend({
  description: z.string(),
  englishDescription: z.string().nullable(),
  bannerUrl: z.string(),
  /** Null until a trailer is uploaded; the UI hides the action rather than
   *  showing a button that fails. */
  trailerPlaybackId: z.string().nullable(),
  cast: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
    }),
  ),
  seasonNumber: z.number().int().positive(),
  publishedAt: z.string().nullable(),
});
export type DramaDetail = z.infer<typeof dramaDetailSchema>;

// ─────────────────────────────── Episodes ────────────────────────────────

/** A viewer's position in one episode. Null when they have never opened it. */
export const watchStateSchema = z.object({
  positionSec: z.number().int().nonnegative(),
  isCompleted: z.boolean(),
});
export type WatchState = z.infer<typeof watchStateSchema>;

export const episodeSummarySchema = z.object({
  id: z.string(),
  dramaId: z.string(),
  episodeNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  thumbnailUrl: z.string(),
  durationSec: z.number().int().positive(),
  accessType: accessTypeSchema,
  /**
   * Computed per caller by the backend, never by the client.
   * CLAUDE.md §11: client-side entitlement is a suggestion, not a control.
   * The app uses this only to decide what to *draw*; the playback token
   * endpoint is what actually enforces access.
   */
  isLocked: z.boolean(),
  unlockOptions: z.array(unlockOptionSchema),
  coinPrice: z.number().int().nonnegative(),
  watchState: watchStateSchema.nullable(),
});
export type EpisodeSummary = z.infer<typeof episodeSummarySchema>;

// ───────────────────────────── Home payload ──────────────────────────────

export const railKeySchema = z.enum([
  'continue_watching',
  'trending',
  'popular_tamil',
  'new',
  'recommended',
]);
export type RailKey = z.infer<typeof railKeySchema>;

/**
 * Continue Watching needs resume coordinates that a plain card does not carry,
 * so it is its own item type rather than a card with four optional fields.
 */
export const continueWatchingItemSchema = z.object({
  drama: dramaCardSchema,
  episodeId: z.string(),
  episodeNumber: z.number().int().positive(),
  positionSec: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
  lastWatchedAt: z.string(),
});
export type ContinueWatchingItem = z.infer<typeof continueWatchingItemSchema>;

/**
 * A rail is a discriminated union on `key` so that Continue Watching's richer
 * items do not force every other rail to carry nullable progress fields.
 */
export const continueWatchingRailSchema = z.object({
  key: z.literal('continue_watching'),
  title: z.string(),
  items: z.array(continueWatchingItemSchema),
});

export const dramaRailSchema = z.object({
  key: z.enum(['trending', 'popular_tamil', 'new', 'recommended']),
  title: z.string(),
  items: z.array(dramaCardSchema),
});

export const homeRailSchema = z.discriminatedUnion('key', [
  continueWatchingRailSchema,
  dramaRailSchema,
]);
export type HomeRail = z.infer<typeof homeRailSchema>;

export const homePayloadSchema = z.object({
  featured: dramaDetailSchema.nullable(),
  /** Empty rails are omitted by the server, not returned empty — the client
   *  renders what it is given rather than deciding which rails exist. */
  rails: z.array(homeRailSchema),
  categories: z.array(categorySchema),
  languages: z.array(languageSchema),
});
export type HomePayload = z.infer<typeof homePayloadSchema>;

// ──────────────────────────────── Search ─────────────────────────────────

export const searchQuerySchema = z.object({
  q: z.string().trim().max(80).default(''),
  languageId: z.string().optional(),
  categoryId: z.string().optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  results: z.array(dramaCardSchema),
  trending: z.array(z.string()),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

// ───────────────────────── List queries (M2.3) ───────────────────────────

/**
 * Sort orders the catalogue endpoints accept.
 *
 * A closed set, not a free-text column name: `?sort=` reaching an ORDER BY is
 * how an injection or an unindexed full-table sort gets in. Each value maps to
 * a known, indexed ordering server-side.
 */
export const dramaSortSchema = z.enum(['popular', 'recent', 'title']);
export type DramaSort = z.infer<typeof dramaSortSchema>;

/**
 * Cursor pagination.
 *
 * Cursor rather than offset, as `paginationQuerySchema` already establishes:
 * a feed that pages by offset duplicates and skips rows whenever anything is
 * inserted between requests, which for a catalogue that publishes daily is
 * every request.
 */
export const dramaListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  languageId: z.string().optional(),
  categoryId: z.string().optional(),
  sort: dramaSortSchema.default('popular'),
});
export type DramaListQuery = z.infer<typeof dramaListQuerySchema>;

export const episodeListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type EpisodeListQuery = z.infer<typeof episodeListQuerySchema>;

/** `{ items, nextCursor, hasMore }` — the shape every list endpoint returns. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}

export const dramaPageSchema = paginatedSchema(dramaCardSchema);
export type DramaPage = z.infer<typeof dramaPageSchema>;

export const episodePageSchema = paginatedSchema(episodeSummarySchema);
export type EpisodePage = z.infer<typeof episodePageSchema>;

export const categoryListSchema = z.array(categorySchema);
export const languageListSchema = z.array(languageSchema);
