import {
  playbackEventSchema,
  type PlaybackErrorCode,
  type PlaybackEvent,
  type PlaybackEventContext,
  type PlaybackEventType,
} from '@minidrama/contracts';
import type { Clock } from './db/driver';

/**
 * Builds playback events.
 *
 * Pure, synchronous, and dependency-free apart from an injected clock and ID
 * source. It does not know about SQLite, the network, or React — which is why
 * every rule in here can be tested directly.
 */

/** Supplies globally unique event and session identifiers. */
export interface IdSource {
  /** Must be unique across devices: it is the server's idempotency key. */
  newId(): string;
}

export interface PlaybackEventInput {
  type: PlaybackEventType;
  dramaId: string;
  episodeId: string;
  positionSec: number;
  durationSec: number | null;
  errorCode?: PlaybackErrorCode;
}

export interface PlaybackEventFactoryOptions {
  sessionId: string;
  context: PlaybackEventContext;
  ids: IdSource;
  clock: Clock;
}

/**
 * Builds and validates one event.
 *
 * Validation happens here, at creation, rather than at send time. An event
 * that cannot be represented should fail where the bug is — in the caller
 * that built it — not hours later in a sync worker holding a row it can
 * neither send nor explain.
 */
export function createPlaybackEvent(
  input: PlaybackEventInput,
  options: PlaybackEventFactoryOptions,
): PlaybackEvent {
  const candidate = {
    eventId: options.ids.newId(),
    sessionId: options.sessionId,
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    type: input.type,
    occurredAt: new Date(options.clock.now()).toISOString(),
    // A player can report a position fractionally past the duration, or a
    // negative one while seeking. Neither is meaningful and both break
    // downstream aggregation, so they are clamped at the boundary.
    positionSec: normalisePosition(input.positionSec, input.durationSec),
    durationSec: normaliseDuration(input.durationSec),
    errorCode: input.type === 'playback_failed' ? (input.errorCode ?? 'unknown') : null,
    context: options.context,
  };

  return playbackEventSchema.parse(candidate);
}

function normalisePosition(positionSec: number, durationSec: number | null): number {
  if (!Number.isFinite(positionSec) || positionSec < 0) return 0;
  const rounded = Math.round(positionSec * 100) / 100;
  if (durationSec !== null && Number.isFinite(durationSec) && durationSec > 0) {
    return Math.min(rounded, Math.round(durationSec * 100) / 100);
  }
  return rounded;
}

function normaliseDuration(durationSec: number | null): number | null {
  if (durationSec === null) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  return Math.round(durationSec * 100) / 100;
}

// ─────────────────────────── Progress throttle ───────────────────────────

/**
 * Decides when a `playback_progress` heartbeat is due.
 *
 * The player reports position twice a second. Recording all of that would
 * write ~1,800 rows per fifteen-minute session, which is both a battery
 * problem on the device and a storage problem on the server for data nobody
 * will ever query at that resolution.
 *
 * SYSTEM_ARCHITECTURE.md §8 specifies a heartbeat every 15 seconds. This
 * enforces that, and additionally emits when the position jumps further than
 * the interval could account for — a seek is a real event that a time-based
 * gate alone would hide, and watch-duration maths that assumes continuous
 * playback between heartbeats would otherwise count skipped content as
 * watched.
 */
export const PROGRESS_HEARTBEAT_SECONDS = 15;

export class ProgressHeartbeat {
  private lastEmittedAtMs: number | null = null;
  private lastPositionSec: number | null = null;
  private episodeId: string | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly intervalSeconds: number = PROGRESS_HEARTBEAT_SECONDS,
  ) {}

  /**
   * @returns true when a heartbeat should be recorded for this tick.
   */
  shouldEmit(episodeId: string, positionSec: number): boolean {
    const now = this.clock.now();

    // A different episode is a fresh timeline; `playback_started` covers the
    // transition, so the heartbeat clock restarts rather than firing
    // immediately on top of it.
    if (this.episodeId !== episodeId) {
      this.episodeId = episodeId;
      this.lastEmittedAtMs = now;
      this.lastPositionSec = positionSec;
      return false;
    }

    const elapsedSeconds =
      this.lastEmittedAtMs === null ? Infinity : (now - this.lastEmittedAtMs) / 1000;
    const jumped =
      this.lastPositionSec !== null &&
      Math.abs(positionSec - this.lastPositionSec) > this.intervalSeconds;

    if (elapsedSeconds >= this.intervalSeconds || jumped) {
      this.lastEmittedAtMs = now;
      this.lastPositionSec = positionSec;
      return true;
    }

    this.lastPositionSec = positionSec;
    return false;
  }

  /** Called when a session ends, so a new one starts with a clean gate. */
  reset(): void {
    this.lastEmittedAtMs = null;
    this.lastPositionSec = null;
    this.episodeId = null;
  }
}

/**
 * Maps a player error to a stable code.
 *
 * The player's own message is a device- and locale-specific string, and on
 * some Android builds it embeds the failing URL — which for a signed playback
 * URL would put a token into telemetry (CLAUDE.md §11). Only the
 * classification is reported.
 */
export function classifyPlaybackError(message: string | null | undefined): PlaybackErrorCode {
  if (!message) return 'unknown';
  const text = message.toLowerCase();
  if (/(network|timeout|unreachable|connection|dns|socket)/.test(text)) return 'network';
  if (/(decode|codec|mediacodec|format)/.test(text)) return 'decode';
  if (/(403|401|expired|forbidden|unauthori[sz]ed)/.test(text)) return 'ticket_expired';
  if (/(404|not found|no such|unavailable|source)/.test(text)) return 'source_unavailable';
  return 'unknown';
}
