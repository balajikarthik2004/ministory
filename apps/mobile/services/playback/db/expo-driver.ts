import * as SQLite from 'expo-sqlite';
import type { SqliteDriver, SqlValue } from './driver';

/**
 * `expo-sqlite` behind the driver interface.
 *
 * Intentionally thin. Every statement this app runs lives in the
 * repositories, which are tested against `node:sqlite`; the only thing that
 * could be wrong here is the plumbing, and there is deliberately very little
 * of it.
 *
 * Not unit tested — it needs a React Native runtime. It is covered by the
 * on-device run instead.
 */

export const DATABASE_NAME = 'minidrama-playback.db';

export async function openExpoSqliteDriver(
  databaseName: string = DATABASE_NAME,
): Promise<SqliteDriver> {
  const db = await SQLite.openDatabaseAsync(databaseName);
  return new ExpoSqliteDriver(db);
}

class ExpoSqliteDriver implements SqliteDriver {
  /**
   * Serialises transactions.
   *
   * `expo-sqlite` runs on one connection and SQLite has no nested
   * transactions, so two overlapping `withTransactionAsync` calls produce
   * "cannot start a transaction within a transaction". Chaining them onto a
   * tail promise keeps the connection's transactions strictly sequential.
   *
   * The player flushing progress while the sync engine drains the outbox is
   * exactly that overlap, and it happens on every session.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SQLite.SQLiteDatabase) {}

  async execute(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.db.runAsync(sql, params as SqlValue[]);
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as SqlValue[]);
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params as SqlValue[]);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // `withTransactionAsync` resolves with void, so the task's result is
    // captured by closure and returned afterwards.
    const run = async (): Promise<T> => {
      let result: T;
      let assigned = false;
      await this.db.withTransactionAsync(async () => {
        result = await fn();
        assigned = true;
      });
      if (!assigned) {
        // Unreachable in practice: `withTransactionAsync` rethrows whatever
        // the task threw, so a non-assignment means it resolved without
        // running the task, which would be a library bug worth surfacing.
        throw new Error('transaction completed without running its task');
      }
      return result!;
    };

    // `.then(run, run)` rather than `.then(run)`: a previous transaction that
    // rejected must not prevent the next one from running.
    const next = this.tail.then(run, run);
    // The tail itself must never hold a rejection, or every later caller
    // inherits it.
    this.tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}
