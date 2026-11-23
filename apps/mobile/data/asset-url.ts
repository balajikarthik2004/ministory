/**
 * The `minidrama-asset://` URL scheme, and the set of dramas that have
 * artwork.
 *
 * Deliberately free of any React Native import and of the `require()` calls
 * that bundle the images — those live in `artwork.ts`. Keeping the scheme
 * separate has two benefits:
 *
 *   1. `catalogue.mock.ts` can be loaded and validated outside Metro, by
 *      plain Node, which is what `tools/verify-mock-catalogue.mjs` does. A
 *      module that `require()`s a PNG cannot be.
 *   2. `ARTWORK_SLUGS` is the contract rather than a by-product of it: adding
 *      a slug here without generating and registering its three images is a
 *      type error in `artwork.ts`, caught at compile time rather than as a
 *      blank card on a device.
 */

export const ARTWORK_SLUGS = [
  'mazhai-ninaivugal',
  'nila-theru-rahasiyam',
  'kadhal-kanakku',
  'iravu-rayil',
  'veliyil-oru-veedu',
  'nizhal-vettai',
  'kaanal-neer',
  'pournami-kadhai',
] as const;

export type ArtworkSlug = (typeof ARTWORK_SLUGS)[number];
export type ArtworkVariant = 'poster' | 'banner' | 'thumb';

/**
 * Not a real protocol — a sentinel the mock emits where the production API
 * returns a CDN URL.
 *
 * The contract types `posterUrl` and friends as strings because in production
 * they are URLs the backend resolves from R2 storage keys
 * (API_DOCUMENTATION.md §4). Emitting a URL-shaped value here rather than
 * smuggling a `require()` id into the contract means the type the mock
 * produces is exactly the type the real endpoint will produce, and the only
 * component that has to care is `Artwork`.
 */
export const ASSET_SCHEME = 'minidrama-asset://';

export function assetUrl(slug: ArtworkSlug, variant: ArtworkVariant): string {
  return `${ASSET_SCHEME}${slug}/${variant}`;
}

export interface ParsedAssetUrl {
  slug: ArtworkSlug;
  variant: ArtworkVariant;
}

const VARIANTS: readonly ArtworkVariant[] = ['poster', 'banner', 'thumb'];

export function parseAssetUrl(url: string): ParsedAssetUrl | null {
  if (!url.startsWith(ASSET_SCHEME)) return null;
  const [slug, variant] = url.slice(ASSET_SCHEME.length).split('/');
  if (!slug || !variant) return null;
  if (!(ARTWORK_SLUGS as readonly string[]).includes(slug)) return null;
  if (!(VARIANTS as readonly string[]).includes(variant)) return null;
  return { slug: slug as ArtworkSlug, variant: variant as ArtworkVariant };
}
