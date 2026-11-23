import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  backoffDelayMs,
} from '../../services/playback/outbox';
import { createHarness } from '../support/fixtures';

describe('PlaybackOutbox — insertion', () => {
  it('queues an event and reports it pending', async () => {
    const h = await createHarness();
    const written = await h.outbox.enqueue(h.event());

    assert.equal(written, true);
    assert.deepEqual(await h.outbox.counts(), { pending: 1, inFlight: 0, dead: 0 });
    await h.close();
  });

  it('round-trips the event unchanged through storage', async () => {
    const h = await createHarness();
    const original = h.event({
      type: 'playback_failed',
      positionSec: 12.5,
      durationSec: 45,
      errorCode: 'network',
    });
    await h.outbox.enqueue(original);

    const [record] = await h.outbox.list();
    assert.ok(record);
    assert.deepEqual(record.event, original);
    await h.close();
  });

  it('queues a batch in one call', async () => {
    const h = await createHarness();
    const written = await h.outbox.enqueueMany([h.event(), h.event(), h.event()]);

    assert.equal(written, 3);
    assert.equal((await h.outbox.counts()).pending, 3);
    await h.close();
  });

  it('accepts an empty batch without touching the database', async () => {
    const h = await createHarness();
    assert.equal(await h.outbox.enqueueMany([]), 0);
    await h.close();
  });

  it('refuses to persist an event that violates the contract', async () => {
    const h = await createHarness();
    const broken = { ...h.event(), positionSec: -1 };

    await assert.rejects(() => h.outbox.enqueue(broken));
    assert.equal((await h.outbox.counts()).pending, 0);
    await h.close();
  });
});

describe('PlaybackOutbox — duplicates', () => {
  it('ignores a re-enqueue of the same event id', async () => {
    const h = await createHarness();
    const event = h.event();

    assert.equal(await h.outbox.enqueue(event), true);
    assert.equal(await h.outbox.enqueue(event), false);

    assert.equal((await h.outbox.counts()).pending, 1);
    await h.close();
  });

  it('does not reset backoff state when the same event is re-enqueued', async () => {
    // A caller retrying an enqueue must not hand a mid-backoff row a fresh
    // schedule — that would defeat the backoff entirely.
    const h = await createHarness();
    const event = h.event();
    await h.outbox.enqueue(event);

    const claimed = await h.outbox.claimBatch(10);
    await h.outbox.markFailed(
      claimed.map((e) => e.eventId),
      'boom',
    );

    const [before] = await h.outbox.list();
    assert.ok(before);
    assert.equal(before.attempts, 1);

    await h.outbox.enqueue(event);

    const [after] = await h.outbox.list();
    assert.ok(after);
    assert.equal(after.attempts, 1);
    assert.equal(after.nextAttemptAt, before.nextAttemptAt);
    await h.close();
  });
});

describe('PlaybackOutbox — claiming', () => {
  it('claims due events and marks them in flight', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);

    const claimed = await h.outbox.claimBatch(10);

    assert.equal(claimed.length, 2);
    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 2, dead: 0 });
    await h.close();
  });

  it('never hands the same row to two claims', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);

    const first = await h.outbox.claimBatch(10);
    const second = await h.outbox.claimBatch(10);

    assert.equal(first.length, 2);
    assert.equal(second.length, 0);
    await h.close();
  });

  it('respects the batch limit', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event(), h.event(), h.event(), h.event()]);

    assert.equal((await h.outbox.claimBatch(2)).length, 2);
    assert.equal((await h.outbox.counts()).pending, 3);
    await h.close();
  });

  it('claims in creation order, so events arrive in the order they happened', async () => {
    const h = await createHarness();
    const first = h.event({ positionSec: 1 });
    await h.outbox.enqueue(first);
    h.clock.advanceSeconds(1);
    const second = h.event({ positionSec: 2 });
    await h.outbox.enqueue(second);

    const claimed = await h.outbox.claimBatch(10);

    assert.deepEqual(
      claimed.map((e) => e.eventId),
      [first.eventId, second.eventId],
    );
    await h.close();
  });

  it('does not claim an event whose backoff has not elapsed', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());

    const claimed = await h.outbox.claimBatch(10);
    await h.outbox.markFailed(
      claimed.map((e) => e.eventId),
      'boom',
    );

    assert.equal((await h.outbox.claimBatch(10)).length, 0);

    h.clock.advance(RETRY_MAX_MS);
    assert.equal((await h.outbox.claimBatch(10)).length, 1);
    await h.close();
  });
});

describe('PlaybackOutbox — acknowledgement', () => {
  it('deletes only the events the server named', async () => {
    const h = await createHarness();
    const kept = h.event({ positionSec: 1 });
    const acked = h.event({ positionSec: 2 });
    await h.outbox.enqueueMany([kept, acked]);
    await h.outbox.claimBatch(10);

    const deleted = await h.outbox.acknowledge([acked.eventId]);

    assert.equal(deleted, 1);
    const remaining = await h.outbox.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.event.eventId, kept.eventId);
    await h.close();
  });

  it('is a no-op for an empty acknowledgement', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    assert.equal(await h.outbox.acknowledge([]), 0);
    assert.equal((await h.outbox.counts()).pending, 1);
    await h.close();
  });
});

describe('PlaybackOutbox — retry and backoff', () => {
  it('grows the delay exponentially and caps it', () => {
    const half = (n: number) => backoffDelayMs(n, () => 0);
    assert.equal(half(1), RETRY_BASE_MS / 2);
    assert.equal(half(2), RETRY_BASE_MS);
    assert.equal(half(3), RETRY_BASE_MS * 2);
    // Well past the cap.
    assert.equal(half(30), RETRY_MAX_MS / 2);
  });

  it('jitters within the upper half of the window', () => {
    const low = backoffDelayMs(4, () => 0);
    const high = backoffDelayMs(4, () => 1);
    assert.ok(low < high, 'jitter should produce a range');
    assert.equal(high, Math.min(RETRY_BASE_MS * 2 ** 3, RETRY_MAX_MS));
    assert.equal(low, high / 2);
  });

  it('returns a failed event to the queue with an incremented attempt count', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    const claimed = await h.outbox.claimBatch(10);

    await h.outbox.markFailed(
      claimed.map((e) => e.eventId),
      'network unreachable',
    );

    const [record] = await h.outbox.list();
    assert.ok(record);
    assert.equal(record.status, 'pending');
    assert.equal(record.attempts, 1);
    assert.equal(record.lastError, 'network unreachable');
    await h.close();
  });

  it('gives up after MAX_ATTEMPTS and marks the event dead rather than deleting it', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(RETRY_MAX_MS);
      const claimed = await h.outbox.claimBatch(10);
      assert.equal(claimed.length, 1, `attempt ${attempt} should have claimed the row`);
      await h.outbox.markFailed(
        claimed.map((e) => e.eventId),
        'still failing',
      );
    }

    const counts = await h.outbox.counts();
    assert.deepEqual(counts, { pending: 0, inFlight: 0, dead: 1 });

    // A dead row is never claimed again, however long we wait.
    h.clock.advance(RETRY_MAX_MS * 100);
    assert.equal((await h.outbox.claimBatch(10)).length, 0);
    await h.close();
  });

  it('truncates a very long error so the column stays diagnostic', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    const claimed = await h.outbox.claimBatch(10);

    await h.outbox.markFailed(
      claimed.map((e) => e.eventId),
      'x'.repeat(5000),
    );

    const [record] = await h.outbox.list();
    assert.ok(record);
    assert.equal(record.lastError?.length, 300);
    await h.close();
  });

  it('discards dead events only when asked', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(RETRY_MAX_MS);
      const claimed = await h.outbox.claimBatch(10);
      await h.outbox.markFailed(
        claimed.map((e) => e.eventId),
        'nope',
      );
    }

    assert.equal(await h.outbox.discardDead(), 1);
    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 0, dead: 0 });
    await h.close();
  });
});

describe('PlaybackOutbox — restart recovery', () => {
  it('releases rows left in flight by a process that died mid-send', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);
    await h.outbox.claimBatch(10);

    // Simulates the app being killed here: the rows are claimed and nothing
    // will ever acknowledge or fail them.
    assert.equal((await h.outbox.counts()).inFlight, 2);

    const recovered = await h.outbox.recoverInFlight();

    assert.equal(recovered, 2);
    assert.deepEqual(await h.outbox.counts(), { pending: 2, inFlight: 0, dead: 0 });
    // And they are immediately due, not backed off.
    assert.equal((await h.outbox.claimBatch(10)).length, 2);
    await h.close();
  });

  it('does not touch rows that were already pending', async () => {
    const h = await createHarness();
    await h.outbox.enqueueMany([h.event(), h.event()]);

    assert.equal(await h.outbox.recoverInFlight(), 0);
    assert.equal((await h.outbox.counts()).pending, 2);
    await h.close();
  });

  it('does not resurrect dead rows', async () => {
    const h = await createHarness();
    await h.outbox.enqueue(h.event());
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(RETRY_MAX_MS);
      const claimed = await h.outbox.claimBatch(10);
      await h.outbox.markFailed(
        claimed.map((e) => e.eventId),
        'nope',
      );
    }

    await h.outbox.recoverInFlight();

    assert.deepEqual(await h.outbox.counts(), { pending: 0, inFlight: 0, dead: 1 });
    await h.close();
  });
});
