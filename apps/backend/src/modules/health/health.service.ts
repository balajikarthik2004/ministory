import type {
  DependencyCheck,
  HealthResponse,
  HealthStatus,
  ReadinessResponse,
} from '@minidrama/contracts';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { pingDatabase } from '../../services/prisma.js';

/**
 * Health module - business logic.
 *
 * Module anatomy per docs/SYSTEM_ARCHITECTURE.md §5: routes wire, controllers
 * handle HTTP, services hold logic, repositories own Prisma. Health has no
 * repository because it has no data of its own.
 */

function baseHealth(status: HealthStatus): HealthResponse {
  return {
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/** Liveness: the process is up. Deliberately checks nothing else - an
 *  orchestrator restarting the process will not fix a dependency outage. */
export function getHealth(): HealthResponse {
  return baseHealth('ok');
}

/**
 * Database reachability, rendered for a health response.
 *
 * The message is fixed text, never the driver's. An unreachable database
 * produces errors that name the host, port, user and sometimes the schema;
 * /ready is unauthenticated, so none of that may appear in the body
 * (CLAUDE.md §11). The real error is logged with a request id instead.
 */
async function checkDatabase(): Promise<DependencyCheck> {
  const { ok, latencyMs } = await pingDatabase();

  return {
    name: 'postgres',
    status: ok ? 'ok' : 'down',
    latencyMs: Math.round(latencyMs),
    message: ok ? 'Connection healthy' : 'Database unreachable',
  };
}

/**
 * Readiness: should this instance receive traffic?
 *
 * Postgres joined the dependency list in M1.3. The video provider joins it in
 * M4 (SYSTEM_ARCHITECTURE.md §9). Checks run concurrently — a readiness probe
 * should cost the slowest dependency, not the sum of all of them.
 */
export async function getReadiness(): Promise<ReadinessResponse> {
  const dependencies: DependencyCheck[] = await Promise.all([checkDatabase()]);

  const status: HealthStatus = dependencies.some((d) => d.status === 'down')
    ? 'down'
    : dependencies.some((d) => d.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return { ...baseHealth(status), dependencies };
}
