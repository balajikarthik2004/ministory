/**
 * M1.2 video player spike - shared types.
 *
 * EXPERIMENTAL CODE. Not the production player. Nothing here should be
 * imported by app code outside experiments/.
 */

export type ExperimentId = 'A-single' | 'B-dual' | 'C-pool';

export interface ExperimentInfo {
  id: ExperimentId;
  title: string;
  summary: string;
  playerCount: number;
}

export const EXPERIMENTS: readonly ExperimentInfo[] = [
  {
    id: 'A-single',
    title: 'A - Single player',
    summary:
      'One instance. Source is replaced on every swipe. The baseline: lowest memory, highest transition cost.',
    playerCount: 1,
  },
  {
    id: 'B-dual',
    title: 'B - Dual player',
    summary:
      'Current plus a preloaded next. Swipe promotes the preloaded instance and reloads the freed one.',
    playerCount: 2,
  },
  {
    id: 'C-pool',
    title: 'C - Three-player pool',
    summary:
      'Previous, current, next. Both swipe directions are instant - at the cost of a third decoder.',
    playerCount: 3,
  },
] as const;

/** One test episode, resolved from the fixture server's manifest.json. */
export interface TestEpisode {
  id: string;
  label: string;
  width: number;
  height: number;
  bitrate: string;
  durationSeconds: number;
  toneHz: number;
  /** Absolute URL to the HLS master playlist. */
  url: string;
}

export type MetricEventType =
  | 'source-set'
  | 'status-change'
  | 'first-frame'
  | 'playing-change'
  | 'transition-start'
  | 'transition-complete'
  | 'playback-error'
  | 'audio-overlap'
  | 'stall'
  | 'player-created'
  | 'player-released'
  | 'video-track-change';

export interface MetricEvent {
  type: MetricEventType;
  /** ms since the run started. */
  at: number;
  episodeId: string;
  playerKey: string;
  detail?: string;
  /** Present on timing events. */
  durationMs?: number;
}

/**
 * One ABR rendition as the player reports it (M1.3).
 *
 * Sourced from expo-video's `VideoTrack`, which is populated on Android and
 * iOS for HLS sources. Nothing here is inferred - if the player does not
 * report a field it stays null rather than being guessed.
 */
export interface RenditionSample {
  /** `${width}x${height}`, or 'unknown' when the player reports no size. */
  label: string;
  width: number | null;
  height: number | null;
  peakBitrate: number | null;
  averageBitrate: number | null;
}

export interface RenditionSwitch {
  /** ms since the run started. */
  at: number;
  from: string | null;
  to: string;
  episodeId: string;
}

export interface RenditionReport {
  /** The rendition the player chose first, across the whole run. */
  initial: string | null;
  /** Every switch, in order. */
  switches: RenditionSwitch[];
  switchCount: number;
  /** Cumulative ms spent on each rendition. */
  timeMsByRendition: Record<string, number>;
  /** The rendition holding the most cumulative time. */
  dominant: string | null;
  /** Renditions the player said were available, from the master playlist. */
  available: RenditionSample[];
}

export interface RunSummary {
  experimentId: ExperimentId;
  startedAt: string;
  durationMs: number;

  /** Time from source assignment to the first advancing frame. */
  timeToFirstFrameMs: Sample;
  /** Time from swipe committing to the first advancing frame of the new episode. */
  transitionLatencyMs: Sample;

  episodesStarted: number;
  transitions: number;
  playbackErrors: number;
  audioOverlapIncidents: number;
  stalls: number;
  playersCreated: number;
  playersReleased: number;

  /** M1.3. Empty-but-present when playing single-variant fixtures. */
  renditions: RenditionReport;
}

export interface Sample {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p75Ms: number | null;
}

/**
 * Metrics this harness CANNOT collect, and how they are obtained instead.
 * Kept in code so the limitation travels with the measurement.
 */
export const UNCOLLECTABLE_IN_APP = {
  memoryUsage: 'adb shell dumpsys meminfo - see tools/android-profiling/sample-memory.sh',
  droppedFrames: 'adb shell dumpsys gfxinfo - see tools/android-profiling/sample-gfx.sh',
  crashCount: 'adb logcat. The process dies, so nothing in JS can record it.',
  blackFrames:
    'Not directly observable. The harness records the gap between a transition committing and the first advancing frame, which is when a black frame would be visible. Confirm visually or with a screen recording.',
} as const;
