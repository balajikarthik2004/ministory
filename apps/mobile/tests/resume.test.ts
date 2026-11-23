import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EpisodeSummary } from '@minidrama/contracts';
import { episodeToPlay, resolveResumePoint } from '../services/resume';

/**
 * The single resume rule shared by Home and the drama detail page.
 *
 * M2.4 Issue A: the two screens used to answer this differently — the rail
 * from server progress, the detail CTA from the device's SQLite copy — and
 * disagreed whenever the two drifted. These tests pin the rule itself, which
 * is what makes "both screens agree" a property rather than a coincidence.
 *
 * It intentionally mirrors the server's `resumeTargets`; the backend suite
 * `continue-watching.test.ts` asserts the same behaviour through the API.
 */

function episode(
  episodeNumber: number,
  watchState?: { positionSec: number; isCompleted: boolean },
): EpisodeSummary {
  return {
    id: `ep${episodeNumber}`,
    dramaId: 'drama_x',
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    durationSec: 30,
    isLocked: false,
    ...(watchState ? { watchState } : {}),
  } as EpisodeSummary;
}

describe('resolveResumePoint', () => {
  it('returns nothing for a drama that was never started', () => {
    assert.equal(resolveResumePoint([episode(1), episode(2), episode(3)]), null);
  });

  it('resumes the episode in progress, at the position reached', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 12, isCompleted: false }),
      episode(3),
    ]);

    assert.deepEqual(point, { episodeId: 'ep2', episodeNumber: 2, positionSec: 12 });
  });

  it('advances past a finished episode to the next one', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 30, isCompleted: true }),
      episode(3),
    ]);

    // The Issue C failure was offering episode 2 at "0s left" forever.
    assert.deepEqual(point, { episodeId: 'ep3', episodeNumber: 3, positionSec: 0 });
  });

  it('returns nothing once the final episode is finished', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 30, isCompleted: true }),
    ]);

    assert.equal(point, null, 'a finished drama has nothing to resume');
  });

  it('takes the furthest episode reached, not the last one in the array', () => {
    const point = resolveResumePoint([
      episode(3, { positionSec: 9, isCompleted: false }),
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 30, isCompleted: true }),
    ]);

    assert.equal(point?.episodeNumber, 3, 'order of the list must not decide the answer');
  });

  it('ignores an episode opened but never watched', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 20, isCompleted: false }),
      episode(2, { positionSec: 0, isCompleted: false }),
    ]);

    assert.equal(point?.episodeNumber, 1, 'a zero position is not progress');
  });

  it('does not rewind when an earlier episode was rewatched to completion', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 30, isCompleted: true }),
      episode(3, { positionSec: 7, isCompleted: false }),
    ]);

    assert.equal(point?.episodeNumber, 3);
    assert.equal(point?.positionSec, 7);
  });

  it('handles a gap in episode numbering without inventing an episode', () => {
    const point = resolveResumePoint([
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(5),
    ]);

    // Episode 2 does not exist, so there is no successor to offer.
    assert.equal(point, null);
  });
});

describe('episodeToPlay', () => {
  it('starts at episode 1 when nothing has been watched', () => {
    assert.equal(episodeToPlay([episode(1), episode(2)]), 1);
  });

  it('restarts a finished drama rather than refusing to play', () => {
    const episodes = [
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 30, isCompleted: true }),
    ];

    // Tapping play on a finished drama is an explicit request to watch it.
    assert.equal(episodeToPlay(episodes), 1);
  });

  it('resumes mid-drama', () => {
    const episodes = [
      episode(1, { positionSec: 30, isCompleted: true }),
      episode(2, { positionSec: 11, isCompleted: false }),
    ];

    assert.equal(episodeToPlay(episodes), 2);
  });
});
