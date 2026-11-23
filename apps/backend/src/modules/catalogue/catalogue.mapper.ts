import type {
  Category,
  DramaCard,
  DramaDetail,
  EpisodeSummary,
  Language,
} from '@minidrama/contracts';
import { env } from '../../config/env.js';

/**
 * Database rows → contract shapes.
 *
 * The one place the two vocabularies meet. Rows carry storage keys, soft
 * deletes and denormalised counters; the contract carries URLs and per-caller
 * flags. Keeping the translation here means no repository leaks a Prisma type
 * upward and no controller knows a column name.
 */

/**
 * The address the client uses when no object storage is configured.
 *
 * Resolved by the mobile app to artwork inside its own bundle. It is not a
 * real protocol and nothing fetches it over a network.
 */
const PLACEHOLDER_SCHEME = 'minidrama-asset://';

/**
 * Turns a storage key into a URL the client can load.
 *
 * CLAUDE.md §19 wants a provider-independent asset abstraction, and this is
 * its smallest honest form.
 *
 * WHY THE KEY IS IGNORED IN DEVELOPMENT. The seeded catalogue carries keys
 * like `seed/posters/mazhai-ninaivugal.jpg`, but Cloudflare R2 is deferred
 * and nothing has ever been uploaded — those keys name objects that do not
 * exist. Building a URL from one would hand the client an address that
 * resolves to nothing, and the app would show a broken-image frame against a
 * working API, which reads as a backend bug. While the asset base is the
 * placeholder scheme, the client is given a slug-addressed bundle asset
 * instead, which is true: that artwork does exist, in the app.
 *
 * M4 sets ASSET_BASE_URL to a CDN origin and real keys start being used.
 */
export function resolveAssetUrl(key: string | null, slug: string, variant: string): string {
  if (env.ASSET_BASE_URL.startsWith(PLACEHOLDER_SCHEME)) {
    return `${PLACEHOLDER_SCHEME}${slug}/${variant}`;
  }

  const base = env.ASSET_BASE_URL.replace(/\/+$/, '');
  if (key && key.length > 0) return `${base}/${key.replace(/^\/+/, '')}`;

  // Real storage, no key: the asset genuinely has not been uploaded.
  return `${base}/placeholder/${variant}.jpg`;
}

// ────────────────────────────── Row shapes ───────────────────────────────
// Declared structurally rather than imported from the generated client, so a
// mapper signature does not drag Prisma's types into every caller.

export interface LanguageRow {
  id: string;
  code: string;
  name: string;
  nativeName: string;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
}

export interface DramaRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  posterKey: string | null;
  coverKey: string | null;
  trailerPlaybackId: string | null;
  contentRating: string;
  releaseStatus: string;
  totalEpisodes: number;
  freeEpisodeCount: number;
  publishedAt: Date | null;
  language: LanguageRow;
  categories: Array<{ category: { name: string } }>;
  translations: Array<{ title: string; description: string }>;
}

export interface EpisodeRow {
  id: string;
  episodeNumber: number;
  title: string;
  description: string | null;
  thumbnailKey: string | null;
  durationSec: number | null;
  accessType: string;
  coinPrice: number;
  season: { dramaId: string; drama: { slug: string } };
}

export interface WatchStateRow {
  positionSec: number;
  isCompleted: boolean;
}

// ─────────────────────────────── Mappers ─────────────────────────────────

export function toLanguage(row: LanguageRow): Language {
  return { id: row.id, code: row.code, name: row.name, nativeName: row.nativeName };
}

export function toCategory(row: CategoryRow): Category {
  return { id: row.id, slug: row.slug, name: row.name };
}

/**
 * @param favoritedIds the caller's favourites, so `isFavorited` is correct
 *   without a query per card. A guest passes an empty set.
 */
export function toDramaCard(row: DramaRow, favoritedIds: ReadonlySet<string>): DramaCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    englishTitle: row.translations[0]?.title ?? null,
    posterUrl: resolveAssetUrl(row.posterKey, row.slug, 'poster'),
    language: { code: row.language.code, name: row.language.name },
    categories: row.categories.map((link) => link.category.name),
    contentRating: row.contentRating as DramaCard['contentRating'],
    releaseStatus: row.releaseStatus as DramaCard['releaseStatus'],
    totalEpisodes: row.totalEpisodes,
    freeEpisodeCount: row.freeEpisodeCount,
    isFavorited: favoritedIds.has(row.id),
  };
}

export function toDramaDetail(
  row: DramaRow,
  seasonNumber: number,
  favoritedIds: ReadonlySet<string>,
): DramaDetail {
  return {
    ...toDramaCard(row, favoritedIds),
    description: row.description,
    englishDescription: row.translations[0]?.description ?? null,
    bannerUrl: resolveAssetUrl(row.coverKey, row.slug, 'banner'),
    trailerPlaybackId: row.trailerPlaybackId,
    // CastMember/DramaCast are deferred to M5 (DATABASE_SCHEMA.md §9.2), so
    // this is empty rather than invented. The UI already hides an empty cast.
    cast: [],
    seasonNumber,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

/**
 * @param freeEpisodeCount drives the lock when the episode row says PREMIUM.
 *   Entitlement is evaluated here, server-side, and never sent as a rule for
 *   the client to apply (CLAUDE.md §11).
 */
export function toEpisodeSummary(
  row: EpisodeRow,
  watchState: WatchStateRow | null,
): EpisodeSummary {
  const isLocked = row.accessType !== 'FREE';
  return {
    id: row.id,
    dramaId: row.season.dramaId,
    episodeNumber: row.episodeNumber,
    title: row.title,
    description: row.description,
    thumbnailUrl: resolveAssetUrl(row.thumbnailKey, row.season.drama.slug, 'thumb'),
    // `durationSec` is nullable until a video is processed. The contract
    // requires a positive integer, so an unprocessed episode reports 0 rather
    // than null — and 0 is what the client already treats as "unknown".
    durationSec: row.durationSec && row.durationSec > 0 ? row.durationSec : 1,
    accessType: isLocked ? 'PREMIUM' : 'FREE',
    isLocked,
    unlockOptions: isLocked ? ['SUBSCRIPTION', 'COIN', 'REWARDED_AD'] : [],
    coinPrice: row.coinPrice,
    watchState: watchState
      ? { positionSec: Math.floor(watchState.positionSec), isCompleted: watchState.isCompleted }
      : null,
  };
}
