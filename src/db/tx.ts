// The serialisation point of a facilitation (spec 5.6).
//
// Every state change and every send of one facilitation runs under ONE lock:
// a Postgres advisory lock on the facilitation id, held on a dedicated
// connection for the whole unit of work, including the channel call of a send.
// A contribution that arrives meanwhile waits, so a reminder computed before
// the last vote is never sent after it.
//
// The lock is session-level on purpose: a unit of work spans several
// transactions (change, then send, then mark sent) and must not let another
// replica in between them. An in-process queue in front of it keeps waiters
// from each holding a pool connection while they wait.

import type { PoolClientLike, PoolLike, Queryable } from './pool.js';

/** Namespace of the engine's advisory locks (second key of the two-int form
 *  is not used; the 64-bit key is derived from the id). */
const LOCK_SEED = 2043;

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

/** Run `fn` holding the facilitation's lock. `fn` gets the locked connection. */
export async function withFacilitationLock<T>(
  pool: PoolLike,
  facilitationId: string,
  fn: (client: PoolClientLike) => Promise<T>,
): Promise<T> {
  return serialised(facilitationId, async () => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, $2))', [facilitationId, LOCK_SEED]);
      try {
        return await fn(client);
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [facilitationId, LOCK_SEED]);
        } catch {
          // A connection that cannot unlock is discarded: closing the session
          // releases the lock, returning it to the pool would leak it.
          broken = true;
        }
      }
    } finally {
      client.release(broken);
    }
  });
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
 *  facilitation (creating one, leasing jobs, retention). */
export async function poolTransaction<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await inTransaction(client, fn);
  } finally {
    client.release();
  }
}
