import {
  playbackEventSchema,
  type PlaybackEvent,
  type PlaybackEventAck,
} from '@minidrama/contracts';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import * as repo from './playback.repository.js';

/**
 * Playback event ingestion.
 *
 * PARTIAL ACCEPTANCE IS THE POINT. The response names the events that are
 * durably stored, and the client deletes only those. Anything unnamed stays
 * in its outbox and is retried. So a batch containing one bad event must not
 * fail the whole batch — that would strand the good events behind it forever,
 * retried until they died.
 *
 * The rules, in order:
 *
 *   1. Every event is re-validated against the shared contract. The client
 *      validated it too; this is the server not trusting that.
 *   2. An event naming an episode that does not exist or is not published is
 *      dropped and NOT acknowledged — it is either a bug or a probe, and
 *      acknowledging it would write unjoinable analytics rows.
 *   3. An event claiming the wrong drama for its episode has the drama
 *      corrected from the database. The client's `dramaId` is a convenience
 *      denormalisation, not an authority.
 *   4. Duplicates are acknowledged. We already hold them.
 */

/** Rejected events, for the log. Never returned to the client. */
interface Rejection {
  eventId: string | null;
  reason: string;
}

export interface IngestResult extends PlaybackEventAck {
  insertedCount: number;
  duplicateCount: number;
  rejectedCount: number;
}

export async function ingestEvents(
  rawEvents: readonly unknown[],
  userId: string | null,
  requestId: string | undefined,
): Promise<IngestResult> {
  if (rawEvents.length === 0) {
    throw AppError.validation([{ field: 'events', message: 'At least one event is required.' }]);
  }

  /*
   * Checked against the parsed array, separately from the body-size cap.
   * Two limits because they fail differently: the body cap stops a huge
   * payload reaching the parser, this stops a small one that expands into an
   * expensive write.
   */
  if (rawEvents.length > env.PLAYBACK_EVENT_MAX_BATCH) {
    throw AppError.validation([
      {
        field: 'events',
        message: `A batch may contain at most ${env.PLAYBACK_EVENT_MAX_BATCH} events.`,
      },
    ]);
  }

  const valid: PlaybackEvent[] = [];
  const rejections: Rejection[] = [];

  for (const candidate of rawEvents) {
    const parsed = playbackEventSchema.safeParse(candidate);
    if (!parsed.success) {
      rejections.push({
        eventId: readEventId(candidate),
        reason: parsed.error.issues.map((issue) => issue.path.join('.')).join(', ') || 'invalid',
      });
      continue;
    }
    valid.push(parsed.data);
  }

  if (valid.length === 0) {
    logger.warn({ requestId, rejected: rejections.length }, 'Playback batch had no valid events');
    return {
      acceptedEventIds: [],
      insertedCount: 0,
      duplicateCount: 0,
      rejectedCount: rejections.length,
    };
  }

  // Two lookups for the whole batch rather than one per event.
  const episodeIds = [...new Set(valid.map((event) => event.episodeId))];
  const [published, owners] = await Promise.all([
    repo.publishedEpisodeIds(episodeIds),
    repo.episodeOwners(episodeIds),
  ]);

  const persistable: PlaybackEvent[] = [];
  for (const event of valid) {
    if (!published.has(event.episodeId)) {
      rejections.push({ eventId: event.eventId, reason: 'unknown or unpublished episode' });
      continue;
    }
    const owner = owners.get(event.episodeId);
    persistable.push(owner && owner !== event.dramaId ? { ...event, dramaId: owner } : event);
  }

  if (persistable.length === 0) {
    logger.warn({ requestId, rejected: rejections.length }, 'Playback batch had nothing to store');
    return {
      acceptedEventIds: [],
      insertedCount: 0,
      duplicateCount: 0,
      rejectedCount: rejections.length,
    };
  }

  const stored = await repo.persistEvents(persistable, userId);

  if (rejections.length > 0) {
    // Logged, never returned: the client cannot act on it, and echoing a
    // rejected payload back is an information leak (CLAUDE.md §11).
    logger.warn(
      { requestId, rejections: rejections.slice(0, 10), total: rejections.length },
      'Some playback events were rejected',
    );
  }

  return {
    acceptedEventIds: stored.acceptedEventIds,
    insertedCount: stored.insertedCount,
    duplicateCount: stored.duplicateCount,
    rejectedCount: rejections.length,
  };
}

/** Best-effort id from an unparseable event, so the log can name it. */
function readEventId(candidate: unknown): string | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const value = (candidate as { eventId?: unknown }).eventId;
  return typeof value === 'string' ? value.slice(0, 64) : null;
}
