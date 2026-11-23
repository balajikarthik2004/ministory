import type { ZodType } from 'zod';
import type { ErrorCode } from '@minidrama/contracts';
import { errorResponseSchema } from '@minidrama/contracts';
import { API_BASE_URL, API_TIMEOUT_MS } from '../config';
import { getAuthBridge } from './auth-bridge';
import { AppError, messageFor } from '../errors';

/**
 * The HTTP client.
 *
 * One place that knows about the network, so every screen's failure handling
 * is the same failure handling. Four things happen here and nowhere else:
 *
 *   1. A timeout. A request with no deadline on a mobile network does not
 *      fail, it hangs — and a hung query shows a spinner forever, which is
 *      worse than an error with a retry button.
 *   2. The envelope is unwrapped. `{ success, data }` is an API-level
 *      concern; callers get `data`.
 *   3. The response is parsed against its contract. A server that changes
 *      shape fails here with a clear message rather than three screens deep
 *      as `undefined is not an object`.
 *   4. Every failure becomes an `AppError` with presentable copy. A raw
 *      fetch rejection must never reach a component (CLAUDE.md §11).
 *
 * M2.5 added a fifth: the access token is attached and, on a 401, refreshed
 * once before the request is retried. See `sendOnce` and the note on the
 * retry below for why it is exactly once.
 */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /**
   * Sends the session access token, and refreshes it on a 401.
   *
   * Set on every `/me/*` call. It is deliberately opt-in rather than always
   * on: a catalogue read works for a guest with no credential at all, and
   * attaching a token to it would mean a failed refresh could break browsing
   * — which PRD AUTH-03 says must keep working.
   */
  authenticated?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = API_BASE_URL.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

/**
 * Maps a transport failure to presentable copy.
 *
 * Deliberately coarse. The distinction a viewer can act on is "you are
 * offline / we could not reach the server" versus "something went wrong" —
 * not which DNS error occurred.
 */
function toTransportError(cause: unknown): AppError {
  const message = cause instanceof Error ? cause.message : '';
  if (/abort/i.test(message)) {
    return new AppError('SERVICE_UNAVAILABLE', 'That took too long. Check your connection.');
  }
  return new AppError('SERVICE_UNAVAILABLE', messageFor('SERVICE_UNAVAILABLE'));
}

export async function request<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const token = options.authenticated ? await getAuthBridge().getAccessToken() : null;
  const response = await sendOnce(path, options, token);

  /*
   * ONE RETRY, AND ONLY FOR A 401 ON AN AUTHENTICATED REQUEST.
   *
   * The access token lives 15 minutes, so a request that starts just before
   * the boundary — or one made from a screen that was backgrounded — lands
   * expired through nobody's fault. Refreshing and retrying makes that
   * invisible, which is what AUTH-07 asks for: "expired session handled
   * without data loss".
   *
   * WHY NOT TWICE. A second 401 after a successful refresh means the request
   * is unauthorised for a reason a new token does not fix — a revoked
   * session, a suspended account, an endpoint the caller may not use. Retrying
   * again produces a loop that ends in a flat battery, not a success.
   *
   * The refresh itself is collapsed across concurrent callers by the session
   * manager, so four screens hitting this branch at once still rotate once.
   */
  if (response.status === 401 && options.authenticated) {
    const refreshed = await getAuthBridge().handleUnauthorized(token);
    if (refreshed) {
      return unwrap(path, schema, await sendOnce(path, options, refreshed));
    }
  }

  return unwrap(path, schema, response);
}

/** One attempt. No retry logic, no token decisions — those belong above. */
async function sendOnce(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // A caller-supplied signal must also cancel this request — the player
  // abandons ticket requests when the viewer swipes past an episode.
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    return await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    throw toTransportError(cause);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Unwraps the envelope and parses the payload against its contract. */
async function unwrap<T>(path: string, schema: ZodType<T>, response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw toApiError(payload, response.status);
  }

  // `{ success: true, data }`. The data is what the caller asked for.
  const envelope = payload as { success?: boolean; data?: unknown } | null;
  if (!envelope || envelope.success !== true) {
    throw new AppError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'));
  }

  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) {
    /*
     * A contract mismatch is a bug, not a user error, but it has to surface
     * as something a viewer can act on. The detail goes to the console in
     * development; the screen gets generic copy.
     */
    // `typeof` guard: this module is also loaded by the Node integration
    // test, where React Native's `__DEV__` global does not exist.
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        `[api] response for ${path} did not match its contract:`,
        parsed.error.issues.slice(0, 5),
      );
    }
    throw new AppError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'));
  }

  return parsed.data;
}

/**
 * Turns the API's error envelope into an `AppError`.
 *
 * The server's `message` is already written for a viewer to read
 * (API_DOCUMENTATION.md §1), so it is used as-is. A body that does not match
 * the envelope falls back to copy derived from the status code — a proxy
 * returning an HTML 502 must not render as `<!DOCTYPE html>`.
 */
function toApiError(payload: unknown, status: number): AppError {
  const parsed = errorResponseSchema.safeParse(payload);

  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    if (code === 'EPISODE_LOCKED') {
      const unlockOptions = details?.find((detail) => detail.field === 'unlockOptions');
      return new AppError(code, message, {
        episodeId: '',
        episodeNumber: 0,
        unlockOptions: parseUnlockOptions(unlockOptions?.message),
        coinPrice: 0,
      });
    }
    return new AppError(code, message);
  }

  return new AppError(statusToCode(status), messageFor(statusToCode(status)));
}

function statusToCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

function parseUnlockOptions(
  value: string | undefined,
): Array<'SUBSCRIPTION' | 'COIN' | 'REWARDED_AD'> {
  if (!value) return ['SUBSCRIPTION'];
  const known = new Set(['SUBSCRIPTION', 'COIN', 'REWARDED_AD']);
  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => known.has(part));
  return parsed.length > 0
    ? (parsed as Array<'SUBSCRIPTION' | 'COIN' | 'REWARDED_AD'>)
    : ['SUBSCRIPTION'];
}

/** Liveness probe, for the development connection indicator. */
export async function pingApi(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}
