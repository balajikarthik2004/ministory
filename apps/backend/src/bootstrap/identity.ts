import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { prisma } from '../services/prisma.js';
import { verifyAccessToken } from '../services/tokens.js';
import {
  DevelopmentIdentityProvider,
  SessionIdentityProvider,
  setIdentityProvider,
} from '../services/identity.js';

/**
 * Chooses the identity provider for this process.
 *
 * The only place that decides. Everything above it asks the registry, so the
 * eventual Firebase provider (ADR-06) is one more branch here and no change
 * anywhere else.
 *
 * ────────────────────────────────────────────────────────────────────────
 * M2.5 CHANGED THE DEFAULT, AND THAT IS THE IMPORTANT PART.
 *
 * Before: real authentication did not exist, so the default was
 * `NullIdentityProvider` — resolve nobody, 401 everywhere, fail closed.
 *
 * Now: `SessionIdentityProvider` is the default in every environment,
 * including production. The development provider is an opt-in override that
 * only a developer's machine can turn on, and it no longer replaces real
 * authentication — it sits beside it.
 *
 * THE NULL PROVIDER IS GONE FROM THIS FILE. Leaving it as a fallback would
 * mean a misconfiguration produces an API where every request is anonymous
 * and every library endpoint returns empty, which reads as a data bug and
 * gets debugged for a day (the failure ADR-27 was written about). There is no
 * configuration now in which that is the right outcome: if the session
 * provider cannot be built, the process should not start, and `config/env.ts`
 * guarantees it cannot be built badly by requiring `AUTH_JWT_SECRET`.
 * ────────────────────────────────────────────────────────────────────────
 */
export function registerIdentityProvider(): void {
  const sessionProvider = new SessionIdentityProvider({
    verifyAccessToken,
    loadUser: (userId) =>
      prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, deletedAt: true, tokensValidFrom: true },
      }),
    loadSession: (sessionId) =>
      prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true, revokedAt: true, expiresAt: true },
      }),
  });

  /*
   * THE DEVELOPMENT OVERRIDE. Three conditions, all required (ADR-27):
   *   - NODE_ENV is not production. Also refused at boot in config/env.ts,
   *     and the provider's own constructor throws in production, so this is
   *     the first of three independent guards rather than the only one.
   *   - DEV_AUTH_ENABLED is explicitly true. The default is off.
   *   - DEV_AUTH_TOKEN is a non-empty value. It has no default.
   */
  if (!isProduction && env.DEV_AUTH_ENABLED) {
    const token = env.DEV_AUTH_TOKEN?.trim();

    if (token) {
      const devProvider = new DevelopmentIdentityProvider(token, env.DEV_AUTH_USER_ID);

      /*
       * BOTH PROVIDERS, SESSION FIRST.
       *
       * M2.5 Phase 5 requires that the catalogue, player and offline sync
       * keep working while the mobile app is migrated to real sessions, and
       * the backend tests cover both paths. Chaining means a real access
       * token authenticates as itself, and only a credential the session
       * provider rejected falls through to the development token.
       *
       * The fallback is narrow on purpose: it is tried only when the session
       * provider threw, never when it resolved somebody. A valid session can
       * therefore never be downgraded into the seeded development user.
       */
      setIdentityProvider({
        name: `session, then development fallback (${devProvider.name})`,
        async resolve(headers) {
          try {
            return await sessionProvider.resolve(headers);
          } catch (sessionError) {
            try {
              return await devProvider.resolve(headers);
            } catch {
              // The development provider rejected it too. Report the real
              // failure, which is the one about the actual credential.
              throw sessionError;
            }
          }
        },
      });

      logger.warn(
        { userId: env.DEV_AUTH_USER_ID },
        'DEVELOPMENT IDENTITY ACTIVE alongside real sessions — the development token verifies no credential. Local use only.',
      );
      return;
    }

    logger.warn(
      'DEV_AUTH_ENABLED is true but DEV_AUTH_TOKEN is empty. ' +
        'Only real session tokens will authenticate.',
    );
  }

  setIdentityProvider(sessionProvider);
}
