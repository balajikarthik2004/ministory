import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPLETION_THRESHOLD,
  ProgressRepository,
} from '../../services/playback/progress-repository';
import { migrate, SCHEMA_VERSION } from '../../services/playback/db/schema';
import { FakeClock, NodeSqliteDriver } from '../support/node-sqlite-driver';
import { createHarness } from '../support/fixtures';

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

describe('ProgressRepository — basic persistence', () => {
  it('stores a position and reads it back', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 12 });

    const stored = await h.progress.episodeProgress(EP1.episodeId);
    assert.equal(stored?.positionSec, 12);
    assert.equal(stored?.durationSec, 30);
    assert.equal(stored?.isCompleted, false);
    await h.close();
  });

  it('ignores a write with no usable duration', async () => {
    // expo-video reports duration 0 before metadata loads. Persisting that
    // would make every completion calculation divide by zero.
    const h = await createHarness();
    await h.progress.record({ ...EP1, durationSec: 0, positionSec: 5 });

    assert.equal(await h.progress.episodeProgress(EP1.episodeId), null);
    await h.close();
  });

  it('clamps a position reported past the end', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 99 });

    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.positionSec, 30);
    await h.close();
  });

  it('maintains a per-drama head alongside the per-episode row', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP2, positionSec: 20 });

    const head = await h.progress.dramaProgress(EP2.dramaId);
    assert.equal(head?.episodeId, EP2.episodeId);
    assert.equal(head?.episodeNumber, 2);
    assert.equal(head?.positionSec, 20);
    await h.close();
  });
});

describe('ProgressRepository — the monotonic rule', () => {
  it('never moves a stored position backwards', async () => {
    // API_DOCUMENTATION.md §6: the server takes the maximum position, never
    // a lower one. The local store has to agree or a replayed queue entry
    // would rewind the viewer.
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 25 });
    await h.progress.record({ ...EP1, positionSec: 5 });

    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.positionSec, 25);
    await h.close();
  });

  it('survives an out-of-order replay of queued writes', async () => {
    const h = await createHarness();
    const base = h.clock.now();

    // Flushed in the wrong order after reconnecting.
    await h.progress.record({ ...EP1, positionSec: 28, occurredAtMs: base + 20_000 });
    await h.progress.record({ ...EP1, positionSec: 10, occurredAtMs: base + 5_000 });

    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.positionSec, 28);
    await h.close();
  });

  it('keeps an episode complete once it has been completed', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 30 });
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.isCompleted, true);

    // Rewatching from the start does not un-watch it.
    await h.progress.record({ ...EP1, positionSec: 0 });
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.isCompleted, true);
    await h.close();
  });
});

describe('ProgressRepository — completion', () => {
  it(`marks an episode complete at ${COMPLETION_THRESHOLD * 100}% (PRD HIST-03)`, async () => {
    const h = await createHarness();
    const justUnder = EP1.durationSec * COMPLETION_THRESHOLD - 0.1;
    const justOver = EP1.durationSec * COMPLETION_THRESHOLD;

    await h.progress.record({ ...EP1, positionSec: justUnder });
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.isCompleted, false);

    await h.progress.record({ ...EP1, positionSec: justOver });
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.isCompleted, true);
    await h.close();
  });

  it('drops a completed drama off Continue Watching (HIST-04)', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 10 });
    assert.equal((await h.progress.continueWatching()).length, 1);

    await h.progress.record({ ...EP1, positionSec: 30 });
    assert.equal((await h.progress.continueWatching()).length, 0);

    // But it is still in the full history.
    assert.equal((await h.progress.allDramaProgress()).length, 1);
    await h.close();
  });
});

describe('ProgressRepository — the drama head', () => {
  it('advances the head when the viewer moves to a later episode', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 10 });
    h.clock.advanceSeconds(10);
    await h.progress.record({ ...EP2, positionSec: 5 });

    const head = await h.progress.dramaProgress(EP1.dramaId);
    assert.equal(head?.episodeNumber, 2);
    assert.equal(head?.positionSec, 5);
    await h.close();
  });

  it('does not move the head back when an earlier episode is rewatched', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP2, positionSec: 20 });
    h.clock.advanceSeconds(10);
    await h.progress.record({ ...EP1, positionSec: 8 });

    const head = await h.progress.dramaProgress(EP1.dramaId);
    assert.equal(head?.episodeNumber, 2, 'the drama still resumes at episode 2');

    // The rewatched episode's own position is still recorded.
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.positionSec, 8);
    await h.close();
  });

  it('ignores a stale write that would reorder Continue Watching', async () => {
    const h = await createHarness();
    const base = h.clock.now();

    await h.progress.record({ ...EP2, positionSec: 20, occurredAtMs: base + 60_000 });
    const before = await h.progress.dramaProgress(EP2.dramaId);

    // A write from an hour earlier, flushed late from the offline queue.
    await h.progress.record({ ...EP2, positionSec: 25, occurredAtMs: base });

    const after = await h.progress.dramaProgress(EP2.dramaId);
    assert.equal(after?.lastWatchedAt, before?.lastWatchedAt, 'head timestamp must not move back');
    await h.close();
  });

  it('orders Continue Watching by recency across dramas', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 5 });
    h.clock.advanceSeconds(60);
    await h.progress.record({
      dramaId: 'drama_kadhal',
      episodeId: 'drama_kadhal_ep01',
      episodeNumber: 1,
      durationSec: 30,
      positionSec: 4,
    });

    const rail = await h.progress.continueWatching();
    assert.deepEqual(
      rail.map((item) => item.dramaId),
      ['drama_kadhal', 'drama_mazhai'],
    );
    await h.close();
  });
});

describe('ProgressRepository — seeding', () => {
  it('seeds only what is absent', async () => {
    const h = await createHarness();
    await h.progress.record({ ...EP1, positionSec: 22 });

    const seeded = await h.progress.seedIfAbsent([
      { ...EP1, positionSec: 3 },
      { ...EP2, positionSec: 7 },
    ]);

    assert.equal(seeded, 1);
    // The real progress is untouched; the fixture value did not overwrite it.
    assert.equal((await h.progress.episodeProgress(EP1.episodeId))?.positionSec, 22);
    assert.equal((await h.progress.episodeProgress(EP2.episodeId))?.positionSec, 7);
    await h.close();
  });
});

describe('ProgressRepository — durability across restarts', () => {
  it("still has the viewer's position after the database is reopened", async () => {
    // One file, two "app launches". This is the restart guarantee stated as
    // a test rather than as a comment.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'minidrama-progress-'));
    const file = join(dir, 'playback.db');

    try {
      const first = new NodeSqliteDriver(file);
      await migrate(first);
      const clock = new FakeClock();
      await new ProgressRepository(first, clock).record({ ...EP2, positionSec: 31 });
      await first.close();

      const second = new NodeSqliteDriver(file);
      // Migration runs again on launch and must be a no-op.
      assert.equal(await migrate(second), SCHEMA_VERSION);
      const reopened = await new ProgressRepository(second, clock).episodeProgress(EP2.episodeId);

      assert.equal(reopened?.positionSec, 31);
      assert.equal((await new ProgressRepository(second, clock).continueWatching()).length, 1);
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
