import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';
import { catalogueRouter } from '../modules/catalogue/catalogue.routes.js';
import { libraryRouter } from '../modules/library/library.routes.js';
import { playbackRouter } from '../modules/playback/playback.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { attachCaller } from '../middleware/identity.js';

/**
 * Version router composition. This file only mounts module routers — it never
 * defines a route of its own.
 *
 * `attachCaller` runs before every module so the catalogue can personalise
 * `isFavorited` for a signed-in viewer while still serving guests. It resolves
 * an identity when a credential is present and does nothing when it is not;
 * `requireCaller` inside the library router is what actually refuses a
 * request.
 *
 * Modules are mounted here as they arrive:
 *   M1.3  (none — database only)
 *   M2.3  catalogue, library, playback ingestion, development identity
 *   M2.5  auth (real sessions)
 *   M4    playback tokens
 *   M5    admin
 *   M6    notifications, content-reports
 *   M7    subscriptions, payments, advertisements
 */
export const apiRouter: Router = Router();

apiRouter.use(healthRouter);

apiRouter.use(attachCaller);
apiRouter.use(authRouter);
apiRouter.use(catalogueRouter);
apiRouter.use(libraryRouter);
apiRouter.use(playbackRouter);
