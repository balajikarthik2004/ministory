import {
  acknowledgementSchema,
  authSessionSchema,
  currentUserSchema,
  deleteAccountResponseSchema,
  deletionReceiptResponseSchema,
  mergeResultSchema,
  registerResponseSchema,
  type Acknowledgement,
  type AuthSession,
  type CurrentUser,
  type DELETION_CONFIRMATION,
  type DeleteAccountResponse,
  type DeletionReceiptResponse,
  type MergeResult,
  type RegisterResponse,
} from '@minidrama/contracts';
import type { ZodType } from 'zod';
import { errorResponseSchema, type ErrorCode } from '@minidrama/contracts';
import { API_BASE_URL, API_TIMEOUT_MS } from '../config';
import { AppError, messageFor } from '../errors';

/**
 * The authentication endpoints.
 *
 * DELIBERATELY SEPARATE FROM `services/api/http-client.ts`, AND NOT A LAYER
 * ON TOP OF IT. The main client asks the session manager for an access token
 * and refreshes on a 401; the session manager refreshes by calling this. If
 * this went through the main client, a failing refresh would trigger another
 * refresh, which would fail, and so on — the classic interceptor loop, where
 * the symptom is a device hammering `/auth/refresh` until the battery dies.
 *
 * The rule that prevents it: NOTHING IN THIS FILE RETRIES, REFRESHES, OR
 * CONSULTS THE SESSION MANAGER. A token, if one is needed, is passed in.
 */

export interface AuthGateway {
  register(input: {
    email: string;
    password: string;
    displayName?: string;
    deviceId?: string;
    platform?: string;
  }): Promise<RegisterResponse>;
  login(input: {
    email: string;
    password: string;
    deviceId?: string;
    platform?: string;
  }): Promise<AuthSession>;
  guest(input: { deviceId: string; platform?: string }): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  logout(accessToken: string, refreshToken: string | null): Promise<void>;
  me(accessToken: string): Promise<CurrentUser>;
  changePassword(
    accessToken: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<Acknowledgement>;
  forgotPassword(email: string): Promise<Acknowledgement>;
  resetPassword(input: { token: string; newPassword: string }): Promise<Acknowledgement>;
  verifyEmail(token: string): Promise<Acknowledgement>;
  resendVerification(accessToken: string): Promise<Acknowledgement>;
  merge(
    accessToken: string,
    input: { email: string; password: string; displayName?: string; deviceId?: string },
  ): Promise<MergeResult>;
  /**
   * Deletes the calling account (M2.6).
   *
   * `receiptId` goes out as `Idempotency-Key`, not in the body, because it is
   * transport metadata — "this is the same attempt as before" — and because
   * it is the only thing that can answer whether the deletion happened once
   * the credential used to ask has been destroyed.
   */
  deleteAccount(
    accessToken: string,
    input: { password?: string; confirm: typeof DELETION_CONFIRMATION },
    receiptId: string,
  ): Promise<DeleteAccountResponse>;
  /** Unauthenticated by necessity — see the contract's note. */
  resolveDeletionReceipt(receiptId: string): Promise<DeletionReceiptResponse>;
}

async function call<T>(
  path: string,
  schema: ZodType<T>,
  options: {
    body?: unknown;
    token?: string | null;
    method?: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  Object.assign(headers, options.headers ?? {});

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}${path}`, {
      method: options.method ?? 'POST',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : '';
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      /abort/i.test(message)
        ? 'That took too long. Check your connection.'
        : messageFor('SERVICE_UNAVAILABLE'),
    );
  } finally {
    clearTimeout(timer);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      /*
       * The server's copy is already written for a viewer (API_DOCUMENTATION
       * §1) and is carefully uniform across the paths that must not be
       * distinguishable — "that email address and password do not match an
       * account" is the same sentence for a wrong password and a missing
       * account. Rewriting it here would be how that care gets undone.
       */
      throw new AppError(parsed.data.error.code, parsed.data.error.message);
    }
    const code = statusToCode(response.status);
    throw new AppError(code, messageFor(code));
  }

  const envelope = payload as { success?: boolean; data?: unknown } | null;
  if (!envelope || envelope.success !== true) {
    throw new AppError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'));
  }

  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(`[auth] response for ${path} did not match its contract:`, parsed.error.issues);
    }
    throw new AppError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'));
  }
  return parsed.data;
}

function statusToCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

export const httpAuthGateway: AuthGateway = {
  register: (input) => call('/auth/register', registerResponseSchema, { body: input }),
  login: (input) => call('/auth/login', authSessionSchema, { body: input }),
  guest: (input) => call('/auth/guest', authSessionSchema, { body: input }),
  refresh: (refreshToken) => call('/auth/refresh', authSessionSchema, { body: { refreshToken } }),
  logout: async (accessToken, refreshToken) => {
    await call('/auth/logout', acknowledgementSchema, {
      token: accessToken,
      body: refreshToken ? { refreshToken } : {},
    });
  },
  me: (accessToken) => call('/auth/me', currentUserSchema, { method: 'GET', token: accessToken }),
  changePassword: (accessToken, input) =>
    call('/auth/change-password', acknowledgementSchema, { token: accessToken, body: input }),
  forgotPassword: (email) =>
    call('/auth/forgot-password', acknowledgementSchema, { body: { email } }),
  resetPassword: (input) => call('/auth/reset-password', acknowledgementSchema, { body: input }),
  verifyEmail: (token) => call('/auth/verify-email', acknowledgementSchema, { body: { token } }),
  resendVerification: (accessToken) =>
    call('/auth/resend-verification', acknowledgementSchema, { token: accessToken }),
  merge: (accessToken, input) =>
    call('/auth/merge', mergeResultSchema, { token: accessToken, body: input }),
  deleteAccount: (accessToken, input, receiptId) =>
    call('/auth/account', deleteAccountResponseSchema, {
      method: 'DELETE',
      token: accessToken,
      body: input,
      headers: { 'Idempotency-Key': receiptId },
    }),
  resolveDeletionReceipt: (receiptId) =>
    call('/auth/deletion-receipt', deletionReceiptResponseSchema, { body: { receiptId } }),
};
