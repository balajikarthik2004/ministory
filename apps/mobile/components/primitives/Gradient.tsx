import type { JSX } from 'react';
import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { colors } from '@minidrama/ui-tokens';

/**
 * A vertical scrim, built from stacked opaque bands.
 *
 * WHY NOT `expo-linear-gradient`
 * ------------------------------
 * `overlay.gradient` is a real design token (UI_UX_GUIDELINES.md §1) and the
 * player, the home banner and the detail hero all need one. The obvious answer
 * is `expo-linear-gradient` — free, first-party, bundled in Expo Go. The M2.1
 * brief says to avoid unnecessary dependencies, and for an opaque dark scrim a
 * band stack is visually indistinguishable: the bands are drawn in the
 * background colour at stepped opacities, and at the default step count the
 * seams fall below one 8-bit level apart on a dark surface.
 *
 * This is the one place that would change if the project later decides a true
 * interpolated gradient is worth a dependency — every caller goes through this
 * component, so the swap is internal.
 *
 * COST
 * ----
 * Each band is a native view. That is cheap for the handful of instances this
 * app renders (banner, detail hero, player overlay), but it would not be cheap
 * inside a list cell repeated forty times. Poster and thumbnail scrims are
 * therefore baked into the generated artwork instead
 * (tools/placeholder-art/generate.mjs), not drawn with this component.
 */

export interface GradientProps {
  /** 'down' darkens towards the bottom; 'up' darkens towards the top. */
  direction?: 'up' | 'down';
  /** Peak opacity at the dark end. */
  intensity?: number;
  /** More bands is smoother and costs more views. Eight is ample on #090A0F. */
  steps?: number;
  color?: string;
  style?: ViewStyle | ViewStyle[];
}

export function Gradient({
  direction = 'down',
  intensity = 0.95,
  steps = 8,
  color = colors.bg.primary,
  style,
}: GradientProps): JSX.Element {
  const bands = useMemo(() => {
    return Array.from({ length: steps }, (_, index) => {
      const position = (index + 1) / steps;
      // Eased rather than linear: a linear ramp reads as a visible hard edge
      // where the scrim begins, because perceived lightness is not linear in
      // alpha. Squaring keeps the top of the scrim genuinely transparent.
      const alpha = position * position * intensity;
      return { key: index, flex: 1, alpha };
    });
  }, [intensity, steps]);

  const ordered = direction === 'down' ? bands : [...bands].reverse();

  return (
    <View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      {ordered.map((band) => (
        <View
          key={band.key}
          style={{ flex: band.flex, backgroundColor: color, opacity: band.alpha }}
        />
      ))}
    </View>
  );
}
