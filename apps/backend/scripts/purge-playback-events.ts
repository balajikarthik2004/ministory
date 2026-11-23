import process from 'node:process';
import { env } from '../src/config/env.js';
import { prisma } from '../src/services/prisma.js';
import {
  cutoffFor,
  purgeExpiredPlaybackEvents,
} from '../src/modules/playback/playback.retention.js';

/**
 * Manually invoked retention sweep.
 *
 *   pnpm --filter @minidrama/backend retention:events -- --dry-run
 *   pnpm --filter @minidrama/backend retention:events
 *
 * WHY A COMMAND AND NOT A SCHEDULER. CLAUDE.md §18 rules out paid
 * infrastructure for the MVP, and a cron container running once a day to
 * delete rows that do not yet exist is infrastructure we would be
 * maintaining for no benefit. The sweep is idempotent and takes arguments,
 * so when scheduling is wanted it becomes one line in whatever runs the
 * deployment — no code change.
 *
 * DRY RUN IS THE DEFAULT POSTURE, not the default flag: the command deletes
 * when asked and counts when asked, but it always prints the cutoff and the
 * eligible total first, so an operator sees what is about to go before it
 * goes.
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const retentionDays = env.PLAYBACK_EVENT_RETENTION_DAYS;
  const cutoff = cutoffFor(retentionDays);

  const [total, eligible] = await Promise.all([
    prisma.playbackEvent.count(),
    prisma.playbackEvent.count({ where: { receivedAt: { lt: cutoff } } }),
  ]);

  process.stdout.write(
    [
      '',
      'Playback event retention',
      `  database      ${maskDatabaseUrl(env.DATABASE_URL)}`,
      `  retention     ${retentionDays} days`,
      `  cutoff        ${cutoff.toISOString()}  (older than this is eligible)`,
      `  total rows    ${total}`,
      `  eligible      ${eligible}`,
      '',
    ].join('\n'),
  );

  if (dryRun) {
    process.stdout.write('Dry run: nothing deleted.\n\n');
    return;
  }

  if (eligible === 0) {
    process.stdout.write('Nothing to delete.\n\n');
    return;
  }

  const result = await purgeExpiredPlaybackEvents({ retentionDays });

  process.stdout.write(
    [
      `Deleted ${result.deleted} event(s) in ${result.batches} batch(es).`,
      result.reachedLimit
        ? 'Stopped at the per-run ceiling — rerun to continue; the sweep is idempotent.'
        : 'Sweep complete.',
      '',
      '',
    ].join('\n'),
  );
}

/** Never print credentials, even to a local terminal (CLAUDE.md §11). */
function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`Retention sweep failed: ${String(error)}\n`);
    await prisma.$disconnect();
  });
