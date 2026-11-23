import { prisma } from '../../services/prisma.js';

/**
 * Per-user library queries: history, progress, favourites.
 *
 * Module-private. Every function takes a `userId` that the caller resolved
 * from a verified credential; nothing here accepts an id from a payload.
 */

/** Shared drama shape so Continue Watching and favourites return one card. */
const dramaCardSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  posterKey: true,
  coverKey: true,
  trailerPlaybackId: true,
  contentRating: true,
  releaseStatus: true,
  totalEpisodes: true,
  freeEpisodeCount: true,
  publishedAt: true,
  language: { select: { id: true, code: true, name: true, nativeName: true } },
  categories: { select: { category: { select: { name: true } } } },
  translations: {
    where: { language: { code: 'en' } },
    select: { title: true, description: true },
    take: 1,
  },
} as const;

/**
 * Continue Watching.
 *
 * Reads `DramaProgress`, the per-drama head, rather than scanning every
 * `WatchHistory` row the viewer owns — which is why that table exists
 * (HIST-04). Completed dramas are excluded: a viewer who finished has nothing
 * to continue, and leaving it in the rail pushes down what they do want.
 */
export async function continueWatching(userId: string, limit: number) {
  return prisma.dramaProgress.findMany({
    where: {
      userId,
      isCompleted: false,
      // The drama must still be publicly visible. Unpublishing a title should
      // remove it from a viewer's rail, not leave a row that 404s on tap.
      drama: { status: 'PUBLISHED', archivedAt: null },
    },
    select: {
      positionSec: true,
      lastWatchedAt: true,
      drama: { select: dramaCardSelect },
      lastEpisode: {
        select: { id: true, episodeNumber: true, durationSec: true },
      },
    },
    orderBy: { lastWatchedAt: 'desc' },
    take: limit,
  });
}

export interface ResumeTarget {
  episodeId: string;
  episodeNumber: number;
  durationSec: number | null;
}

/**
 * Where each drama should actually resume.
 *
 * `DramaProgress` records the furthest episode *watched*. When that episode
 * is finished, the thing to resume is the next one — otherwise Continue
 * Watching offers a title at "0s left" forever, which is Issue C: a rail
 * entry that cannot be acted on and never clears.
 *
 * Returns only the dramas whose target differs from their head, so a caller
 * can treat a miss as "resume the head".
 *
 * TWO QUERIES, NOT N+1. One pass finds which heads are complete, a second
 * resolves the successors for just those. A per-row lookup here would run
 * twenty queries to render one rail.
 */
export async function resumeTargets(
  userId: string,
  heads: readonly { dramaId: string; episodeId: string; episodeNumber: number }[],
): Promise<Map<string, ResumeTarget>> {
  const targets = new Map<string, ResumeTarget>();
  if (heads.length === 0) return targets;

  const finished = await prisma.watchHistory.findMany({
    where: {
      userId,
      episodeId: { in: heads.map((head) => head.episodeId) },
      isCompleted: true,
    },
    select: { episodeId: true },
  });
  const finishedIds = new Set(finished.map((row) => row.episodeId));

  const needSuccessor = heads.filter((head) => finishedIds.has(head.episodeId));
  if (needSuccessor.length === 0) return targets;

  const successors = await prisma.episode.findMany({
    where: {
      status: 'PUBLISHED',
      season: { status: 'PUBLISHED' },
      OR: needSuccessor.map((head) => ({
        season: { dramaId: head.dramaId },
        episodeNumber: head.episodeNumber + 1,
      })),
    },
    select: {
      id: true,
      episodeNumber: true,
      durationSec: true,
      season: { select: { dramaId: true } },
    },
  });

  for (const episode of successors) {
    targets.set(episode.season.dramaId, {
      episodeId: episode.id,
      episodeNumber: episode.episodeNumber,
      durationSec: episode.durationSec,
    });
  }

  return targets;
}

/** Paginated watch history, newest first. */
export async function watchHistory(userId: string, limit: number, cursor?: string) {
  const rows = await prisma.watchHistory.findMany({
    where: {
      userId,
      episode: {
        status: 'PUBLISHED',
        season: { status: 'PUBLISHED', drama: { status: 'PUBLISHED', archivedAt: null } },
      },
    },
    select: {
      id: true,
      positionSec: true,
      isCompleted: true,
      lastWatchedAt: true,
      episode: {
        select: {
          id: true,
          episodeNumber: true,
          durationSec: true,
          season: { select: { drama: { select: dramaCardSelect } } },
        },
      },
    },
    orderBy: [{ lastWatchedAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function favorites(userId: string, limit: number, cursor?: string) {
  const rows = await prisma.favorite.findMany({
    where: { userId, drama: { status: 'PUBLISHED', archivedAt: null } },
    select: { dramaId: true, createdAt: true, drama: { select: dramaCardSelect } },
    orderBy: [{ createdAt: 'desc' }, { dramaId: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { userId_dramaId: { userId, dramaId: cursor } }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.dramaId ?? null) : null };
}

export async function favoriteIdsFor(userId: string): Promise<Set<string>> {
  const rows = await prisma.favorite.findMany({ where: { userId }, select: { dramaId: true } });
  return new Set(rows.map((row) => row.dramaId));
}

/**
 * Adds a favourite, idempotently, keeping the denormalised counter in step.
 *
 * The counter increments only when a row was actually created. Doing it
 * outside the existence check would inflate `favoriteCount` every time a
 * client retried — and a retried favourite is normal, because the mobile app
 * fires it optimistically.
 *
 * In one transaction: a crash between the insert and the increment leaves the
 * counter permanently wrong, and nothing recomputes it.
 */
export async function addFavorite(userId: string, dramaId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.favorite.findUnique({
      where: { userId_dramaId: { userId, dramaId } },
      select: { dramaId: true },
    });
    if (existing) return false;

    await tx.favorite.create({ data: { userId, dramaId } });
    await tx.drama.update({ where: { id: dramaId }, data: { favoriteCount: { increment: 1 } } });
    return true;
  });
}

/** Removes a favourite, idempotently. Mirror of `addFavorite`. */
export async function removeFavorite(userId: string, dramaId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.favorite.findUnique({
      where: { userId_dramaId: { userId, dramaId } },
      select: { dramaId: true },
    });
    if (!existing) return false;

    await tx.favorite.delete({ where: { userId_dramaId: { userId, dramaId } } });
    await tx.drama.update({
      where: { id: dramaId },
      data: { favoriteCount: { decrement: 1 } },
    });
    return true;
  });
}

export interface RecordProgressInput {
  userId: string;
  dramaId: string;
  episodeId: string;
  positionSec: number;
  durationSec: number;
  occurredAt: Date;
  completionThreshold: number;
}

export interface RecordProgressOutput {
  positionSec: number;
  isCompleted: boolean;
  applied: boolean;
  /** True when this write finished the drama's last published episode. */
  dramaIsCompleted: boolean;
}

/**
 * Records a playback position.
 *
 * THE MONOTONIC RULE. The stored position only ever moves forward, and
 * completion is sticky. API_DOCUMENTATION.md §6 states it for the server; the
 * mobile outbox depends on it, because an at-least-once queue replays writes
 * out of order whenever a device reconnects. Without this, flushing a backlog
 * would rewind a viewer to wherever the oldest queued write happened to be.
 *
 * Both tables are written in one transaction. A crash between them would
 * leave Continue Watching pointing at a position `WatchHistory` does not
 * have, and nothing reconciles the two.
 */
export async function recordProgress(input: RecordProgressInput): Promise<RecordProgressOutput> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.watchHistory.findUnique({
      where: { userId_episodeId: { userId: input.userId, episodeId: input.episodeId } },
      select: { positionSec: true, watchedSec: true, isCompleted: true, lastWatchedAt: true },
    });

    const incoming = Math.floor(Math.min(Math.max(input.positionSec, 0), input.durationSec));
    const position = Math.max(existing?.positionSec ?? 0, incoming);
    const isCompleted =
      (existing?.isCompleted ?? false) || position / input.durationSec >= input.completionThreshold;

    // A write older than what is stored is recorded for the episode — the
    // maximum rule makes that harmless — but must not move the drama head,
    // which carries ordering for Continue Watching.
    const isStale = existing !== null && existing.lastWatchedAt > input.occurredAt;

    await tx.watchHistory.upsert({
      where: { userId_episodeId: { userId: input.userId, episodeId: input.episodeId } },
      create: {
        userId: input.userId,
        episodeId: input.episodeId,
        positionSec: position,
        watchedSec: position,
        isCompleted,
        lastWatchedAt: input.occurredAt,
      },
      update: {
        positionSec: position,
        // Cumulative, for completion percentage. Never decreases.
        watchedSec: Math.max(existing?.watchedSec ?? 0, position),
        isCompleted,
        ...(isStale ? {} : { lastWatchedAt: input.occurredAt }),
      },
    });

    const head = await tx.dramaProgress.findUnique({
      where: { userId_dramaId: { userId: input.userId, dramaId: input.dramaId } },
      select: {
        lastEpisodeId: true,
        lastWatchedAt: true,
        episodesWatched: true,
        lastEpisode: { select: { episodeNumber: true } },
      },
    });

    const incomingEpisode = await tx.episode.findUnique({
      where: { id: input.episodeId },
      select: { episodeNumber: true },
    });
    const incomingNumber = incomingEpisode?.episodeNumber ?? 0;
    const headNumber = head?.lastEpisode?.episodeNumber ?? 0;

    // The head advances only forward in time and forward in episode number.
    // Rewatching episode 2 after reaching episode 5 updates episode 2's own
    // row but leaves the drama resuming at 5.
    const headShouldMove = !head || (!isStale && incomingNumber >= headNumber);

    /*
     * Is the drama itself finished?
     *
     * Only meaningful when this episode just completed AND the head is
     * moving — rewatching episode 1 of a ten-part drama completes an
     * episode but finishes nothing.
     *
     * Computed fresh rather than made sticky, deliberately: publishing
     * episode 11 of a drama a viewer had finished must put it back in
     * Continue Watching. A sticky flag would strand them on a title they
     * can no longer resume, which is the Issue C failure in reverse.
     */
    let dramaIsCompleted = false;
    if (isCompleted && headShouldMove) {
      const laterEpisode = await tx.episode.findFirst({
        where: {
          status: 'PUBLISHED',
          season: { status: 'PUBLISHED', dramaId: input.dramaId },
          episodeNumber: { gt: incomingNumber },
        },
        select: { id: true },
      });
      dramaIsCompleted = laterEpisode === null;
    }

    if (headShouldMove) {
      const episodesWatched = await tx.watchHistory.count({
        where: {
          userId: input.userId,
          isCompleted: true,
          episode: { season: { dramaId: input.dramaId } },
        },
      });

      await tx.dramaProgress.upsert({
        where: { userId_dramaId: { userId: input.userId, dramaId: input.dramaId } },
        create: {
          userId: input.userId,
          dramaId: input.dramaId,
          lastEpisodeId: input.episodeId,
          positionSec: position,
          episodesWatched,
          isCompleted: dramaIsCompleted,
          lastWatchedAt: input.occurredAt,
        },
        update: {
          lastEpisodeId: input.episodeId,
          positionSec: position,
          episodesWatched,
          isCompleted: dramaIsCompleted,
          lastWatchedAt: input.occurredAt,
        },
      });
    }

    return { positionSec: position, isCompleted, applied: !isStale, dramaIsCompleted };
  });
}

/** Confirms an episode is published and returns the drama it belongs to. */
export async function resolveEpisodeOwnership(episodeId: string) {
  return prisma.episode.findFirst({
    where: {
      id: episodeId,
      status: 'PUBLISHED',
      season: { status: 'PUBLISHED', drama: { status: 'PUBLISHED', archivedAt: null } },
    },
    select: {
      id: true,
      durationSec: true,
      season: { select: { dramaId: true } },
    },
  });
}

export async function findUserProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      phone: true,
      isAnonymous: true,
      createdAt: true,
      profile: {
        select: {
          displayName: true,
          avatarKey: true,
          preferredGenres: true,
          autoplayNext: true,
          notificationsOptIn: true,
          preferredLanguage: {
            select: { id: true, code: true, name: true, nativeName: true },
          },
        },
      },
    },
  });
}
