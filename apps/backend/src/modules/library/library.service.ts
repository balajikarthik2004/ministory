import type {
  ContinueWatchingItem,
  DramaCard,
  FavoriteResult,
  ProgressUpdateRequest,
  ProgressUpdateResult,
  UserProfile,
  WatchHistoryEntry,
} from '@minidrama/contracts';
import { AppError } from '../../utils/app-error.js';
import { toDramaCard, resolveAssetUrl } from '../catalogue/catalogue.mapper.js';
import * as repo from './library.repository.js';

/**
 * The viewer's own data.
 *
 * Every function's first parameter is a `userId` the caller resolved from a
 * verified credential. There is no code path here that reads an id from a
 * payload — that is the ownership guarantee, and it is structural rather than
 * a check somebody has to remember (CLAUDE.md §11).
 */

/** PRD HIST-03: an episode is complete at ≥90% watched. */
export const COMPLETION_THRESHOLD = 0.9;

export async function continueWatching(
  userId: string,
  limit = 20,
): Promise<ContinueWatchingItem[]> {
  const rows = await repo.continueWatching(userId, limit);
  const favorites = await repo.favoriteIdsFor(userId);

  /*
   * Resolve each head to what should actually be played next (Issue C).
   *
   * A head whose episode is finished resumes at the *following* episode,
   * from the start. Without this the rail shows a finished episode at
   * "0s left" and tapping it replays something the viewer just watched.
   *
   * A drama with no successor never reaches here: completing its final
   * episode sets `DramaProgress.isCompleted`, and the repository query
   * excludes completed dramas from the rail entirely.
   */
  const targets = await repo.resumeTargets(
    userId,
    rows.map((row) => ({
      dramaId: row.drama.id,
      episodeId: row.lastEpisode.id,
      episodeNumber: row.lastEpisode.episodeNumber,
    })),
  );

  return rows.map((row) => {
    const next = targets.get(row.drama.id);
    return {
      drama: toDramaCard(row.drama, favorites),
      episodeId: next?.episodeId ?? row.lastEpisode.id,
      episodeNumber: next?.episodeNumber ?? row.lastEpisode.episodeNumber,
      // A fresh episode starts at zero; only the unfinished head carries a
      // position worth resuming from.
      positionSec: next ? 0 : Math.floor(row.positionSec),
      durationSec: positiveDuration(next ? next.durationSec : row.lastEpisode.durationSec),
      lastWatchedAt: row.lastWatchedAt.toISOString(),
    };
  });
}

export async function watchHistory(
  userId: string,
  limit = 20,
  cursor?: string,
): Promise<{ items: WatchHistoryEntry[]; nextCursor: string | null; hasMore: boolean }> {
  const page = await repo.watchHistory(userId, limit, cursor);
  const favorites = await repo.favoriteIdsFor(userId);

  return {
    items: page.items.map((row) => ({
      drama: toDramaCard(row.episode.season.drama, favorites),
      episodeId: row.episode.id,
      episodeNumber: row.episode.episodeNumber,
      positionSec: Math.floor(row.positionSec),
      durationSec: positiveDuration(row.episode.durationSec),
      isCompleted: row.isCompleted,
      lastWatchedAt: row.lastWatchedAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function favorites(
  userId: string,
  limit = 50,
  cursor?: string,
): Promise<{ items: DramaCard[]; nextCursor: string | null; hasMore: boolean }> {
  const page = await repo.favorites(userId, limit, cursor);
  // Every drama in this list is by definition favourited by this caller.
  const ids = new Set(page.items.map((row) => row.dramaId));

  return {
    items: page.items.map((row) => toDramaCard(row.drama, ids)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * Idempotent add. A repeated call is success, not a conflict — the mobile app
 * fires this optimistically and retries, and a 409 would surface as an error
 * for an action that already achieved what the viewer wanted.
 */
export async function addFavorite(userId: string, dramaId: string): Promise<FavoriteResult> {
  await repo.addFavorite(userId, dramaId);
  return { dramaId, isFavorited: true };
}

export async function removeFavorite(userId: string, dramaId: string): Promise<FavoriteResult> {
  await repo.removeFavorite(userId, dramaId);
  return { dramaId, isFavorited: false };
}

/**
 * Records a playback position.
 *
 * The episode is resolved server-side and its `dramaId` is taken from the
 * database, not from the request. The body carries a `dramaId`, but it is only
 * checked for agreement — a client that claims episode X belongs to drama Y
 * cannot write progress into Y.
 */
export async function updateProgress(
  userId: string,
  episodeId: string,
  body: ProgressUpdateRequest,
): Promise<ProgressUpdateResult> {
  const episode = await repo.resolveEpisodeOwnership(episodeId);
  if (!episode) throw AppError.notFound('That episode');

  if (body.dramaId !== episode.season.dramaId) {
    // Not a 403: the caller is allowed to write their own progress, they just
    // described this episode incorrectly. Treating it as validation keeps the
    // message useful without implying an authorisation problem.
    throw AppError.validation([
      { field: 'dramaId', message: 'This episode does not belong to that drama.' },
    ]);
  }

  // The media's real length, from the catalogue — not the client's claim.
  // A client reporting a 10000-second duration would otherwise make a 90%
  // completion threshold unreachable.
  const durationSec = positiveDuration(episode.durationSec ?? body.durationSec);

  const occurredAt = parseOccurredAt(body.occurredAt);

  const result = await repo.recordProgress({
    userId,
    dramaId: episode.season.dramaId,
    episodeId,
    positionSec: body.positionSec,
    durationSec,
    occurredAt,
    completionThreshold: COMPLETION_THRESHOLD,
  });

  return {
    episodeId,
    positionSec: result.positionSec,
    isCompleted: result.isCompleted,
    applied: result.applied,
  };
}

export async function getProfile(userId: string): Promise<UserProfile> {
  const row = await repo.findUserProfile(userId);
  if (!row) throw AppError.notFound('That account');

  return {
    id: row.id,
    displayName: row.profile?.displayName ?? null,
    email: row.email,
    phone: row.phone,
    isAnonymous: row.isAnonymous,
    avatarUrl: row.profile?.avatarKey
      ? resolveAssetUrl(row.profile.avatarKey, row.id, 'avatar')
      : null,
    preferredLanguage: row.profile?.preferredLanguage
      ? {
          id: row.profile.preferredLanguage.id,
          code: row.profile.preferredLanguage.code,
          name: row.profile.preferredLanguage.name,
          nativeName: row.profile.preferredLanguage.nativeName,
        }
      : null,
    preferredGenres: row.profile?.preferredGenres ?? [],
    autoplayNext: row.profile?.autoplayNext ?? true,
    notificationsOptIn: row.profile?.notificationsOptIn ?? true,
    // Subscriptions are M7. Reported as NONE rather than omitted, because the
    // contract requires a value and inventing an ACTIVE one would be a
    // client-visible entitlement claim with nothing behind it.
    subscriptionStatus: 'NONE',
    memberSince: row.createdAt.toISOString(),
  };
}

/**
 * A duration the contract will accept.
 *
 * `Episode.durationSec` is nullable until a video is processed, and the
 * contract requires a positive number. Returning 1 rather than 0 keeps the
 * completion maths from dividing by zero; the client already treats a
 * nonsensical duration as unknown.
 */
function positiveDuration(value: number | null): number {
  return value && value > 0 ? value : 1;
}

function parseOccurredAt(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  /*
   * A device clock can be wrong or deliberately set forward. A future
   * timestamp would win every staleness comparison from then on and freeze
   * the viewer's Continue Watching ordering, so it is clamped to now.
   */
  const now = new Date();
  return parsed > now ? now : parsed;
}
