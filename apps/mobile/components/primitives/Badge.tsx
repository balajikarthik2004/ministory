import type { JSX } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText, type TextTone } from './AppText';

/**
 * Small non-interactive status marker: FREE, a lock, a content rating, "NEW".
 *
 * `locked` deliberately reads as an invitation rather than a refusal
 * (UI_UX_GUIDELINES.md §3: "a lock is an invitation, a disabled control is a
 * dead end"), so it uses the accent surface rather than the error colour.
 */

export type BadgeTone = 'free' | 'locked' | 'neutral' | 'accent' | 'live';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: ViewStyle;
}

const TONE: Record<BadgeTone, { surface: string; border: string; text: TextTone; glyph: string }> =
  {
    free: {
      surface: 'rgba(34, 197, 94, 0.16)',
      border: colors.status.success,
      text: 'primary',
      glyph: colors.status.success,
    },
    locked: {
      surface: colors.accent.subtle,
      border: colors.accent.primary,
      text: 'primary',
      glyph: colors.accent.primary,
    },
    neutral: {
      surface: colors.bg.elevated,
      border: colors.border.subtle,
      text: 'secondary',
      glyph: colors.text.secondary,
    },
    accent: {
      surface: colors.accent.primary,
      border: colors.accent.primary,
      text: 'onAccent',
      glyph: colors.text.onAccent,
    },
    live: {
      surface: colors.overlay.scrim,
      border: colors.border.strong,
      text: 'primary',
      glyph: colors.text.primary,
    },
  };

export function Badge({ label, tone = 'neutral', icon, style }: BadgeProps): JSX.Element {
  const palette = TONE[tone];
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: palette.surface, borderColor: palette.border },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={11} color={palette.glyph} /> : null}
      <AppText variant="micro" tone={palette.text} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    // minHeight, not height: Tamil glyphs are taller than Latin at the same
    // size and a fixed height clips their descenders.
    minHeight: 20,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
});
