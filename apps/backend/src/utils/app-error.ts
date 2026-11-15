import { ERROR_STATUS, type ErrorCode, type ErrorDetail } from '@minidrama/contracts';

/**
 * The only error type that should reach the client.
 *
 * `message` is written for a user to read. Anything diagnostic goes in `cause`,
 * which is logged and never serialised - CLAUDE.md §7 and §11 both require that
 * internal errors stay internal.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  readonly isOperational = true;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: ErrorDetail[]; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options?.details) {
      this.details = options.details;
    }
    Error.captureStackTrace?.(this, AppError);
  }

  static notFound(resource: string): AppError {
    return new AppError('NOT_FOUND', `${resource} was not found.`);
  }

  static unauthenticated(message = 'You need to sign in to continue.'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static forbidden(message = "You don't have access to this."): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static validation(details: ErrorDetail[]): AppError {
    return new AppError('VALIDATION_ERROR', 'Some of the information provided is invalid.', {
      details,
    });
  }
}

/** Distinguishes our thrown errors from genuine crashes. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
