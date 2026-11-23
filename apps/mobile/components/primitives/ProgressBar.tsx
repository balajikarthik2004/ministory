import type { JSX } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { colors, radius } from '@minidrama/ui-tokens';

/**
 * A determinate progress track.
 *
 * Used for watch progress on Continue Watching cards and episode rows, and for
 * playback position in the player overlay. Purely presentational — it never
 * animates itself, because the player drives it from a time update and a
 * competing animation would fight that.
 */

export interface ProgressBarProps {
  /** 0..1. Values outside the range are clamped rather than overflowing. */
  value: number;
  height?: number;
  trackColor?: string;
  fillColor?: string;
  style?: ViewStyle;
  /** Progress communicated to assistive tech, e.g. "Episode 4, 62% watched". */
  accessibilityLabel?: string;
}

export function ProgressBar({
  value,
  height = 3,
  trackColor = colors.border.strong,
  fillColor = colors.accent.primary,
  style,
  accessibilityLabel,
}: ProgressBarProps): JSX.Element {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[styles.track, { height, backgroundColor: trackColor, borderRadius: height }, style]}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          backgroundColor: fillColor,
          borderRadius: height,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: radius.full,
  },
});
