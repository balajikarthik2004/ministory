import type {
  ExperimentId,
  MetricEvent,
  MetricEventType,
  RenditionReport,
  RenditionSample,
  RenditionSwitch,
  RunSummary,
  Sample,
} from '../types';

/**
 * Metrics collector for the M1.2 spike.
 *
 * Design rule: this records only what it can actually observe. Memory, dropped
 * frames and crashes are not observable from JavaScript, so they are not
 * guessed at here - they come from adb (see types.ts UNCOLLECTABLE_IN_APP).
 *
 * "First frame" is an approximation and the docs say so: expo-video exposes no
 * render callback, so the harness uses the first `timeUpdate` reporting
 * currentTime > 0, which means frames are advancing. That is slightly LATER
 * than the true first frame, bounded by timeUpdateEventInterval (set to 0.05s
 * in the strategies). Measurements are therefore conservative - real
 * performance is at least this good, never worse.
 */

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? null;
}

function summarise(values: number[]): Sample {
  if (values.length === 0) {
    return { count: 0, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p75Ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: Math.round(sorted[0] ?? 0),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
    meanMs: Math.round(total / sorted.length),
    p50Ms: Math.round(percentile(sorted, 0.5) ?? 0),
    p75Ms: Math.round(percentile(sorted, 0.75) ?? 0),
  };
}

/** Audio from two players must not overlap for longer than this (ms). Below
 *  this, a brief overlap during a crossfade-free swap is inaudible. */
const AUDIO_OVERLAP_TOLERANCE_MS = 120;

export class MetricsCollector {
  private readonly experimentId: ExperimentId;
  private readonly startedAtIso: string;
  private readonly startedAt: number;

  private events: MetricEvent[] = [];
  private firstFrameSamples: number[] = [];
  private transitionSamples: number[] = [];

  /** playerKey -> timestamp when its source was assigned. */
  private sourceSetAt = new Map<string, number>();
  /** Set of playerKeys currently reporting playing === true. */
  private playingPlayers = new Set<string>();
  private overlapStartedAt: number | null = null;

  private pendingTransition: { at: number; episodeId: string } | null = null;

  // ── M1.3: ABR rendition tracking ────────────────────────────────────
  private renditionInitial: string | null = null;
  private renditionSwitches: RenditionSwitch[] = [];
  private renditionTimeMs: Record<string, number> = {};
  private renditionCurrent: string | null = null;
  private renditionSince: number | null = null;
  private renditionAvailable: RenditionSample[] = [];

  private counters = {
    episodesStarted: 0,
    transitions: 0,
    playbackErrors: 0,
    audioOverlapIncidents: 0,
    stalls: 0,
    playersCreated: 0,
    playersReleased: 0,
  };

  constructor(experimentId: ExperimentId) {
    this.experimentId = experimentId;
    this.startedAt = Date.now();
    this.startedAtIso = new Date(this.startedAt).toISOString();
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  private push(
    type: MetricEventType,
    episodeId: string,
    playerKey: string,
    extra?: Partial<MetricEvent>,
  ): void {
    this.events.push({ type, at: this.now(), episodeId, playerKey, ...extra });
  }

  playerCreated(playerKey: string): void {
    this.counters.playersCreated += 1;
    this.push('player-created', '-', playerKey);
  }

  playerReleased(playerKey: string): void {
    this.counters.playersReleased += 1;
    this.playingPlayers.delete(playerKey);
    this.push('player-released', '-', playerKey);
  }

  /** Called the moment a source is handed to a player. Starts the TTFF clock. */
  sourceSet(playerKey: string, episodeId: string): void {
    this.sourceSetAt.set(playerKey, Date.now());
    this.push('source-set', episodeId, playerKey);
  }

  /** Called when the user's swipe commits. Starts the transition clock. */
  transitionStarted(episodeId: string): void {
    this.counters.transitions += 1;
    this.pendingTransition = { at: Date.now(), episodeId };
    this.push('transition-start', episodeId, '-');
  }

  /**
   * Called on the first timeUpdate with currentTime > 0 for a given episode.
   * Closes both the TTFF clock and, if one is open, the transition clock.
   */
  firstFrame(playerKey: string, episodeId: string): void {
    const now = Date.now();
    this.counters.episodesStarted += 1;

    const sourceAt = this.sourceSetAt.get(playerKey);
    if (sourceAt !== undefined) {
      const elapsed = now - sourceAt;
      this.firstFrameSamples.push(elapsed);
      this.sourceSetAt.delete(playerKey);
      this.push('first-frame', episodeId, playerKey, { durationMs: Math.round(elapsed) });
    } else {
      this.push('first-frame', episodeId, playerKey);
    }

    if (this.pendingTransition && this.pendingTransition.episodeId === episodeId) {
      const elapsed = now - this.pendingTransition.at;
      this.transitionSamples.push(elapsed);
      this.push('transition-complete', episodeId, playerKey, { durationMs: Math.round(elapsed) });
      this.pendingTransition = null;
    }
  }

  statusChanged(playerKey: string, episodeId: string, status: string, error?: string): void {
    this.push('status-change', episodeId, playerKey, {
      detail: error ? `${status}: ${error}` : status,
    });
    if (status === 'error') {
      this.counters.playbackErrors += 1;
      this.push('playback-error', episodeId, playerKey, { detail: error ?? 'unknown' });
    }
  }

  /**
   * Tracks which players are producing audio. More than one at a time, for
   * longer than the tolerance, is an overlap incident - the defect that makes
   * a pooled player feel broken.
   */
  playingChanged(playerKey: string, episodeId: string, isPlaying: boolean): void {
    if (isPlaying) this.playingPlayers.add(playerKey);
    else this.playingPlayers.delete(playerKey);

    this.push('playing-change', episodeId, playerKey, { detail: isPlaying ? 'playing' : 'paused' });

    const now = Date.now();
    if (this.playingPlayers.size > 1) {
      if (this.overlapStartedAt === null) this.overlapStartedAt = now;
    } else if (this.overlapStartedAt !== null) {
      const overlapMs = now - this.overlapStartedAt;
      if (overlapMs > AUDIO_OVERLAP_TOLERANCE_MS) {
        this.counters.audioOverlapIncidents += 1;
        this.push('audio-overlap', episodeId, playerKey, { durationMs: Math.round(overlapMs) });
      }
      this.overlapStartedAt = null;
    }
  }

  /**
   * The renditions the player parsed from the master playlist.
   *
   * Recorded once, the first time a non-empty list is seen. Before the
   * manifest is parsed the player reports an empty array, which is not
   * evidence that the ladder is missing.
   */
  availableRenditions(tracks: RenditionSample[]): void {
    if (tracks.length > 0 && this.renditionAvailable.length === 0) {
      this.renditionAvailable = tracks;
    }
  }

  /**
   * An ABR rendition switch, as reported by expo-video's videoTrackChange.
   *
   * Time spent on the outgoing rendition is banked here, so the dominant
   * rendition is time-weighted rather than a count of switches.
   */
  videoTrackChanged(playerKey: string, episodeId: string, track: RenditionSample | null): void {
    const now = Date.now();

    if (this.renditionCurrent !== null && this.renditionSince !== null) {
      const elapsed = now - this.renditionSince;
      this.renditionTimeMs[this.renditionCurrent] =
        (this.renditionTimeMs[this.renditionCurrent] ?? 0) + elapsed;
    }

    if (track === null) {
      this.renditionCurrent = null;
      this.renditionSince = null;
      return;
    }

    if (this.renditionInitial === null) this.renditionInitial = track.label;
    else if (this.renditionCurrent !== track.label) {
      this.renditionSwitches.push({
        at: this.now(),
        from: this.renditionCurrent,
        to: track.label,
        episodeId,
      });
    }

    this.renditionCurrent = track.label;
    this.renditionSince = now;

    this.push('video-track-change', episodeId, playerKey, {
      detail: `${track.label}${track.averageBitrate ? ` @${Math.round(track.averageBitrate / 1000)}k` : ''}`,
    });
  }

  /**
   * Time on the rendition still playing when the run ends must be banked too,
   * but without mutating state - summary() is called on every HUD render.
   */
  private renditionReport(): RenditionReport {
    const timeMsByRendition = { ...this.renditionTimeMs };
    if (this.renditionCurrent !== null && this.renditionSince !== null) {
      timeMsByRendition[this.renditionCurrent] =
        (timeMsByRendition[this.renditionCurrent] ?? 0) + (Date.now() - this.renditionSince);
    }

    let dominant: string | null = null;
    let best = -1;
    for (const [label, ms] of Object.entries(timeMsByRendition)) {
      if (ms > best) {
        best = ms;
        dominant = label;
      }
    }

    return {
      initial: this.renditionInitial,
      switches: this.renditionSwitches,
      switchCount: this.renditionSwitches.length,
      timeMsByRendition,
      dominant,
      available: this.renditionAvailable,
    };
  }

  /** A player that was playing stopped advancing without being paused. */
  stallDetected(playerKey: string, episodeId: string, stalledMs: number): void {
    this.counters.stalls += 1;
    this.push('stall', episodeId, playerKey, { durationMs: Math.round(stalledMs) });
  }

  /**
   * An overlap that is still open when summary() is called still counts, but
   * counting it must not mutate state: the HUD calls summary() on every render
   * while a run is live, and a destructive finaliser would count the same
   * ongoing overlap once per frame.
   */
  private pendingOverlapIncident(): number {
    if (this.overlapStartedAt === null) return 0;
    return Date.now() - this.overlapStartedAt > AUDIO_OVERLAP_TOLERANCE_MS ? 1 : 0;
  }

  /** Pure. Safe to call as often as you like. */
  summary(): RunSummary {
    return {
      experimentId: this.experimentId,
      startedAt: this.startedAtIso,
      durationMs: this.now(),
      timeToFirstFrameMs: summarise(this.firstFrameSamples),
      transitionLatencyMs: summarise(this.transitionSamples),
      ...this.counters,
      audioOverlapIncidents: this.counters.audioOverlapIncidents + this.pendingOverlapIncident(),
      renditions: this.renditionReport(),
    };
  }

  allEvents(): readonly MetricEvent[] {
    return this.events;
  }

  /** Printed to the Metro terminal so results can be copied without adding a
   *  clipboard dependency. */
  export(): string {
    return JSON.stringify({ summary: this.summary(), events: this.events }, null, 2);
  }

  reset(): void {
    this.events = [];
    this.firstFrameSamples = [];
    this.transitionSamples = [];
    this.sourceSetAt.clear();
    this.playingPlayers.clear();
    this.overlapStartedAt = null;
    this.pendingTransition = null;
    this.renditionInitial = null;
    this.renditionSwitches = [];
    this.renditionTimeMs = {};
    this.renditionCurrent = null;
    this.renditionSince = null;
    this.renditionAvailable = [];
    this.counters = {
      episodesStarted: 0,
      transitions: 0,
      playbackErrors: 0,
      audioOverlapIncidents: 0,
      stalls: 0,
      playersCreated: 0,
      playersReleased: 0,
    };
  }
}
