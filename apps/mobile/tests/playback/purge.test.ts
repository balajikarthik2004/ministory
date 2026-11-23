import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlaybackService } from '../../services/playback/playback-service';
import { SCHEMA_VERSION } from '../../services/playback/db/schema';
import { createPlaybackEvent } from '../../services/playback/events';
import { MockPlaybackSyncAdapter } from '../../services/playback/sync/adapter';
import { FakeConnectivitySource } from '../../services/playback/sync/connectivity';
import { FakeClock, NodeSqliteDriver, SequentialIds } from '../support/node-sqlite-driver';
import { TEST_CONTEXT } from '../support/fixtures';

/**
 * `PlaybackService.purge()` — M2.6 D8.
 *
 * WHY THIS IS A TEST AND NOT A ONE-LINER LEFT TO A DEVICE RUN. Account
 * deletion is the only caller, and it calls this on a handset where the next
 * thing that happens is the viewer being dropped back on Home as a fresh
 * guest. If purge left the database closed, or the sync engine stopped, the
 * failure would not be an error — it would be progress silently never
 * recording again until the app was restarted, which is exactly the kind of
 * thing a manual check passes.
 *
 * Built with `buildPlaybackService`, the same composition root the app uses.
 */

function buildOver(driver: NodeSqliteDriver, clock: FakeClock) {
  return buildPlaybackService({
    driver,
    // A delay of 0 so a drain, if one were wrongly triggered, would be
    // observable rather than racing the assertions.
    adapter: new MockPlaybackSyncAdapter(0),
    connectivity: new FakeConnectivitySource(),
    ids: new SequentialIds(),
    clock,
    context: TEST_CONTEXT,
  });
}

/** `PRAGMA user_version` — what `migrate` sets and `dropAll` resets to 0. */
async function userVersion(driver: NodeSqliteDriver): Promise<number> {
  const row = await driver.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

const EPISODE = {
  dramaId: 'drama_mazhai',
  episodeId: 'drama_mazhai_ep01',
  durationSec: 30,
};

describe('purging local playback data', () => {
  it('removes queued events and recorded progress', async () => {
    const driver = new NodeSqliteDriver();
    const service = await buildOver(driver, new FakeClock());

    await service.outbox.enqueue(
      createPlaybackEvent(
        { ...EPISODE, type: 'playback_started', positionSec: 0 },
        {
          sessionId: 'ps_purge_0001',
          context: service.context,
          ids: service.ids,
          clock: service.clock,
        },
      ),
    );
    await service.progress.record({ ...EPISODE, episodeNumber: 1, positionSec: 12 });

    assert.ok((await service.outbox.counts()).pending > 0, 'something to lose');
    assert.ok(await service.progress.episodeProgress(EPISODE.episodeId), 'and progress to lose');

    await service.purge();

    const counts = await service.outbox.counts();
    assert.equal(counts.pending, 0);
    assert.equal(counts.inFlight, 0);
    assert.equal(counts.dead, 0);
    assert.equal(await service.progress.episodeProgress(EPISODE.episodeId), null);
    assert.equal(await service.progress.dramaProgress(EPISODE.dramaId), null);
  });

  /**
   * The database must come back MIGRATED, not merely dropped. `dropAll` takes
   * the tables and resets `user_version`, so a purge that forgot to migrate
   * would leave the next write hitting a table that does not exist — on the
   * screen right after a deletion, where the viewer has just been handed a
   * fresh guest account and starts watching.
   */
  it('leaves the database open, migrated and writable', async () => {
    const driver = new NodeSqliteDriver();
    const service = await buildOver(driver, new FakeClock());

    await service.purge();

    assert.equal(await userVersion(driver), SCHEMA_VERSION);

    await service.progress.record({ ...EPISODE, episodeNumber: 1, positionSec: 5 });
    const after = await service.progress.episodeProgress(EPISODE.episodeId);
    assert.equal(after?.positionSec, 5, 'the device can record again immediately');
  });

  it('is safe to run twice', async () => {
    const driver = new NodeSqliteDriver();
    const service = await buildOver(driver, new FakeClock());

    await service.purge();
    await service.purge();

    assert.equal(await userVersion(driver), SCHEMA_VERSION);
    assert.equal((await service.outbox.counts()).pending, 0);
  });
});
