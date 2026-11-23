import type { JSX } from 'react';
import { StyleSheet, Text, type TextProps, type TextStyle } from 'react-native';
import { colors, typography, type TypographyVariant } from '@minidrama/ui-tokens';

/**
 * The only text component in the app.
 *
 * Exists so that no screen ever writes `fontSize` or a colour literal
 * (UI_UX_GUIDELINES.md §1: no raw hex, px or font size in a component file).
 * Variants map one-to-one onto the type scale.
 *
 * Tamil renders taller than Latin at the same point size, so line height comes
 * from the token and containers use `minHeight` rather than a fixed height.
 * Clipped Tamil descenders are the most common i18n layout bug in this kind of
 * app, and the only reliable defence is never fixing a text container's height.
 */

export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'onAccent' | 'error';

const TONE_COLOR: Record<TextTone, string> = {
  primary: colors.text.primary,
  secondary: colors.text.secondary,
  tertiary: colors.text.tertiary,
  accent: colors.accent.primary,
  onAccent: colors.text.onAccent,
  error: colors.status.error,
};

export interface AppTextProps extends TextProps {
  variant?: TypographyVariant;
  tone?: TextTone;
}

export function AppText({
  variant = 'body',
  tone = 'primary',
  style,
  ...rest
}: AppTextProps): JSX.Element {
  // `fontWeight` in the token set is a string literal union that TextStyle
  // accepts, but the object is `as const` so it needs the cast to widen.
  const variantStyle = typography[variant] as TextStyle;

  return (
    <Text
      {...rest}
      style={StyleSheet.flatten([variantStyle, { color: TONE_COLOR[tone] }, style])}
    />
  );
}
