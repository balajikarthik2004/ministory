import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ErrorDetail } from '@minidrama/contracts';
import { AppError, isAppError } from '../utils/app-error.js';
import { sendError } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

/** 404 for anything that matched no route. Must be registered last. */
export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 404, 'NOT_FOUND', `No route matches ${req.method} ${req.path}.`, {
    requestId: req.requestId,
  });
}

/**
 * Centralised error handler - the single exit point for every failure
 * (CLAUDE.md §7).
 *
 * Three cases:
 *   AppError  - deliberate, safe to show.
 *   ZodError  - validation, safe to show which fields failed.
 *   anything else - a bug. Log it in full, return a generic 500 with a
 *                   correlation ID. Never leak a driver or stack string.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express identifies an error handler by arity, so `next` must stay.
  _next: NextFunction,
): void {
  const requestId = req.requestId;

  if (isAppError(err)) {
    logger.warn(
      { requestId, code: err.code, status: err.status, path: req.path, cause: err.cause },
      err.message,
    );
    sendError(res, err.status, err.code, err.message, {
      ...(err.details ? { details: err.details } : {}),
      requestId,
    });
    return;
  }

  /*
   * A body the parser could not read.
   *
   * `express.json()` throws for malformed JSON, a body that is not an object
   * or array under its default strict mode, a wrong charset, and a payload
   * over the size cap. Those are all client mistakes, but the error reaches
   * here as a plain `SyntaxError` and would otherwise be reported as a 500 —
   * which tells the client to retry something that can never succeed, and
   * fills error monitoring with alerts for other people's typos.
   *
   * The parser's own message is not forwarded: it can quote the offending
   * body back, which for a request carrying a token is a reflected leak.
   */
  if (isBodyParserError(err)) {
    const status = err.status === 413 ? 413 : 400;
    const code = status === 413 ? 'VALIDATION_ERROR' : 'VALIDATION_ERROR';
    logger.warn({ requestId, path: req.path, type: err.type }, 'Malformed request body');
    sendError(
      res,
      status,
      code,
      status === 413
        ? 'That request was too large.'
        : 'The request body could not be read as JSON.',
      { requestId },
    );
    return;
  }

  if (err instanceof ZodError) {
    const details: ErrorDetail[] = err.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    const validationError = AppError.validation(details);
    logger.warn({ requestId, path: req.path, details }, 'Request validation failed');
    sendError(res, validationError.status, validationError.code, validationError.message, {
      details,
      requestId,
    });
    return;
  }

  // Unexpected: this is a bug, not a user error.
  logger.error(
    { requestId, path: req.path, method: req.method, err },
    'Unhandled error while processing request',
  );

  sendError(
    res,
    500,
    'INTERNAL_ERROR',
    isProduction
      ? 'Something went wrong on our end. Please try again.'
      : `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
    { requestId },
  );
}

/**
 * Recognises an error thrown by `express.json()` / `body-parser`.
 *
 * Identified by the `type` property body-parser attaches (`entity.parse.failed`,
 * `entity.too.large`, `encoding.unsupported`, …) rather than by `instanceof
 * SyntaxError`, which would also catch genuine bugs in our own code.
 */
function isBodyParserError(err: unknown): err is { type: string; status?: number } {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { type?: unknown; expose?: unknown };
  return typeof candidate.type === 'string' && candidate.type.length > 0 && 'expose' in candidate;
}
