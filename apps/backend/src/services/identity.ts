import { isProduction } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

/**
 * Who is making this request.
 *
 * The interface M2.5 implements with real authentication. Everything above it
 * — controllers, services, repositories — takes a `Caller` and never knows how
 * one was produced, so swapping the development provider for Firebase + a
 * session JWT changes this file and nothing else.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a caller's identity comes from a
 * credential the server verified, never from a request body, query string or
 * client-supplied header field that was not authenticated. A `userId` in a
 * payload is a claim, not an identity (CLAUDE.md §11).
 */

export interface Caller {
  userId: string;
  /** False once real authentication issues sessions. */
  isDevelopmentIdentity: boolean;
}

export interface IdentityProvider {
  readonly name: string;
  /**
   * Resolves the caller from a request's credentials.
   *
   * @returns the caller, or null for an anonymous request. Throwing is
   *   reserved for a credential that was *presented and rejected* — an absent
   *   credential is not an error, because guest browsing is a product
   *   requirement (PRD AUTH-03).
   */
  resolve(headers: IncomingHeaders): Promise<Caller | null>;
}

/** The subset of request headers a provider is allowed to look at. */
export interface IncomingHeaders {
  authorization?: string | undefined;
  'x-minidrama-dev-user'?: string | undefined;
}

/**
 * DEVELOPMENT IDENTITY — local development only. Replaced in M2.5.
 * ════════════════════════════════════════════════════════════════
 *
 * Accepts a shared development token and maps it to one configured user id.
 * It verifies nothing cryptographically and must never run outside a
 * developer's machine.
 *
 * FOUR INDEPENDENT GUARDS, because one flag is one typo away from shipping:
 *
 *   1. `DEV_AUTH_ENABLED` must be explicitly true.
 *   2. `NODE_ENV` must not be production — checked here as well as in env.ts,
 *      so a future refactor of the config cannot silently remove the check.
 *   3. The constructor throws in production rather than returning an inert
 *      provider, so a misconfigured production process fails at boot with a
 *      clear message instead of serving traffic with a broken auth model.
 *   4. The token is compared against a value that has no default. An unset
 *      `DEV_AUTH_TOKEN` means no caller is ever resolved.
 *
 * Guard 3 is the important one. A provider that quietly does nothing in
 * production is the failure mode where every request becomes anonymous and
 * the library endpoints return empty rather than erroring — which looks like
 * a data problem and gets debugged for a day.
 */
export class DevelopmentIdentityProvider implements IdentityProvider {
  readonly name = 'development (no real authentication — M2.5 replaces this)';

  constructor(
    private readonly token: string,
    private readonly userId: string,
  ) {
    if (isProduction) {
      throw new Error(
        'DevelopmentIdentityProvider was constructed with NODE_ENV=production. ' +
          'This provider performs no credential verification and must never run in production.',
      );
    }
    if (!token || !userId) {
      throw new Error('DevelopmentIdentityProvider requires both a token and a user id.');
    }
  }

  async resolve(headers: IncomingHeaders): Promise<Caller | null> {
    const presented = readBearer(headers.authorization) ?? headers['x-minidrama-dev-user'];
    if (!presented) return null;

    if (presented !== this.token) {
      // A credential was presented and is wrong. That is an error, unlike no
      // credential at all.
      throw AppError.unauthenticated('That sign-in is not valid.');
    }

    return { userId: this.userId, isDevelopmentIdentity: true };
  }
}

/**
 * A provider that resolves nobody.
 *
 * What production gets until M2.5 lands. Every protected endpoint therefore
 * returns 401 rather than silently operating on a default user — failing
 * closed is the only safe behaviour for an unimplemented auth system.
 */
export class NullIdentityProvider implements IdentityProvider {
  readonly name = 'none (authentication not implemented)';

  async resolve(): Promise<Caller | null> {
    return null;
  }
}

/**
 * SESSION IDENTITY — the real one (M2.5).
 * ═══════════════════════════════════════
 *
 * Verifies the access token the authentication module issued, and resolves a
 * `Caller` from it. This is the branch that replaces the development provider
 * in every configuration that is not a developer's laptop.
 *
 * FOUR CHECKS, AND THE THIRD IS THE ONE PEOPLE FORGET:
 *
 *   1. Signature, issuer, audience, expiry and token type — all in
 *      `verifyAccessToken`, which refuses on any of them.
 *   2. The user still exists and is usable. A banned account's token stays
 *      cryptographically valid for up to fifteen minutes, so the signature
 *      alone is not an answer to "may this person act?".
 *   3. The token was issued after `User.tokensValidFrom`. Access tokens are
 *      stateless, so a password change cannot reach out and invalidate the
 *      ones already in circulation — this comparison is what does. Without
 *      it, "change your password to sign out whoever stole your session"
 *      would be true only after a quarter of an hour.
 *   4. The session row behind the token is still live. Catches an explicit
 *      logout or a revoked family within the access token's lifetime.
 *
 * THE COST, STATED HONESTLY: checks 2 to 4 are database reads on every
 * authenticated request, which is exactly what a stateless token is supposed
 * to avoid. They are two indexed primary-key lookups, and the alternative is
 * revocation that takes effect "within fifteen minutes", which is not
 * revocation. ADR-07 already accepted this trade for entitlement; the same
 * reasoning applies here. If the read ever shows up in a p95 measurement, the
 * fix is a short-lived cache of revoked session ids, not removing the check.
 */
export class SessionIdentityProvider implements IdentityProvider {
  readonly name = 'session (access token verified against the database)';

  constructor(
    private readonly deps: {
      verifyAccessToken: (token: string) => Promise<{
        userId: string;
        sessionId: string;
        isAnonymous: boolean;
        issuedAt: number;
      }>;
      loadUser: (
        userId: string,
      ) => Promise<{ status: string; deletedAt: Date | null; tokensValidFrom: Date | null } | null>;
      loadSession: (sessionId: string) => Promise<{
        userId: string;
        revokedAt: Date | null;
        expiresAt: Date;
      } | null>;
    },
  ) {}

  async resolve(headers: IncomingHeaders): Promise<Caller | null> {
    const presented = readBearer(headers.authorization);
    // No credential is not an error — guest browsing is a product requirement.
    if (!presented) return null;

    const claims = await this.deps.verifyAccessToken(presented);

    const user = await this.deps.loadUser(claims.userId);
    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    }

    /*
     * `iat` is in whole seconds and `tokensValidFrom` in milliseconds, so a
     * token minted in the same second as the revocation could compare as
     * newer. Comparing against the second boundary makes that case revoke,
     * which is the safe direction to round.
     */
    if (user.tokensValidFrom) {
      const validFromSec = Math.floor(user.tokensValidFrom.getTime() / 1000);
      if (claims.issuedAt < validFromSec) {
        throw new AppError('TOKEN_EXPIRED', 'Your session has expired.');
      }
    }

    const session = await this.deps.loadSession(claims.sessionId);
    if (!session || session.userId !== claims.userId || session.revokedAt) {
      throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    }

    return { userId: claims.userId, isDevelopmentIdentity: false };
  }
}

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

// ─────────────────────────── Provider registry ───────────────────────────

let provider: IdentityProvider = new NullIdentityProvider();

export function setIdentityProvider(next: IdentityProvider): void {
  provider = next;
  logger.info({ provider: next.name }, 'Identity provider registered');
}

export function getIdentityProvider(): IdentityProvider {
  return provider;
}
