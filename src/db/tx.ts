// The serialisation point of a facilitation (spec 5.6).
//
// Every state change and every send of one facilitation runs under ONE lock.
// It stays held while a queued message goes to the channel, so a contribution
// that arrives meanwhile waits and a reminder computed before the last vote is
// never sent after it. No TRANSACTION is open during that call, and nothing
// but the channel send happens under the lock outside a transaction.
//
// The lock is a ROW with a lease, and every step of it is ONE statement:
//   - taking it (insert, or take over a lease that ran out);
//   - renewing the lease while the holder works;
//   - deleting the row when the work is done.
// A holder that died is not waited for longer than one lease.
//
// Nothing here holds a connection. The engine has none: the kernel gives it
// a statement and a transaction (`Db`), each on whatever server session a
// pooler picks (transaction mode). Until 1.0.4 the lock was a session-level
// advisory lock, which is not released when the release lands on another
// session; it blocked a facilitation for minutes in production. Until 1.2.0
// the lock held one pool connection for the whole unit of work; a connection
// cannot be held any more, and the row never needed it.
//
// The database behind `Db` is small (the kernel's default for an archetype
// plugin is four connections), so:
//   - at most `lockLimits.maxConnections` units of locked work run at the
//     same time, however many facilitations are busy; the rest queue in
//     memory. Each uses one connection at a time (its transaction, or one
//     statement), the lease renewal one more for a moment;
//   - a lock is tried with a deadline, never with a blocking wait.

import { randomUUID } from 'node:crypto';

import type { Db } from './pool.js';

const LOCKS = 'plg_omadia_agent_facilitator_locks';

/** Bounds of the lock. Mutable so an operator-facing setting or a test can
 *  tighten them; the defaults sit well below four connections. */
export const lockLimits = {
  /** Units of locked work that may run at the same time; each uses one
   *  connection at a time. */
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

// A counting semaphore over the locked work of the whole engine.
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

/** Units of locked work running right now. */
export const heldLockConnections = (): number => held;

const ms = (n: number): string => `${String(Math.max(1, Math.round(n)))} milliseconds`;

/** One statement: take a free lock, or one whose holder's lease ran out. */
async function tryTake(q: Db, facilitationId: string, owner: string): Promise<boolean> {
  const taken = await q.query(
    `INSERT INTO ${LOCKS} (facilitation_id, owner, lease_until, acquired_at) VALUES ($1, $2, now() + $3::interval, now())
       ON CONFLICT (facilitation_id) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until, acquired_at = EXCLUDED.acquired_at
       WHERE ${LOCKS}.lease_until < now()
     RETURNING owner`,
    [facilitationId, owner, ms(lockLimits.leaseMs)],
  );
  return taken.rows.length > 0;
}

/**
 * Run `fn` holding the facilitation's lock. `fn` gets the database: a
 * transaction for what belongs together, single statements for the rest.
 */
export async function withFacilitationLock<T>(db: Db, facilitationId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return serialised(facilitationId, () =>
    withSlot(async () => {
      const owner = randomUUID();
      const started = Date.now();
      for (;;) {
        if (await tryTake(db, facilitationId, owner)) break;
        if (Date.now() - started >= lockLimits.acquireTimeoutMs) throw new LockTimeoutError(facilitationId, Date.now() - started);
        await sleep(lockLimits.pollMs);
      }
      // The renewal is a statement of its own, never part of a transaction of
      // `fn`: there it would wait for the commit and be undone by a rollback.
      let lost = false;
      const renewal = setInterval(() => {
        db.query(`UPDATE ${LOCKS} SET lease_until = now() + $3::interval WHERE facilitation_id = $1 AND owner = $2`, [facilitationId, owner, ms(lockLimits.leaseMs)])
          .then((renewed) => {
            if (renewed.rowCount === 0 && !lost) {
              lost = true;
              lockLog.write(`facilitation ${facilitationId}: the lock was taken over while its work was still running (no renewal within a lease)`);
            }
          })
          .catch((err: unknown) => lockLog.write(`facilitation ${facilitationId}: the lock's lease could not be renewed: ${err instanceof Error ? err.message : String(err)}`));
      }, lockLimits.renewMs);
      try {
        return await fn(db);
      } finally {
        clearInterval(renewal);
        try {
          await db.query(`DELETE FROM ${LOCKS} WHERE facilitation_id = $1 AND owner = $2`, [facilitationId, owner]);
        } catch (err) {
          // Not released: nobody waits longer than the rest of the lease.
          lockLog.write(`facilitation ${facilitationId}: the lock could not be released and runs out with its lease: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );
}
