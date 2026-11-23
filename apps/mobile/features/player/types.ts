import type { VideoPlayer } from 'expo-video';
import type { PlaybackTicket } from '@minidrama/contracts';

/**
 * The player abstraction.
 *
 * WHY AN INTERFACE AT ALL
 * -----------------------
 * The M2.1 brief asks for the player to sit behind a reusable interface so the
 * implementation can evolve. That is not speculative: docs/VIDEO_PLAYER_SPIKE.md
 * §10 recommends Strategy A (one player, source replaced on each swipe) but
 * ends with an explicit caveat — B and C were never measured on an
 * unconstrained link, and the recommendation "should be re-tested before it
 * hardens into architecture". A second strategy is a live possibility, so the
 * screen is written against this contract rather than against expo-video.
 *
 * `useSinglePlayerController` is the Strategy A implementation. A dual-player
 * or pooled controller would implement the same interface and the player
 * screen would not change.
 */

export type PlaybackPhase =
  | 'idle'
  /** A ticket has been requested, or a source is loading. */
  | 'loading'
  | 'playing'
  | 'paused'
  /** Playing, but starved of data — the spinner belongs over the video. */
  | 'buffering'
  | 'ended'
  | 'error';

export interface PlaybackSnapshot {
  phase: PlaybackPhase;
  /** The episode this controller currently holds, if any. */
  episodeId: string | null;
  positionSec: number;
  durationSec: number;
  muted: boolean;
  /** Presentable copy. Never a raw exception message (CLAUDE.md §11). */
  errorMessage: string | null;
}

export interface VideoPlayerController {
  snapshot: PlaybackSnapshot;
  /**
   * The native player instance to hand to `VideoView`, or null while none is
   * allocated. The screen passes this straight through and never calls methods
   * on it — every command goes through this interface.
   */
  player: VideoPlayer | null;

  /** Point the controller at an episode, using an already-issued ticket. */
  load: (ticket: PlaybackTicket) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setMuted: (muted: boolean) => void;
  seekTo: (positionSec: number) => void;
  /** Re-attempt the current source after a playback failure. */
  retry: () => void;
  /** Stop playback and drop the source. Safe to call more than once. */
  releaseSource: () => void;
  /** Wired to `VideoView.onFirstFrameRender`. */
  reportFirstFrame: () => void;
}

/**
 * A transition the player observed.
 *
 * The controller reports *what happened*; it does not know what telemetry
 * exists or what gets persisted. That is why M2.2's event pipeline could be
 * added without touching the Strategy A playback logic.
 */
export type PlaybackLifecycleEvent =
  | { kind: 'started'; episodeId: string; positionSec: number; durationSec: number | null }
  | { kind: 'paused'; episodeId: string; positionSec: number; durationSec: number | null }
  | { kind: 'resumed'; episodeId: string; positionSec: number; durationSec: number | null }
  | {
      kind: 'failed';
      episodeId: string;
      positionSec: number;
      durationSec: number | null;
      /** The player's raw message, for classification only. Never displayed. */
      rawMessage: string | null;
    };

/** Reported upward so the screen can persist progress and advance the feed. */
export interface PlaybackCallbacks {
  onProgress: (episodeId: string, positionSec: number, durationSec: number) => void;
  onEnded: (episodeId: string) => void;
  /** Optional: a caller that only needs progress can leave it off. */
  onLifecycle?: (event: PlaybackLifecycleEvent) => void;
}
