import { z } from 'zod';

/**
 * Environment validation.
 *
 * The process refuses to start on a missing or malformed variable rather than
 * failing at the first request that needs it (SYSTEM_ARCHITECTURE.md §11).
 * A config error at boot is a five-second fix; the same error at 2am under load
 * is an incident.
 *
 * No secret has a default. Defaults exist only for values that are genuinely
 * environment-shaped, never for credentials.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Comma-separated allowed origins for the admin dashboard.
   * The mobile app does not send an Origin header, so it is unaffected.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  /**
   * DATABASE_URL is intentionally optional in Milestone 1.1: the database
   * arrives in M1.3. It becomes required the moment Prisma is wired in.
   */
  DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Written directly to stderr: the logger itself depends on this config.
    process.stderr.write(
      `\nInvalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.\n\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
