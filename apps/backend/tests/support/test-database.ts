import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

/**
 * An isolated database for the test suite.
 *
 * NEVER THE DEVELOPER'S DATABASE. The tests truncate tables between cases, so
 * pointing them anywhere else destroys whatever a developer was looking at.
 *
 * A SEPARATE DATABASE, NOT A SCHEMA — and that distinction cost real data.
 * The first version of this file appended `?schema=minidrama_test` to the
 * development connection string, which is how Prisma isolates when it drives
 * Postgres through its own query engine. This project uses the **driver
 * adapter** (`@prisma/adapter-pg`, ADR-17), and the adapter passes the
 * connection string to `pg`, which does not understand `?schema=`. Every
 * "isolated" statement ran against `public`, and the suite emptied the
 * development database on its first full run.
 *
 * A separate database has no such subtlety: `pg` connects to whatever is
 * named in the path, and there is no parameter to be silently ignored.
 *
 * Two further guards, because the failure above was silent:
 *   - `assertIsTestDatabase` refuses any URL whose database is not exactly
 *     `minidrama_test`.
 *   - The harness asks Postgres `SELECT current_database()` after connecting
 *     and refuses to run if the answer is wrong. That check would have caught
 *     the original bug on the first run instead of after it.
 */

export const TEST_DATABASE = 'minidrama_test';

/**
 * Loads `apps/backend/.env`, because the test runner is plain Node and does
 * not read it the way `tsx` does for `prisma.config.ts`.
 */
function loadLocalEnv(): void {
  if (process.env['DATABASE_URL']) return;
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '..', '..', '.env'));
  } catch {
    // Nothing to load; the check below produces the actionable message.
  }
}

function developmentUrl(): URL {
  loadLocalEnv();
  const base = process.env['DATABASE_URL'];
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set. Start the database with `docker compose up -d` ' +
        'and copy apps/backend/.env.example to .env.',
    );
  }
  return new URL(base);
}

/** The test connection string: same server, same credentials, other database. */
export function testDatabaseUrl(): string {
  const url = developmentUrl();
  url.pathname = `/${TEST_DATABASE}`;
  // `?schema=` is meaningless to the driver adapter and was the source of the
  // original mistake. Removed so it cannot imply an isolation it never gave.
  url.searchParams.delete('schema');
  const result = url.toString();
  assertIsTestDatabase(result);
  return result;
}

/**
 * Refuses anything that is not unmistakably the test database.
 *
 * Exported so the harness can re-check after Postgres has answered, not only
 * before it is asked.
 */
export function assertIsTestDatabase(connectionString: string): void {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (name !== TEST_DATABASE) {
    throw new Error(
      `Refusing to run destructive tests against database "${name}". ` +
        `Only "${TEST_DATABASE}" is allowed.`,
    );
  }
}

/**
 * Creates the test database if it does not exist, then applies the committed
 * migrations to it.
 *
 * `CREATE DATABASE` cannot run inside a transaction and cannot be
 * parameterised, so it is issued against the server's default `postgres`
 * database with a hard-coded identifier — never an interpolated one.
 *
 * `migrate deploy`, not `migrate dev`: deploy only applies what is already in
 * `prisma/migrations` and never authors one from schema drift. A test run must
 * not be able to write a migration. It also means the suite proves the
 * committed migrations apply cleanly to an empty database.
 */
export async function prepareTestDatabase(): Promise<string> {
  const url = testDatabaseUrl();
  await ensureDatabaseExists();

  const backendRoot = path.resolve(import.meta.dirname, '..', '..');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  return url;
}

async function ensureDatabaseExists(): Promise<void> {
  const { Client } = await import('pg');

  const admin = developmentUrl();
  admin.pathname = '/postgres';
  admin.searchParams.delete('schema');

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DATABASE,
    ]);
    if (existing.rowCount === 0) {
      // Identifier is the module constant, never input.
      await client.query(`CREATE DATABASE "${TEST_DATABASE}"`);
    }
  } finally {
    await client.end();
  }
}
