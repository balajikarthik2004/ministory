import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Structural verification of a migrated database.
 *
 *   tsx scripts/verify-schema.ts                  verify a migrated database
 *   tsx scripts/verify-schema.ts --expect-empty   assert nothing is there yet
 *
 * Run by the `migrations` CI job AFTER `prisma migrate deploy` has applied
 * every committed migration to an empty database. It answers one question:
 * does the database the migrations produced actually contain the structures
 * the schema declares?
 *
 * `--expect-empty` is the same job's FIRST step, before any migration runs.
 * It exists because of how this verification fails silently if it is ever
 * pointed at a database that already has the tables: `migrate deploy` would
 * report "No pending migrations", every later check would pass, and the job
 * would go green having verified nothing at all. A green run that tested
 * nothing is worse than a red one.
 *
 * WHY THIS EXISTS ALONGSIDE `prisma migrate diff`.
 *
 * The CI job already runs `migrate diff --exit-code`, which is the stronger
 * and more authoritative check: it fails if the migrations do not reproduce
 * `schema.prisma`. This script is not a replacement for it. It exists because
 * `migrate diff` answers "does the database match the model?" in Prisma's
 * terms and prints a Prisma-shaped diff, whereas a migration failure in
 * practice is investigated in Postgres' terms — a missing table, an enum with
 * the wrong labels, an index that silently never got created. This prints
 * exactly that, from `information_schema` and `pg_catalog`, which is the
 * vocabulary the person debugging at 2am is already using.
 *
 * It is also the check that survives a Prisma major version. `migrate diff`
 * is a CLI contract that has changed shape before.
 *
 * EXPECTATIONS ARE DERIVED, NEVER HAND-LISTED. Every model and enum below is
 * read out of `prisma/schema.prisma` at run time. A hand-maintained list of
 * table names is a list that goes stale on the first migration nobody
 * remembers to update it for, and a stale allow-list that passes is worse
 * than no check at all.
 *
 * READ-ONLY. This script issues SELECTs and nothing else. It never creates,
 * alters or drops anything, and it is safe to point at any database — though
 * CI points it only at its own ephemeral container.
 */

// ─────────────────────────── Schema parsing ───────────────────────────

interface ParsedSchema {
  /** Model names. With no `@@map` in this schema, these are the table names. */
  models: string[];
  /** Enum name → its declared labels, in declaration order. */
  enums: Map<string, string[]>;
  /** How many `@@index` declarations the schema makes. */
  indexDeclarations: number;
  /** How many `@@unique` declarations the schema makes. */
  uniqueDeclarations: number;
}

/**
 * Reads the declarations out of schema.prisma.
 *
 * A regex rather than a Prisma parser dependency: the shapes being matched
 * are `model X {` and `enum Y {` at the start of a line, which is a fixed
 * part of the Prisma grammar and not something a formatter rearranges. If
 * this project ever gains `@@map`, the mapping has to be read here too — the
 * assertion below about that is deliberate and will fail loudly rather than
 * silently check the wrong name.
 */
function parseSchema(schemaPath: string): ParsedSchema {
  const source = readFileSync(schemaPath, 'utf8');

  // Strip comments so a commented-out model is not counted as declared.
  const code = source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  if (/@@map\s*\(/.test(code) || /@map\s*\(/.test(code)) {
    throw new Error(
      'schema.prisma now uses @map/@@map, so a model name is no longer its table name. ' +
        'verify-schema.ts must be taught to read the mapping before it can be trusted again.',
    );
  }

  const models = [...code.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);

  const enums = new Map<string, string[]>();
  for (const match of code.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const name = match[1]!;
    const labels = match[2]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^\w+$/.test(line));
    enums.set(name, labels);
  }

  return {
    models,
    enums,
    indexDeclarations: [...code.matchAll(/@@index\s*\(/g)].length,
    uniqueDeclarations: [...code.matchAll(/@@unique\s*\(/g)].length,
  };
}

// ───────────────────────────── Reporting ─────────────────────────────

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    process.stdout.write(`  ok    ${message}\n`);
  } else {
    process.stdout.write(`  FAIL  ${message}\n`);
    failures.push(message);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

// ────────────────────────────── Main ──────────────────────────────

async function main(): Promise<void> {
  /*
   * DATABASE_URL is read straight from the environment rather than through
   * src/config/env.ts. That module validates the whole application config and
   * exits on a missing AUTH_JWT_SECRET — correct for the API, wrong here. The
   * migration job has no business holding a signing key to count tables.
   */
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  const expectEmpty = process.argv.includes('--expect-empty');

  const backendRoot = path.resolve(import.meta.dirname, '..');
  const schema = parseSchema(path.join(backendRoot, 'prisma', 'schema.prisma'));

  /*
   * `pg` is a declared dependency of `@prisma/adapter-pg` (ADR-17), which the
   * backend depends on directly. Same import style as
   * tests/support/test-database.ts, for the same reason: it is the driver the
   * application already talks to Postgres through.
   */
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // ── --expect-empty ──────────────────────────────────────────────
    if (expectEmpty) {
      const target =
        (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0]
          ?.current_database ?? '(unknown)';

      const existing = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );

      if (existing.rowCount && existing.rowCount > 0) {
        process.stderr.write(
          `\nRefusing to verify migrations against "${target}": the public schema already ` +
            `holds ${existing.rowCount} table(s).\n\n` +
            existing.rows.map((row) => `  - ${row.table_name}`).join('\n') +
            '\n\nMigration verification is only meaningful from a completely empty database.\n' +
            'Against a populated one, `migrate deploy` reports "No pending migrations" and\n' +
            'every subsequent check passes without having tested anything.\n\n' +
            'NOTHING WAS DROPPED. This script never writes. Point it at a fresh database.\n\n',
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`Database "${target}" is empty. Safe to verify migrations against.\n`);
      return;
    }

    const database =
      (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0]
        ?.current_database ?? '(unknown)';
    process.stdout.write(`Verifying database "${database}"\n`);
    process.stdout.write(
      `Schema declares ${schema.models.length} models, ${schema.enums.size} enums, ` +
        `${schema.indexDeclarations} @@index, ${schema.uniqueDeclarations} @@unique\n`,
    );

    // ── Migrations ──────────────────────────────────────────────────
    section('Migrations');

    const migrations = await client.query<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
      applied_steps_count: number;
    }>(
      `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
         FROM _prisma_migrations
        ORDER BY started_at`,
    );

    check(
      migrations.rowCount !== null && migrations.rowCount > 0,
      'at least one migration applied',
    );

    for (const row of migrations.rows) {
      check(
        row.finished_at !== null && row.rolled_back_at === null,
        `migration ${row.migration_name} applied cleanly`,
      );
    }

    // ── Tables ──────────────────────────────────────────────────────
    section('Tables');

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tableNames = new Set(tables.rows.map((row) => row.table_name));

    for (const model of schema.models) {
      check(tableNames.has(model), `table "${model}" exists`);
    }

    /*
     * The reverse direction. A table in the database that no model declares
     * means a migration created something the schema does not know about —
     * which is drift in the direction `migrate diff` is best at catching, but
     * worth naming here because the name of the orphan table is the useful
     * part. `_prisma_migrations` is Prisma's own bookkeeping and is expected.
     */
    const declared = new Set(schema.models);
    const orphans = [...tableNames].filter(
      (name) => !declared.has(name) && name !== '_prisma_migrations',
    );
    check(orphans.length === 0, `no undeclared tables (found: ${orphans.join(', ') || 'none'})`);

    // ── Enums ───────────────────────────────────────────────────────
    section('Enums');

    const enumRows = await client.query<{ enum_name: string; labels: string[] }>(
      /*
       * `::text` IS LOADS-BEARING. `pg_enum.enumlabel` is of Postgres type
       * `name`, and `array_agg` over it yields `name[]` — for which node-pg
       * has no array parser, so the driver hands back the raw literal
       * "{ACTIVE,SUSPENDED,...}" as a string instead of an array. The cast
       * makes it `text[]`, which pg does parse. Without it this check throws
       * `actualLabels.filter is not a function` on the first enum.
       */
      `SELECT t.typname AS enum_name,
              array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname`,
    );
    const actualEnums = new Map(enumRows.rows.map((row) => [row.enum_name, row.labels]));

    for (const [name, expectedLabels] of schema.enums) {
      const actualLabels = actualEnums.get(name);
      if (!actualLabels) {
        check(false, `enum "${name}" exists`);
        continue;
      }
      /*
       * Set comparison, not array comparison. Postgres preserves the order
       * labels were added in, and `ALTER TYPE ... ADD VALUE` can append out
       * of declaration order without that being wrong. Membership is what
       * the application depends on.
       */
      const missing = expectedLabels.filter((label) => !actualLabels.includes(label));
      const extra = actualLabels.filter((label) => !expectedLabels.includes(label));
      check(
        missing.length === 0 && extra.length === 0,
        `enum "${name}" has exactly its ${expectedLabels.length} declared labels` +
          (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '') +
          (extra.length > 0 ? ` (unexpected: ${extra.join(', ')})` : ''),
      );
    }

    // ── Constraints ─────────────────────────────────────────────────
    section('Constraints');

    const constraints = await client.query<{ constraint_type: string; count: string }>(
      `SELECT tc.constraint_type, count(*)::text AS count
         FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
        GROUP BY tc.constraint_type`,
    );
    const counts = new Map(constraints.rows.map((row) => [row.constraint_type, Number(row.count)]));

    const primaryKeys = counts.get('PRIMARY KEY') ?? 0;
    const foreignKeys = counts.get('FOREIGN KEY') ?? 0;

    /*
     * UNIQUENESS IS COUNTED AS INDEXES, NOT AS CONSTRAINTS, and that is not a
     * detail — the first version of this check looked in
     * `information_schema.table_constraints` for `UNIQUE` and found zero,
     * against migrations that are entirely correct.
     *
     * Prisma does not emit `ADD CONSTRAINT ... UNIQUE`. Every `@unique` and
     * `@@unique` becomes a `CREATE UNIQUE INDEX` (20 of them across the four
     * committed migrations, and no unique constraints at all). Postgres treats
     * the two as different objects, and only the constraint form appears in
     * `table_constraints`.
     *
     * `NOT indisprimary` excludes the unique index backing each primary key,
     * which is already counted above.
     */
    const uniqueIndexes = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND i.indisunique
          AND NOT i.indisprimary`,
    );
    const uniques = Number(uniqueIndexes.rows[0]?.count ?? 0);

    process.stdout.write(
      `  ${primaryKeys} primary keys, ${foreignKeys} foreign keys, ${uniques} unique indexes\n`,
    );

    /*
     * Every model gets a primary key, and `_prisma_migrations` has one too.
     * An exact equality rather than a floor: a model that somehow arrived
     * without a primary key is a serious problem and this is the only check
     * that would notice.
     */
    check(
      primaryKeys === schema.models.length + 1,
      `every table has a primary key (${primaryKeys} of ${schema.models.length + 1})`,
    );

    /*
     * Floors, not exact counts, for the rest. Field-level `@unique` and every
     * relation field also produce objects, so the schema's `@@unique` and
     * `@@index` counts are a lower bound rather than a total. The check that
     * matters is that the relational structure is present at all — a
     * migration run that produced tables but no foreign keys is the failure
     * mode worth catching, and it is not a hypothetical: it is what a
     * partially-applied migration looks like.
     */
    check(foreignKeys > 0, 'foreign keys exist');
    check(
      uniques >= schema.uniqueDeclarations,
      `at least the ${schema.uniqueDeclarations} declared @@unique indexes exist (${uniques})`,
    );

    // ── Indexes ─────────────────────────────────────────────────────
    section('Indexes');

    const indexes = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexCount = Number(indexes.rows[0]?.count ?? 0);

    process.stdout.write(`  ${indexCount} indexes in schema "public"\n`);
    check(
      indexCount >= schema.indexDeclarations,
      `at least the ${schema.indexDeclarations} declared @@index indexes exist (${indexCount})`,
    );

    // ── Result ──────────────────────────────────────────────────────
    section('Result');

    if (failures.length > 0) {
      process.stdout.write(`${failures.length} check(s) failed:\n`);
      for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
      process.stdout.write(
        '\nThe migrations did not produce the structures schema.prisma declares.\n' +
          'See docs/MIGRATIONS.md §5 before changing anything — historical\n' +
          'migrations are immutable and are not the thing to edit.\n',
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write('All structural checks passed.\n');
  } finally {
    await client.end();
  }
}

await main();
