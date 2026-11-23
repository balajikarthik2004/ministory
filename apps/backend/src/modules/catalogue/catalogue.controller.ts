import type { Request, Response } from 'express';
import {
  dramaListQuerySchema,
  episodeListQuerySchema,
  searchQuerySchema,
} from '@minidrama/contracts';
import { sendSuccess } from '../../utils/response.js';
import { optionalCallerOf } from '../../middleware/identity.js';
import * as service from './catalogue.service.js';

/**
 * HTTP in, HTTP out. No business rules.
 *
 * Every query string is parsed through a contract schema before it reaches a
 * service, so a service never sees an unvalidated value and a malformed
 * `?limit=abc` becomes a 400 with field detail rather than a NaN that silently
 * returns the whole table.
 */

/** Express 5 types query values as unknown; the schema does the narrowing. */
function queryOf(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}

export async function handleListDramas(req: Request, res: Response): Promise<void> {
  const query = dramaListQuerySchema.parse(queryOf(req));
  const caller = optionalCallerOf(req);
  sendSuccess(res, await service.listDramas(query, caller?.userId ?? null));
}

export async function handleGetDrama(req: Request, res: Response): Promise<void> {
  const slug = String(req.params['idOrSlug'] ?? '');
  const caller = optionalCallerOf(req);
  sendSuccess(res, await service.getDramaBySlug(slug, caller?.userId ?? null));
}

export async function handleListEpisodes(req: Request, res: Response): Promise<void> {
  const dramaId = String(req.params['id'] ?? '');
  const query = episodeListQuerySchema.parse(queryOf(req));
  const caller = optionalCallerOf(req);
  sendSuccess(res, await service.listEpisodes(dramaId, query, caller?.userId ?? null));
}

export async function handleSearch(req: Request, res: Response): Promise<void> {
  const query = searchQuerySchema.parse(queryOf(req));
  const caller = optionalCallerOf(req);
  sendSuccess(res, await service.search(query, caller?.userId ?? null));
}

export async function handleListCategories(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.listCategories());
}

export async function handleListLanguages(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.listLanguages());
}

/**
 * The composed home payload — one round trip (API_DOCUMENTATION.md §4).
 *
 * Five rail requests on a cold start is five chances to be slow on a weak
 * connection, which is the connection this audience has.
 */
export async function handleHome(req: Request, res: Response): Promise<void> {
  const caller = optionalCallerOf(req);
  sendSuccess(res, await service.getHome(caller?.userId ?? null));
}
