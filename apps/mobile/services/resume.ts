import type { EpisodeSummary } from '@minidrama/contracts';

/**
 * Where a drama should resume, from its episode list.
 *
 * ONE RULE, ONE PLACE (M2.4 Issue A). Home and the drama detail page used to
 * answer this question differently: the rail read server progress while the
 * detail page's "Resume Episode N" read the device's SQLite copy. When the
 * two disagreed — which they did, because nothing reconciled them — the same
 * drama offered two different episodes depending on which screen you tapped.
 *
 * This resolves from `watchState`, which the server attaches to every
 * episode it returns. That makes the server authoritative whenever the
 * episode list came from the server, and makes both screens agree by
 * construction rather than by both remembering to call the same store.
 *
 * It deliberately mirrors the server's own rule
 * (`library.repository.resumeTargets`): resume the furthest episode reached,
 * and if that episode is finished, resume the next one instead. Keeping the
 * two in step is what stops a rail entry and a CTA from drifting apart
 * again.
 *
 * OFFLINE. The episode list is served from the TanStack Query cache when the
 * network is gone, so this keeps working — it resolves against the last
 * known watch state rather than falling back to a second source of truth.
 */

export interface ResumePoint {
  episodeId: string;
  episodeNumber: number;
  /** Seconds into that episode. Zero when resuming a fresh one. */
  positionSec: number;
}

/** Started, or finished. A zero-position row is not a resume point. */
function hasBeenWatched(episode: EpisodeSummary): boolean {
  const state = episode.watchState;
  if (!state) return false;
  return state.isCompleted || state.positionSec > 0;
}

/**
 * Returns the resume point, or `null` when there is nothing to resume —
 * either the drama was never started, or its final episode is finished.
 *
 * A `null` means different things to different callers, and that is correct:
 * the detail page shows "Start watching", the Continue Watching rail should
 * not be offering the drama at all.
 */
export function resolveResumePoint(episodes: readonly EpisodeSummary[]): ResumePoint | null {
  let furthest: EpisodeSummary | null = null;

  for (const episode of episodes) {
    if (!hasBeenWatched(episode)) continue;
    if (!furthest || episode.episodeNumber > furthest.episodeNumber) furthest = episode;
  }

  if (!furthest) return null;

  if (furthest.watchState?.isCompleted) {
    const next = episodes.find((item) => item.episodeNumber === furthest.episodeNumber + 1);
    // No next episode: the drama is finished, so there is nothing to resume.
    if (!next) return null;
    return { episodeId: next.id, episodeNumber: next.episodeNumber, positionSec: 0 };
  }

  return {
    episodeId: furthest.id,
    episodeNumber: furthest.episodeNumber,
    positionSec: Math.floor(furthest.watchState?.positionSec ?? 0),
  };
}

/**
 * The episode to open when a viewer taps play.
 *
 * Falls back to episode 1, which covers both "never watched" and "finished
 * the whole thing" — in the second case restarting is the only sensible
 * action left, and it is what the viewer asked for by tapping play.
 */
export function episodeToPlay(episodes: readonly EpisodeSummary[]): number {
  return resolveResumePoint(episodes)?.episodeNumber ?? 1;
}
