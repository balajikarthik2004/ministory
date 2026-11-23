import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isDevelopment, isTest } from '../config/env.js';
import { DB_CONNECT_TIMEOUT_MS, DB_PING_TIMEOUT_MS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

/**
 * The Prisma client — one instance for the process.
 *
 * Cross-cutting infrastructure, so it lives in services/ alongside the other
 * providers (SYSTEM_ARCHITECTURE.md §2). Modules do not import this directly:
 * a module's repository layer owns its queries, and the repository is the only
 * file that touches Prisma. That boundary is lint-enforced.
 *
 * Why a module-level singleton: each PrismaClient holds its own connection
 * pool. Constructing one per request exhausts Postgres' connection limit long
 * before it exhausts anything else.
 */

/**
 * `tsx watch` reloads the module graph on every save. Without this, each
 * reload would construct another client and leak a pool until Postgres starts
 * refusing connections. Stashing the instance on globalThis survives the
 * reload; production never takes this path.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  /**
   * Prisma 7 talks to Postgres through a driver adapter rather than a bundled
   * query engine, so the connection string is given to the adapter here. The
   * pool bounds are explicit: the default is per-instance unlimited, which
   * fails as a surprise at Postgres' `max_connections` rather than as
   * backpressure in the app.
   */
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Reap idle connections so a quiet instance stops holding server slots.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  });

  return new PrismaClient({
    adapter,
    // Queries are logged in development only. In production they would be a
    // performance cost and a privacy hazard: query parameters carry user data.
    log: isDevelopment ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (isDevelopment || isTest) globalForPrisma.prisma = prisma;

/** Resolves to the rejection reason after `ms`, so a hung socket cannot hang
 *  the caller. Postgres being unreachable should fail fast and visibly. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      // Do not keep the event loop alive just to reject later.
      timer.unref?.();
    }),
  ]);
}

/**
 * Establishes the first connection at boot.
 *
 * Prisma connects lazily on first query. Doing it explicitly at startup means
 * a bad DATABASE_URL or an unreachable database surfaces in the startup log,
 * not in whichever request happened to arrive first.
 */
export async function connectDatabase(): Promise<void> {
  await withTimeout($connect(), DB_CONNECT_TIMEOUT_MS, 'Database connection');
  logger.info('Database connected');
}

function $connect(): Promise<void> {
  return prisma.$connect();
}

/**
 * Closes the pool during graceful shutdown.
 *
 * Never throws: this runs while the process is already on its way out, and a
 * failure to disconnect must not replace the original shutdown reason in the
 * logs with a less interesting one.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await withTimeout(prisma.$disconnect(), DB_CONNECT_TIMEOUT_MS, 'Database disconnect');
    logger.info('Database disconnected');
  } catch (err) {
    logger.warn({ err }, 'Database disconnect failed during shutdown');
  }
}

export interface DatabasePing {
  ok: boolean;
  latencyMs: number;
}

/**
 * Liveness probe for the database connection: the cheapest statement Postgres
 * will answer, under a short timeout.
 *
 * Returns a boolean rather than throwing, and deliberately discards the driver
 * error after logging it. The caller renders this into a health response, and
 * CLAUDE.md §11 forbids an internal database error reaching a client — a
 * connection string, host name or schema detail in an error body is an
 * information leak.
 */
export async function pingDatabase(): Promise<DatabasePing> {
  const startedAt = process.hrtime.bigint();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_PING_TIMEOUT_MS, 'Database ping');
    return { ok: true, latencyMs: elapsedMs(startedAt) };
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    return { ok: false, latencyMs: elapsedMs(startedAt) };
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
