import type { Request, Response } from 'express';
import {
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  deletionReceiptRequestSchema,
  forgotPasswordRequestSchema,
  guestRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  mergeGuestRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from '@minidrama/contracts';
import { sendSuccess } from '../../utils/response.js';
import { callerOf } from '../../middleware/identity.js';
import * as service from './auth.service.js';
import * as deletionService from './deletion.service.js';
import { AccountDeletionSource } from './deletion.repository.js';

/**
 * HTTP for the authentication module.
 *
 * TWO THINGS HAPPEN HERE AND NOWHERE ELSE: the body is validated against its
 * contract, and the request's own context (device, platform, user agent, IP)
 * is read off the request. Everything else is the service's.
 *
 * NO HANDLER READS A USER ID FROM A BODY, A PARAM OR A QUERY. The only source
 * is `callerOf(req)`, which throws if the route was reached without
 * `requireCaller` — so a forgotten guard fails with a 401 instead of
 * operating on `undefined` (the same structural rule the library module
 * follows).
 */

/**
 * Request context the policy layer is allowed to see.
 *
 * `deviceId` and `platform` come from the validated body because only the
 * client knows them, and neither grants anything on its own — they label a
 * session, they do not authorise one. The user agent and IP come from the
 * request itself and cannot be set by the body at all.
 */
function contextOf(
  req: Request,
  body?: { deviceId?: string | undefined; platform?: string | undefined },
): service.RequestContext {
  return {
    deviceId: body?.deviceId,
    platform: body?.platform,
    // Truncated: a user agent is attacker-controlled and unbounded, and this
    // column exists for recognising a device, not for storing a payload.
    userAgent: req.header('user-agent')?.slice(0, 256),
    ip: req.ip,
  };
}

export async function handleRegister(req: Request, res: Response): Promise<void> {
  const body = registerRequestSchema.parse(req.body);
  sendSuccess(res, await service.register(body, contextOf(req, body)), 201);
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
  const body = loginRequestSchema.parse(req.body);
  sendSuccess(res, await service.login(body, contextOf(req, body)));
}

export async function handleGuest(req: Request, res: Response): Promise<void> {
  const body = guestRequestSchema.parse(req.body);
  sendSuccess(res, await service.guest(body, contextOf(req, body)), 201);
}

export async function handleRefresh(req: Request, res: Response): Promise<void> {
  const body = refreshRequestSchema.parse(req.body);
  sendSuccess(res, await service.refresh(body.refreshToken, contextOf(req)));
}

export async function handleLogout(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  /*
   * An unparseable logout body must not stop a logout. The client is trying
   * to get rid of its credentials; refusing because the JSON was malformed
   * leaves it holding them, which is the opposite of what was asked for.
   */
  const parsed = logoutRequestSchema.safeParse(req.body ?? {});
  const body = parsed.success ? parsed.data : {};

  await service.logout(userId, body);
  sendSuccess(res, { accepted: true as const, message: 'Signed out.' });
}

export async function handleMe(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  sendSuccess(res, await service.currentUser(userId));
}

export async function handleChangePassword(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const body = changePasswordRequestSchema.parse(req.body);
  sendSuccess(res, await service.changePassword(userId, body));
}

export async function handleForgotPassword(req: Request, res: Response): Promise<void> {
  const body = forgotPasswordRequestSchema.parse(req.body);
  sendSuccess(res, await service.forgotPassword(body.email));
}

export async function handleResetPassword(req: Request, res: Response): Promise<void> {
  const body = resetPasswordRequestSchema.parse(req.body);
  sendSuccess(res, await service.resetPassword(body));
}

export async function handleVerifyEmail(req: Request, res: Response): Promise<void> {
  const body = verifyEmailRequestSchema.parse(req.body);
  sendSuccess(res, await service.verifyEmail(body.token));
}

export async function handleResendVerification(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  sendSuccess(res, await service.resendVerification(userId));
}

export async function handleMerge(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const body = mergeGuestRequestSchema.parse(req.body);
  sendSuccess(res, await service.mergeGuest(userId, body, contextOf(req, body)));
}

// ────────────────────────── Account deletion (M2.6) ──────────────────────────

/**
 * `DELETE /auth/account`.
 *
 * THE RECEIPT ID COMES FROM A HEADER, NOT THE BODY, and `Idempotency-Key` is
 * already in the CORS allowlist (`app.ts`) because it was reserved for
 * exactly this shape of problem. Keeping it out of the body also keeps it out
 * of the validated contract, where it would look like account data; it is a
 * transport concern — "this is the same attempt as before" — and belongs with
 * the other transport metadata.
 */
export async function handleDeleteAccount(req: Request, res: Response): Promise<void> {
  const { userId } = callerOf(req);
  const body = deleteAccountRequestSchema.parse(req.body);

  // Bounded before it reaches a hash function or a log: the header is
  // attacker-controlled and unbounded.
  const receiptId = req.header('idempotency-key')?.trim().slice(0, 256);

  sendSuccess(
    res,
    await deletionService.deleteAccount(userId, body, {
      ...(receiptId ? { receiptId } : {}),
      source: AccountDeletionSource.IN_APP,
    }),
  );
}

/**
 * `POST /auth/deletion-receipt` — unauthenticated by necessity.
 *
 * The credential that would authenticate this question is destroyed by the
 * deletion it asks about. See `deletion.service.ts` for why answering it with
 * no credential leaks nothing.
 */
export async function handleDeletionReceipt(req: Request, res: Response): Promise<void> {
  const body = deletionReceiptRequestSchema.parse(req.body);
  sendSuccess(res, await deletionService.resolveReceipt(body.receiptId));
}
