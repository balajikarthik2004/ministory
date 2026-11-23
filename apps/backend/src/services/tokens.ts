import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

/**
 * Token primitives: the access JWT, opaque secrets, and the hashes they are
 * stored as.
 *
 * TWO KINDS OF TOKEN, FOR TWO DIFFERENT JOBS.
 *
 *   ACCESS — a signed JWT, 15 minutes, verified with no database read on the
 *   hot path. Stateless so that every catalogue and playback request does not
 *   cost a session lookup.
 *
 *   REFRESH, RESET, VERIFY — opaque 256-bit random values. Nothing is encoded
 *   in them and nothing can be read out of them; they are row keys, and the
 *   database decides what they mean. A JWT would be the wrong shape: these
 *   must be revocable the instant they are used or abused, which is a
 *   property of a row, not of a signature.
 *
 * NOTHING IN THIS FILE LOGS A TOKEN, A SECRET OR A HASH, and nothing returns
 * one inside an error. The raw value of an opaque token exists in exactly two
 * places: the response that issues it, and the holder.
 */

// ───────────────────────────── Access tokens ─────────────────────────────

const ACCESS_ALG = 'HS256';
const secretKey = new TextEncoder().encode(env.AUTH_JWT_SECRET);

/** Distinguishes an access token from anything else that might be signed with
 *  the same key later. Verified, not just set. */
const ACCESS_TYPE = 'access';

export interface AccessTokenClaims {
  /** The user this token speaks for. */
  userId: string;
  /** The session it was minted from, so a revoked session can be traced. */
  sessionId: string;
  /** True while the account is anonymous. Carried so guest-only UI decisions
   *  do not need a round trip; never used for an authorisation decision. */
  isAnonymous: boolean;
  /** Seconds since epoch. */
  issuedAt: number;
}

export interface SignedAccessToken {
  token: string;
  expiresInSec: number;
}

export async function signAccessToken(input: {
  userId: string;
  sessionId: string;
  isAnonymous: boolean;
}): Promise<SignedAccessToken> {
  const expiresInSec = env.AUTH_ACCESS_TTL_SEC;
  const nowSec = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    typ: ACCESS_TYPE,
    sid: input.sessionId,
    anon: input.isAnonymous,
  })
    .setProtectedHeader({ alg: ACCESS_ALG })
    .setSubject(input.userId)
    .setIssuer(env.AUTH_TOKEN_ISSUER)
    .setAudience(env.AUTH_TOKEN_AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expiresInSec)
    .sign(secretKey);

  return { token, expiresInSec };
}

/**
 * Verifies an access token's signature, issuer, audience, expiry and type.
 *
 * ALL FIVE, NOT JUST THE SIGNATURE. A valid signature only says the token was
 * minted with our key; it says nothing about whether the token was meant for
 * this API. Checking `aud` is what will stop an admin token from ever
 * authenticating a consumer route, and vice versa, when M5 adds a second
 * audience (ARCH §6) — a check that is free now and a migration later.
 *
 * Throws `TOKEN_EXPIRED` separately from `UNAUTHENTICATED` because the client
 * acts on the difference: expiry means "refresh and retry silently", anything
 * else means "this session is finished, sign in again".
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: [ACCESS_ALG],
      issuer: env.AUTH_TOKEN_ISSUER,
      audience: env.AUTH_TOKEN_AUDIENCE,
    });

    if (payload['typ'] !== ACCESS_TYPE) {
      throw AppError.unauthenticated('That sign-in is not valid.');
    }

    const userId = payload.sub;
    const sessionId = payload['sid'];
    if (typeof userId !== 'string' || typeof sessionId !== 'string') {
      throw AppError.unauthenticated('That sign-in is not valid.');
    }

    return {
      userId,
      sessionId,
      isAnonymous: payload['anon'] === true,
      issuedAt: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError('TOKEN_EXPIRED', 'Your session has expired.');
    }
    /*
     * Everything else — bad signature, wrong issuer, wrong audience,
     * malformed — collapses to one message. Telling a caller *which* check
     * failed tells an attacker which part of their forgery to fix.
     */
    throw AppError.unauthenticated('That sign-in is not valid.');
  }
}

// ───────────────────────────── Opaque tokens ─────────────────────────────

/** 32 bytes of CSPRNG output, base64url. ~256 bits: not guessable, and short
 *  enough to sit in a URL without wrapping in an email client. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stored form of an opaque token: SHA-256, hex.
 *
 * DELIBERATELY NOT ARGON2, and the reasoning is on `Session.refreshHash` in
 * the Prisma schema. In short: Argon2 is salted, so the same token hashes
 * differently every time and the row cannot be found by hashing what the
 * client presented — which would make refresh-token reuse detection
 * impossible, since a replayed token's row is exactly what has to be found.
 * Argon2's cost buys resistance to brute force over a small search space;
 * there is no small search space here, only 256 random bits.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The database does the lookup by equality, so this is for the places that
 * compare two values already in memory. `===` on a secret leaks its prefix
 * through timing; the cost of avoiding that is one function call.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Hashes an IP address for storage.
 *
 * Keyed with the JWT secret so the digests are not reversible with a rainbow
 * table of the whole IPv4 space — an unkeyed SHA-256 of an IP address is
 * effectively plaintext, since there are only four billion inputs to try.
 * Stored for abuse investigation, never displayed, and minimised under the
 * DPDP Act.
 */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${env.AUTH_JWT_SECRET}:${ip}`, 'utf8').digest('hex');
}
