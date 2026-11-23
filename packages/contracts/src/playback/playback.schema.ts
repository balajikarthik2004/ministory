import { z } from 'zod';
import { unlockOptionSchema } from '../catalogue/catalogue.schema.js';

/**
 * Playback contract — API_DOCUMENTATION.md §5, the security-critical path.
 *
 * The client asks for a ticket to play one episode and is given a URL that
 * already expires. It never constructs a playback URL itself, and it never
 * decides whether it is entitled to one: a locked episode comes back as an
 * `EPISODE_LOCKED` error envelope, not as a flag the app could ignore.
 *
 * M2.1 fulfils this shape from a local mock backed by the FFmpeg-generated HLS
 * fixtures in tools/video-fixtures. M4 replaces the implementation behind it
 * with a signed provider URL. Nothing in the player changes when it does —
 * that is the point of resolving playback through a contract rather than
 * reading a URL off the episode record.
 */

export const subtitleTrackSchema = z.object({
  languageCode: z.string(),
  label: z.string(),
  url: z.string(),
  isDefault: z.boolean(),
});
export type SubtitleTrack = z.infer<typeof subtitleTrackSchema>;

export const playbackTicketSchema = z.object({
  episodeId: z.string(),
  /** An HLS master playlist. Signed and short-lived in production. */
  playbackUrl: z.string(),
  /** ISO-8601. The player refuses to start on an already-expired ticket. */
  expiresAt: z.string(),
  durationSec: z.number().int().positive(),
  /** Where this viewer left off, resolved server-side from WatchHistory. */
  startPositionSec: z.number().int().nonnegative(),
  subtitles: z.array(subtitleTrackSchema),
  nextEpisodeId: z.string().nullable(),
});
export type PlaybackTicket = z.infer<typeof playbackTicketSchema>;

/** The payload carried in an `EPISODE_LOCKED` error's details. */
export const lockedEpisodeInfoSchema = z.object({
  episodeId: z.string(),
  episodeNumber: z.number().int().positive(),
  unlockOptions: z.array(unlockOptionSchema),
  coinPrice: z.number().int().nonnegative(),
});
export type LockedEpisodeInfo = z.infer<typeof lockedEpisodeInfoSchema>;

// ────────────────────────── Playback telemetry ───────────────────────────

/**
 * The events a client reports about a playback session (M2.2).
 *
 * NAMING. These are lower_snake_case while every other enum in the project is
 * SCREAMING_SNAKE. That is deliberate and worth stating once: these values are
 * an analytics event taxonomy, not a database enum. They are written to
 * `PlaybackEvent.type`, aggregated into `EpisodeDailyStat`, and will appear in
 * dashboards and ad-hoc SQL for the life of the product. Matching the event
 * naming used in the M2.2 specification keeps one vocabulary across the app,
 * the API and the analytics surface. Renaming them later means rewriting
 * historical rows, so the convention is fixed here.
 *
 * WHAT EACH ONE MEANS — these definitions are the contract, because an
 * analytics event whose meaning is ambiguous produces numbers nobody trusts:
 *
 *  playback_started    A source began playing for the first time in this
 *                      session for this episode. Not emitted on resume.
 *  playback_paused     The viewer paused, or the app backgrounded.
 *  playback_resumed    Playback continued after a pause. Together with
 *                      `paused`, this is what makes watch time measurable
 *                      rather than inferred from wall-clock.
 *  playback_progress   Periodic heartbeat (SYSTEM_ARCHITECTURE.md §8: every
 *                      15 seconds). The basis of watch-duration reporting.
 *  playback_completed  Reached the end of the episode.
 *  playback_failed     The player reported an error. `errorCode` carries a
 *                      stable classification, never a raw message.
 *  episode_changed     The viewer moved to a different episode — a swipe, an
 *                      auto-advance, or a jump from the episode list.
 *  playback_abandoned  The session ended without completing: the player
 *                      screen closed, or the app was dismissed. This is the
 *                      event that makes drop-off curves possible.
 */
export const PLAYBACK_EVENT_TYPES = [
  'playback_started',
  'playback_paused',
  'playback_resumed',
  'playback_progress',
  'playback_completed',
  'playback_failed',
  'episode_changed',
  'playback_abandoned',
] as const;

export const playbackEventTypeSchema = z.enum(PLAYBACK_EVENT_TYPES);
export type PlaybackEventType = z.infer<typeof playbackEventTypeSchema>;

/**
 * A stable classification of why playback failed.
 *
 * Deliberately coarse. A free-text message from the player is a device- and
 * locale-specific string that cannot be grouped, and may carry a URL with a
 * signed token in it (CLAUDE.md §11). The code is what gets reported; the
 * detail belongs in the error monitor.
 */
export const playbackErrorCodeSchema = z.enum([
  'network',
  'decode',
  'source_unavailable',
  'ticket_expired',
  'unknown',
]);
export type PlaybackErrorCode = z.infer<typeof playbackErrorCodeSchema>;

/**
 * Context attached to every event.
 *
 * Deliberately minimal (M2.2 §2: avoid unnecessary personal or device
 * information). `platform` and `appVersion` are what make a QoE regression
 * attributable to a release or an OS; nothing here identifies a device or a
 * person. No advertising identifier, no device model, no IP, no locale, no
 * installation ID. If a future metric needs more, it gets added deliberately
 * and reviewed, rather than arriving as a convenient blob.
 */
export const playbackEventContextSchema = z.object({
  platform: z.enum(['android', 'ios', 'web']),
  appVersion: z.string(),
});
export type PlaybackEventContext = z.infer<typeof playbackEventContextSchema>;

export const playbackEventSchema = z.object({
  /**
   * Client-generated, globally unique, and the server's idempotency key.
   * A batch may be delivered twice — the queue retries on an ambiguous
   * failure, which is the correct behaviour for an at-least-once pipeline —
   * so ingestion must be able to recognise a repeat.
   */
  eventId: z.string().min(8),
  /** Groups every event from one visit to the player screen. */
  sessionId: z.string().min(8),
  dramaId: z.string().min(1),
  episodeId: z.string().min(1),
  type: playbackEventTypeSchema,
  /** ISO-8601, from the device clock. The server records its own receipt
   *  time separately; a device clock can be wrong or deliberately altered. */
  occurredAt: z.string().min(20),
  positionSec: z.number().nonnegative(),
  /** Null until the player has resolved the media's real duration. */
  durationSec: z.number().positive().nullable(),
  /** Present only on `playback_failed`. */
  errorCode: playbackErrorCodeSchema.nullable(),
  context: playbackEventContextSchema,
});
export type PlaybackEvent = z.infer<typeof playbackEventSchema>;

/**
 * The body of `POST /playback/events`.
 *
 * Batched and fire-and-forget: a client never blocks playback on telemetry,
 * and a failure here is logged and dropped rather than surfaced
 * (API_DOCUMENTATION.md §5).
 */
export const playbackEventBatchSchema = z.object({
  events: z.array(playbackEventSchema).min(1).max(100),
});
export type PlaybackEventBatch = z.infer<typeof playbackEventBatchSchema>;

/**
 * What ingestion returns.
 *
 * It names the events it has durably accepted rather than returning a bare
 * 202, because the client must not delete anything it cannot prove was
 * stored. A partial accept is therefore expressible: the unnamed events stay
 * queued and are retried.
 */
export const playbackEventAckSchema = z.object({
  acceptedEventIds: z.array(z.string()),
});
export type PlaybackEventAck = z.infer<typeof playbackEventAckSchema>;
