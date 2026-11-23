import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';

/**
 * A form-level message: the one that is about the submission rather than
 * about a field.
 *
 * Returns null when there is nothing to say, so the layout has no reserved
 * gap. That is the opposite of `FormField`'s always-present error slot, and
 * deliberately: a field error appears while the user is typing in a form
 * whose geometry must not shift under their thumb, whereas this one appears
 * only after a submit, when focus is already on the result.
 */

export interface FormBannerProps {
  message: string | null | undefined;
  tone?: 'error' | 'success' | 'info';
}

const TONE = {
  error: { icon: 'alert-circle', color: colors.status.error },
  success: { icon: 'checkmark-circle', color: colors.status.success },
  info: { icon: 'information-circle', color: colors.accent.primary },
} as const;

export function FormBanner({ message, tone = 'error' }: FormBannerProps): JSX.Element | null {
  if (!message) return null;
  const style = TONE[tone];

  return (
    <View
      style={[styles.banner, { borderColor: style.color }]}
      // Announced when it appears, so the outcome of a submit is not
      // silent for a screen-reader user (UI_UX_GUIDELINES.md §7).
      accessibilityLiveRegion="polite"
      accessible
    >
      <Ionicons name={style.icon} size={18} color={style.color} />
      <AppText variant="caption" style={styles.text}>
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.bg.card,
  },
  text: { flex: 1 },
});
