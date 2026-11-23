/**
 * @minidrama/contracts
 *
 * The single definition of the MiniDrama API contract. The backend validates
 * with these schemas, the mobile and admin clients parse with them, and the
 * OpenAPI document is generated from them. One definition, three consumers -
 * a field that does not exist here is a type error, not a runtime surprise.
 *
 * See docs/DECISIONS.md ADR-05.
 */

export * from './common/errors.js';
export * from './common/envelope.js';
export * from './health/health.schema.js';
export * from './catalogue/catalogue.schema.js';
export * from './library/library.schema.js';
export * from './auth/auth.schema.js';
export * from './playback/playback.schema.js';

/** API version carried in the URL path: /api/v1. */
export const API_VERSION = 'v1' as const;
export const API_BASE_PATH = `/api/${API_VERSION}` as const;
