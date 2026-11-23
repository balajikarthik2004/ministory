import { DatabaseSync } from 'node:sqlite';
import type { SqliteDriver, SqlValue } from '../../services/playback/db/driver';

/**
 * The driver interface over Node's built-in SQLite.
 *
 * This is what makes the playback tests worth running. The repositories'
 * statements — `ON CONFLICT DO NOTHING`, the backoff gate, the monotonic
 * progress rule, `PRAGMA user_version` migrations — are executed by a real
 * SQLite engine, not by a hand-written fake that was written to agree with
 * the implementation. A fake would pass while the SQL was wrong.
 *
 * `node:sqlite` ships with Node 22+, so this costs no dependency.
 *
 * The real driver is async because `expo-sqlite` is; this one is synchronous
 * underneath and simply returns resolved promises. That difference is itself
 * useful: code that accidentally depends on async interleaving behaves
 * differently here and in the app, so the repositories are written not to.
 */
export class NodeSqliteDriver implements SqliteDriver {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
  }

  async execute(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as SqlValue[]));
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...(params as SqlValue[]));
    return (row as T | undefined) ?? null;
  }

  /**
   * SQLite has no nested transactions, and the repositories call each other
   * (`enqueueMany` → `enqueue`). Rather than forbidding that, the inner call
   * joins the outer transaction: only the outermost `BEGIN`/`COMMIT` is
   * real. This matches what the device driver's serialising tail achieves.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return await fn();
      } finally {
        this.depth -= 1;
      }
    }

    this.depth = 1;
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * A clock the test drives.
 *
 * Backoff windows are minutes long. Asserting on them against the real clock
 * would mean either sleeping or asserting nothing.
 */
export class FakeClock {
  constructor(private current = Date.parse('2026-11-16T10:00:00.000Z')) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  set(iso: string): void {
    this.current = Date.parse(iso);
  }
}

/** Deterministic, sequential event ids. */
export class SequentialIds {
  private next = 0;

  constructor(private readonly prefix = 'evt') {}

  newId(): string {
    this.next += 1;
    return `${this.prefix}-${String(this.next).padStart(6, '0')}`;
  }
}

/** A `random()` that always returns the midpoint, so jitter is predictable. */
export const fixedRandom = (): number => 0.5;
