/**
 * Type scale. See docs/UI_UX_GUIDELINES.md §1.
 *
 * System fonts only - a downloaded custom font costs cold-start time on exactly
 * the devices the launch audience carries.
 *
 * Tamil renders taller than Latin at the same size, so text containers use
 * minHeight rather than a fixed height. This is the most common i18n layout bug
 * in this kind of app.
 */
export const typography = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  h1: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  h2: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  h3: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
} as const;

export type Typography = typeof typography;
export type TypographyVariant = keyof Typography;
