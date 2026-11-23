import type { PlaybackEvent, PlaybackEventAck } from '@minidrama/contracts';

/**
 * How a batch of events reaches the server.
 *
 * M2.3 implements the real ingestion endpoint. Until it exists, this
 * interface is the seam: the sync engine is written against it and is
 * complete, and the only thing M2.3 changes is which implementation is
 * registered.
 *
 * CLAUDE.md §16.13 — no endpoint is invented here. The shape of the
 * acknowledgement comes from the contract (`playbackEventAckSchema`), which
 * M2.3 will satisfy; nothing in this file assumes a URL, a method or a
 * payload envelope.
 */

/** Distinguishes failures the engine should treat differently. */
export class SyncTransportError extends Error {
  /**
   * `true` when the request may have reached the server. The engine must
   * retry these, because the alternative is losing an event that was never
   * stored. The server deduplicates on `eventId`, which is what makes
   * retrying a possibly-delivered batch safe.
   */
  readonly ambiguous: boolean;

  constructor(message: string, options: { ambiguous: boolean }) {
    super(message);
    this.name = 'SyncTransportError';
    this.ambiguous = options.ambiguous;
  }
}

/** Raised when the server rejected the batch as malformed. Not retryable. */
export class SyncRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRejectedError';
  }
}

export interface PlaybackSyncAdapter {
  /**
   * Delivers a batch.
   *
   * Resolves with the ids the server *durably accepted*. Anything not named
   * stays queued — a partial accept is a normal outcome, not an error.
   *
   * Throws `SyncTransportError` when delivery could not be established or
   * confirmed, and `SyncRejectedError` when the server understood the batch
   * and refused it.
   */
  send(events: readonly PlaybackEvent[]): Promise<PlaybackEventAck>;

  /** Shown in the developer inspector so it is obvious which one is live. */
  readonly name: string;
}

/**
 * MOCK ADAPTER — M2.2 only. Replaced in M2.3.
 * ═══════════════════════════════════════════
 *
 * CLAUDE.md §16.12 requires temporary implementations to be unmistakable.
 * This one accepts everything after a short delay and keeps a log, so the
 * pipeline can be exercised end to end on a device without a server
 * existing. It talks to nothing.
 *
 * `failureMode` is not a gimmick: the retry and backoff paths are the parts
 * most likely to be wrong and least likely to be exercised by accident. Being
 * able to turn failure on from the Profile screen is how they get tested on
 * real hardware.
 */
export type MockFailureMode = 'none' | 'transport' | 'ambiguous' | 'reject' | 'partial';

export class MockPlaybackSyncAdapter implements PlaybackSyncAdapter {
  readonly name = 'mock (no server — M2.3 replaces this)';

  /** Every event this adapter has accepted, newest last. */
  private readonly accepted: PlaybackEvent[] = [];
  private failure: MockFailureMode = 'none';

  constructor(private readonly latencyMs = 250) {}

  setFailureMode(mode: MockFailureMode): void {
    this.failure = mode;
  }

  getFailureMode(): MockFailureMode {
    return this.failure;
  }

  acceptedCount(): number {
    return this.accepted.length;
  }

  acceptedEvents(): readonly PlaybackEvent[] {
    return this.accepted;
  }

  reset(): void {
    this.accepted.length = 0;
    this.failure = 'none';
  }

  async send(events: readonly PlaybackEvent[]): Promise<PlaybackEventAck> {
    await delay(this.latencyMs);

    switch (this.failure) {
      case 'transport':
        throw new SyncTransportError('mock: could not reach the server', { ambiguous: false });
      case 'ambiguous':
        // The dangerous case: it may have been stored. Record it, then fail,
        // so a retry has something to collide with and duplicate handling is
        // genuinely exercised.
        this.record(events);
        throw new SyncTransportError('mock: no response after sending', { ambiguous: true });
      case 'reject':
        throw new SyncRejectedError('mock: batch rejected');
      case 'partial': {
        // Accept the first half only. The rest must stay queued.
        const half = Math.max(1, Math.floor(events.length / 2));
        const taken = events.slice(0, half);
        this.record(taken);
        return { acceptedEventIds: taken.map((event) => event.eventId) };
      }
      case 'none':
      default:
        this.record(events);
        return { acceptedEventIds: events.map((event) => event.eventId) };
    }
  }

  /** Deduplicates, exactly as the real ingestion endpoint must. */
  private record(events: readonly PlaybackEvent[]): void {
    const known = new Set(this.accepted.map((event) => event.eventId));
    for (const event of events) {
      if (known.has(event.eventId)) continue;
      known.add(event.eventId);
      this.accepted.push(event);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
