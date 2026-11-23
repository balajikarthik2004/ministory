import type { Request, Response } from 'express';
import { paginationQuerySchema, progressUpdateRequestSchema } from '@minidrama/contracts';
import { sendSuccess } from '../../utils/response.js';
import { callerOf } from '../../middleware/identity.js';
import * as service from './library.service.js';

/**
 * Every handler here calls `callerOf`, which throws if the route was reached
 * without `requireCaller`. A forgotten guard therefore fails with a 401
 * rather than silently operating on `undefined`.
 *
 * No handler reads a user id from params, query or body.
 */

function queryOf(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}

export async function handleContinueWatching(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const { limit } = paginationQuerySchema.parse(queryOf(req));
  sendSuccess(res, await service.continueWatching(userId, limit));
}

export async function handleHistory(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const { limit, cursor } = paginationQuerySchema.parse(queryOf(req));
  sendSuccess(res, await service.watchHistory(userId, limit, cursor));
}

export async function handleFavorites(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const { limit, cursor } = paginationQuerySchema.parse(queryOf(req));
  sendSuccess(res, await service.favorites(userId, limit, cursor));
}

export async function handleAddFavorite(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const dramaId = String(req.params['dramaId'] ?? '');
  sendSuccess(res, await service.addFavorite(userId, dramaId));
}

export async function handleRemoveFavorite(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const dramaId = String(req.params['dramaId'] ?? '');
  sendSuccess(res, await service.removeFavorite(userId, dramaId));
}

export async function handleUpdateProgress(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const episodeId = String(req.params['episodeId'] ?? '');
  const body = progressUpdateRequestSchema.parse(req.body);
  sendSuccess(res, await service.updateProgress(userId, episodeId, body));
}

export async function handleProfile(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  sendSuccess(res, await service.getProfile(userId));
}
