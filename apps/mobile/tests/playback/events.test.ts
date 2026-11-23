import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { playbackEventSchema } from '@minidrama/contracts';
import {
  ProgressHeartbeat,
  PROGRESS_HEARTBEAT_SECONDS,
  classifyPlaybackError,
  createPlaybackEvent,
} from '../../services/playback/events';
import { FakeClock, SequentialIds } from '../support/node-sqlite-driver';
import { TEST_CONTEXT } from '../support/fixtures';

function factoryOptions(clock = new FakeClock(), ids = new SequentialIds()) {
  return { sessionId: 'session-aaaaaaaa', context: TEST_CONTEXT, ids, clock };
}

describe('createPlaybackEvent', () => {
  it('produces an event that satisfies the shared contract', () => {
    const event = createPlaybackEvent(
      {
        type: 'playback_started',
        dramaId: 'drama_mazhai',
        episodeId: 'drama_mazhai_ep02',
        positionSec: 0,
        durationSec: 45,
      },
      factoryOptions(),
    );

    assert.equal(playbackEventSchema.safeParse(event).success, true);
    assert.equal(event.type, 'playback_started');
    assert.equal(event.dramaId, 'drama_mazhai');
    assert.equal(event.episodeId, 'drama_mazhai_ep02');
    assert.equal(event.durationSec, 45);
  });

  it('stamps occurredAt from the injected clock, not the wall clock', () => {
    const clock = new FakeClock();
    clock.set('2026-11-16T12:34:56.000Z');

    const event = createPlaybackEvent(
      { type: 'playback_paused', dramaId: 'd', episodeId: 'e', positionSec: 5, durationSec: 30 },
      factoryOptions(clock),
    );

    assert.equal(event.occurredAt, '2026-11-16T12:34:56.000Z');
  });

  it('gives every event a distinct id', () => {
    const options = factoryOptions();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(
        createPlaybackEvent(
          {
            type: 'playback_progress',
            dramaId: 'd',
            episodeId: 'e',
            positionSec: i,
            durationSec: 60,
          },
          options,
        ).eventId,
      );
    }
    assert.equal(ids.size, 50);
  });

  it('clamps a position reported past the end of the media', () => {
    // ExoPlayer reports currentTime slightly past duration at the end of a
    // stream. Left alone it produces completion percentages above 100%.
    const event = createPlaybackEvent(
      {
        type: 'playback_completed',
        dramaId: 'd',
        episodeId: 'e',
        positionSec: 45.87,
        durationSec: 45,
      },
      factoryOptions(),
    );

    assert.equal(event.positionSec, 45);
  });

  it('clamps a negative position to zero', () => {
    const event = createPlaybackEvent(
      { type: 'playback_progress', dramaId: 'd', episodeId: 'e', positionSec: -3, durationSec: 30 },
      factoryOptions(),
    );

    assert.equal(event.positionSec, 0);
  });

  it('treats a non-finite position as zero rather than emitting NaN', () => {
    const event = createPlaybackEvent(
      {
        type: 'playback_progress',
        dramaId: 'd',
        episodeId: 'e',
        positionSec: Number.NaN,
        durationSec: 30,
      },
      factoryOptions(),
    );

    assert.equal(event.positionSec, 0);
    assert.equal(playbackEventSchema.safeParse(event).success, true);
  });

  it('nulls a duration the player has not resolved yet', () => {
    // The contract requires a positive duration or null. Zero is what
    // expo-video reports before metadata loads, and persisting it would make
    // every completion calculation divide by zero.
    const event = createPlaybackEvent(
      { type: 'playback_started', dramaId: 'd', episodeId: 'e', positionSec: 0, durationSec: 0 },
      factoryOptions(),
    );

    assert.equal(event.durationSec, null);
    assert.equal(playbackEventSchema.safeParse(event).success, true);
  });

  it('attaches an error code only to playback_failed', () => {
    const failed = createPlaybackEvent(
      {
        type: 'playback_failed',
        dramaId: 'd',
        episodeId: 'e',
        positionSec: 12,
        durationSec: 30,
        errorCode: 'network',
      },
      factoryOptions(),
    );
    const progress = createPlaybackEvent(
      {
        type: 'playback_progress',
        dramaId: 'd',
        episodeId: 'e',
        positionSec: 12,
        durationSec: 30,
        errorCode: 'network',
      },
      factoryOptions(),
    );

    assert.equal(failed.errorCode, 'network');
    assert.equal(progress.errorCode, null);
  });

  it('defaults a failure with no classification to unknown', () => {
    const event = createPlaybackEvent(
      { type: 'playback_failed', dramaId: 'd', episodeId: 'e', positionSec: 1, durationSec: 30 },
      factoryOptions(),
    );

    assert.equal(event.errorCode, 'unknown');
  });

  it('carries no device or personal identifiers', () => {
    const event = createPlaybackEvent(
      { type: 'playback_started', dramaId: 'd', episodeId: 'e', positionSec: 0, durationSec: 30 },
      factoryOptions(),
    );

    // The context is an allow-list, and this asserts the list has not grown.
    assert.deepEqual(Object.keys(event.context).sort(), ['appVersion', 'platform']);
  });

  it('rejects an event that cannot satisfy the contract', () => {
    assert.throws(() =>
      createPlaybackEvent(
        { type: 'playback_started', dramaId: '', episodeId: 'e', positionSec: 0, durationSec: 30 },
        factoryOptions(),
      ),
    );
  });
});

describe('classifyPlaybackError', () => {
  it('maps player messages to stable codes', () => {
    assert.equal(classifyPlaybackError('Source error: connection timed out'), 'network');
    assert.equal(classifyPlaybackError('MediaCodec decode failure'), 'decode');
    assert.equal(classifyPlaybackError('HTTP 403 Forbidden'), 'ticket_expired');
    assert.equal(classifyPlaybackError('Response code: 404 not found'), 'source_unavailable');
    assert.equal(classifyPlaybackError('something unusual'), 'unknown');
    assert.equal(classifyPlaybackError(null), 'unknown');
  });

  it('never returns the original message', () => {
    // A player message can embed the failing URL, which for a signed
    // playback URL would put a token into telemetry.
    const message = 'Source error: failed to load https://cdn.example/ep01.m3u8?token=SECRET123';
    const code = classifyPlaybackError(message);

    assert.equal(code, 'source_unavailable');
    assert.equal(code.includes('SECRET123'), false);
    assert.equal(code.includes('cdn.example'), false);
  });

  it('falls back to unknown rather than guessing', () => {
    // An unrecognised message must not be forced into a bucket it does not
    // belong in — a wrong classification is worse than no classification,
    // because it will be counted in someone's error breakdown.
    assert.equal(classifyPlaybackError('Failed to load https://cdn.example/a.m3u8'), 'unknown');
  });
});

describe('ProgressHeartbeat', () => {
  it('does not emit on the first tick of an episode', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);

    assert.equal(heartbeat.shouldEmit('ep1', 0), false);
  });

  it('emits once the interval has elapsed', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);

    heartbeat.shouldEmit('ep1', 0);

    clock.advanceSeconds(PROGRESS_HEARTBEAT_SECONDS - 1);
    assert.equal(heartbeat.shouldEmit('ep1', 14), false);

    clock.advanceSeconds(2);
    assert.equal(heartbeat.shouldEmit('ep1', 16), true);
  });

  it('throttles a two-per-second tick rate down to the heartbeat interval', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);
    heartbeat.shouldEmit('ep1', 0);

    let emitted = 0;
    // Five minutes of playback at the player's real 0.5s tick interval.
    for (let tick = 1; tick <= 600; tick += 1) {
      clock.advance(500);
      if (heartbeat.shouldEmit('ep1', tick * 0.5)) emitted += 1;
    }

    // 300 seconds / 15 = 20. Not 600.
    assert.equal(emitted, 20);
  });

  it('emits on a seek even when the interval has not elapsed', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);
    heartbeat.shouldEmit('ep1', 0);

    clock.advanceSeconds(1);
    // Jumped 40s in one second of wall time: a seek, not playback.
    assert.equal(heartbeat.shouldEmit('ep1', 40), true);
  });

  it('restarts its clock when the episode changes', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);

    heartbeat.shouldEmit('ep1', 0);
    clock.advanceSeconds(60);

    // A new episode would otherwise emit immediately, duplicating the
    // playback_started event that accompanies the change.
    assert.equal(heartbeat.shouldEmit('ep2', 0), false);

    clock.advanceSeconds(PROGRESS_HEARTBEAT_SECONDS + 1);
    assert.equal(heartbeat.shouldEmit('ep2', 16), true);
  });

  it('starts clean after a reset', () => {
    const clock = new FakeClock();
    const heartbeat = new ProgressHeartbeat(clock);
    heartbeat.shouldEmit('ep1', 0);
    clock.advanceSeconds(60);
    heartbeat.reset();

    assert.equal(heartbeat.shouldEmit('ep1', 0), false);
  });
});
