/** Service-wide constants. Values that vary by environment belong in env.ts. */

export const SERVICE_NAME = 'minidrama-api';
export const SERVICE_VERSION = '0.1.0';

/** Request body cap. Video never passes through this API - uploads go direct
 *  to the storage provider, so no endpoint has a legitimate reason to be large.
 *  See docs/SYSTEM_ARCHITECTURE.md §7. */
export const MAX_JSON_BODY_SIZE = '100kb';

/** Graceful shutdown budget before in-flight requests are abandoned. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Budget for the first connection at boot, and for closing the pool on the
 *  way out. Generous enough for a container that is still starting, short
 *  enough that a wrong host fails visibly instead of hanging. */
export const DB_CONNECT_TIMEOUT_MS = 10_000;

/** Budget for the `SELECT 1` behind /ready. Deliberately short: a readiness
 *  probe that waits is a readiness probe a load balancer has already given up
 *  on, and a slow database should read as degraded rather than as healthy. */
export const DB_PING_TIMEOUT_MS = 2_000;
