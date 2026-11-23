import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Image, StyleSheet, View, type ImageStyle, type StyleProp } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '@minidrama/ui-tokens';
import { resolveArtwork } from '../../data/artwork';

/**
 * Renders a poster, banner or thumbnail from a contract `*Url` string.
 *
 * The contract types these as strings because in production they are CDN URLs
 * resolved server-side from R2 storage keys. In M2.1 they are
 * `minidrama-asset://` sentinels pointing at bundled generated artwork. This
 * component is the only place that knows the difference — a bundled image
 * resolves through `resolveArtwork`, anything else falls through to a remote
 * URI, so the day M3 serves real URLs nothing above this changes.
 *
 * A failed load renders a placeholder frame rather than an empty hole.
 * CLAUDE.md §9: no screen shows a placeholder-looking layout, including when
 * an image is missing.
 */

export interface ArtworkProps {
  url: string;
  style: StyleProp<ImageStyle>;
  /** `cover` for posters and banners; `contain` only where cropping is wrong. */
  contentFit?: 'cover' | 'contain';
  accessibilityLabel?: string;
  /** Rounded corners need to clip the fallback frame too. */
  borderRadius?: number;
}

export function Artwork({
  url,
  style,
  contentFit = 'cover',
  accessibilityLabel,
  borderRadius = 0,
}: ArtworkProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const bundled = useMemo(() => resolveArtwork(url), [url]);

  if (failed || (!bundled && url.length === 0)) {
    return (
      <View style={[styles.fallback, { borderRadius }, style]}>
        <Ionicons name="film-outline" size={24} color={colors.text.tertiary} />
      </View>
    );
  }

  return (
    <Image
      source={bundled ?? { uri: url }}
      style={style}
      resizeMode={contentFit}
      onError={() => setFailed(true)}
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
      accessibilityIgnoresInvertColors
      // Cache artwork aggressively: a rail scrolls back and forth constantly
      // and re-decoding a poster on every pass is wasted work (CLAUDE.md §13).
      fadeDuration={160}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.bg.card,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
