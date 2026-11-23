import type { ErrorCode, LockedEpisodeInfo } from '@minidrama/contracts';

/**
 * Client-side error model.
 *
 * Every failure the UI can show goes through `AppError`, which carries a
 * machine-readable `code` and a message that is already safe to render.
 * CLAUDE.md §11 and UI_UX_GUIDELINES.md §5: an exception's own message, a
 * stack, or an HTTP body never reaches the screen. Whatever a thrown value
 * actually was, `toAppError` converts it into presentable copy.
 */

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Present on EPISODE_LOCKED, so the UI can offer the unlock routes. */
  readonly locked?: LockedEpisodeInfo;

  constructor(code: ErrorCode, message: string, locked?: LockedEpisodeInfo) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (locked) this.locked = locked;
  }
}

/**
 * Copy for the situations users actually hit, from UI_UX_GUIDELINES.md §5.
 * Never blames the user, never shows a code, always says what to do next.
 */
const MESSAGE: Partial<Record<ErrorCode, string>> = {
  SERVICE_UNAVAILABLE: "We couldn't reach MiniDrama. Check your connection and try again.",
  NOT_FOUND: "This drama isn't available right now.",
  EPISODE_LOCKED: 'Unlock this episode to keep watching.',
  UNAUTHENTICATED: 'Sign in to continue.',
  RATE_LIMITED: 'Too many requests. Give it a moment and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side. Try again in a moment.',
};

export function messageFor(code: ErrorCode): string {
  return MESSAGE[code] ?? MESSAGE.INTERNAL_ERROR ?? 'Something went wrong.';
}

/**
 * Narrows an unknown thrown value to an `AppError`.
 *
 * TanStack Query types its `error` as `unknown` by default, and a component
 * must not render it directly. This is the one conversion point.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'));
}

/** Playback-specific copy — UI_UX_GUIDELINES.md §5. */
export const PLAYBACK_ERROR_COPY =
  "Couldn't play this episode. Check your connection and try again.";
