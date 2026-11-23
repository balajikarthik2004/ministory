import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../primitives/AppText';
import { PressableScale } from '../primitives/PressableScale';

/** Rail and section heading, with an optional "See all" affordance. */

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function SectionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
}: SectionHeaderProps): JSX.Element {
  return (
    <View style={styles.row}>
      <View style={styles.titles}>
        <AppText variant="h2" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" tone="secondary" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      {actionLabel && onAction ? (
        <PressableScale
          onPress={onAction}
          activeScale={0.94}
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel}, ${title}`}
          style={styles.action}
        >
          <AppText variant="caption" tone="accent">
            {actionLabel}
          </AppText>
          <Ionicons name="chevron-forward" size={14} color={colors.accent.primary} />
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    // minHeight keeps the 44dp target for "See all" without fixing the height
    // of a title that may wrap taller in Tamil.
    minHeight: 44,
  },
  titles: {
    flex: 1,
    gap: 2,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.sm,
  },
});
