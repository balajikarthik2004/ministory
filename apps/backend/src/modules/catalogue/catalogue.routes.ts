import { Router } from 'express';
import {
  handleGetDrama,
  handleHome,
  handleListCategories,
  handleListDramas,
  handleListEpisodes,
  handleListLanguages,
  handleSearch,
} from './catalogue.controller.js';

/**
 * Catalogue routes. All public — guest browsing is a product requirement
 * (PRD AUTH-03) — but personalised when a credential is present, which is why
 * `attachCaller` runs globally rather than per-route.
 */
export const catalogueRouter: Router = Router();

catalogueRouter.get('/home', handleHome);
catalogueRouter.get('/dramas', handleListDramas);
catalogueRouter.get('/dramas/:idOrSlug', handleGetDrama);
catalogueRouter.get('/dramas/:id/episodes', handleListEpisodes);
catalogueRouter.get('/categories', handleListCategories);
catalogueRouter.get('/languages', handleListLanguages);
catalogueRouter.get('/search', handleSearch);
