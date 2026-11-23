import { createVideoPlayer, type VideoPlayer, type VideoTrack } from 'expo-video';
import type { MetricsCollector } from '../metrics/collector';
import type { RenditionSample, TestEpisode } from '../types';

/**
 * Normalises expo-video's VideoTrack into the shape the collector records.
 * Fields the player does not report stay null - never guessed.
 */
function toRendition(track: VideoTrack | null): RenditionSample | null {
  if (!track) return null;
  const width = track.size?.width ?? null;
  const height = track.size?.height ?? null;
  return {
    label: width && height ? `${width}x${height}` : 'unknown',
    width,
    height,
    peakBitrate: track.peakBitrate ?? null,
    averageBitrate: track.averageBitrate ?? null,
  };
}

/**
 * A VideoPlayer with the spike's instrumentation attached.
 *
 * `createVideoPlayer` is used rather than `useVideoPlayer` because the whole
 * point of experiments B and C is manual lifecycle control - the hook releases
 * on unmount, which is exactly the behaviour under test.
 *
 * Every instance MUST be released. An unreleased ExoPlayer holds a codec, and
 * leaked codecs are what kills a feed on a low-memory device (CLAUDE.md §13).
 *
 * First-frame timing comes from VideoView's `onFirstFrameRender` callback,
 * which is the renderer telling us a frame actually reached the surface -
 * not a progress tick we inferred it from.
 */

/** Progress reporting interval, used for stall detection. */
const TIME_UPDATE_INTERVAL_SECONDS = 0.1;

/** currentTime not advancing for this long while `playing` is a stall. */
const STALL_THRESHOLD_MS = 1500;

export interface InstrumentedPlayer {
  readonly key: string;
  readonly player: VideoPlayer;
  /** Episode currently loaded, or null if idle. */
  currentEpisodeId: string | null;
  /** Point this player at an episode. Starts the time-to-first-frame clock. */
  load(episode: TestEpisode, autoplay: boolean): void;
  /** Called from VideoView's onFirstFrameRender - the authoritative signal. */
  reportFirstFrame(): void;
  play(): void;
  pause(): void;
  release(): void;
}

export function createInstrumentedPlayer(
  key: string,
  collector: MetricsCollector,
  options?: { muted?: boolean },
): InstrumentedPlayer {
  // Created with an empty source; a real source arrives via load().
  const player = createVideoPlayer(null);
  player.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_SECONDS;
  player.loop = false;
  player.muted = options?.muted ?? false;

  collector.playerCreated(key);

  let currentEpisodeId: string | null = null;
  let firstFrameReported = false;
  let lastTime = 0;
  let lastAdvanceAt = Date.now();
  let stallReported = false;
  let released = false;

  const subscriptions = [
    player.addListener('timeUpdate', ({ currentTime }) => {
      if (released || currentEpisodeId === null) return;

      const now = Date.now();
      if (currentTime > lastTime) {
        lastTime = currentTime;
        lastAdvanceAt = now;
        stallReported = false;
      } else if (player.playing && !stallReported && now - lastAdvanceAt > STALL_THRESHOLD_MS) {
        stallReported = true;
        collector.stallDetected(key, currentEpisodeId, now - lastAdvanceAt);
      }
    }),

    player.addListener('statusChange', ({ status, error }) => {
      if (released || currentEpisodeId === null) return;
      collector.statusChanged(key, currentEpisodeId, status, error?.message);
    }),

    player.addListener('playingChange', ({ isPlaying }) => {
      if (released || currentEpisodeId === null) return;
      collector.playingChanged(key, currentEpisodeId, isPlaying);
    }),

    // M1.3: ABR rendition selection. Fires whenever the player switches
    // variant, which on a multi-variant HLS source is ABR doing its job.
    player.addListener('videoTrackChange', ({ videoTrack }) => {
      if (released || currentEpisodeId === null) return;
      collector.videoTrackChanged(key, currentEpisodeId, toRendition(videoTrack));
    }),

    // The ladder the player parsed from the master playlist.
    //
    // There is no `availableVideoTracksChange` event - the list arrives with
    // `sourceLoad`, once the manifest has been read.
    player.addListener('sourceLoad', ({ availableVideoTracks }) => {
      if (released) return;
      collector.availableRenditions(
        availableVideoTracks
          .map((track) => toRendition(track))
          .filter((r): r is RenditionSample => r !== null),
      );
    }),
  ];

  return {
    key,
    player,
    get currentEpisodeId() {
      return currentEpisodeId;
    },
    set currentEpisodeId(value: string | null) {
      currentEpisodeId = value;
    },

    load(episode, autoplay) {
      if (released) return;
      currentEpisodeId = episode.id;
      firstFrameReported = false;
      lastTime = 0;
      lastAdvanceAt = Date.now();
      stallReported = false;

      collector.sourceSet(key, episode.id);
      player.replace({ uri: episode.url });
      if (autoplay) player.play();
    },

    reportFirstFrame() {
      if (released || currentEpisodeId === null || firstFrameReported) return;
      firstFrameReported = true;
      collector.firstFrame(key, currentEpisodeId);
    },

    play() {
      if (!released) player.play();
    },

    pause() {
      if (!released) player.pause();
    },

    release() {
      if (released) return;
      released = true;
      for (const subscription of subscriptions) subscription.remove();
      try {
        player.pause();
      } catch {
        // Already torn down natively - nothing useful to do.
      }
      player.release();
      collector.playerReleased(key);
      currentEpisodeId = null;
    },
  };
}
