import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, spacing, typography } from '@minidrama/ui-tokens';
import { AppText } from '../primitives/AppText';

/**
 * The MiniDrama wordmark.
 *
 * Original, and drawn in React Native rather than shipped as an image file:
 * a vector-crisp mark at every density, no asset to decode at cold start, and
 * it recolours with the token set. CLAUDE.md §16.17 asks for original
 * branding, and this is it — a rounded accent tile carrying a play-shaped
 * negative space, set against the two-weight "MINI / DRAMA" lockup.
 *
 * Placeholder-grade, deliberately: a real logotype is a design deliverable,
 * not something to invent in a UI milestone. It is honest, consistent and
 * replaceable from one file.
 */

export type WordmarkSize = 'sm' | 'lg';

export interface WordmarkProps {
  size?: WordmarkSize;
}

const METRICS: Record<WordmarkSize, { tile: number; gap: number; glyph: number }> = {
  sm: { tile: 28, gap: spacing.sm, glyph: 10 },
  lg: { tile: 64, gap: spacing.md, glyph: 24 },
};

export function Wordmark({ size = 'sm' }: WordmarkProps): JSX.Element {
  const metrics = METRICS[size];
  const isLarge = size === 'lg';

  return (
    <View
      style={[styles.row, { gap: metrics.gap }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="MiniDrama"
    >
      <View
        style={[
          styles.tile,
          {
            width: metrics.tile,
            height: metrics.tile,
            borderRadius: metrics.tile * 0.32,
          },
        ]}
      >
        {/* A triangle from borders: the standard RN way to draw a play glyph
            without pulling in an SVG renderer. */}
        <View
          style={{
            width: 0,
            height: 0,
            borderTopWidth: metrics.glyph * 0.58,
            borderBottomWidth: metrics.glyph * 0.58,
            borderLeftWidth: metrics.glyph,
            borderTopColor: 'transparent',
            borderBottomColor: 'transparent',
            borderLeftColor: colors.text.onAccent,
            marginLeft: metrics.glyph * 0.22,
          }}
        />
      </View>

      <View style={styles.lockup}>
        <AppText
          variant={isLarge ? 'display' : 'h3'}
          style={[styles.word, isLarge ? styles.tightLarge : styles.tightSmall]}
        >
          MINI
        </AppText>
        <AppText
          variant={isLarge ? 'display' : 'h3'}
          tone="accent"
          style={[styles.word, isLarge ? styles.tightLarge : styles.tightSmall]}
        >
          DRAMA
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tile: {
    backgroundColor: colors.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockup: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  word: {
    letterSpacing: 0.5,
  },
  tightSmall: {
    lineHeight: typography.h3.lineHeight,
  },
  tightLarge: {
    lineHeight: typography.display.lineHeight,
  },
});
