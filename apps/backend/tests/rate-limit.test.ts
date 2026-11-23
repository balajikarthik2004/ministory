import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  apiRequest,
  dataOf,
  DEV_TOKEN,
  resetTestData,
  startTestServer,
  stopTestServer,
} from './support/harness.js';
import {
  createDrama,
  createTestUser,
  episodeId,
  playbackEvent,
  seedReferenceData,
} from './support/factories.js';

/**
 * Rate limiting on playback event ingestion.
 *
 * THE RISK BEING TESTED IS NOT "does it refuse". It is that a limit set to
 * stop an abusive client also stops a legitimate one: a device returning
 * from an outage drains a real backlog, and refusing that would be a
 * self-inflicted outage for the viewer. Both halves are asserted here.
 */

const DRAMA = 'drama_ratelimit';

describe('RateLimiter', () => {
  it('permits exactly `max` requests in a window, then refuses', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3 });

    const verdicts = [0, 1, 2, 3, 4].map((index) => limiter.hit('k', 1_000 + index).allowed);

    assert.deepEqual(verdicts, [true, true, true, false, false]);
  });

  it('starts a fresh allowance once the window rolls over', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 1_000, max: 2 });

    assert.equal(limiter.hit('k', 0).allowed, true);
    assert.equal(limiter.hit('k', 0).allowed, true);
    assert.equal(limiter.hit('k', 0).allowed, false);

    // One millisecond past the window boundary.
    assert.equal(limiter.hit('k', 1_001).allowed, true);
  });

  it('counts each key separately, so one caller cannot spend another’s', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });

    assert.equal(limiter.hit('user:a', 0).allowed, true);
    assert.equal(limiter.hit('user:a', 0).allowed, false);
    // b is untouched by a exhausting its allowance.
    assert.equal(limiter.hit('user:b', 0).allowed, true);
  });

  it('reports a retry delay that never rounds down to zero', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });

    limiter.hit('k', 0);
    const refused = limiter.hit('k', 59_900);

    assert.equal(refused.allowed, false);
    // 100ms remain; a `Retry-After: 0` would invite an immediate retry.
    assert.equal(refused.retryAfterSec, 1);
  });

  it('bounds its memory rather than tracking keys forever', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 60_000, max: 10, maxKeys: 5 });

    for (let index = 0; index < 50; index += 1) limiter.hit(`key-${index}`, 0);

    assert.ok(limiter.size <= 5, `expected the map to stay bounded, held ${limiter.size}`);
  });

  it('drops expired windows on prune', async () => {
    const { RateLimiter } = await import('../src/middleware/rate-limit.js');
    const limiter = new RateLimiter({ windowMs: 1_000, max: 10 });

    limiter.hit('a', 0);
    limiter.hit('b', 0);
    assert.equal(limiter.size, 2);

    limiter.prune(2_000);
    assert.equal(limiter.size, 0);
  });
});

describe('POST /playback/events under rate limiting', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetTestData();
    await seedReferenceData();
    await createTestUser();
    await createDrama({ id: DRAMA, episodes: 5, freeEpisodes: 5 });
  });

  it('accepts a realistic offline backlog without throttling it', async () => {
    /*
     * The scenario the limit must not break: a device reconnects and drains
     * its outbox. Twelve full batches is far more than an hour of playback
     * generates, and the configured allowance is 120 requests per minute —
     * so this must pass cleanly or the limit is mis-sized.
     */
    const batches = 12;
    const perBatch = 20;

    for (let batch = 0; batch < batches; batch += 1) {
      const events = Array.from({ length: perBatch }, (_, index) =>
        playbackEvent({
          eventId: `evt-backlog-${batch}-${index}`,
          dramaId: DRAMA,
          episodeId: episodeId(DRAMA, 1),
          type: 'playback_progress',
          positionSec: index,
        }),
      );

      const response = await apiRequest<{ acceptedEventIds: string[] }>('/playback/events', {
        method: 'POST',
        token: DEV_TOKEN,
        body: { events },
      });

      assert.equal(response.status, 202, `batch ${batch} was refused`);
      assert.equal(dataOf(response).acceptedEventIds.length, perBatch);
    }

    const { prisma } = await import('./support/harness.js');
    assert.equal(await prisma.playbackEvent.count(), batches * perBatch);
  });

  it('refuses with RATE_LIMITED, which the client retries rather than discards', async () => {
    const { rateLimit } = await import('../src/middleware/rate-limit.js');

    /*
     * Exercised against the middleware directly with a max of one, because
     * driving the real endpoint past 120 requests would make the suite slow
     * to assert something the unit tests above already cover. What matters
     * here is the *shape* of the refusal.
     */
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });

    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
    } as unknown as Parameters<typeof middleware>[1];
    const req = { ip: '203.0.113.5' } as unknown as Parameters<typeof middleware>[0];

    let firstError: unknown = 'untouched';
    middleware(req, res, (error?: unknown) => {
      firstError = error;
    });
    assert.equal(firstError, undefined, 'the first request passes through');

    let secondError: unknown = null;
    middleware(req, res, (error?: unknown) => {
      secondError = error;
    });

    const { AppError } = await import('../src/utils/app-error.js');
    assert.ok(secondError instanceof AppError);
    assert.equal(secondError.code, 'RATE_LIMITED');
    // 429, not 4xx-other: HttpPlaybackSyncAdapter treats 429 as a transport
    // failure and retries. Any other 4xx marks the batch dead and loses it.
    assert.equal(secondError.status, 429);
    assert.equal(headers.get('Retry-After'), '60');
  });

  it('never reveals other callers in a refusal', async () => {
    const { rateLimit } = await import('../src/middleware/rate-limit.js');
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const res = { setHeader() {} } as unknown as Parameters<typeof middleware>[1];
    const req = { ip: '203.0.113.9' } as unknown as Parameters<typeof middleware>[0];

    middleware(req, res, () => {});
    let refusal: unknown = null;
    middleware(req, res, (error?: unknown) => {
      refusal = error;
    });

    const message = (refusal as Error).message;
    assert.ok(!message.includes('203.0.113.9'), 'the message must not echo the key');
    assert.match(message, /retry/i);
  });
});
