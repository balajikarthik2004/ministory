import { z } from 'zod';

/**
 * Stable, machine-readable error codes. Clients branch on these, so a code is
 * part of the public contract: add freely, never rename or repurpose.
 * See docs/API_DOCUMENTATION.md §1.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RESOURCE_CONFLICT',
  'EPISODE_LOCKED',
  'SUBSCRIPTION_REQUIRED',
  'INSUFFICIENT_COINS',
  'PURCHASE_VERIFICATION_FAILED',
  'RATE_LIMITED',
  'UPLOAD_FAILED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** HTTP status paired with each code, so controllers never pick one by hand. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RESOURCE_CONFLICT: 409,
  EPISODE_LOCKED: 403,
  SUBSCRIPTION_REQUIRED: 402,
  INSUFFICIENT_COINS: 402,
  PURCHASE_VERIFICATION_FAILED: 402,
  RATE_LIMITED: 429,
  UPLOAD_FAILED: 400,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};
