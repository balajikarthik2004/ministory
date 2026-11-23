import process from 'node:process';
import { env } from '../src/config/env.js';
import { prisma } from '../src/services/prisma.js';
import { reconcileDeletions } from '../src/modules/auth/deletion.reconcile.js';

/**
 * Account-deletion reconciliation (M2.6 §6, R3).
 *
 *   pnpm --filter @minidrama/backend reconcile:deletions -- --dry-run
 *   pnpm --filter @minidrama/backend reconcile:deletions
 *   pnpm --filter @minidrama/backend reconcile:deletions -- --prune
 *
 * WHAT IT REPAIRS. Deletion commits everything personal in one transaction,
 * then de-links `PlaybackEvent` rows outside it because that is the only
 * unbounded part. A process killed mid-sweep leaves events carrying a deleted
 * user's id and an `AccountDeletion` row stuck at `IN_PROGRESS`. This finds
 * both of those and the harder case — a row claiming `COMPLETED` that still
 * has events — and finishes the job.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: events belonging to a `DELETED` user
 * with no deletion record. Those are guests retired by `mergeGuestInto`
 * (ADR-41), whose events were re-pointed at the account the person actually
 * owns. The command names them and stops; nulling them would destroy
 * attribution the merge was careful to keep.
 *
 * EXIT CODE 1 when anything is left unrepaired, so this is usable as a health
 * check the day there is somewhere to run it from.
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const prune = process.argv.includes('--prune');

  const header = [
    'Account deletion reconciliation',
    `  database        ${maskDatabaseUrl(env.DATABASE_URL)}`,
    `  mode            ${dryRun ? 'dry run (nothing will be changed)' : 'repair'}`,
    `  prune           ${prune && !dryRun ? 'yes' : 'no'}`,
  ];

  if (prune && !dryRun) {
    header.push(
      `  receipt TTL     ${env.AUTH_DELETION_RECEIPT_TTL_DAYS} days`,
      `  audit retention ${env.ACCOUNT_DELETION_AUDIT_RETENTION_DAYS} days`,
    );
  }

  process.stdout.write(`\n${header.join('\n')}\n\n`);

  const report = await reconcileDeletions({ dryRun, prune });

  const lines = [
    `  unfinished sweeps          ${report.unfinished}`,
    `  COMPLETED but with residue ${report.lyingCompleted}`,
    `  repaired this run          ${report.repaired.length}`,
    `  events de-linked           ${report.repaired.reduce((n, r) => n + r.anonymised, 0)}`,
    `  still failing              ${report.stillFailing}`,
  ];

  if (prune && !dryRun) {
    lines.push(
      `  receipts pruned            ${report.receiptsPruned}`,
      `  audit rows pruned          ${report.auditRowsPruned}`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n\n`);

  for (const row of report.repaired) {
    process.stdout.write(
      `  repaired ${row.userId}  ${row.previousStatus} -> ${row.status}  ` +
        `(${row.anonymised} event(s))\n`,
    );
  }
  if (report.repaired.length > 0) process.stdout.write('\n');

  if (report.orphans.length > 0) {
    process.stdout.write(
      [
        'Reported, NOT modified — deleted users with no deletion record:',
        '  These are guest accounts retired by a merge (ADR-41). Their events',
        '  were deliberately re-pointed at the registered account. Nulling them',
        '  would destroy that attribution, so this command leaves them alone.',
        '',
        ...report.orphans.map((row) => `    ${row.userId}  ${row.events} event(s)`),
        '',
        '',
      ].join('\n'),
    );
  }

  if (report.dryRun) {
    process.stdout.write('Dry run: nothing was changed.\n\n');
    return;
  }

  if (report.stillFailing > 0) {
    process.exitCode = 1;
    process.stderr.write(
      `${report.stillFailing} deletion(s) could not be reconciled. Rerun; the sweep is idempotent.\n\n`,
    );
    return;
  }

  process.stdout.write('Nothing outstanding.\n\n');
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
    process.stderr.write(`Reconciliation failed: ${String(error)}\n`);
    await prisma.$disconnect();
  });
