import type { JSX } from 'react';
import { StyleSheet } from 'react-native';
import { colors, radius, spacing, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';

/**
 * Selectable filter chip — genre and language filters on Search, language
 * selection on Profile.
 *
 * Selected state uses `accent.subtle` as a surface with an accent border, not
 * accent-coloured text on a card. UI_UX_GUIDELINES.md §1 is explicit that
 * amber body text on `bg.card` is the one pairing in this palette that fails
 * contrast, so selection is signalled by the surface and the border.
 */

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress: () => void;
  accessibilityHint?: string;
}

export function Chip({
  label,
  selected = false,
  onPress,
  accessibilityHint,
}: ChipProps): JSX.Element {
  return (
    <PressableScale
      onPress={onPress}
      activeScale={0.94}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      style={[styles.chip, selected ? styles.selected : styles.idle]}
    >
      <AppText variant="caption" tone={selected ? 'primary' : 'secondary'} numberOfLines={1}>
        {label}
      </AppText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: MIN_TOUCH_TARGET - 8,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
  },
  idle: {
    backgroundColor: colors.bg.card,
    borderColor: colors.border.subtle,
  },
  selected: {
    backgroundColor: colors.accent.subtle,
    borderColor: colors.accent.primary,
  },
});
