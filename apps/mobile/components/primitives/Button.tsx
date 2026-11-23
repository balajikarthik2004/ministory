import type { JSX } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { AppText, type TextTone } from './AppText';
import { PressableScale } from './PressableScale';

/**
 * Button — primary / secondary / ghost / destructive, in three sizes
 * (UI_UX_GUIDELINES.md §4).
 *
 * Every size is at least 44dp tall, so the accessibility minimum is a property
 * of the component rather than something each screen has to remember.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ionicons glyph name, drawn before the label. */
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  /** Stretches to the container width. Used for the detail screen's CTA. */
  fullWidth?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
}

const SIZE_STYLE: Record<ButtonSize, { height: number; padding: number; icon: number }> = {
  sm: { height: MIN_TOUCH_TARGET, padding: spacing.md, icon: 16 },
  md: { height: 48, padding: spacing.lg, icon: 18 },
  lg: { height: 54, padding: spacing.xl, icon: 20 },
};

const VARIANT_TONE: Record<ButtonVariant, TextTone> = {
  primary: 'onAccent',
  secondary: 'primary',
  ghost: 'primary',
  destructive: 'primary',
};

function surfaceFor(variant: ButtonVariant, disabled: boolean): ViewStyle {
  if (disabled) {
    return { backgroundColor: colors.bg.card, borderColor: colors.border.subtle };
  }
  switch (variant) {
    case 'primary':
      return { backgroundColor: colors.accent.primary, borderColor: colors.accent.primary };
    case 'secondary':
      return { backgroundColor: colors.bg.elevated, borderColor: colors.border.strong };
    case 'ghost':
      return { backgroundColor: 'transparent', borderColor: colors.border.strong };
    case 'destructive':
      return { backgroundColor: 'transparent', borderColor: colors.status.error };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  accessibilityHint,
}: ButtonProps): JSX.Element {
  const metrics = SIZE_STYLE[size];
  const isInert = disabled || loading;
  const tone: TextTone = disabled
    ? 'tertiary'
    : variant === 'destructive'
      ? 'error'
      : VARIANT_TONE[variant];
  const glyphColor = disabled
    ? colors.text.tertiary
    : variant === 'primary'
      ? colors.text.onAccent
      : variant === 'destructive'
        ? colors.status.error
        : colors.text.primary;

  return (
    <PressableScale
      onPress={onPress}
      disabled={isInert}
      activeScale={0.97}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert, busy: loading }}
      style={[
        styles.base,
        surfaceFor(variant, disabled),
        { height: metrics.height, paddingHorizontal: metrics.padding },
        fullWidth ? styles.fullWidth : styles.hug,
        style ?? {},
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator
            size="small"
            color={variant === 'primary' ? colors.text.onAccent : colors.accent.primary}
          />
        ) : (
          <>
            {icon ? <Ionicons name={icon} size={metrics.icon} color={glyphColor} /> : null}
            <AppText variant="bodyStrong" tone={tone} numberOfLines={1}>
              {label}
            </AppText>
          </>
        )}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: 'center',
  },
  /**
   * A button that is not `fullWidth` sizes to its content and centres itself.
   *
   * It has to set `alignSelf` to something: the default (`auto`) inherits
   * `stretch` from a column parent, which would make every button full width
   * and make the `fullWidth` prop meaningless. `center` is the right default
   * here because a standalone action in this app always sits in a centred
   * context — empty states, error states, the unlock sheet. A caller that
   * wants otherwise passes `alignSelf` in `style`, which is applied last and
   * therefore wins.
   */
  hug: {
    alignSelf: 'center',
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
});
