// The facilitation lock behind a transaction-mode pooler (1.0.5).
//
// Live, a mention was not processed: "its lock was not free within 15015 ms",
// for minutes, while the engine was doing nothing. The instance reaches
// Postgres through a pooler in transaction mode, where a statement outside a
// transaction may run on any server session. A session-level advisory lock
// taken on one session and "released" on another stays held by the first.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolClientLike, PoolLike, QueryResult } from '../src/db/pool.js';
import { LockTimeoutError, lockLimits, withFacilitationLock } from '../src/db/tx.js';
import { openTestDb } from './pg.js';
import { PG_SKIP } from './pg.js';

/** A pool that hands every statement outside a transaction to the next of
 *  three server sessions, as a pooler in transaction mode may. */
async function transactionPooled(pool: PoolLike): Promise<{ pool: PoolLike; close(): void }> {
  const sessions = [await pool.connect(), await pool.connect(), await pool.connect()];
  let next = 0;
  const pick = (): PoolClientLike => sessions[next++ % sessions.length] as PoolClientLike;
  const client = (): PoolClientLike => {
    let pinned: PoolClientLike | undefined;
    return {
      async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
        const begins = /^\s*BEGIN\b/i.test(text);
        const ends = /^\s*(COMMIT|ROLLBACK)\b/i.test(text);
        if (begins) pinned = pick();
        const session = pinned ?? pick();
        if (ends) pinned = undefined;
        return session.query<R>(text, params);
      },
      release: () => undefined,
    };
  };
  return {
    pool: { query: (text, params) => client().query(text, params), connect: async () => client() },
    close: () => sessions.forEach((s) => s.release()),
  };
}

test('the lock is released for everybody, whichever server session a statement lands on', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const db = await openTestDb();
  await db.runMigrations();
  const pooled = await transactionPooled(db.pool);
  const before = { ...lockLimits };
  lockLimits.acquireTimeoutMs = 500;
  try {
    const ran: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await withFacilitationLock(pooled.pool, 'facilitation-behind-a-pooler', async (client) => {
        await client.query('BEGIN');
        await client.query('SELECT 1');
        await client.query('COMMIT');
        // A different number of statements each time: which session the
        // release lands on is not for the engine to rely on.
        for (let n = 0; n <= i; n += 1) await client.query('SELECT 1');
        ran.push(i);
      });
    }
    assert.deepEqual(ran, [0, 1, 2, 3, 4, 5]);
    // Nothing is left behind on any server session: a lock that stays there
    // blocks everybody who lands on another one, until that session ends.
    const leaked = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    assert.equal(Number(leaked.rows[0]?.n ?? 0), 0, 'no session-level lock is left on a server session');
    const rows = await db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = 'facilitation-behind-a-pooler'`);
    assert.equal(rows.rows.length, 0, 'and the lock is free');
  } finally {
    Object.assign(lockLimits, before);
    pooled.close();
    await db.close();
  }
});

test('a holder that died is not waited for forever: its lease runs out', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const db = await openTestDb();
  await db.runMigrations();
  const before = { ...lockLimits };
  Object.assign(lockLimits, { acquireTimeoutMs: 3000, leaseMs: 400, renewMs: 100 });
  try {
    // A process that took the lock and never came back.
    await db.pool.query(
      `INSERT INTO plg_omadia_agent_facilitator_locks (facilitation_id, owner, lease_until, acquired_at) VALUES ($1, 'dead-process', now() + interval '400 milliseconds', now())`,
      ['abandoned'],
    );
    lockLimits.acquireTimeoutMs = 100;
    await assert.rejects(withFacilitationLock(db.pool, 'abandoned', async () => undefined), (err: unknown) => err instanceof LockTimeoutError);
    lockLimits.acquireTimeoutMs = 3000;
    let ran = false;
    await withFacilitationLock(db.pool, 'abandoned', async () => {
      ran = true;
    });
    assert.equal(ran, true);
  } finally {
    Object.assign(lockLimits, before);
    await db.close();
  }
});

test('work that takes longer than a lease keeps its lock', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const db = await openTestDb();
  await db.runMigrations();
  const before = { ...lockLimits };
  Object.assign(lockLimits, { leaseMs: 300, renewMs: 80, acquireTimeoutMs: 150 });
  try {
    await withFacilitationLock(db.pool, 'long-work', async () => {
      await new Promise((r) => setTimeout(r, 700));
      // Another process tries meanwhile: the lock is still held.
      const other = await db.pool.query(
        `INSERT INTO plg_omadia_agent_facilitator_locks (facilitation_id, owner, lease_until, acquired_at) VALUES ('long-work', 'intruder', now() + interval '1 minute', now())
         ON CONFLICT (facilitation_id) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until WHERE plg_omadia_agent_facilitator_locks.lease_until < now() RETURNING owner`,
      );
      assert.equal(other.rows.length, 0);
    });
    const left = await db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = 'long-work'`);
    assert.equal(left.rows.length, 0, 'released afterwards');
  } finally {
    Object.assign(lockLimits, before);
    await db.close();
  }
});
