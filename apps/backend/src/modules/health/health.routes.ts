import { Router } from 'express';
import { handleHealth, handleReadiness } from './health.controller.js';

/** Path and middleware wiring only - no logic in a routes file. */
export const healthRouter: Router = Router();

healthRouter.get('/health', handleHealth);
healthRouter.get('/ready', handleReadiness);
