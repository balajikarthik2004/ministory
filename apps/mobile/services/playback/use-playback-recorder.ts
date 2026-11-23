import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PlaybackErrorCode, PlaybackEventType } from '@minidrama/contracts';
import { createPlaybackEvent } from './events';
import { api } from '../api';
import { getPlaybackService, peekPlaybackService } from './device-service';
import type { PlaybackService } from './playback-service';

/**
 * Turns what the player reports into durable events and progress.
 *
 * The player controller does not know this exists. It reports what happened;
 * this decides what is worth recording. That separation is why the Strategy A
 * controller is untouched by M2.2 and why the recorder can be reasoned about
 * without a video decoder.
 *
 * EVERY WRITE IS FIRE-AND-FORGET. Telemetry must never block playback
 * (API_DOCUMENTATION.md §5), so nothing here is awaited by the UI and a
 * failure is swallowed after being counted. A dropped event is a worse
 * outcome than a missing one only if it takes the video with it.
 */

/** One session per visit to the player screen. */
function newSessionId(service: PlaybackService): string {
  return `ps_${service.ids.newId()}`;
}

export interface RecordEventInput {
  type: PlaybackEventType;
  dramaId: string;
  episodeId: string;
  positionSec: number;
  durationSec: number | null;
  errorCode?: PlaybackErrorCode;
}

export interface PlaybackRecorder {
  /** Queues an event. Never throws, never blocks. */
  record: (input: RecordEventInput) => void;
  /**
   * Records a heartbeat, but only when one is due. Call on every player
   * tick; the throttle decides.
   */
  recordProgressTick: (input: Omit<RecordEventInput, 'type'> & { episodeNumber: number }) => void;
  /** Persists position to SQLite. Throttled independently of events. */
  persistProgress: (input: {
    dramaId: string;
    episodeId: string;
    episodeNumber: number;
    positionSec: number;
    durationSec: number;
    /** Bypasses the throttle. Used on pause, completion and teardown. */
    immediate?: boolean;
  }) => void;
}

/**
 * How often position is written to SQLite.
 *
 * The player ticks twice a second. Writing each tick would mean ~1,800
 * transactions per fifteen-minute session — a measurable battery cost for
 * data whose useful resolution is a few seconds. Five seconds bounds the
 * worst-case loss on an unclean kill to five seconds of progress, which a
 * viewer will not notice; pause, completion and screen teardown all flush
 * immediately regardless.
 */
const PROGRESS_PERSIST_INTERVAL_MS = 5_000;

export function usePlaybackRecorder(): PlaybackRecorder {
  const serviceRef = useRef<PlaybackService | null>(peekPlaybackService());
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<ReturnType<PlaybackService['newHeartbeat']> | null>(null);
  const lastPersistRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    void (async () => {
      const service = await getPlaybackService();
      if (!mountedRef.current) return;
      serviceRef.current = service;
      sessionIdRef.current ??= newSessionId(service);
      heartbeatRef.current ??= service.newHeartbeat();
    })();

    return () => {
      mountedRef.current = false;
      heartbeatRef.current?.reset();
      heartbeatRef.current = null;
      sessionIdRef.current = null;
    };
  }, []);

  const record = useCallback((input: RecordEventInput) => {
    const service = serviceRef.current;
    if (!service) return;

    const sessionId = (sessionIdRef.current ??= newSessionId(service));

    try {
      const event = createPlaybackEvent(input, {
        sessionId,
        context: service.context,
        ids: service.ids,
        clock: service.clock,
      });
      // Not awaited: the player must not wait on a database write. The
      // outbox is durable, so a queued event survives whatever happens next.
      void service.outbox.enqueue(event).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // A malformed event is a bug in the caller, not a reason to interrupt
      // playback. It is dropped rather than persisted.
    }
  }, []);

  const recordProgressTick = useCallback<PlaybackRecorder['recordProgressTick']>(
    (input) => {
      const heartbeat = heartbeatRef.current;
      if (!heartbeat) return;
      if (!heartbeat.shouldEmit(input.episodeId, input.positionSec)) return;

      record({
        type: 'playback_progress',
        dramaId: input.dramaId,
        episodeId: input.episodeId,
        positionSec: input.positionSec,
        durationSec: input.durationSec,
      });
    },
    [record],
  );

  const persistProgress = useCallback<PlaybackRecorder['persistProgress']>((input) => {
    const service = serviceRef.current;
    if (!service || input.durationSec <= 0) return;

    const now = service.clock.now();
    if (!input.immediate && now - lastPersistRef.current < PROGRESS_PERSIST_INTERVAL_MS) return;
    lastPersistRef.current = now;

    const occurredAt = new Date(now).toISOString();

    // Local first. SQLite is the device's own record and must not depend on
    // the network — losing a viewer's position because the server was down is
    // exactly what M2.2's outbox exists to prevent.
    // `occurredAtMs` is passed explicitly so the row's `updated_at` is the
    // very string sent to the server below. `markSynced` matches on it, and
    // a repository that stamped its own `clock.now()` would differ by a
    // millisecond and leave every row dirty forever.
    const localWrite = service.progress.record({
      dramaId: input.dramaId,
      episodeId: input.episodeId,
      episodeNumber: input.episodeNumber,
      positionSec: input.positionSec,
      durationSec: input.durationSec,
      occurredAtMs: now,
    });

    void localWrite.then(
      () => undefined,
      () => undefined,
    );

    /*
     * Then the server, best-effort.
     *
     * Deliberately NOT queued in the outbox. That queue carries playback
     * events, which are append-only analytics; progress is last-write-wins
     * state with a monotonic rule on both sides. A position that failed to
     * send is superseded by the next tick a few seconds later, and the final
     * one is flushed on pause, completion and teardown. Queueing every
     * intermediate position would fill the outbox with writes that are
     * obsolete before they are delivered.
     *
     * The server applies the same monotonic rule (API_DOCUMENTATION.md §6),
     * so an out-of-order arrival cannot rewind anyone.
     */
    void (async () => {
      try {
        // The local write must land first, or `markSynced` would look for a
        // row that is not there yet and the position would stay dirty until
        // the next restart flushed it.
        await localWrite;
        await api.syncProgress({
          episodeId: input.episodeId,
          dramaId: input.dramaId,
          episodeNumber: input.episodeNumber,
          positionSec: Math.floor(input.positionSec),
          durationSec: input.durationSec,
          occurredAt,
        });
        // Delivered. Clear the flag so the startup flush does not resend it.
        await service.progress.markSynced(input.episodeId, occurredAt);
      } catch {
        // Left dirty. `flushPendingProgress` retries it on the next
        // startup, foreground or reconnect — which is the whole point of
        // the flag (M2.4 §5).
      }
    })();
  }, []);

  // The session id is deliberately NOT exposed. It lives in a ref, and
  // reading a ref during render is both flagged by react-hooks/refs and
  // genuinely wrong: the memo would capture whatever the ref held on the
  // render that happened to run first, which is `null` on mount. Nothing
  // outside this hook needs it — every event already carries it.
  return useMemo(
    () => ({ record, recordProgressTick, persistProgress }),
    [persistProgress, record, recordProgressTick],
  );
}
