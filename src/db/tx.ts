// The serialisation point of a facilitation (spec 5.6), on a pool the engine
// shares with the kernel.
//
// Every state change and every send of one facilitation runs under ONE lock.
// It stays held while a queued message goes to the channel, so a contribution
// that arrives meanwhile waits and a reminder computed before the last vote is
// never sent after it. No TRANSACTION is open during that call, and nothing
// but the channel send happens under the lock outside a transaction.
//
// The lock is a ROW with a lease, not a session-level advisory lock. The
// engine does not own its connections: an instance may reach Postgres through
// a pooler in transaction mode, where each statement outside a transaction
// can run on a different server session. An advisory lock taken on one
// session and released on another is not released; it blocked a facilitation
// for minutes in production (1.0.5). A row means the same on every session:
//   - taking it is one statement (insert, or take over a lease that ran out);
//   - the holder renews the lease while it works and deletes the row when done;
//   - a holder that died is not waited for longer than one lease.
//
// The pool is not ours (the kernel's default is five connections), so:
//   - the engine holds at most `lockLimits.maxConnections` lock connections at
//     any time, however many facilitations are busy; the rest queue in memory
//     without a connection;
//   - code that runs under the lock uses the locked connection and never asks
//     the pool for a second one (the short lease renewal is the one exception);
//   - a lock is tried with a deadline, never with a blocking wait.

import { randomUUID } from 'node:crypto';

import type { PoolClientLike, PoolLike, Queryable } from './pool.js';

const LOCKS = 'plg_omadia_agent_facilitator_locks';

/** Bounds of the lock. Mutable so an operator-facing setting or a test can
 *  tighten them; the defaults sit well below a pool of five. */
export const lockLimits = {
  /** Connections the engine may hold for locked work at the same time. */
  maxConnections: 2,
  /** How long to wait for a facilitation's lock before giving up. */
  acquireTimeoutMs: 15_000,
  pollMs: 20,
  /** How long a lock stays taken without a sign of life from its holder.
   *  Longer than one channel send may take, shorter than anybody waits. */
  leaseMs: 30_000,
  /** How often the holder says that it is still there. */
  renewMs: 5_000,
};

/** What the lock tells an operator (the engine's log). */
export const lockLog: { write: (message: string) => void } = { write: () => undefined };

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

const ms = (n: number): string => `${String(Math.max(1, Math.round(n)))} milliseconds`;

/** One statement: take a free lock, or one whose holder's lease ran out. */
async function tryTake(q: Queryable, facilitationId: string, owner: string): Promise<boolean> {
  const taken = await q.query(
    `INSERT INTO ${LOCKS} (facilitation_id, owner, lease_until, acquired_at) VALUES ($1, $2, now() + $3::interval, now())
       ON CONFLICT (facilitation_id) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until, acquired_at = EXCLUDED.acquired_at
       WHERE ${LOCKS}.lease_until < now()
     RETURNING owner`,
    [facilitationId, owner, ms(lockLimits.leaseMs)],
  );
  return taken.rows.length > 0;
}

/** Run `fn` holding the facilitation's lock. `fn` gets a connection and must
 *  use it for every query it makes. */
export async function withFacilitationLock<T>(
  pool: PoolLike,
  facilitationId: string,
  fn: (client: PoolClientLike) => Promise<T>,
): Promise<T> {
  return serialised(facilitationId, () =>
    withSlot(async () => {
      const client = await pool.connect();
      const owner = randomUUID();
      try {
        const started = Date.now();
        for (;;) {
          if (await tryTake(client, facilitationId, owner)) break;
          if (Date.now() - started >= lockLimits.acquireTimeoutMs) throw new LockTimeoutError(facilitationId, Date.now() - started);
          await sleep(lockLimits.pollMs);
        }
        // The lease is renewed on the pool, not on `client`: that one may be
        // inside a transaction of `fn`, where a renewal would wait for the
        // commit and be undone by a rollback.
        let lost = false;
        const renewal = setInterval(() => {
          pool
            .query(`UPDATE ${LOCKS} SET lease_until = now() + $3::interval WHERE facilitation_id = $1 AND owner = $2`, [facilitationId, owner, ms(lockLimits.leaseMs)])
            .then((renewed) => {
              if (renewed.rowCount === 0 && !lost) {
                lost = true;
                lockLog.write(`facilitation ${facilitationId}: the lock was taken over while its work was still running (no renewal within a lease)`);
              }
            })
            .catch((err: unknown) => lockLog.write(`facilitation ${facilitationId}: the lock's lease could not be renewed: ${err instanceof Error ? err.message : String(err)}`));
        }, lockLimits.renewMs);
        try {
          return await fn(client);
        } finally {
          clearInterval(renewal);
          try {
            await client.query(`DELETE FROM ${LOCKS} WHERE facilitation_id = $1 AND owner = $2`, [facilitationId, owner]);
          } catch (err) {
            // Not released: nobody waits longer than the rest of the lease.
            lockLog.write(`facilitation ${facilitationId}: the lock could not be released and runs out with its lease: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        client.release();
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
