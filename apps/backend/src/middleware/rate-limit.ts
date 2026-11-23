import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/app-error.js';
import { optionalCallerOf } from './identity.js';

/**
 * A fixed-window rate limiter, in process memory.
 *
 * WHY NOT A LIBRARY, AND WHY NOT REDIS. The free-first policy (CLAUDE.md §18)
 * rules out a managed store for the MVP, and a single Express process needs
 * neither. `express-rate-limit` would add a dependency to re-implement the
 * thirty lines below, and CLAUDE.md §16.15 is explicit about not installing
 * what we do not need.
 *
 * THE LIMITATION, STATED PLAINLY: this counts per process. Run two instances
 * behind a load balancer and the effective limit doubles. That is acceptable
 * while the deployment is one container and unacceptable the moment it is
 * not, so `RateLimiter` is a class behind a narrow interface — swapping the
 * counter for Redis means replacing `hit()`, not touching any route.
 *
 * WHY A FIXED WINDOW rather than a token bucket: the thing being protected is
 * a batch endpoint whose clients are already batching and backing off. The
 * extra smoothing a bucket buys does not pay for the extra state, and a fixed
 * window's worst case — two full allowances across a window boundary — is
 * still far below anything that threatens the server.
 */

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests permitted per key per window. */
  max: number;
  /**
   * Upper bound on tracked keys, so a flood of distinct keys cannot grow the
   * map without limit. On overflow the whole map is cleared rather than
   * evicted one by one: an eviction policy here would be a cache, and the
   * failure mode of clearing is one forgiving window, not a memory leak.
   */
  maxKeys?: number;
  /**
   * What counts as "the same caller". Defaults to user id, falling back to IP.
   *
   * EXISTS FOR THE CREDENTIAL ENDPOINTS (M2.5). Login and password reset are
   * called by someone who is by definition not authenticated yet, so the
   * default key is their IP — and an IP-only limit is the wrong shape for
   * them in both directions. It is too coarse on shared-NAT mobile networks,
   * where it throttles a whole neighbourhood, and too loose against someone
   * with a pool of addresses guessing one account's password. Keying on the
   * address being attacked as well as the source fixes both.
   *
   * The function must never return something unbounded: the key becomes a map
   * entry, and `maxKeys` is the only thing standing between a caller-chosen
   * key and memory growth.
   */
  keyBy?: (req: Request) => string;
}

interface Window {
  count: number;
  /** Epoch ms at which this window expires. */
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for `Retry-After`. */
  retryAfterSec: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxKeys: number;

  constructor(options: RateLimitOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Records one request against `key` and says whether it is permitted. */
  hit(key: string, nowMs: number): RateLimitDecision {
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= nowMs) {
      if (this.windows.size >= this.maxKeys) this.windows.clear();
      const resetAt = nowMs + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.max - 1, retryAfterSec: 0 };
    }

    existing.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000));

    if (existing.count > this.max) {
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    return { allowed: true, remaining: this.max - existing.count, retryAfterSec };
  }

  /** Drops expired windows. Exposed for tests; the map self-heals otherwise. */
  prune(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= nowMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Identifies the caller for limiting purposes.
 *
 * An authenticated caller is keyed by user id, so one viewer on a flaky
 * connection cannot spend another's allowance. Everyone else falls back to
 * the socket address.
 *
 * API_DOCUMENTATION.md §9 already flags the IP problem: shared-NAT mobile
 * networks in India put many real viewers behind one address, so an
 * IP-keyed limit produces false positives. That is why the limit below is
 * generous and why the authenticated key is preferred wherever we have one.
 * A device-bound guest token (M2.5) is the real fix.
 */
function keyFor(req: Request): string {
  const caller = optionalCallerOf(req);
  if (caller) return `user:${caller.userId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Builds the middleware.
 *
 * Refusals carry `Retry-After` and the `RATE_LIMITED` code, which maps to 429
 * (packages/contracts/src/common/errors.ts). That pairing matters for the
 * offline queue: `HttpPlaybackSyncAdapter` classifies 429 as a transport
 * failure and retries it, so a throttled batch is delayed, never discarded.
 * Returning 400 here would mark those events dead and lose them.
 */
export function rateLimit(
  options: RateLimitOptions,
  now: () => number = Date.now,
): (req: Request, res: Response, next: NextFunction) => void {
  const limiter = new RateLimiter(options);

  const key = options.keyBy ?? keyFor;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const decision = limiter.hit(key(req), now());

    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));

    if (decision.allowed) {
      next();
      return;
    }

    res.setHeader('Retry-After', String(decision.retryAfterSec));
    next(
      new AppError(
        'RATE_LIMITED',
        'Too many requests. Please retry shortly.',
        // No payload, no key, no count: a refusal must not tell a caller
        // anything about other callers (CLAUDE.md §11).
      ),
    );
  };
}
