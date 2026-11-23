import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../../config/env.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCaller } from '../../middleware/identity.js';
import {
  handleChangePassword,
  handleDeleteAccount,
  handleDeletionReceipt,
  handleForgotPassword,
  handleGuest,
  handleLogin,
  handleLogout,
  handleMe,
  handleMerge,
  handleRefresh,
  handleRegister,
  handleResendVerification,
  handleResetPassword,
  handleVerifyEmail,
} from './auth.controller.js';

/**
 * Authentication routes, and the rate limits that guard them.
 *
 * EVERY UNAUTHENTICATED ENDPOINT HERE IS LIMITED. These are the endpoints
 * that accept a guess — a password, an email address, a token — and the only
 * thing that makes guessing expensive is a limit. The playback limiter
 * (ADR-34) is deliberately generous because honest clients send bursts; these
 * are deliberately tight, because nobody legitimately attempts ten logins in
 * fifteen minutes.
 */
export const authRouter: Router = Router();

/**
 * Keys a credential attempt by source AND by the address being attacked.
 *
 * WHY BOTH. An IP-only limit fails twice over on this traffic. Shared-NAT
 * mobile networks in India put thousands of real viewers behind one address
 * (API_DOCUMENTATION.md §9), so an IP limit tight enough to stop guessing
 * would lock out a city; and someone guessing one account's password from a
 * pool of addresses never trips an IP limit at all. Combining the two means a
 * single account can only be guessed at `max` times per window no matter how
 * many addresses the attacker has, while a legitimate user behind a shared
 * address is only ever counted against their own email.
 *
 * The email is hashed into the key rather than concatenated: the key lives in
 * a map that may be dumped in a heap snapshot, and a map full of plaintext
 * addresses is an unnecessary store of personal data.
 */
function keyByIpAndEmail(req: Request): string {
  const ip = req.ip ?? 'unknown';
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Bounded by construction: a hex digest, or the empty string.
  const emailKey = email ? createHash('sha256').update(email).digest('hex').slice(0, 32) : 'none';
  return `auth:${ip}:${emailKey}`;
}

const loginLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_LOGIN_RATE_MAX,
  keyBy: keyByIpAndEmail,
});

const registerLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_REGISTER_RATE_MAX,
  keyBy: keyByIpAndEmail,
});

/**
 * `forgot-password`, which carries an email and so gets a per-address key.
 */
const recoveryLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_RECOVERY_RATE_MAX,
  keyBy: keyByIpAndEmail,
});

/**
 * `reset-password` and `verify-email`, which carry a token and no email.
 *
 * A SEPARATE, LOOSER LIMITER, and the reason is the shared-NAT problem this
 * file's key function exists to solve. With no email in the body,
 * `keyByIpAndEmail` degrades to the source address alone — so every viewer
 * behind one mobile carrier NAT shares a single allowance. At the recovery
 * limit of five per fifteen minutes, ordinary traffic trips it, and the
 * symptom is "the link in my email says it doesn't work".
 *
 * Loosening it costs nothing real: the thing being presented is a 256-bit
 * random token, and no rate limit is what makes that unguessable. See
 * `AUTH_TOKEN_RATE_MAX`.
 */
const tokenLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_TOKEN_RATE_MAX,
});

/**
 * Refresh is limited too, and more loosely.
 *
 * It is called by legitimate clients on a schedule, so the limit is sized to
 * allow that while still bounding a client stuck in a refresh loop — which is
 * a real failure mode, since a refresh that fails and retries immediately
 * will do so forever.
 */
const refreshLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_REFRESH_RATE_MAX,
});

/**
 * Guest creation: limited per install, then per source address.
 *
 * See `AUTH_GUEST_RATE_MAX` for why one limiter cannot do both jobs. In
 * short: the per-device limit is what a legitimate client is measured
 * against, and the per-IP backstop is what stops someone forging device ids
 * to create rows in bulk. A real install calls this once per launch and
 * resumes thereafter.
 */
const guestDeviceLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_GUEST_RATE_MAX,
  keyBy: (req) => {
    const body = req.body as { deviceId?: unknown } | undefined;
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim().slice(0, 128) : '';
    // Hashed and bounded, for the same reasons as `keyByIpAndEmail`.
    const key = deviceId
      ? createHash('sha256').update(deviceId).digest('hex').slice(0, 32)
      : 'none';
    return `guest-device:${key}`;
  },
});

const guestIpLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_GUEST_IP_RATE_MAX,
  keyBy: (req) => `guest-ip:${req.ip ?? 'unknown'}`,
});

/**
 * The authenticated endpoints that RE-VERIFY A PASSWORD: `change-password`
 * and account deletion.
 *
 * THIS CLOSES A GAP M2.5 SHIPPED WITH (M2.6 D7). `change-password` had no
 * limiter at all, and it compares `currentPassword` against the stored hash —
 * so anyone holding a stolen access token had an unbounded oracle for the
 * real password, with none of the protection `/auth/login` gets. Deletion
 * re-verifies the same way and would have added a second one.
 *
 * KEYED ON THE USER ID, not the source address. The caller is already
 * authenticated, so there is exactly one account at risk and it is known by
 * name; counting against it is both tighter and immune to the shared-NAT
 * problem that shapes every other key in this file. `requireCaller` runs
 * first, so `req.caller` is always set by the time this reads it.
 */
const sensitiveLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_SENSITIVE_RATE_MAX,
  keyBy: (req) => `auth-sensitive:${req.caller?.userId ?? req.ip ?? 'unknown'}`,
});

/**
 * `POST /auth/deletion-receipt`.
 *
 * Gets the loose token allowance, for the same reason `reset-password` does
 * (ADR-43): there is no email in the body, so the key degrades to the source
 * address and a tight limit would punish a shared NAT. What is presented is
 * 256 bits of CSPRNG output — no rate limit is what makes that unguessable,
 * and this one only bounds a flood.
 */
const receiptLimiter = rateLimit({
  windowMs: env.AUTH_RATE_WINDOW_MS,
  max: env.AUTH_TOKEN_RATE_MAX,
  keyBy: (req) => `deletion-receipt:${req.ip ?? 'unknown'}`,
});

// ── Unauthenticated ──
authRouter.post('/auth/register', registerLimiter, handleRegister);
authRouter.post('/auth/login', loginLimiter, handleLogin);
authRouter.post('/auth/guest', guestIpLimiter, guestDeviceLimiter, handleGuest);
authRouter.post('/auth/refresh', refreshLimiter, handleRefresh);
authRouter.post('/auth/forgot-password', recoveryLimiter, handleForgotPassword);
authRouter.post('/auth/reset-password', tokenLimiter, handleResetPassword);
authRouter.post('/auth/verify-email', tokenLimiter, handleVerifyEmail);
authRouter.post('/auth/deletion-receipt', receiptLimiter, handleDeletionReceipt);

// ── Authenticated ──
//
// Guarded individually rather than with a shared `router.use`, because this
// router's prefix is also where the unauthenticated endpoints live. The
// library router can guard `/me` as a group precisely because nothing public
// sits under that prefix; here, a group guard would have to be mounted on a
// path that does not exist.
authRouter.get('/auth/me', requireCaller, handleMe);
authRouter.post('/auth/logout', requireCaller, handleLogout);
authRouter.post('/auth/change-password', requireCaller, sensitiveLimiter, handleChangePassword);
authRouter.delete('/auth/account', requireCaller, sensitiveLimiter, handleDeleteAccount);
authRouter.post(
  '/auth/resend-verification',
  requireCaller,
  recoveryLimiter,
  handleResendVerification,
);
authRouter.post('/auth/merge', requireCaller, registerLimiter, handleMerge);
