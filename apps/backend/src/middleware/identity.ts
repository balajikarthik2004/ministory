import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getIdentityProvider, type Caller } from '../services/identity.js';
import { AppError } from '../utils/app-error.js';

/**
 * Identity middleware.
 *
 * `attachCaller` runs on every route and resolves the caller if a credential
 * is present. `requireCaller` guards the routes that operate on somebody's
 * own data and rejects an anonymous request.
 *
 * Why two layers rather than one: guest browsing is a product requirement
 * (PRD AUTH-03), so the catalogue must work with no credential while still
 * personalising `isFavorited` when there is one. A single "require auth"
 * middleware would force a choice between the two.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `attachCaller`. Undefined means anonymous. */
    caller?: Caller;
  }
}

export const attachCaller: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const caller = await getIdentityProvider().resolve({
        authorization: req.header('authorization') ?? undefined,
        'x-minidrama-dev-user': req.header('x-minidrama-dev-user') ?? undefined,
      });
      if (caller) req.caller = caller;
      next();
    } catch (error) {
      next(error);
    }
  })();
};

export function requireCaller(req: Request, _res: Response, next: NextFunction): void {
  if (!req.caller) {
    next(AppError.unauthenticated());
    return;
  }
  next();
}

/**
 * Reads the authenticated caller, or throws.
 *
 * Services take a `userId` and never a `Request`, so this is the one place a
 * controller converts "this HTTP request" into "this user". Throwing rather
 * than returning null means a route that forgot `requireCaller` fails loudly
 * instead of operating on `undefined`.
 */
export function callerOf(req: Request): Caller {
  const caller = req.caller;
  if (!caller) throw AppError.unauthenticated();
  return caller;
}

/** The caller if there is one, for endpoints that personalise but allow guests. */
export function optionalCallerOf(req: Request): Caller | null {
  return req.caller ?? null;
}
