import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Assigns a correlation ID to every request and echoes it back.
 *
 * This is the thread that ties a user's "it failed" to a specific log line and
 * Sentry event. The client sees the ID; it never sees the error behind it.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();

  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
