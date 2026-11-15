import type {
  DependencyCheck,
  HealthResponse,
  HealthStatus,
  ReadinessResponse,
} from '@minidrama/contracts';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/constants.js';
import { env } from '../../config/env.js';

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
 * Readiness: should this instance receive traffic?
 *
 * The dependency list is empty in Milestone 1.1 because there are no
 * dependencies yet. Postgres joins it in M1.3, Mux in M4.
 */
export async function getReadiness(): Promise<ReadinessResponse> {
  const dependencies: DependencyCheck[] = await Promise.all([]);

  const status: HealthStatus = dependencies.some((d) => d.status === 'down')
    ? 'down'
    : dependencies.some((d) => d.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return { ...baseHealth(status), dependencies };
}
