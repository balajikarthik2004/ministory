import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { SERVICE_NAME, SERVICE_VERSION, SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server: Server = app.listen(env.PORT, env.HOST, () => {
  logger.info(
    {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: env.NODE_ENV,
      url: `http://localhost:${env.PORT}`,
    },
    `${SERVICE_NAME} listening on ${env.HOST}:${env.PORT}`,
  );
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then exit. Without this a deploy drops whatever was mid-flight.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received, draining connections');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error while closing the server');
      process.exit(1);
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An unhandled rejection leaves the process in an unknown state. Log it loudly
// and let the supervisor restart rather than continuing to serve traffic.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});

export { server };
