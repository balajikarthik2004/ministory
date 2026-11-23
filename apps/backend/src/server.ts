import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { SERVICE_NAME, SERVICE_VERSION, SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { logger } from './utils/logger.js';
import { connectDatabase, disconnectDatabase } from './services/prisma.js';
import { registerIdentityProvider } from './bootstrap/identity.js';

/*
 * Identity before the app is built, so the first request cannot arrive before
 * a provider is registered. The default is the null provider, which refuses
 * every protected route — failing closed is the only safe default while real
 * authentication does not exist.
 */
registerIdentityProvider();

const app = createApp();

/**
 * Connect before binding the port.
 *
 * An instance that is listening but cannot reach its database will accept
 * traffic and fail every request. Connecting first means a database problem
 * stops the deploy instead of starting a broken instance.
 */
await connectDatabase().catch((err: unknown) => {
  // The URL itself is never logged: it carries the password.
  logger.fatal({ err }, 'Could not connect to the database - refusing to start');
  process.exit(1);
});

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

    // The pool closes only after the HTTP server has drained, so a request
    // still in flight keeps the database it is using.
    void disconnectDatabase().finally(() => {
      logger.info('Shutdown complete');
      process.exit(0);
    });
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
