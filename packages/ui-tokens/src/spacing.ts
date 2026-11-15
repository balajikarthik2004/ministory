/** Spacing, radius and motion tokens. See docs/UI_UX_GUIDELINES.md §1. */

/** 4px base scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 999,
} as const;

/**
 * Motion durations in ms.
 * Animation never runs during buffering or a feed swipe - CLAUDE.md §13 puts
 * playback ahead of decoration, and a JS-thread animation mid-swipe is exactly
 * what drops a frame on a mid-range device.
 */
export const duration = {
  instant: 100,
  fast: 180,
  base: 240,
  slow: 400,
} as const;

/** Minimum accessible touch target in dp. */
export const MIN_TOUCH_TARGET = 44;

export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type Duration = typeof duration;
