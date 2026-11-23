import path from 'node:path';
import process from 'node:process';

/**
 * Loads apps/backend/.env into process.env, if it exists.
 *
 * Node's own loader (20.12+) rather than a dotenv dependency — one fewer
 * package for something the runtime already does.
 *
 * Call this before reading any environment variable. env.ts does so at import
 * time, which makes it the first thing that happens in the process.
 *
 * Real environment variables already set are NOT overwritten by the file, so a
 * container's configuration always wins over a stray .env left in an image.
 */
export function loadDotEnv(): void {
  // Production configuration comes from the orchestrator. Reading a file there
  // would mean a deployed secret could be shadowed by one baked into an image.
  if (process.env['NODE_ENV'] === 'production') return;

  try {
    process.loadEnvFile(path.join(import.meta.dirname, '..', '..', '.env'));
  } catch {
    // No .env file. Expected in CI, where variables come from the environment.
  }
}
