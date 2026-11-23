import type { SqliteDriver } from './driver';

/**
 * The local database schema, and its migrations.
 *
 * SCOPE. This is the *mobile app's* durable local store. It is not a copy of
 * the server's PostgreSQL schema and must never become one: it holds exactly
 * two things, an outbox of events waiting to be delivered and the viewer's
 * own watch progress. Everything else the app shows is server state and
 * belongs in TanStack Query's cache, not here (SYSTEM_ARCHITECTURE.md §4).
 *
 * NOTHING SECRET LIVES HERE. No tokens, no playback URLs, no credentials.
 * A rooted device can read this file; it must contain nothing that matters if
 * it does (CLAUDE.md §11).
 *
 * MIGRATIONS use SQLite's own `user_version` pragma rather than a table of
 * applied migrations. It is a single integer in the database header, it is
 * updated inside the same transaction as the DDL, and it cannot drift from
 * the schema it describes. A migrations table would be a second source of
 * truth for the same fact.
 */

export const SCHEMA_VERSION = 2;

/** Status values for an outbox row. Mirrors `OutboxStatus` in the repository. */
export const OUTBOX_STATUS = {
  /** Waiting to be sent, subject to `next_attempt_at`. */
  pending: 'pending',
  /** Claimed by a sync run that has not yet reported back. */
  inFlight: 'in_flight',
  /** Retries exhausted. Kept for inspection, never sent again. */
  dead: 'dead',
} as const;

const MIGRATION_1 = `
  -- ── Outbox ──────────────────────────────────────────────────────────
  -- One row per playback event awaiting delivery. The row IS the unit of
  -- idempotency: event_id is the primary key, so re-inserting an event that
  -- is already queued is a no-op rather than a duplicate.
  CREATE TABLE IF NOT EXISTS playback_event_outbox (
    event_id        TEXT PRIMARY KEY NOT NULL,
    session_id      TEXT NOT NULL,
    drama_id        TEXT NOT NULL,
    episode_id      TEXT NOT NULL,
    type            TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    position_sec    REAL NOT NULL,
    duration_sec    REAL,
    -- The full wire body, already validated against the contract. Stored
    -- whole so that a schema change on the client cannot silently reshape
    -- events that were queued by an older build and are still undelivered.
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    -- Backoff gate. A row is eligible when next_attempt_at <= now.
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    last_attempt_at TEXT
  );

  -- The dispatch query filters on status and the backoff gate, and orders by
  -- creation. Without this index that is a full scan on every sync tick.
  CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
    ON playback_event_outbox (status, next_attempt_at, created_at);

  -- ── Watch progress ──────────────────────────────────────────────────
  -- Per-episode position. Mirrors the server's WatchHistory
  -- (DATABASE_SCHEMA.md §3) closely enough to be reconciled in M2.3.
  CREATE TABLE IF NOT EXISTS watch_progress (
    episode_id     TEXT PRIMARY KEY NOT NULL,
    drama_id       TEXT NOT NULL,
    episode_number INTEGER NOT NULL,
    position_sec   REAL NOT NULL,
    duration_sec   REAL NOT NULL,
    is_completed   INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_watch_progress_drama
    ON watch_progress (drama_id);

  -- ── Continue Watching ───────────────────────────────────────────────
  -- Per-drama head. The server equivalent is DramaProgress, and it exists
  -- for the same reason there: Continue Watching must not scan every
  -- watch_progress row a viewer owns to find where they were (HIST-04).
  CREATE TABLE IF NOT EXISTS drama_progress (
    drama_id        TEXT PRIMARY KEY NOT NULL,
    episode_id      TEXT NOT NULL,
    episode_number  INTEGER NOT NULL,
    position_sec    REAL NOT NULL,
    duration_sec    REAL NOT NULL,
    is_completed    INTEGER NOT NULL DEFAULT 0,
    last_watched_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_drama_progress_recent
    ON drama_progress (is_completed, last_watched_at DESC);
`;

const MIGRATION_2 = `
  -- ── Durable server sync for progress (M2.4) ─────────────────────────
  -- Progress is written locally and pushed to the server best-effort. If
  -- that push failed — offline, app killed, request lost — nothing retried
  -- it, so the server stayed behind until the drama was played again. This
  -- flag is the record that a row still owes the server a write.
  --
  -- WHY A FLAG AND NOT A QUEUE. One row per episode already holds the
  -- *latest* position, so a backlog is bounded by episodes watched rather
  -- than by ticks elapsed. Queueing each 5-second position instead would
  -- accumulate writes that are obsolete before they are delivered, which is
  -- exactly why progress does not go in the event outbox.
  --
  -- Existing rows default to 1: on upgrade we cannot know whether they were
  -- ever delivered, and re-sending is harmless. Both sides take the maximum
  -- position and completion is sticky, so a replay cannot rewind anyone.
  ALTER TABLE watch_progress ADD COLUMN pending_sync INTEGER NOT NULL DEFAULT 1;

  -- The flush query selects only dirty rows, oldest first.
  CREATE INDEX IF NOT EXISTS idx_watch_progress_pending
    ON watch_progress (pending_sync, updated_at);
`;

/** Ordered. Index 0 migrates from user_version 0 to 1, and so on. */
const MIGRATIONS: readonly string[] = [MIGRATION_1, MIGRATION_2];

interface UserVersionRow {
  user_version: number;
}

/**
 * Brings the database up to `SCHEMA_VERSION`.
 *
 * Safe to call on every launch and safe to call concurrently with itself:
 * each step runs inside a transaction that also bumps `user_version`, so a
 * second caller either sees the new version and does nothing, or blocks on
 * the write lock and then sees it.
 *
 * Forward-only. There is no `down` path, deliberately — a downgrade on a
 * user's device is not a situation that can be recovered by running SQL
 * backwards, and pretending otherwise invites someone to try.
 */
export async function migrate(driver: SqliteDriver): Promise<number> {
  // WAL keeps a reader (the UI hydrating progress) from blocking the writer
  // (the player flushing position). Both happen constantly in this app.
  await driver.execute('PRAGMA journal_mode = WAL;');
  // Enforced per-connection in SQLite, and off by default.
  await driver.execute('PRAGMA foreign_keys = ON;');

  const row = await driver.get<UserVersionRow>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;

  if (current >= SCHEMA_VERSION) return current;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    await driver.transaction(async () => {
      await driver.execute(sql);
      // `user_version` cannot be parameterised — it is a pragma, not a
      // statement. The value is a loop counter, never external input.
      await driver.execute(`PRAGMA user_version = ${version + 1};`);
    });
  }

  return SCHEMA_VERSION;
}

/**
 * Drops everything. Test support, the developer reset action, and account
 * deletion.
 *
 * STILL NOT A TROUBLESHOOTING STEP: losing a viewer's undelivered events is
 * data loss, so this is reached only through `PlaybackService.purge()`, which
 * documents the single product reason for calling it. M2.6 (D8) added that
 * caller — after a deletion these rows describe what somebody watched on an
 * account that no longer exists, and the server will refuse them forever.
 */
export async function dropAll(driver: SqliteDriver): Promise<void> {
  await driver.execute(`
    DROP TABLE IF EXISTS playback_event_outbox;
    DROP TABLE IF EXISTS watch_progress;
    DROP TABLE IF EXISTS drama_progress;
    PRAGMA user_version = 0;
  `);
}
