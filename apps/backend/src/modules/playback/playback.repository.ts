import { prisma } from '../../services/prisma.js';
import type { PlaybackEvent } from '@minidrama/contracts';

/**
 * Playback event persistence.
 *
 * ONE RESPONSIBILITY: write events exactly once, however many times they
 * arrive. The mobile outbox delivers at-least-once (ADR-25) and will resend a
 * batch whose response was lost, so a repeat is normal traffic rather than an
 * error condition.
 */

export interface PersistResult {
  /** Events now durably stored — includes ones that were already present. */
  acceptedEventIds: string[];
  /** Newly written. Diagnostics only; the client does not need the split. */
  insertedCount: number;
  duplicateCount: number;
}

/**
 * Stores a batch.
 *
 * `skipDuplicates` turns idempotency into a primary-key constraint rather
 * than a read-then-write. The alternative — SELECT the existing ids, then
 * insert the rest — has a race between the two statements that two concurrent
 * retries of the same batch would lose.
 *
 * A duplicate is acknowledged, not rejected. The client is asking "is this
 * stored?", and for an event we already hold the answer is yes. Refusing it
 * would leave the row in the outbox forever, retried until it died.
 *
 * `receivedAt` is deliberately NOT set here: the column defaults to the
 * database's `CURRENT_TIMESTAMP`. Taking server time from the database rather
 * than from the Node process means it is consistent across instances and
 * cannot be influenced by anything in the request.
 */
export async function persistEvents(
  events: readonly PlaybackEvent[],
  userId: string | null,
): Promise<PersistResult> {
  if (events.length === 0) {
    return { acceptedEventIds: [], insertedCount: 0, duplicateCount: 0 };
  }

  const result = await prisma.playbackEvent.createMany({
    data: events.map((event) => ({
      eventId: event.eventId,
      sessionId: event.sessionId,
      // From the verified caller, never from the payload. The contract has no
      // userId field precisely so there is nothing to spoof.
      userId,
      dramaId: event.dramaId,
      episodeId: event.episodeId,
      type: event.type,
      positionSec: event.positionSec,
      durationSec: event.durationSec,
      errorCode: event.errorCode,
      occurredAt: new Date(event.occurredAt),
      platform: event.context.platform,
      appVersion: event.context.appVersion,
    })),
    skipDuplicates: true,
  });

  const inserted = result.count;
  return {
    acceptedEventIds: events.map((event) => event.eventId),
    insertedCount: inserted,
    duplicateCount: events.length - inserted,
  };
}

/** Which of these ids are already stored. Test and diagnostics support. */
export async function existingEventIds(eventIds: readonly string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await prisma.playbackEvent.findMany({
    where: { eventId: { in: [...eventIds] } },
    select: { eventId: true },
  });
  return new Set(rows.map((row) => row.eventId));
}

/** Episode ids that exist and are published, from a candidate list. */
export async function publishedEpisodeIds(episodeIds: readonly string[]): Promise<Set<string>> {
  if (episodeIds.length === 0) return new Set();
  const rows = await prisma.episode.findMany({
    where: {
      id: { in: [...episodeIds] },
      status: 'PUBLISHED',
      season: { status: 'PUBLISHED', drama: { status: 'PUBLISHED', archivedAt: null } },
    },
    select: { id: true, season: { select: { dramaId: true } } },
  });
  return new Set(rows.map((row) => row.id));
}

/** Episode id → the drama that actually owns it. */
export async function episodeOwners(episodeIds: readonly string[]): Promise<Map<string, string>> {
  if (episodeIds.length === 0) return new Map();
  const rows = await prisma.episode.findMany({
    where: { id: { in: [...episodeIds] } },
    select: { id: true, season: { select: { dramaId: true } } },
  });
  return new Map(rows.map((row) => [row.id, row.season.dramaId]));
}

export async function countEventsForSession(sessionId: string): Promise<number> {
  return prisma.playbackEvent.count({ where: { sessionId } });
}
