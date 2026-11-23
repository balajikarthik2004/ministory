import path from 'node:path';
import process from 'node:process';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Prisma 7 removed `url` from the datasource block in schema.prisma. The
 * migration and introspection commands read the connection string from here;
 * the running application gets it from src/services/prisma.ts via the driver
 * adapter. Both read the same DATABASE_URL, so there is still one credential.
 *
 * This file is for the CLI only. Nothing in src/ imports it.
 */

/**
 * Prisma 7 no longer loads .env implicitly. Node's own loader is used rather
 * than adding a dotenv dependency — Node 20.12+ ships `loadEnvFile`.
 *
 * Absent file is not an error: in CI and production the variables come from
 * the environment, and there is no .env to read.
 */
try {
  process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
  // No .env — DATABASE_URL is expected to be set in the environment already.
}

const databaseUrl = process.env['DATABASE_URL'];

if (!databaseUrl) {
  // Thrown rather than defaulted: a migration against a silently chosen
  // database is how a developer's test data ends up somewhere it should not.
  throw new Error(
    'DATABASE_URL is not set. Copy apps/backend/.env.example to .env, or export it, ' +
      'then start the database with `docker compose up -d` from the repository root.',
  );
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),

  datasource: {
    url: databaseUrl,
  },

  migrations: {
    path: path.join('prisma', 'migrations'),
    // Run by `prisma migrate reset` and `prisma db seed`.
    seed: 'tsx prisma/seed.ts',
  },
});
