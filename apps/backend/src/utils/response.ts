import type { Response } from 'express';
import type { ErrorBody, ErrorCode, ErrorDetail } from '@minidrama/contracts';

/**
 * Every response leaves through one of these two helpers, so the envelope in
 * docs/API_DOCUMENTATION.md §1 is guaranteed rather than remembered.
 */

export function sendSuccess<T>(res: Response, data: T, status = 200, meta?: unknown): void {
  res
    .status(status)
    .json(meta === undefined ? { success: true, data } : { success: true, data, meta });
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  options?: { details?: ErrorDetail[]; requestId?: string },
): void {
  const error: ErrorBody = { code, message };
  if (options?.details) error.details = options.details;
  if (options?.requestId) error.requestId = options.requestId;

  res.status(status).json({ success: false, error });
}
