import { z } from 'zod';
import { errorCodeSchema } from './errors.js';

/**
 * Every response, success or failure, uses this envelope.
 * See docs/API_DOCUMENTATION.md §1.
 */

export const errorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  /** Always safe to show a user. Internal detail belongs in the logs. */
  message: z.string(),
  details: z.array(errorDetailSchema).optional(),
  requestId: z.string().optional(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorBodySchema,
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Cursor pagination. Offset pagination skips and duplicates rows in a feed. */
export const paginationMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Wraps a payload schema in the success envelope. */
export function successResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.literal(true),
    data,
    meta: z.unknown().optional(),
  });
}

export type SuccessResponse<T> = {
  success: true;
  data: T;
  meta?: unknown;
};

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;
