import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import type { PlaybackTicket } from '@minidrama/contracts';
import { PLAYBACK_ERROR_COPY } from '../../services/errors';
import type { PlaybackCallbacks, PlaybackSnapshot, VideoPlayerController } from './types';

/**
 * Strategy A — one player instance, source replaced on every swipe.
 *
 * This is the strategy docs/VIDEO_PLAYER_SPIKE.md §10 recommends, and the
 * reasoning is worth keeping next to the code:
 *
 *   - A was best on visible-frame rate (58.9% vs B 53.3% vs C 30.0%) and best
 *     on time-to-first-frame at every percentile, with a p95 of ~1095 ms — the
 *     only strategy inside the 1.5 s target.
 *   - Three players was actively harmful, roughly halving the success rate.
 *   - The residual miss rate was a *packaging* problem, not a pooling problem.
 *     The ABR ladder closed it completely (58.9% → 100% on the constrained
 *     profile), which is why the mock serves the multi-variant fixtures from
 *     tools/video-fixtures/out-abr rather than the single-variant set.
 *
 * Lifecycle: `useVideoPlayer` owns release-on-unmount, which is what Strategy
 * A wants — there is no manual pool to drain. `releaseSource` exists for the
 * case where the screen wants playback to stop before the component unmounts
 * (navigating away), because an ExoPlayer holding a decoder on a 4GB device is
 * exactly the cost CLAUDE.md §13 is about.
 */

/** How often the player reports position. 0.5s is enough for a scrub bar and
 *  cheap enough not to flood the JS thread during a swipe. */
const TIME_UPDATE_INTERVAL_SECONDS = 0.5;

/** Progress is persisted at most this often, regardless of tick rate. */
const PROGRESS_FLUSH_MS = 4000;

export function useSinglePlayerController(
  callbacks: PlaybackCallbacks,
  initialMuted: boolean,
): VideoPlayerController {
  // Created with a null source: the first real source arrives from a playback
  // ticket, never from a URL the component guessed.
  const player = useVideoPlayer(null, (instance) => {
    instance.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_SECONDS;
    instance.loop = false;
    instance.muted = initialMuted;
    // Background playback is off by default (CLAUDE.md §5). Nothing enables
    // it; this is stated to make the default explicit rather than incidental.
    instance.staysActiveInBackground = false;
  });

  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({
    phase: 'idle',
    episodeId: null,
    positionSec: 0,
    durationSec: 0,
    muted: initialMuted,
    errorMessage: null,
  });

  /** The ticket currently loaded, kept for `retry`. */
  const ticketRef = useRef<PlaybackTicket | null>(null);
  const lastFlushRef = useRef(0);
  const endedReportedRef = useRef(false);
  const firstFrameSeenRef = useRef(false);
  /**
   * Distinguishes the first play of an episode from a resume.
   *
   * `playingChange` cannot tell them apart on its own — both are
   * `isPlaying: true` — and conflating them would make "how many people
   * started this episode" count every unpause.
   */
  const startedReportedRef = useRef(false);

  // Callbacks live in a ref so the listener effect does not re-subscribe every
  // time the screen re-renders. Re-subscribing mid-playback drops events.
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const patch = useCallback((next: Partial<PlaybackSnapshot>) => {
    setSnapshot((current) => ({ ...current, ...next }));
  }, []);

  /** The media's real duration, or the ticket's, or null if neither is known. */
  const effectiveDuration = useCallback((): number | null => {
    if (Number.isFinite(player.duration) && player.duration > 0) return player.duration;
    const fromTicket = ticketRef.current?.durationSec;
    return fromTicket && fromTicket > 0 ? fromTicket : null;
  }, [player]);

  // ── Player event wiring ────────────────────────────────────────────────
  useEffect(() => {
    const subscriptions = [
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'error') {
          // The underlying message goes nowhere near the screen. It is passed
          // upward only so the recorder can classify it into a stable code;
          // the user sees fixed copy (CLAUDE.md §11).
          patch({ phase: 'error', errorMessage: PLAYBACK_ERROR_COPY });
          const episodeId = ticketRef.current?.episodeId;
          if (episodeId) {
            callbacksRef.current.onLifecycle?.({
              kind: 'failed',
              episodeId,
              positionSec: player.currentTime,
              durationSec: effectiveDuration(),
              rawMessage: error?.message ?? null,
            });
          }
          return;
        }
        if (status === 'loading') {
          // Distinguish the first load from a mid-playback rebuffer: both are
          // `loading`, but only one should blank the overlay.
          patch({ phase: firstFrameSeenRef.current ? 'buffering' : 'loading' });
          return;
        }
        if (status === 'readyToPlay') {
          patch({
            phase: player.playing ? 'playing' : 'paused',
            durationSec: Number.isFinite(player.duration) ? player.duration : 0,
            errorMessage: null,
          });
        }
      }),

      player.addListener('playingChange', ({ isPlaying }) => {
        setSnapshot((current) => {
          if (current.phase === 'error' || current.phase === 'ended') return current;
          return { ...current, phase: isPlaying ? 'playing' : 'paused' };
        });

        const episodeId = ticketRef.current?.episodeId;
        if (!episodeId) return;
        const payload = {
          episodeId,
          positionSec: player.currentTime,
          durationSec: effectiveDuration(),
        };

        if (isPlaying) {
          if (startedReportedRef.current) {
            callbacksRef.current.onLifecycle?.({ kind: 'resumed', ...payload });
          } else {
            startedReportedRef.current = true;
            callbacksRef.current.onLifecycle?.({ kind: 'started', ...payload });
          }
          return;
        }

        // A pause before anything played is the player settling, not the
        // viewer acting. Reporting it would put a `paused` before the
        // `started` it belongs to.
        if (startedReportedRef.current) {
          callbacksRef.current.onLifecycle?.({ kind: 'paused', ...payload });
        }
      }),

      player.addListener('mutedChange', ({ muted }) => {
        patch({ muted });
      }),

      player.addListener('timeUpdate', ({ currentTime }) => {
        const episodeId = ticketRef.current?.episodeId;
        if (!episodeId) return;

        const durationSec =
          Number.isFinite(player.duration) && player.duration > 0
            ? player.duration
            : (ticketRef.current?.durationSec ?? 0);

        patch({ positionSec: currentTime, durationSec });

        // Persisting on every tick would write the store twice a second and
        // re-render anything subscribed to it. Throttled to a flush interval.
        const now = Date.now();
        if (now - lastFlushRef.current >= PROGRESS_FLUSH_MS && durationSec > 0) {
          lastFlushRef.current = now;
          callbacksRef.current.onProgress(episodeId, currentTime, durationSec);
        }
      }),

      player.addListener('playToEnd', () => {
        const episodeId = ticketRef.current?.episodeId;
        if (!episodeId || endedReportedRef.current) return;
        endedReportedRef.current = true;

        const durationSec =
          Number.isFinite(player.duration) && player.duration > 0
            ? player.duration
            : (ticketRef.current?.durationSec ?? 0);

        // Flush the final position before announcing the end, so the episode
        // is recorded as complete rather than at wherever the last tick fell.
        callbacksRef.current.onProgress(episodeId, durationSec, durationSec);
        patch({ phase: 'ended', positionSec: durationSec });
        callbacksRef.current.onEnded(episodeId);
      }),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [effectiveDuration, patch, player]);

  // ── Commands ───────────────────────────────────────────────────────────

  const applyTicket = useCallback(
    (ticket: PlaybackTicket, instance: VideoPlayer) => {
      ticketRef.current = ticket;
      endedReportedRef.current = false;
      firstFrameSeenRef.current = false;
      startedReportedRef.current = false;
      lastFlushRef.current = Date.now();

      patch({
        phase: 'loading',
        episodeId: ticket.episodeId,
        positionSec: ticket.startPositionSec,
        durationSec: ticket.durationSec,
        errorMessage: null,
      });

      // `replaceAsync` rather than `replace`: the synchronous form blocks
      // while the new source is prepared, which on a swipe is a visible hitch
      // on exactly the mid-range devices this app targets.
      instance
        .replaceAsync({ uri: ticket.playbackUrl, contentType: 'hls' })
        .then(() => {
          // Resume where the viewer left off. The *server* decided this
          // position (API_DOCUMENTATION.md §5 returns startPositionSec); the
          // client does not look it up, so resume behaves the same on a new
          // device as on the one that built the history.
          if (ticket.startPositionSec > 0) {
            instance.currentTime = ticket.startPositionSec;
          }
          instance.play();
        })
        .catch(() => {
          patch({ phase: 'error', errorMessage: PLAYBACK_ERROR_COPY });
        });
    },
    [patch],
  );

  const load = useCallback(
    (ticket: PlaybackTicket) => {
      // Re-loading the episode already playing would restart it mid-watch,
      // which is what happens if a list re-emits its current index.
      //
      // The guard is on episode identity ALONE, deliberately. An earlier
      // version also reloaded when the phase was 'error', so that a failed
      // episode would recover by itself. That produced an infinite retry
      // loop: the phase was a dependency of this callback, so an error
      // changed `load`'s identity, which re-ran the caller's effect, which
      // called `load`, which reloaded, which errored again — hammering a
      // failing stream as fast as it could fail. Recovery is `retry()`,
      // driven by the user pressing the retry control.
      if (ticketRef.current?.episodeId === ticket.episodeId) return;
      applyTicket(ticket, player);
    },
    [applyTicket, player],
  );

  const play = useCallback(() => {
    player.play();
  }, [player]);

  const pause = useCallback(() => {
    player.pause();
  }, [player]);

  const togglePlay = useCallback(() => {
    if (player.playing) player.pause();
    else player.play();
  }, [player]);

  /*
   * `react-hooks/immutability` flags the two assignments below, because the
   * player came out of a hook and the rule treats hook return values as
   * immutable. That is the right default and a false positive here:
   * `VideoPlayer` is an `expo.SharedObject` wrapping a native ExoPlayer, and
   * `muted` and `currentTime` are its *documented* imperative setters —
   * assigning `currentTime` is how expo-video seeks. There is no functional
   * alternative to move the mutation to, and the object is not React state:
   * nothing re-renders from it. The visible state that does drive rendering
   * is mirrored into `snapshot` through `patch`, immediately below each
   * assignment, so the component tree still updates through React.
   *
   * Scoped to these two callbacks rather than the whole file, so a genuine
   * mutation of React-owned state elsewhere in this hook is still caught.
   */
  /* eslint-disable react-hooks/immutability -- expo-video's native setters; see note above */
  const setMuted = useCallback(
    (muted: boolean) => {
      player.muted = muted;
      patch({ muted });
    },
    [patch, player],
  );

  const seekTo = useCallback(
    (positionSec: number) => {
      const duration = Number.isFinite(player.duration) ? player.duration : 0;
      const target = Math.max(0, duration > 0 ? Math.min(positionSec, duration) : positionSec);
      player.currentTime = target;
      patch({ positionSec: target });
      endedReportedRef.current = false;
    },
    [patch, player],
  );
  /* eslint-enable react-hooks/immutability */

  const retry = useCallback(() => {
    const ticket = ticketRef.current;
    if (!ticket) return;
    // Clear the identity check in `load` so the same episode reloads.
    ticketRef.current = null;
    applyTicket(ticket, player);
  }, [applyTicket, player]);

  const releaseSource = useCallback(() => {
    ticketRef.current = null;
    firstFrameSeenRef.current = false;
    try {
      player.pause();
      // Dropping the source frees the decoder without destroying the player
      // object, which `useVideoPlayer` releases on unmount anyway. Calling
      // this on navigate-away is what stops audio continuing over the next
      // screen if the unmount is a frame late.
      player.replace(null, true);
    } catch {
      // The player may already be released if this runs during teardown.
      // Nothing useful to do, and throwing here would break unmount.
    }
    patch({ phase: 'idle', episodeId: null, positionSec: 0, errorMessage: null });
  }, [patch, player]);

  const reportFirstFrame = useCallback(() => {
    firstFrameSeenRef.current = true;
    setSnapshot((current) =>
      current.phase === 'loading' || current.phase === 'buffering'
        ? { ...current, phase: 'playing' }
        : current,
    );
  }, []);

  return useMemo(
    (): VideoPlayerController => ({
      snapshot,
      player,
      load,
      play,
      pause,
      togglePlay,
      setMuted,
      seekTo,
      retry,
      releaseSource,
      reportFirstFrame,
    }),
    [
      load,
      pause,
      play,
      player,
      releaseSource,
      reportFirstFrame,
      retry,
      seekTo,
      setMuted,
      snapshot,
      togglePlay,
    ],
  );
}
