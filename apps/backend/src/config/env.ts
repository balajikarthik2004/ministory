import { z } from 'zod';
import { loadDotEnv } from './dotenv.js';

// Before anything reads process.env. Import order matters here: env.ts is the
// first module the rest of the application pulls in.
loadDotEnv();

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
  /** `silent` is a real pino level and is what the test suite uses — a run
   *  that prints a request log per assertion buries the failures. */
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

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
   * Required since Milestone 1.3, when Prisma was wired in. The API cannot
   * serve a single catalogue request without it, so booting and failing later
   * only moves the error somewhere less obvious.
   *
   * Validated for shape, never for reachability — that is what /ready is for.
   * The value is a credential: it is never logged and never returned in an
   * error response (CLAUDE.md §11).
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required since M1.3')
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'DATABASE_URL must be a postgresql:// connection string',
    ),

  /**
   * Maximum Postgres connections held by this instance's pool.
   *
   * Sized against the server's `max_connections` divided by the number of
   * instances, not against expected traffic — every instance holds its own
   * pool, and the failure mode is the database refusing connections for
   * everyone rather than this process slowing down.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Development identity (M2.3). Replaced by real authentication in M2.5.
   *
   * Off unless explicitly turned on, and refused outright in production by the
   * cross-field check below. The token has no default: an enabled provider
   * with no token resolves nobody, which fails closed.
   */
  DEV_AUTH_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value.trim().toLowerCase() === 'true'),
  DEV_AUTH_TOKEN: z.string().optional(),
  /** The seeded user the development token maps to (prisma/seed.ts). */
  DEV_AUTH_USER_ID: z.string().default('user_seed_test'),

  // ───────────────────────── Authentication (M2.5) ─────────────────────────

  /**
   * Signing key for access tokens. HS256.
   *
   * REQUIRED, WITH NO DEFAULT, IN EVERY ENVIRONMENT INCLUDING DEVELOPMENT.
   * A default here would be a published signing key: anyone who read the
   * repository could mint a token for any user id. The 32-character floor is
   * the HMAC-SHA256 block-size floor — a shorter key is simply a weaker one.
   *
   * It is deliberately required in development too. An ephemeral per-boot key
   * would invalidate every session on restart, which is exactly the behaviour
   * that makes "session restoration after app restart" (Phase 6) untestable.
   */
  AUTH_JWT_SECRET: z
    .string()
    .min(
      32,
      'AUTH_JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48',
    ),

  /**
   * Access-token lifetime.
   *
   * Fifteen minutes is the compromise ADR-07 settled on. Short enough that a
   * leaked token is a bounded problem, long enough that a viewer mid-episode
   * is not refreshing constantly. Revocation does not wait for it: a password
   * change moves `User.tokensValidFrom` forward and every token issued before
   * that instant stops verifying immediately.
   */
  AUTH_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),

  /**
   * Refresh-token lifetime. Sixty days, per ARCH §6.
   *
   * Long on purpose: a short-form drama app is opened in bursts, and forcing
   * a re-login on someone returning after six weeks loses the session that
   * holds their Continue Watching. Rotation on every use plus reuse detection
   * is what makes a long-lived refresh token defensible.
   */
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  /**
   * `iss` and `aud`, validated on every verification.
   *
   * The audience is what will keep a consumer token from ever authenticating
   * an admin route when the admin app arrives in M5 (ARCH §6). Separating the
   * audiences later, after tokens are in circulation, is a migration; setting
   * it now costs one string.
   */
  AUTH_TOKEN_ISSUER: z.string().min(1).default('minidrama-api'),
  AUTH_TOKEN_AUDIENCE: z.string().min(1).default('minidrama-mobile'),

  /** Password-reset link lifetime. Short: it is a bearer credential sitting
   *  in a mailbox. */
  AUTH_RESET_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(30),

  /** Email-verification link lifetime. Longer, because nothing is at risk
   *  while it waits and people check email on their own schedule. */
  AUTH_VERIFY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  /**
   * Credential-endpoint rate limits, per window.
   *
   * SIZED DIFFERENTLY FROM THE PLAYBACK LIMIT, and for the opposite reason.
   * The playback limiter is generous because honest clients legitimately send
   * bursts (ADR-34). Nobody legitimately attempts ten logins a minute, so
   * these are tight enough to make online password guessing worthless while
   * leaving room for a person who has genuinely forgotten which password
   * they used.
   */
  AUTH_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(900_000),
  AUTH_LOGIN_RATE_MAX: z.coerce.number().int().min(1).default(10),
  AUTH_REGISTER_RATE_MAX: z.coerce.number().int().min(1).default(5),
  AUTH_RECOVERY_RATE_MAX: z.coerce.number().int().min(1).default(5),
  /**
   * Allowance for the endpoints that carry a TOKEN rather than an email:
   * `reset-password` and `verify-email`.
   *
   * HIGHER THAN THE RECOVERY LIMIT, DELIBERATELY. Those two have no email in
   * the body, so the per-address half of the rate-limit key is empty and they
   * degrade to a per-IP limit — which on a shared-NAT mobile network means
   * one allowance shared by a neighbourhood (API_DOCUMENTATION.md §9). Five
   * would be hit by ordinary traffic.
   *
   * It can afford to be loose: the secret being presented is 256 bits of
   * CSPRNG output. A rate limit is not what makes guessing it infeasible, and
   * pretending otherwise would be security theatre at the cost of real users.
   * This bounds a flood, nothing more.
   */
  AUTH_TOKEN_RATE_MAX: z.coerce.number().int().min(1).default(30),

  /**
   * Guest-session creation, per install and then per source address.
   *
   * TWO LIMITS, BECAUSE ONE CANNOT DO BOTH JOBS. `POST /auth/guest` creates a
   * `User` row with no credential, so an unbounded endpoint is a way to fill
   * the users table — that is what the per-IP backstop is for. But keying it
   * ONLY on the address is the shared-NAT mistake again, and a worse version
   * of it: every new install behind one carrier NAT would be competing for
   * the same handful of first launches, and the failure is the app not
   * working at all on first open.
   *
   * The device id in the body is the right granularity for the first limit.
   * It is not a credential and it is trivially forgeable — which is exactly
   * why the second limit exists, since forging it is how you would try to
   * create rows in bulk.
   */
  AUTH_GUEST_RATE_MAX: z.coerce.number().int().min(1).default(5),
  AUTH_GUEST_IP_RATE_MAX: z.coerce.number().int().min(1).default(60),
  AUTH_REFRESH_RATE_MAX: z.coerce.number().int().min(1).default(60),

  /**
   * Allowance for AUTHENTICATED endpoints that re-verify the password:
   * `change-password` and `account` (deletion). Keyed on the user id.
   *
   * THIS CLOSES A REAL GAP (M2.6 D7). `change-password` shipped in M2.5 with
   * no limit at all, and it compares `currentPassword` — so anyone holding a
   * stolen access token had an unbounded oracle for the real password, with
   * none of the per-address limiting that protects `/auth/login`. Deletion
   * re-verifies the same way and would have added a second one.
   *
   * Keyed on the user id rather than the IP because the caller is already
   * authenticated: there is exactly one account at risk, it is known, and it
   * is the right thing to count against. The shared-NAT problem that shapes
   * every other key in this file does not apply.
   */
  AUTH_SENSITIVE_RATE_MAX: z.coerce.number().int().min(1).default(5),

  /**
   * How long a deletion receipt stays resolvable (M2.6 §7).
   *
   * A receipt answers "did the deletion I asked for actually happen?" after
   * the credential that would have asked has been destroyed. Thirty days is
   * far longer than any client needs — the lookup happens seconds later, or
   * on the next app launch — and bounds how long an unused secret's hash sits
   * in the table. `reconcile:deletions --prune` nulls them past this.
   */
  AUTH_DELETION_RECEIPT_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /**
   * How long an `AccountDeletion` audit row is kept.
   *
   * Two years, matching the `AdminAuditLog` figure in DATABASE_SCHEMA.md §6.
   * The row holds no direct identifier (see the model's comment), so this is
   * about not accumulating rows forever rather than about privacy exposure.
   */
  ACCOUNT_DELETION_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(730),

  // ──────────────────────────── Mail (M2.5) ────────────────────────────

  /**
   * How outbound mail leaves the process.
   *
   * `file` writes each message to `MAIL_OUTBOX_DIR` and is the approved
   * development delivery method (M2.5 Phase 1): password reset and email
   * verification are built and tested end to end, and the link is read from a
   * file rather than an inbox. No external account exists to send through.
   *
   * There is no `smtp` value yet. Adding one is a provider implementation
   * behind `MailProvider`, not a change to any flow that sends mail.
   */
  MAIL_PROVIDER: z.enum(['file']).default('file'),
  MAIL_OUTBOX_DIR: z.string().default('./.mail-outbox'),
  MAIL_FROM: z.string().default('MiniDrama <no-reply@minidrama.local>'),

  /**
   * Base for links inside emails.
   *
   * A deep link into the app by default, so a reset link opens the reset
   * screen rather than a website that does not exist. The web fallback that
   * Play requires for account deletion (AUTH-09) arrives with hosting.
   */
  AUTH_LINK_BASE_URL: z.string().default('minidrama://auth'),

  /**
   * Where client-visible asset URLs point.
   *
   * No real object storage exists yet (CLAUDE.md §19 — R2 is deferred), and
   * the seeded catalogue has no uploaded artwork. In development this is the
   * `minidrama-asset://` scheme the mobile app already resolves to bundled
   * placeholder images, so the device shows real posters against a live API.
   * M4's storage provider replaces the value with a CDN origin and nothing
   * above `resolveAssetUrl` changes.
   */
  ASSET_BASE_URL: z.string().default('minidrama-asset://'),

  /**
   * Cap on a playback-event batch, independent of the body-size limit.
   *
   * Two limits because they fail differently: the body cap stops a huge
   * payload reaching the parser at all, while this one stops a small payload
   * that expands into an expensive write. The contract allows 100; this is
   * the server's own ceiling and is checked against the parsed array.
   */
  PLAYBACK_EVENT_MAX_BATCH: z.coerce.number().int().min(1).max(500).default(100),

  /**
   * Rate limit for `POST /playback/events`, per caller per window.
   *
   * SIZED SO LEGITIMATE OFFLINE SYNC NEVER TRIPS IT. A device returning from
   * an outage drains its outbox in batches of `PLAYBACK_EVENT_MAX_BATCH`, so
   * 120 requests buys 12,000 events per minute from one viewer — far beyond
   * any real backlog, since an hour of continuous playback generates roughly
   * 240 heartbeats. The limit exists to bound an abusive or looping client,
   * not to shape honest traffic, and tripping it is recoverable anyway: 429
   * is retried by the sync adapter rather than treated as a rejection.
   */
  PLAYBACK_EVENT_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  PLAYBACK_EVENT_RATE_MAX: z.coerce.number().int().min(1).default(120),

  /**
   * How long raw playback events are kept.
   *
   * SYSTEM_ARCHITECTURE.md §8 and DATABASE_SCHEMA.md §6: 90 days. Raw events
   * are the highest-volume write path in the system (risk R-7) and become the
   * largest object in the database within a quarter if never trimmed. The
   * admin dashboard reads rollups, not these rows.
   */
  PLAYBACK_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  /*
   * PRODUCTION REFUSALS (M2.5 Phase 4).
   *
   * Each of these is a configuration that would start successfully and then
   * be wrong in a way nobody notices until it matters. Refusing at boot turns
   * every one of them into a five-second fix.
   *
   * WHAT IS DELIBERATELY *NOT* HERE: a file-based mail provider in production.
   * It is a real problem — a password reset written to a directory on the
   * server and read by nobody is worse than one that fails loudly — but it is
   * not a reason to refuse to serve a catalogue, a player and a watch history
   * that are all perfectly fine. The narrower answer is in
   * `services/mail.ts` and `auth.service.ts`: the endpoints that depend on
   * delivery refuse individually with 503, and the rest of the API runs.
   * Scope the refusal to the thing that is broken.
   */
  if (parsed.success && parsed.data.NODE_ENV === 'production') {
    const refusals: string[] = [];

    if (parsed.data.DEV_AUTH_ENABLED) {
      refusals.push(
        'DEV_AUTH_ENABLED is true. The development identity provider verifies no ' +
          'credential: anyone holding DEV_AUTH_TOKEN becomes the configured user.',
      );
    }

    if (refusals.length > 0) {
      process.stderr.write(
        [
          '',
          'Refusing to start in production:',
          '',
          ...refusals.map((r) => `  - ${r}`),
          '',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
  }

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
