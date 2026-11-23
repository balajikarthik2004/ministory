import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlaybackEvent, PlaybackEventAck } from '@minidrama/contracts';
import { MAX_ATTEMPTS, RETRY_MAX_MS } from '../../services/playback/outbox';
import {
  SyncRejectedError,
  SyncTransportError,
  type PlaybackSyncAdapter,
} from '../../services/playback/sync/adapter';
import { createHarness } from '../support/fixtures';

describe('PlaybackSyncEngine — the happy path', () => {
  it('sends queued events and clears them once acknowledged', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event(), h.event()]);

    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 0, dead: 0 });
    assert.equal(h.adapter.acceptedCount(), 3);
    await h.close();
  });

  it('reports idle when there is nothing to send', async () => {
    const h = await createHarness();
    const outcome = await h.sync.run();

    assert.deepEqual(outcome, { kind: 'idle', reason: 'empty' });
    await h.close();
  });

  it('drains a backlog larger than one batch', async () => {
    const h = await createHarness({ batchSize: 2 });
    await h.outbox.enqueueMany([h.event(), h.event(), h.event(), h.event(), h.event()]);

    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.equal(h.adapter.acceptedCount(), 5);
    assert.equal((await h.outbox.counts()).pending, 0);
    await h.close();
  });

  it('preserves the order events happened in', async () => {
    const h = await createHarness({ batchSize: 2 });
    const positions = [1, 2, 3, 4, 5];
    for (const positionSec of positions) {
      await h.outbox.enqueue(h.event({ positionSec }));
      h.clock.advanceSeconds(1);
    }

    await h.sync.run();

    assert.deepEqual(
      h.adapter.acceptedEvents().map((e) => e.positionSec),
      positions,
    );
    await h.close();
  });
});

describe('PlaybackSyncEngine — offline', () => {
  it('does not attempt to send while offline', async () => {
    const h = await createHarness();
    h.connectivity.goOffline();
    await h.outbox.enqueue(h.event());

    const outcome = await h.sync.run();

    assert.deepEqual(outcome, { kind: 'idle', reason: 'offline' });
    assert.equal(h.adapter.acceptedCount(), 0);
    // Crucially, the event is untouched — not failed, not counted against
    // its retry budget. Being offline is not a delivery attempt.
    const [record] = await h.outbox.list();
    assert.equal(record?.attempts, 0);
    assert.equal(record?.status, 'pending');
    await h.close();
  });

  it('treats a connected-but-unreachable network as offline', async () => {
    // A captive portal looks connected and carries no traffic. Sending into
    // it burns retry attempts against a network that will never deliver.
    const h = await createHarness();
    h.connectivity.set({ isConnected: true, isInternetReachable: false });
    await h.outbox.enqueue(h.event());

    assert.deepEqual(await h.sync.run(), { kind: 'idle', reason: 'offline' });
    await h.close();
  });

  it('flushes automatically when connectivity returns', async () => {
    const h = await createHarness();
    await h.sync.start();

    h.connectivity.goOffline();
    await h.outbox.enqueueMany([h.event(), h.event()]);
    assert.equal((await h.outbox.counts()).pending, 2);

    // The transition is what triggers the drain — nothing polls.
    const flushed = new Promise<void>((resolve) => {
      const unsubscribe = h.sync.subscribe((outcome) => {
        if (outcome.kind === 'synced') {
          unsubscribe();
          resolve();
        }
      });
    });

    h.connectivity.goOnline();
    await flushed;

    assert.equal((await h.outbox.counts()).pending, 0);
    assert.equal(h.adapter.acceptedCount(), 2);
    await h.close();
  });

  it('queues events written while offline and keeps them across the transition', async () => {
    const h = await createHarness();
    h.connectivity.goOffline();

    for (let i = 0; i < 5; i += 1) {
      await h.outbox.enqueue(h.event({ positionSec: i }));
      h.clock.advanceSeconds(15);
    }
    await h.sync.run();
    assert.equal((await h.outbox.counts()).pending, 5, 'nothing lost while offline');

    h.connectivity.goOnline();
    await h.sync.run();

    assert.equal(h.adapter.acceptedCount(), 5);
    await h.close();
  });
});

describe('PlaybackSyncEngine — failure handling', () => {
  it('returns events to the queue on a transport failure', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);
    h.adapter.setFailureMode('transport');

    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.retryable, true);
    const counts = await h.outbox.counts();
    assert.equal(counts.pending, 2, 'nothing is dropped on failure');
    assert.equal(counts.inFlight, 0, 'nothing is left claimed');
    await h.close();
  });

  it('succeeds on a later run once the transport recovers', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());

    h.adapter.setFailureMode('transport');
    await h.sync.run();
    assert.equal(h.adapter.acceptedCount(), 0);

    h.adapter.setFailureMode('none');
    h.clock.advance(RETRY_MAX_MS);
    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.equal((await h.outbox.counts()).pending, 0);
    await h.close();
  });

  it('retries an ambiguous failure, and the duplicate is absorbed', async () => {
    // The request may have been stored. Retrying is correct; the server
    // deduplicates on eventId, which is what makes at-least-once safe.
    const h = await createHarness();
    await h.outbox.enqueue(h.event());

    h.adapter.setFailureMode('ambiguous');
    await h.sync.run();
    assert.equal(h.adapter.acceptedCount(), 1, 'the server did store it');
    assert.equal((await h.outbox.counts()).pending, 1, 'the client could not know that');

    h.adapter.setFailureMode('none');
    h.clock.advance(RETRY_MAX_MS);
    await h.sync.run();

    assert.equal(h.adapter.acceptedCount(), 1, 'the retry did not create a second row');
    assert.equal((await h.outbox.counts()).pending, 0);
    await h.close();
  });

  it('keeps unacknowledged events when the server accepts only part of a batch', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event(), h.event(), h.event()]);
    h.adapter.setFailureMode('partial');

    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.equal(h.adapter.acceptedCount(), 2);
    assert.equal((await h.outbox.counts()).pending, 2, 'the rest stay queued');
    await h.close();
  });

  it('does not treat a rejection as retryable', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    h.adapter.setFailureMode('reject');

    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.retryable, false);
    await h.close();
  });

  it('eventually marks a permanently failing event dead instead of looping forever', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    h.adapter.setFailureMode('transport');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(RETRY_MAX_MS);
      await h.sync.run();
    }

    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 0, dead: 1 });

    // And the engine stops trying.
    h.clock.advance(RETRY_MAX_MS * 10);
    assert.deepEqual(await h.sync.run(), { kind: 'idle', reason: 'empty' });
    await h.close();
  });
});

describe('PlaybackSyncEngine — concurrency', () => {
  it('runs one drain at a time, however many callers ask', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const sent: string[] = [];

    const slowAdapter: PlaybackSyncAdapter = {
      name: 'slow',
      async send(events: readonly PlaybackEvent[]): Promise<PlaybackEventAck> {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        for (const event of events) sent.push(event.eventId);
        return { acceptedEventIds: events.map((event) => event.eventId) };
      },
    };

    const h = await createHarness({ batchSize: 1 });
    const { PlaybackSyncEngine } = await import('../../services/playback/sync/sync-engine');
    const engine = new PlaybackSyncEngine(h.outbox, slowAdapter, h.connectivity, { batchSize: 1 });

    await h.outbox.enqueueMany([h.event(), h.event(), h.event(), h.event()]);

    await Promise.all([engine.run(), engine.run(), engine.run(), engine.run()]);

    assert.equal(maxConcurrent, 1, 'two drains must never overlap');
    // Each event sent exactly once: no batch was claimed twice.
    assert.equal(new Set(sent).size, sent.length);
    assert.equal(sent.length, 4);
    await h.close();
  });

  it('reports the piggybacked callers as already_running', async () => {
    const h = await createHarness({ adapterLatencyMs: 10 });
    await h.outbox.enqueueMany([h.event(), h.event()]);

    const [first, second] = await Promise.all([h.sync.run(), h.sync.run()]);

    const kinds = [first.kind, second.kind].sort();
    assert.deepEqual(kinds, ['idle', 'synced']);
    assert.equal(h.adapter.acceptedCount(), 2);
    await h.close();
  });
});

describe('PlaybackSyncEngine — restart recovery', () => {
  it('releases and resends rows left in flight by a killed process', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);

    // The app died between claiming and sending.
    await h.outbox.claimBatch(10);
    assert.equal((await h.outbox.counts()).inFlight, 2);

    // Next launch.
    await h.sync.start();
    const outcome = await h.sync.run();

    assert.equal(outcome.kind, 'synced');
    assert.equal(h.adapter.acceptedCount(), 2);
    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 0, dead: 0 });
    await h.close();
  });
});

describe('SyncTransportError', () => {
  it('distinguishes ambiguous failures, which must be retried', () => {
    assert.equal(new SyncTransportError('x', { ambiguous: true }).ambiguous, true);
    assert.equal(new SyncTransportError('x', { ambiguous: false }).ambiguous, false);
    assert.ok(new SyncRejectedError('x') instanceof Error);
  });
});
