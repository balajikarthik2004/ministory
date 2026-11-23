import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flushPendingProgress, type ProgressPush } from '../../services/playback/progress-sync';
import { createHarness } from '../support/fixtures';

/**
 * Durable server sync for watch progress (M2.4 §5).
 *
 * THE BUG THIS EXISTS FOR: progress was written to SQLite and then pushed to
 * the server fire-and-forget. The local write was durable; the push was not
 * retried by anything. A position recorded as the connection dropped — or
 * just before the app was killed — stayed on the device and never reached
 * the server, which is one of the two ways Home and the detail page came to
 * disagree.
 *
 * These drive the real repository over real SQLite (`node:sqlite`), so the
 * dirty-flag SQL is what is being tested, not a stand-in for it.
 */

const EP1 = {
  dramaId: 'drama_mazhai',
  episodeId: 'drama_mazhai_ep01',
  episodeNumber: 1,
  durationSec: 30,
};
const EP2 = {
  dramaId: 'drama_mazhai',
  episodeId: 'drama_mazhai_ep02',
  episodeNumber: 2,
  durationSec: 45,
};

/** A push that records what it was asked to send. */
function recordingPush(): { sent: ProgressPush[]; push: (input: ProgressPush) => Promise<void> } {
  const sent: ProgressPush[] = [];
  return {
    sent,
    push: async (input) => {
      sent.push(input);
    },
  };
}

const failingPush = async (): Promise<never> => {
  throw new Error('network down');
};

describe('pending progress — the dirty flag', () => {
  it('marks every new write as owing the server', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });

    assert.equal(await h.progress.pendingSyncCount(), 1);
    await h.close();
  });

  it('coalesces repeated writes into one pending row', async () => {
    const h = await createHarness();

    // What a player tick does: many writes to the same episode.
    for (const positionSec of [2, 4, 6, 8, 10]) {
      await h.progress.record({ ...EP1, positionSec });
    }

    assert.equal(
      await h.progress.pendingSyncCount(),
      1,
      'one row per episode, holding the latest position — not one row per tick',
    );

    const [pending] = await h.progress.pendingSync();
    assert.equal(pending?.positionSec, 10, 'the newest position, not the oldest');
    await h.close();
  });

  it('clears the flag once the server accepts the row', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });

    const { sent, push } = recordingPush();
    const result = await flushPendingProgress(h.progress, push);

    assert.equal(result.attempted, 1);
    assert.equal(result.synced, 1);
    assert.equal(result.remaining, 0);
    assert.equal(sent[0]?.episodeId, EP1.episodeId);
    assert.equal(sent[0]?.positionSec, 12);
    await h.close();
  });

  it('sends the time the position was recorded, not the time it was flushed', async () => {
    const h = await createHarness();
    await h.progress.record({
      ...EP1,
      positionSec: 12,
      occurredAtMs: Date.parse('2026-01-01T10:00:00.000Z'),
    });

    const { sent, push } = recordingPush();
    await flushPendingProgress(h.progress, push);

    // The server orders Continue Watching by this. Sending "now" would
    // reorder a viewer's rail to whatever happened to flush last.
    assert.equal(sent[0]?.occurredAt, '2026-01-01T10:00:00.000Z');
    await h.close();
  });
});

describe('pending progress — failure and recovery', () => {
  it('keeps the row dirty when the push fails', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });

    const result = await flushPendingProgress(h.progress, failingPush);

    assert.equal(result.attempted, 1);
    assert.equal(result.synced, 0);
    assert.equal(result.remaining, 1, 'still owed, so it will be retried');
    await h.close();
  });

  it('recovers the write on a later flush, which is the whole point', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });

    // Offline: the app is killed here. The position lives only on device.
    await flushPendingProgress(h.progress, failingPush);
    assert.equal(await h.progress.pendingSyncCount(), 1);

    // Next launch, network back.
    const { sent, push } = recordingPush();
    const result = await flushPendingProgress(h.progress, push);

    assert.equal(result.synced, 1);
    assert.equal(sent[0]?.positionSec, 12, 'the stranded position reached the server');
    assert.equal(await h.progress.pendingSyncCount(), 0);
    await h.close();
  });

  it('does not let one failing episode block the others', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });
    await h.progress.record({ ...EP2, positionSec: 20 });

    const sent: ProgressPush[] = [];
    const result = await flushPendingProgress(h.progress, async (input) => {
      // EP1 is permanently unacceptable — deleted upstream, say.
      if (input.episodeId === EP1.episodeId) throw new Error('gone');
      sent.push(input);
    });

    assert.equal(result.attempted, 2);
    assert.equal(result.synced, 1);
    assert.equal(sent[0]?.episodeId, EP2.episodeId, 'the healthy episode still went');
    assert.equal(result.remaining, 1, 'only the broken one is still owed');
    await h.close();
  });

  it('does not mark a position delivered when a newer one landed mid-flight', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12, occurredAtMs: 1_000 });

    // The viewer keeps watching while the request is in flight.
    const result = await flushPendingProgress(h.progress, async () => {
      await h.progress.record({ ...EP1, positionSec: 25, occurredAtMs: 2_000 });
    });

    assert.equal(result.synced, 0, 'the row we sent is no longer the row on disk');
    assert.equal(
      await h.progress.pendingSyncCount(),
      1,
      'the newer position is still owed — clearing it here would lose it',
    );

    const [pending] = await h.progress.pendingSync();
    assert.equal(pending?.positionSec, 25);
    await h.close();
  });

  it('is a no-op when nothing is owed', async () => {
    const h = await createHarness();

    const { sent, push } = recordingPush();
    const result = await flushPendingProgress(h.progress, push);

    assert.deepEqual(result, { attempted: 0, synced: 0, remaining: 0 });
    assert.equal(sent.length, 0, 'no request is made just to discover there is nothing to send');
    await h.close();
  });

  it('bounds how much one pass sends', async () => {
    const h = await createHarness();
    for (let index = 1; index <= 10; index += 1) {
      await h.progress.record({
        dramaId: 'drama_mazhai',
        episodeId: `drama_mazhai_ep${index}`,
        episodeNumber: index,
        durationSec: 30,
        positionSec: 5,
      });
    }

    const { sent, push } = recordingPush();
    const result = await flushPendingProgress(h.progress, push, 4);

    assert.equal(sent.length, 4, 'one pass is capped');
    assert.equal(result.remaining, 6, 'the rest go on the next pass');
    await h.close();
  });

  it('preserves the monotonic rule across a replay', async () => {
    const h = await createHarness();

    await h.progress.record({ ...EP1, positionSec: 25, occurredAtMs: 2_000 });
    // A stale write arriving late, as a queue replay produces.
    await h.progress.record({ ...EP1, positionSec: 5, occurredAtMs: 1_000 });

    const { sent, push } = recordingPush();
    await flushPendingProgress(h.progress, push);

    assert.equal(sent[0]?.positionSec, 25, 'a replayed older position cannot rewind the viewer');
    await h.close();
  });
});
