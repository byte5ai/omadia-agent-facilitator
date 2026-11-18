// The serialisation point of a facilitation (spec 5.6), on a pool the engine
// shares with the kernel.
//
// Every state change and every send of one facilitation runs under ONE lock: a
// Postgres advisory lock on the facilitation id. The lock is session-level and
// stays held while a queued message goes to the channel, so a contribution
// that arrives meanwhile waits and a reminder computed before the last vote is
// never sent after it. No TRANSACTION is open during that call, and nothing
// but the channel send happens under the lock outside a transaction.
//
// The pool is not ours (the kernel's default is five connections), so:
//   - the engine holds at most `lockLimits.maxConnections` lock connections at
//     any time, however many facilitations are busy; the rest queue in memory
//     without a connection;
//   - code that runs under the lock uses the locked connection and never asks
//     the pool for a second one;
//   - a lock is taken with pg_try_advisory_lock and a deadline, never with a
//     blocking wait.

import type { PoolClientLike, PoolLike, Queryable } from './pool.js';

/** Namespace of the engine's advisory locks. */
const LOCK_SEED = 2043;

/** Bounds of the lock. Mutable so an operator-facing setting or a test can
 *  tighten them; the defaults sit well below a pool of five. */
export const lockLimits = {
  /** Connections the engine may hold for locked work at the same time. */
  maxConnections: 2,
  /** How long to wait for a facilitation's lock before giving up. */
  acquireTimeoutMs: 15_000,
  pollMs: 20,
};

export class LockTimeoutError extends Error {
  constructor(facilitationId: string, waitedMs: number) {
    super(`facilitation ${facilitationId}: its lock was not free within ${String(waitedMs)} ms`);
    this.name = 'LockTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One queue per facilitation keeps its work in order without a connection.
const queues = new Map<string, Promise<unknown>>();

async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  try {
    return await run;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}

// A counting semaphore over the lock connections of the whole engine.
let held = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (held >= lockLimits.maxConnections) await new Promise<void>((resolve) => waiting.push(resolve));
  else held += 1;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    // The slot passes straight to the next waiter.
    if (next) next();
    else held -= 1;
  }
}

/** Connections the engine holds for locked work right now. */
export const heldLockConnections = (): number => held;

/** Run `fn` holding the facilitation's lock. `fn` gets the locked connection
 *  and must use it for every query it makes. */
export async function withFacilitationLock<T>(
  pool: PoolLike,
  facilitationId: string,
  fn: (client: PoolClientLike) => Promise<T>,
): Promise<T> {
  return serialised(facilitationId, () =>
    withSlot(async () => {
      const client = await pool.connect();
      let broken = false;
      try {
        const started = Date.now();
        for (;;) {
          const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked', [facilitationId, LOCK_SEED]);
          if (got.rows[0]?.locked === true) break;
          if (Date.now() - started >= lockLimits.acquireTimeoutMs) throw new LockTimeoutError(facilitationId, Date.now() - started);
          await sleep(lockLimits.pollMs);
        }
        try {
          return await fn(client);
        } finally {
          try {
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [facilitationId, LOCK_SEED]);
          } catch {
            // A connection that cannot unlock is discarded: closing the
            // session releases the lock, returning it to the pool would leak it.
            broken = true;
          }
        }
      } finally {
        client.release(broken);
      }
    }),
  );
}

/** One atomic change on an already locked connection. */
export async function inTransaction<T>(client: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw err;
  }
}

/** A transaction on a fresh pool connection, for work outside any one
 *  facilitation (creating one). */
export async function poolTransaction<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await inTransaction(client, fn);
  } finally {
    client.release();
  }
}
