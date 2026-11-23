import type { PlaybackEvent } from '@minidrama/contracts';
import type { PlaybackOutbox } from '../outbox';
import { SyncRejectedError, SyncTransportError, type PlaybackSyncAdapter } from './adapter';
import { isOnline, type ConnectivitySource } from './connectivity';

/**
 * Drains the outbox.
 *
 * Deliberately not a React hook and not a singleton with hidden state: it is
 * a plain object with injected collaborators, so every behaviour below —
 * the mutex, the backoff, giving up, partial acceptance, coming back online —
 * is reachable from a test without a device, a network or a timer.
 */

export type SyncOutcome =
  | { kind: 'idle'; reason: 'offline' | 'empty' | 'already_running' }
  | { kind: 'synced'; sent: number; accepted: number; remaining: number }
  | { kind: 'failed'; attempted: number; error: string; retryable: boolean };

export interface SyncEngineOptions {
  /** Events per request. Kept well under the contract's 100 cap. */
  batchSize?: number;
  /** Upper bound on batches in one run, so a huge backlog cannot block. */
  maxBatchesPerRun?: number;
}

export class PlaybackSyncEngine {
  private readonly batchSize: number;
  private readonly maxBatchesPerRun: number;

  /**
   * The mutex.
   *
   * Held as the in-flight promise rather than a boolean: a second caller
   * gets the *same* run to await instead of being told "busy" and having to
   * poll. Two concurrent drains would claim overlapping batches, double-send
   * them and race on acknowledgement.
   */
  private running: Promise<SyncOutcome> | null = null;

  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(outcome: SyncOutcome) => void>();

  constructor(
    private readonly outbox: PlaybackOutbox,
    private readonly adapter: PlaybackSyncAdapter,
    private readonly connectivity: ConnectivitySource,
    options: SyncEngineOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.maxBatchesPerRun = options.maxBatchesPerRun ?? 10;
  }

  /**
   * Recovers anything a previous process left mid-flight, then starts
   * reacting to connectivity.
   *
   * The recovery step is the "app restart during pending synchronisation"
   * case: a row claimed by a run that never finished is invisible to the
   * dispatch query forever unless something releases it.
   */
  async start(): Promise<void> {
    await this.outbox.recoverInFlight();
    await this.connectivity.start();

    this.unsubscribe?.();
    this.unsubscribe = this.connectivity.subscribe((status) => {
      // Only the offline→online edge is interesting. Firing on every change
      // would start a run each time the OS re-reports the same state.
      if (isOnline(status)) void this.run();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connectivity.stop();
    this.listeners.clear();
  }

  /** Notified after every completed run, for the pending-count UI. */
  subscribe(listener: (outcome: SyncOutcome) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Drains what is due.
   *
   * Safe to call from anywhere, as often as you like. Concurrent callers
   * share one run.
   */
  async run(): Promise<SyncOutcome> {
    if (this.running) {
      // Await the run already in progress, then report that this call did
      // not start one of its own.
      await this.running;
      return { kind: 'idle', reason: 'already_running' };
    }

    this.running = this.drain();
    try {
      const outcome = await this.running;
      for (const listener of [...this.listeners]) listener(outcome);
      return outcome;
    } finally {
      this.running = null;
    }
  }

  private async drain(): Promise<SyncOutcome> {
    if (!isOnline(this.connectivity.current())) {
      return { kind: 'idle', reason: 'offline' };
    }

    let sent = 0;
    let accepted = 0;

    for (let batchNumber = 0; batchNumber < this.maxBatchesPerRun; batchNumber += 1) {
      const batch = await this.outbox.claimBatch(this.batchSize);
      if (batch.length === 0) {
        if (sent === 0) return { kind: 'idle', reason: 'empty' };
        break;
      }

      sent += batch.length;

      try {
        const ack = await this.adapter.send(batch);
        const acceptedIds = new Set(ack.acceptedEventIds);

        if (acceptedIds.size > 0) {
          accepted += await this.outbox.acknowledge([...acceptedIds]);
        }

        // Anything the server did not name is NOT delivered. It goes back to
        // the queue with a backoff rather than being quietly dropped, which
        // is the whole reason the acknowledgement lists ids.
        const unacknowledged = batch
          .filter((event) => !acceptedIds.has(event.eventId))
          .map((event) => event.eventId);

        if (unacknowledged.length > 0) {
          await this.outbox.markFailed(unacknowledged, 'not acknowledged by the server');
        }
      } catch (error: unknown) {
        const ids = batch.map((event) => event.eventId);

        if (error instanceof SyncRejectedError) {
          // The server understood it and refused. Retrying an unchanged
          // batch cannot succeed, so these burn attempts deliberately and
          // reach `dead`, where they are visible rather than looping.
          await this.outbox.markFailed(ids, `rejected: ${error.message}`);
          return { kind: 'failed', attempted: sent, error: error.message, retryable: false };
        }

        const message = error instanceof Error ? error.message : 'unknown transport failure';
        await this.outbox.markFailed(ids, message);
        return { kind: 'failed', attempted: sent, error: message, retryable: true };
      }
    }

    const remaining = (await this.outbox.counts()).pending;
    return { kind: 'synced', sent, accepted, remaining };
  }
}

/** Narrowing helper for callers that only care whether a retry is worth it. */
export function isRetryableFailure(outcome: SyncOutcome): boolean {
  return outcome.kind === 'failed' && outcome.retryable;
}

/** Re-exported so callers do not reach past the engine for the error types. */
export { SyncTransportError, SyncRejectedError };
export type { PlaybackSyncAdapter, PlaybackEvent };
