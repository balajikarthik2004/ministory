import {
  playbackEventAckSchema,
  type PlaybackEvent,
  type PlaybackEventAck,
} from '@minidrama/contracts';
import { API_BASE_URL, API_TIMEOUT_MS } from '../../config';
import { SyncRejectedError, SyncTransportError, type PlaybackSyncAdapter } from './adapter';

/**
 * The real sync adapter — `POST /api/v1/playback/events`.
 *
 * Replaces `MockPlaybackSyncAdapter`. Nothing above it changes: the engine's
 * mutex, backoff, bounded retries and partial-acceptance handling were all
 * written against this interface in M2.2 and are untouched.
 *
 * THE ONE THING THIS CLASS MUST GET RIGHT is classifying failures, because
 * the engine decides whether to retry from that classification alone:
 *
 *   * A request that never got a response is AMBIGUOUS. It may have been
 *     stored. Retrying is correct, and the server deduplicates on `eventId`
 *     — that is what makes at-least-once safe (ADR-25).
 *   * A 5xx is a transport failure and retryable: the server is unwell, not
 *     the batch.
 *   * A 4xx other than 429 means the server understood and refused.
 *     Retrying an unchanged batch cannot succeed, so it is NOT retryable and
 *     the events burn their attempts down to `dead`, where they are visible.
 *   * A 429 is retryable — it is a request to come back later, not a
 *     rejection of the content.
 *
 * Getting that backwards either loses data or hammers a server that already
 * said no.
 */
export class HttpPlaybackSyncAdapter implements PlaybackSyncAdapter {
  readonly name: string;
  private readonly baseUrl: string;

  private readonly getAccessToken: () => Promise<string | null>;

  /**
   * @param baseUrl overrides the configured API origin.
   * @param getAccessToken supplies the credential. Injected rather than
   *   imported so this class stays loadable under Node, where
   *   `services/auth/session` pulls in `react-native` and `expo-secure-store`
   *   and cannot be imported at all. The sync tests construct it directly.
   *
   * The app passes neither. The base URL exists so the failure classification
   * above can be tested against an address that genuinely refuses
   * connections — the alternative is asserting on a branch nothing ever
   * executes, and the retry/ambiguity decision is the one thing in this class
   * that loses data if it is wrong.
   */
  constructor(
    baseUrl: string = API_BASE_URL,
    getAccessToken: () => Promise<string | null> = async () => null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.name = `http (${this.baseUrl})`;
    this.getAccessToken = getAccessToken;
  }

  async send(events: readonly PlaybackEvent[]): Promise<PlaybackEventAck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    /*
     * THE TOKEN IS FETCHED PER BATCH, NOT HELD.
     *
     * A drain can run for a while — a returning device sends batches of 100
     * until the outbox is empty — and an access token captured at the start
     * may expire partway through. `getAccessToken()` refreshes when it is
     * close to expiry, so each batch carries a current one.
     *
     * A NULL TOKEN STILL SENDS. Events from a guest with no session are
     * accepted with a null `userId` (the server treats the caller as
     * anonymous), so refusing to send here would strand the outbox rather
     * than degrade it. Ownership is the server's decision, not ours.
     */
    const accessToken = await this.getAccessToken().catch(() => null);
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/playback/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
    } catch (cause: unknown) {
      /*
       * The request did not complete. Whether it reached the server is
       * unknowable from here — a timeout after the body was sent looks
       * identical to a DNS failure before it. Ambiguous, therefore retried.
       */
      throw new SyncTransportError(
        cause instanceof Error ? cause.message : 'could not reach the server',
        { ambiguous: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new SyncTransportError('rate limited', { ambiguous: false });
    }

    if (response.status >= 500) {
      throw new SyncTransportError(`server error ${response.status}`, { ambiguous: false });
    }

    if (response.status >= 400) {
      // Understood and refused. Not retryable.
      throw new SyncRejectedError(`rejected with ${response.status}`);
    }

    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { success?: boolean; data?: unknown } | null;

    if (!envelope || envelope.success !== true) {
      // A 2xx whose body we cannot read is not proof of storage. Treated as
      // ambiguous so the events stay queued and are retried.
      throw new SyncTransportError('unreadable response body', { ambiguous: true });
    }

    const ack = playbackEventAckSchema.safeParse(envelope.data);
    if (!ack.success) {
      throw new SyncTransportError('acknowledgement did not match its contract', {
        ambiguous: true,
      });
    }

    return ack.data;
  }
}
