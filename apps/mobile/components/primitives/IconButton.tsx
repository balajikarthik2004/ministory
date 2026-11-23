import type { JSX } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { PressableScale } from './PressableScale';

/**
 * A circular icon control.
 *
 * `surface` picks the background. `glass` is for controls that sit over video
 * or artwork — a translucent disc keeps the icon legible against a bright
 * frame without a hard-edged chip fighting the image.
 *
 * The frame is always at least 44dp (UI_UX_GUIDELINES.md §7) even when the
 * glyph inside it is small, so a 20dp close icon is still a 44dp target.
 */

export type IconButtonSurface = 'none' | 'card' | 'glass' | 'accent';

export interface IconButtonProps {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** Glyph size. The frame grows to the 44dp minimum regardless. */
  size?: number;
  color?: string;
  surface?: IconButtonSurface;
  disabled?: boolean;
  /** Required: an icon with no label is invisible to a screen reader. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  selected?: boolean;
  style?: ViewStyle;
}

const SURFACE_STYLE: Record<IconButtonSurface, ViewStyle> = {
  none: { backgroundColor: 'transparent' },
  card: { backgroundColor: colors.bg.card },
  glass: { backgroundColor: colors.overlay.scrim },
  accent: { backgroundColor: colors.accent.primary },
};

export function IconButton({
  name,
  onPress,
  size = 22,
  color = colors.text.primary,
  surface = 'none',
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  selected,
  style,
}: IconButtonProps): JSX.Element {
  const frame = Math.max(MIN_TOUCH_TARGET, size + 20);

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      activeScale={0.9}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      style={[
        styles.frame,
        SURFACE_STYLE[surface],
        { width: frame, height: frame, borderRadius: radius.full },
        style ?? {},
      ]}
    >
      <View style={styles.center}>
        <Ionicons name={name} size={size} color={disabled ? colors.text.tertiary : color} />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
