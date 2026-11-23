import process from 'node:process';
import { assertIsTestDatabase, prepareTestDatabase, TEST_DATABASE } from './test-database.js';

/**
 * Test harness.
 *
 * The database URL is pinned to the test schema BEFORE anything imports the
 * application, because `config/env.ts` reads `process.env` at module load and
 * `services/prisma.ts` builds its pool from it. Importing the app first and
 * repointing it afterwards would connect to the developer's database.
 *
 * TEST FILES RUN SERIALLY (`--test-concurrency=1` in the test script). Node
 * runs each file in its own process by default, and several processes
 * truncating the same schema between cases produce failures that depend on
 * which one got there first. One schema, one file at a time. Per-file schemas
 * would allow parallelism and are the upgrade if the suite ever gets slow.
 */
const testUrl = await prepareTestDatabase();
assertIsTestDatabase(testUrl);
process.env['DATABASE_URL'] = testUrl;
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';
process.env['DEV_AUTH_ENABLED'] = 'true';
process.env['DEV_AUTH_TOKEN'] = 'test-token-not-a-secret';
process.env['DEV_AUTH_USER_ID'] = 'user_test_harness';

import type { Server } from 'node:http';

const { createApp } = await import('../../src/app.js');
const { registerIdentityProvider } = await import('../../src/bootstrap/identity.js');
const { prisma } = await import('../../src/services/prisma.js');

registerIdentityProvider();

/*
 * Ask Postgres which database it actually connected to.
 *
 * The static URL check happens before the connection; this one happens after,
 * and is the check that would have caught the `?schema=` mistake — the URL
 * looked isolated, the connection was not. Any future change to the adapter
 * or the connection string is caught here rather than by a developer noticing
 * their catalogue is empty.
 */
{
  const [row] = await prisma.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `;
  if (row?.current_database !== TEST_DATABASE) {
    throw new Error(
      `Refusing to run: connected to "${row?.current_database}", expected "${TEST_DATABASE}". ` +
        'The tests truncate tables and must never touch the development database.',
    );
  }
}

export const DEV_TOKEN = 'test-token-not-a-secret';
export const TEST_USER_ID = 'user_test_harness';
export { prisma };

const app = createApp();

/**
 * Starts the app on an ephemeral port and returns a base URL.
 *
 * Port 0 so parallel runs cannot collide, and a real socket rather than a
 * fake request object so the middleware pipeline — helmet, CORS, the body
 * parser, the error handler — is genuinely exercised.
 */
let server: Server | null = null;
let baseUrl = '';

export async function startTestServer(): Promise<string> {
  if (baseUrl) return baseUrl;
  const { createServer } = await import('node:http');
  server = createServer(app);

  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not bind a test port');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    baseUrl = '';
  }
  await prisma.$disconnect();
}

export interface ApiResponse<T> {
  status: number;
  body: { success: true; data: T } | { success: false; error: { code: string; message: string } };
}

/** A request against the running test server. */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
    /** Extra request headers — `Idempotency-Key` for the deletion receipt. */
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const url = `${await startTestServer()}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  Object.assign(headers, options.headers ?? {});

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const body = (await response.json().catch(() => null)) as ApiResponse<T>['body'];
  return { status: response.status, body };
}

/** Unwraps a successful envelope, or fails loudly with the server's reason. */
export function dataOf<T>(response: ApiResponse<T>): T {
  if (!response.body || response.body.success !== true) {
    const reason =
      response.body && response.body.success === false
        ? `${response.body.error.code}: ${response.body.error.message}`
        : 'no body';
    throw new Error(`expected success, got ${response.status} (${reason})`);
  }
  return response.body.data;
}

/**
 * Empties the test schema.
 *
 * Order matters: children before parents, because the foreign keys are real.
 * `deleteMany` rather than TRUNCATE so the migrations' constraints are the
 * thing being respected rather than bypassed.
 */
export async function resetTestData(): Promise<void> {
  // No foreign key to `User` (it is the record that a user ceased to exist),
  // so nothing cascades it away and it has to be cleared explicitly.
  await prisma.accountDeletion.deleteMany();
  await prisma.playbackEvent.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.dramaProgress.deleteMany();
  await prisma.watchHistory.deleteMany();
  await prisma.subtitle.deleteMany();
  await prisma.episode.deleteMany();
  await prisma.season.deleteMany();
  await prisma.dramaTranslation.deleteMany();
  await prisma.dramaCategory.deleteMany();
  await prisma.drama.deleteMany();
  await prisma.userProfile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.category.deleteMany();
  await prisma.language.deleteMany();
}

export { TEST_DATABASE };
