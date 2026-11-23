/**
 * The SQLite surface this app uses, as an interface.
 *
 * WHY NOT JUST CALL `expo-sqlite` DIRECTLY
 * ----------------------------------------
 * Everything interesting about the outbox — idempotent inserts, backoff gates,
 * the monotonic progress rule, recovery of rows left mid-flight by a crash —
 * is SQL. If that SQL can only run inside a React Native runtime then it can
 * only be verified on a device, by hand, which is how a queue ends up with a
 * bug that loses a viewer's watch history.
 *
 * So the repositories take a driver. On the device it is backed by
 * `expo-sqlite`; under test it is backed by Node's built-in `node:sqlite`.
 * Both are SQLite, so the tests exercise the *real* statements rather than a
 * hand-written fake that agrees with whatever the implementation does.
 *
 * The shape deliberately mirrors `expo-sqlite`'s async API, so the device
 * adapter is a thin pass-through and has almost nothing to get wrong.
 */

/** Values SQLite can bind. `null` is distinct from "not provided". */
export type SqlValue = string | number | null;

export interface SqliteDriver {
  /**
   * Runs one or more statements for their effect. Used for DDL and pragmas.
   * Not parameterised — never build one of these from user input.
   */
  execute(sql: string): Promise<void>;

  /** Runs a single parameterised statement for its effect. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;

  /** Returns every row. */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;

  /** Returns the first row, or null. */
  get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;

  /**
   * Runs `fn` inside a transaction, committing on resolve and rolling back on
   * throw.
   *
   * Transactions do not nest here. A caller already inside one must not open
   * another, and the repositories are written so that never happens: the
   * transaction boundary is always the outermost repository method.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * A clock, injected for the same reason the driver is.
 *
 * Backoff, staleness and retry windows are all time arithmetic. Testing them
 * against the real clock means either sleeping — which makes the suite slow
 * and flaky — or asserting nothing. A controllable clock makes "after eight
 * failed attempts, two hours apart" a test that runs in a millisecond.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
