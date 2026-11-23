import { Dimensions, type Insets } from 'react-native';
import { MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';

/**
 * Layout constants from docs/UI_UX_GUIDELINES.md §2.
 *
 * These are *layout* numbers — aspect ratios, rail widths, bar heights — not
 * design tokens. Spacing, radius, colour and type live in
 * `@minidrama/ui-tokens` and must not be duplicated here.
 */

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export const screen = {
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
} as const;

/** Guidelines §2: designs target 390dp and must hold from 360dp to 430dp. */
export const POSTER_ASPECT = 2 / 3;
export const BANNER_ASPECT = 16 / 9;
export const THUMB_ASPECT = 9 / 16;

export const posterSize = {
  /** Rail card width, from the guidelines' 136dp. */
  railWidth: 136,
  get railHeight(): number {
    return Math.round(136 / POSTER_ASPECT);
  },
  /** Continue Watching cards are wider — they carry a progress bar and a
   *  resume label, and 136dp cannot hold "Episode 12 · 3:21 left". */
  continueWidth: 176,
  get continueHeight(): number {
    return Math.round(176 / POSTER_ASPECT);
  },
} as const;

/** Episode list thumbnail, guidelines §2: 9:16 at 96dp wide. */
export const episodeThumb = {
  width: 96,
  get height(): number {
    return Math.round(96 / THUMB_ASPECT);
  },
} as const;

/** Tab bar: 56dp plus the safe-area inset, applied by the bar itself. */
export const TAB_BAR_HEIGHT = 56;

/**
 * The drama detail hero. Tall enough to be cinematic, short enough that the
 * primary CTA stays above the fold on a 360x640 device — the smallest frame
 * the guidelines require support for.
 */
export const DETAIL_HERO_HEIGHT = Math.round(SCREEN_HEIGHT * 0.52);

/**
 * Expands a small control's touch area to the 44dp minimum without changing
 * its visual size (guidelines §2, §7). Takes the rendered size and returns the
 * hitSlop that brings it up to target.
 */
export function hitSlopFor(renderedSize: number): Insets {
  const deficit = Math.max(0, MIN_TOUCH_TARGET - renderedSize);
  const pad = Math.ceil(deficit / 2);
  return { top: pad, bottom: pad, left: pad, right: pad };
}

/**
 * `position: absolute` filling the parent, as a plain object.
 *
 * React Native 0.88 dropped `StyleSheet.absoluteFillObject` from its generated
 * types, and `StyleSheet.absoluteFill` is a registered style that can be used
 * in a style *array* but not spread into one. Overlays need the object form,
 * so it lives here rather than being re-declared in every player component.
 */
export const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/** Formats seconds as m:ss, or h:mm:ss past an hour. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "3 min left" style remainder, used on Continue Watching cards. */
export function formatRemaining(positionSec: number, durationSec: number): string {
  const remaining = Math.max(0, durationSec - positionSec);
  if (remaining < 60) return `${Math.ceil(remaining)}s left`;
  return `${Math.ceil(remaining / 60)} min left`;
}
