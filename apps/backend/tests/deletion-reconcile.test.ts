import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSession, RegisterResponse } from '@minidrama/contracts';
import { apiRequest, dataOf, prisma, resetTestData, stopTestServer } from './support/harness.js';
import { createDrama, episodeId, seedReferenceData } from './support/factories.js';

/**
 * Deletion reconciliation — M2.6 §6 (R3).
 *
 * WHAT THESE TESTS ARE ACTUALLY ABOUT. Deletion commits everything personal
 * in one transaction and de-links `PlaybackEvent` rows outside it, because
 * that is the only unbounded part of the work. The question this file answers
 * is what happens when the process dies between those two steps — which is
 * not a hypothetical, it is a deploy landing at the wrong moment.
 *
 * The interrupted state is produced by calling the REPOSITORY'S transaction
 * directly and never running the sweep, which is exactly what a process
 * killed after `COMMIT` leaves behind. Driving it over HTTP could not produce
 * it, because the HTTP path always runs the sweep.
 */

const { deleteAccount: deleteAccountTx, anonymisePlaybackEvents } =
  await import('../src/modules/auth/deletion.repository.js');
const { reconcileDeletions } = await import('../src/modules/auth/deletion.reconcile.js');
const { AccountDeletionSource } = await import('../src/generated/prisma/enums.js');
const { MemoryMailProvider, setMailProvider } = await import('../src/services/mail.js');

const mail = new MemoryMailProvider();
const PASSWORD = 'a-perfectly-fine-password';

async function signedInUser(email: string): Promise<AuthSession> {
  dataOf(
    await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: { email, password: PASSWORD },
    }),
  );
  return dataOf(
    await apiRequest<AuthSession>('/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    }),
  );
}

async function seedEvents(userId: string, count: number, prefix: string): Promise<void> {
  await prisma.playbackEvent.createMany({
    data: Array.from({ length: count }, (_unused, index) => ({
      eventId: `evt-${prefix}-${index}`,
      sessionId: `ps_${prefix}`,
      userId,
      dramaId: 'drama_rec',
      episodeId: episodeId('drama_rec', 1),
      type: 'playback_progress' as const,
      positionSec: index,
      durationSec: 60,
      occurredAt: new Date(),
      platform: 'android',
      appVersion: '0.1.0-test',
    })),
  });
}

/** TX1 only — the state a process killed immediately after COMMIT leaves. */
async function deleteWithoutSweep(userId: string): Promise<void> {
  await deleteAccountTx({
    userId,
    source: AccountDeletionSource.IN_APP,
    receiptHash: null,
    receiptTtlDays: 30,
  });
}

before(async () => {
  setMailProvider(mail);
  await resetTestData();
  await seedReferenceData();
  await createDrama({ id: 'drama_rec', episodes: 2, freeEpisodes: 2 });
});

beforeEach(async () => {
  await prisma.accountDeletion.deleteMany();
  await prisma.playbackEvent.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.dramaProgress.deleteMany();
  await prisma.watchHistory.deleteMany();
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();
  mail.clear();
});

after(async () => {
  await stopTestServer();
});

describe('reconciling an interrupted deletion', () => {
  it('finishes a sweep that never ran', async () => {
    const session = await signedInUser('interrupted@test.local');
    await seedEvents(session.user.id, 12, 'interrupted');

    await deleteWithoutSweep(session.user.id);

    // The state a crash leaves: account gone, events still pointing at it.
    const before = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(before.playbackStatus, 'PENDING');
    assert.equal(await prisma.playbackEvent.count({ where: { userId: session.user.id } }), 12);

    const report = await reconcileDeletions();

    assert.equal(report.unfinished, 1);
    assert.equal(report.repaired.length, 1);
    assert.equal(report.repaired[0]?.anonymised, 12);
    assert.equal(report.stillFailing, 0);

    assert.equal(await prisma.playbackEvent.count({ where: { userId: session.user.id } }), 0);
    assert.equal(
      await prisma.playbackEvent.count({ where: { sessionId: 'ps_interrupted' } }),
      12,
      'de-linked, not deleted',
    );

    const after_ = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(after_.playbackStatus, 'COMPLETED');
    assert.equal(after_.playbackAnonymised, 12);
    assert.equal(after_.playbackAttempts, 1);
  });

  it('is idempotent — a second run finds nothing to do', async () => {
    const session = await signedInUser('twice@test.local');
    await seedEvents(session.user.id, 5, 'twice');
    await deleteWithoutSweep(session.user.id);

    await reconcileDeletions();
    const second = await reconcileDeletions();

    assert.equal(second.unfinished, 0);
    assert.equal(second.lyingCompleted, 0);
    assert.equal(second.repaired.length, 0);
    assert.equal(second.stillFailing, 0);
  });

  /**
   * A STATUS THAT LIES IS WORSE THAN ONE THAT IS BEHIND. `COMPLETED` is what
   * tells an operator there is nothing left to do, so the reconciler verifies
   * it against the events rather than trusting a flag that may have been
   * written by a process killed a moment later.
   */
  it('repairs a row that claims COMPLETED but still has events', async () => {
    const session = await signedInUser('liar@test.local');
    await deleteWithoutSweep(session.user.id);
    await anonymisePlaybackEvents(session.user.id);

    // Events arrive (or survived) after the row was marked done.
    await seedEvents(session.user.id, 4, 'liar');

    const report = await reconcileDeletions();

    assert.equal(report.unfinished, 0, 'the row claims to be finished');
    assert.equal(report.lyingCompleted, 1, 'but it is not');
    assert.equal(report.repaired[0]?.anonymised, 4);
    assert.equal(await prisma.playbackEvent.count({ where: { userId: session.user.id } }), 0);
  });

  it('recovers a sweep recorded as FAILED', async () => {
    const session = await signedInUser('failed@test.local');
    await seedEvents(session.user.id, 7, 'failed');
    await deleteWithoutSweep(session.user.id);

    // A sweep that ran and threw: status FAILED, an error code, and one
    // attempt already on the counter — which is what makes the assertion
    // below about the retry being counted mean anything.
    await prisma.accountDeletion.update({
      where: { userId: session.user.id },
      data: {
        playbackStatus: 'FAILED',
        playbackErrorCode: 'PLAYBACK_SWEEP_FAILED',
        playbackAttempts: 1,
        playbackStartedAt: new Date(),
        playbackFinishedAt: new Date(),
      },
    });

    const report = await reconcileDeletions();

    assert.equal(report.repaired[0]?.previousStatus, 'FAILED');
    assert.equal(report.stillFailing, 0);

    const after_ = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(after_.playbackStatus, 'COMPLETED');
    assert.equal(after_.playbackErrorCode, null, 'a recovered row must not keep its error');
    assert.equal(after_.playbackAttempts, 2, 'the retry is counted');
  });

  it('changes nothing on a dry run', async () => {
    const session = await signedInUser('dryrun@test.local');
    await seedEvents(session.user.id, 6, 'dryrun');
    await deleteWithoutSweep(session.user.id);

    const report = await reconcileDeletions({ dryRun: true });

    assert.equal(report.unfinished, 1, 'it still reports the work');
    assert.equal(report.repaired.length, 0, 'but does none of it');
    assert.equal(
      await prisma.playbackEvent.count({ where: { userId: session.user.id } }),
      6,
      'the events are untouched',
    );

    const audit = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(audit.playbackStatus, 'PENDING');
  });

  it('de-links in bounded batches', async () => {
    const session = await signedInUser('batched@test.local');
    await seedEvents(session.user.id, 10, 'batched');
    await deleteWithoutSweep(session.user.id);

    const result = await anonymisePlaybackEvents(session.user.id, { batchSize: 3 });

    assert.equal(result.anonymised, 10);
    assert.ok(result.batches >= 4, `expected several batches, got ${result.batches}`);
    assert.equal(await prisma.playbackEvent.count({ where: { userId: session.user.id } }), 0);
  });
});

describe('merged guests are reported, never touched', () => {
  /**
   * `mergeGuestInto` retires a guest with `status = 'DELETED'` and no
   * `AccountDeletion` row, and deliberately re-points its events at the
   * account the person actually owns (ADR-41). An event that lands from the
   * outbox afterwards still carries the guest's id.
   *
   * Nulling it would destroy attribution the merge was careful to preserve,
   * so the reconciler names it and stops. This test is the guard on that
   * restraint: a future "tidy up all DELETED users" change fails here.
   */
  it('leaves a retired guest’s straggler events alone', async () => {
    const guest = dataOf(
      await apiRequest<AuthSession>('/auth/guest', {
        method: 'POST',
        body: { deviceId: 'device-reconcile-merge', platform: 'android' },
      }),
    );
    const guestId = guest.user.id;

    await signedInUser('owner@test.local');
    dataOf(
      await apiRequest('/auth/merge', {
        method: 'POST',
        token: guest.accessToken,
        body: { email: 'owner@test.local', password: PASSWORD },
      }),
    );

    const retired = await prisma.user.findUniqueOrThrow({ where: { id: guestId } });
    assert.equal(retired.status, 'DELETED');
    assert.equal(
      await prisma.accountDeletion.count({ where: { userId: guestId } }),
      0,
      'a merge is not a deletion and writes no audit row',
    );

    // The straggler ADR-41 describes.
    await seedEvents(guestId, 3, 'straggler');

    const report = await reconcileDeletions();

    assert.equal(report.orphans.length, 1);
    assert.equal(report.orphans[0]?.userId, guestId);
    assert.equal(report.orphans[0]?.events, 3);

    assert.equal(
      await prisma.playbackEvent.count({ where: { userId: guestId } }),
      3,
      'reported, not nulled',
    );
  });
});

describe('pruning', () => {
  it('nulls receipts past their expiry and keeps live ones', async () => {
    const stale = await signedInUser('stale@test.local');
    const fresh = await signedInUser('fresh@test.local');

    await deleteWithoutSweep(stale.user.id);
    await deleteWithoutSweep(fresh.user.id);

    const past = new Date(Date.now() - 60_000);
    await prisma.accountDeletion.update({
      where: { userId: stale.user.id },
      data: { receiptHash: 'a'.repeat(64), receiptExpiresAt: past },
    });
    await prisma.accountDeletion.update({
      where: { userId: fresh.user.id },
      data: {
        receiptHash: 'b'.repeat(64),
        receiptExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const report = await reconcileDeletions({ prune: true });
    assert.equal(report.receiptsPruned, 1);

    const staleRow = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: stale.user.id },
    });
    const freshRow = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: fresh.user.id },
    });

    assert.equal(staleRow.receiptHash, null);
    assert.equal(staleRow.receiptExpiresAt, null);
    assert.equal(freshRow.receiptHash, 'b'.repeat(64), 'a live receipt must survive');
  });

  it('removes audit rows past the retention period and keeps recent ones', async () => {
    const old = await signedInUser('old@test.local');
    const recent = await signedInUser('recent@test.local');

    await deleteWithoutSweep(old.user.id);
    await deleteWithoutSweep(recent.user.id);

    await prisma.accountDeletion.update({
      where: { userId: old.user.id },
      // Three years back, against a 730-day default.
      data: { requestedAt: new Date(Date.now() - 3 * 365 * 86_400_000) },
    });

    const report = await reconcileDeletions({ prune: true });

    assert.equal(report.auditRowsPruned, 1);
    assert.equal(await prisma.accountDeletion.count({ where: { userId: old.user.id } }), 0);
    assert.equal(await prisma.accountDeletion.count({ where: { userId: recent.user.id } }), 1);
  });

  it('prunes nothing unless asked', async () => {
    const session = await signedInUser('nopruneplease@test.local');
    await deleteWithoutSweep(session.user.id);
    await prisma.accountDeletion.update({
      where: { userId: session.user.id },
      data: {
        receiptHash: 'c'.repeat(64),
        receiptExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const report = await reconcileDeletions();

    assert.equal(report.receiptsPruned, 0);
    assert.equal(report.auditRowsPruned, 0);
    const row = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: session.user.id },
    });
    assert.equal(row.receiptHash, 'c'.repeat(64));
  });
});
