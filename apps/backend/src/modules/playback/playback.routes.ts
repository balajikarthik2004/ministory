import { Router } from 'express';
import { env } from '../../config/env.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { handleIngestEvents } from './playback.controller.js';

/** Path and middleware wiring only. */
export const playbackRouter: Router = Router();

/**
 * Ingestion is rate limited; nothing else in this module is.
 *
 * It is the only endpoint a client calls unprompted and in a loop, so it is
 * the only one where a bug in the retry path — ours or a future client's —
 * could hammer the server. The limit is deliberately generous; see
 * `PLAYBACK_EVENT_RATE_*` in config/env.ts for the arithmetic showing that a
 * real offline backlog cannot reach it.
 */
const ingestLimiter = rateLimit({
  windowMs: env.PLAYBACK_EVENT_RATE_WINDOW_MS,
  max: env.PLAYBACK_EVENT_RATE_MAX,
});

playbackRouter.post('/playback/events', ingestLimiter, handleIngestEvents);
