import { z } from 'zod';
import { dramaCardSchema, languageSchema } from '../catalogue/catalogue.schema.js';

/**
 * Library contract — the viewer's own data. API_DOCUMENTATION.md §6.
 *
 * Everything here is per-user and requires authentication in production. M2.1
 * runs against a mock profile; the shapes are what M3 will implement.
 */

export const watchHistoryEntrySchema = z.object({
  drama: dramaCardSchema,
  episodeId: z.string(),
  episodeNumber: z.number().int().positive(),
  positionSec: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
  isCompleted: z.boolean(),
  lastWatchedAt: z.string(),
});
export type WatchHistoryEntry = z.infer<typeof watchHistoryEntrySchema>;

/**
 * Written on every position flush. The server takes the maximum position and
 * never a lower one, so an out-of-order replay from the offline queue cannot
 * rewind a viewer's progress (API_DOCUMENTATION.md §6).
 */
export const watchProgressUpdateSchema = z.object({
  episodeId: z.string(),
  positionSec: z.number().int().nonnegative(),
  watchedSec: z.number().int().nonnegative(),
});
export type WatchProgressUpdate = z.infer<typeof watchProgressUpdateSchema>;

export const subscriptionStatusSchema = z.enum(['NONE', 'ACTIVE', 'GRACE', 'EXPIRED']);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const userProfileSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** PRD AUTH-03. A guest is a real account, not the absence of one. */
  isAnonymous: z.boolean(),
  avatarUrl: z.string().nullable(),
  preferredLanguage: languageSchema.nullable(),
  preferredGenres: z.array(z.string()),
  autoplayNext: z.boolean(),
  notificationsOptIn: z.boolean(),
  /**
   * Display only. CLAUDE.md §11: the client never decides entitlement from
   * this field — the playback token endpoint evaluates it server-side.
   */
  subscriptionStatus: subscriptionStatusSchema,
  memberSince: z.string(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

// ──────────────────────── Library requests (M2.3) ────────────────────────

/**
 * The body of `PUT /me/history/:episodeId`.
 *
 * Deliberately does NOT carry a userId. The caller is whoever the request is
 * authenticated as, resolved by middleware from the credential — never from
 * the body. A body-supplied userId is an ownership claim the server would have
 * to disprove (CLAUDE.md §11).
 */
export const progressUpdateRequestSchema = z.object({
  dramaId: z.string().min(1),
  episodeNumber: z.number().int().positive(),
  positionSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  /**
   * The device clock at the moment this position was observed.
   *
   * Optional, and used only to reject a stale write: a queued update flushed
   * after a newer one must not move the viewer backwards. Absent means "now".
   */
  occurredAt: z.string().optional(),
});
export type ProgressUpdateRequest = z.infer<typeof progressUpdateRequestSchema>;

export const progressUpdateResultSchema = z.object({
  episodeId: z.string(),
  positionSec: z.number().nonnegative(),
  isCompleted: z.boolean(),
  /** False when the write was ignored because a newer one already applied. */
  applied: z.boolean(),
});
export type ProgressUpdateResult = z.infer<typeof progressUpdateResultSchema>;

export const favoriteResultSchema = z.object({
  dramaId: z.string(),
  isFavorited: z.boolean(),
});
export type FavoriteResult = z.infer<typeof favoriteResultSchema>;
