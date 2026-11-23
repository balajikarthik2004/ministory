import { Router } from 'express';
import { requireCaller } from '../../middleware/identity.js';
import {
  handleAddFavorite,
  handleContinueWatching,
  handleFavorites,
  handleHistory,
  handleProfile,
  handleRemoveFavorite,
  handleUpdateProgress,
} from './library.controller.js';

/**
 * Everything under /me operates on the caller's own data and is guarded as a
 * group rather than per-route.
 *
 * `router.use` before any handler means a route added later is protected by
 * default. A per-route guard is one `requireCaller` away from being the
 * endpoint that leaks somebody's watch history.
 */
export const libraryRouter: Router = Router();

libraryRouter.use('/me', requireCaller);

libraryRouter.get('/me/profile', handleProfile);
libraryRouter.get('/me/continue-watching', handleContinueWatching);
libraryRouter.get('/me/history', handleHistory);
libraryRouter.put('/me/history/:episodeId', handleUpdateProgress);
libraryRouter.get('/me/favorites', handleFavorites);
libraryRouter.post('/me/favorites/:dramaId', handleAddFavorite);
libraryRouter.delete('/me/favorites/:dramaId', handleRemoveFavorite);
