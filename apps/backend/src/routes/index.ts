import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Version router composition. This file only mounts module routers - it never
 * defines a route of its own.
 *
 * Modules are mounted here as they arrive:
 *   M1.3  (none - database only)
 *   M3    auth, users, dramas, seasons, episodes, categories, languages,
 *         watch-history, favorites
 *   M4    playback
 *   M5    admin
 *   M6    notifications, content-reports
 *   M7    subscriptions, payments, advertisements
 */
export const apiRouter: Router = Router();

apiRouter.use(healthRouter);
