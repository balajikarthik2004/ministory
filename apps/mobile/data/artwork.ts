import type { ImageSourcePropType } from 'react-native';
import { parseAssetUrl, type ArtworkSlug, type ArtworkVariant } from './asset-url';

/**
 * Static registry of the generated placeholder artwork.
 *
 * Metro resolves `require()` of an image at bundle time, so the path cannot be
 * built from a variable — `require(\`./posters/${slug}.png\`)` does not work.
 * A literal map is the standard answer.
 *
 * The `satisfies Record<ArtworkSlug, DramaArtwork>` is what makes this safe:
 * adding a drama to `ARTWORK_SLUGS` without generating and registering its
 * three images is a compile error, not a blank card at runtime.
 *
 * The images come from `node tools/placeholder-art/generate.mjs`. They are
 * original abstract compositions generated offline — no reference app's assets
 * and no external image service (CLAUDE.md §16.16, §18).
 */

export interface DramaArtwork {
  poster: ImageSourcePropType;
  banner: ImageSourcePropType;
  thumb: ImageSourcePropType;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const ARTWORK = {
  'mazhai-ninaivugal': {
    poster: require('../assets/posters/mazhai-ninaivugal-poster.png'),
    banner: require('../assets/posters/mazhai-ninaivugal-banner.png'),
    thumb: require('../assets/posters/mazhai-ninaivugal-thumb.png'),
  },
  'nila-theru-rahasiyam': {
    poster: require('../assets/posters/nila-theru-rahasiyam-poster.png'),
    banner: require('../assets/posters/nila-theru-rahasiyam-banner.png'),
    thumb: require('../assets/posters/nila-theru-rahasiyam-thumb.png'),
  },
  'kadhal-kanakku': {
    poster: require('../assets/posters/kadhal-kanakku-poster.png'),
    banner: require('../assets/posters/kadhal-kanakku-banner.png'),
    thumb: require('../assets/posters/kadhal-kanakku-thumb.png'),
  },
  'iravu-rayil': {
    poster: require('../assets/posters/iravu-rayil-poster.png'),
    banner: require('../assets/posters/iravu-rayil-banner.png'),
    thumb: require('../assets/posters/iravu-rayil-thumb.png'),
  },
  'veliyil-oru-veedu': {
    poster: require('../assets/posters/veliyil-oru-veedu-poster.png'),
    banner: require('../assets/posters/veliyil-oru-veedu-banner.png'),
    thumb: require('../assets/posters/veliyil-oru-veedu-thumb.png'),
  },
  'nizhal-vettai': {
    poster: require('../assets/posters/nizhal-vettai-poster.png'),
    banner: require('../assets/posters/nizhal-vettai-banner.png'),
    thumb: require('../assets/posters/nizhal-vettai-thumb.png'),
  },
  'kaanal-neer': {
    poster: require('../assets/posters/kaanal-neer-poster.png'),
    banner: require('../assets/posters/kaanal-neer-banner.png'),
    thumb: require('../assets/posters/kaanal-neer-thumb.png'),
  },
  'pournami-kadhai': {
    poster: require('../assets/posters/pournami-kadhai-poster.png'),
    banner: require('../assets/posters/pournami-kadhai-banner.png'),
    thumb: require('../assets/posters/pournami-kadhai-thumb.png'),
  },
} satisfies Record<ArtworkSlug, DramaArtwork>;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Resolves a `minidrama-asset://` sentinel to a bundled image.
 *
 * Returns null for anything else — including a real `https://` URL, which the
 * `Artwork` component then loads over the network. That fall-through is the
 * whole point: when M3 starts returning CDN URLs, nothing here changes.
 */
export function resolveArtwork(url: string): ImageSourcePropType | null {
  const parsed = parseAssetUrl(url);
  if (!parsed) return null;
  const entry: Record<ArtworkVariant, ImageSourcePropType> = ARTWORK[parsed.slug];
  return entry[parsed.variant];
}
