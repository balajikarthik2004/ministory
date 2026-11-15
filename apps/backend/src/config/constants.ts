/** Service-wide constants. Values that vary by environment belong in env.ts. */

export const SERVICE_NAME = 'minidrama-api';
export const SERVICE_VERSION = '0.1.0';

/** Request body cap. Video never passes through this API - uploads go direct
 *  to the storage provider, so no endpoint has a legitimate reason to be large.
 *  See docs/SYSTEM_ARCHITECTURE.md §7. */
export const MAX_JSON_BODY_SIZE = '100kb';

/** Graceful shutdown budget before in-flight requests are abandoned. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
