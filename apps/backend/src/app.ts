import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { API_BASE_PATH } from '@minidrama/contracts';
import { env } from './config/env.js';
import { MAX_JSON_BODY_SIZE } from './config/constants.js';
import { logger } from './utils/logger.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application.
 *
 * Kept separate from server.ts so integration tests can mount the app without
 * binding a port.
 *
 * Pipeline order matters and is documented in SYSTEM_ARCHITECTURE.md §5:
 *   helmet -> cors -> request id -> logging -> body parse -> routes
 *   -> 404 -> centralised error handler
 *
 * Rate limiting and authentication slot in before the routes in M3. They are
 * absent here because Milestone 1.1 has no authenticated endpoint - not because
 * they are optional.
 */
export function createApp(): Express {
  const app = express();

  // Behind a proxy or load balancer, trust exactly one hop so that client IPs
  // and rate limiting are correct without accepting a spoofed header chain.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    }),
  );

  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? '',
      autoLogging: {
        // Health checks run every few seconds; logging them buries real traffic.
        ignore: (req) => req.url === '/health' || req.url === `${API_BASE_PATH}/health`,
      },
    }),
  );

  app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
  app.use(express.urlencoded({ extended: true, limit: MAX_JSON_BODY_SIZE }));

  // Unversioned aliases so orchestrators and uptime checks have a stable path
  // that survives an API version bump.
  app.use(apiRouter);
  app.use(API_BASE_PATH, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
