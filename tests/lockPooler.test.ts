// The facilitation lock behind a transaction-mode pooler (1.0.5).
//
// Live, a mention was not processed: "its lock was not free within 15015 ms",
// for minutes, while the engine was doing nothing. The instance reaches
// Postgres through a pooler in transaction mode, where a statement outside a
// transaction may run on any server session. A session-level advisory lock
// taken on one session and "released" on another stays held by the first.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FacilitationEngine } from '../src/engine/engine.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';

import type pg from 'pg';

import { dbOf } from '../src/db/pool.js';
import type { Db } from '../src/db/pool.js';
import { LockTimeoutError, lockLimits, withFacilitationLock } from '../src/db/tx.js';
import { kernelSql, openTestDb } from './pg.js';
import { PG_SKIP } from './pg.js';

/**
 * The kernel's accessor behind a pooler in transaction mode: three server
 * sessions, and every statement outside a transaction goes to the next one.
 * A transaction stays on the session it began on.
 */
async function transactionPooled(runtime: pg.Pool, schema: string): Promise<{ db: Db; sessions: number[]; close(): void }> {
  const clients = [await runtime.connect(), await runtime.connect(), await runtime.connect()];
  const sessions: number[] = [];
  let next = 0;
  const pick = (): pg.PoolClient => {
    const index = next++ % clients.length;
    sessions.push(index);
    return clients[index] as pg.PoolClient;
  };
  const rotating = {
    query: (text: string, params?: unknown[]) => pick().query(text, params),
    connect: async () => {
      const pinned = pick();
      return { query: (text: string, params?: unknown[]) => pinned.query(text, params), release: () => undefined };
    },
  } as unknown as pg.Pool;
  const db = dbOf(kernelSql(rotating, schema));
  if (!db) throw new Error('incomplete accessor');
  return { db, sessions, close: () => clients.forEach((c) => c.release()) };
}

test('the lock is released for everybody, whichever server session a statement lands on', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const db = await openTestDb();
  const pooled = await transactionPooled(db.runtime, db.schema);
  const before = { ...lockLimits };
  lockLimits.acquireTimeoutMs = 500;
  try {
    const ran: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await withFacilitationLock(pooled.db, 'facilitation-behind-a-pooler', async (locked) => {
        await locked.transaction(async (tx) => {
          await tx.query('SELECT 1');
        });
        // A different number of statements each time: which session the
        // release lands on is not for the engine to rely on.
        for (let n = 0; n <= i; n += 1) await locked.query('SELECT 1');
        ran.push(i);
      });
    }
    assert.deepEqual(ran, [0, 1, 2, 3, 4, 5]);
    assert.equal(new Set(pooled.sessions).size, 3, 'the statements really went over all three server sessions');
    // Nothing is left behind on any server session: a lock that stays there
    // blocks everybody who lands on another one, until that session ends.
    const leaked = await db.admin.query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    assert.equal(Number(leaked.rows[0]?.n ?? 0), 0, 'no session-level lock is left on a server session');
    const rows = await db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = 'facilitation-behind-a-pooler'`);
    assert.equal(rows.rows.length, 0, 'and the lock is free');
  } finally {
    Object.assign(lockLimits, before);
    pooled.close();
    await db.close();
  }
});

test('a whole facilitation runs behind a pooler in transaction mode', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const h = await createHarness();
  const pooled = await transactionPooled(h.db.runtime, h.db.schema);
  try {
    // A second engine on the same database, reaching it through the pooler.
    await h.engine.stop();
    const kernel = h.kernel.kernel();
    const engine = new FacilitationEngine({ kernel: { ...kernel, db: () => pooled.db }, config: h.engine.core.config, clock: h.clock, log: () => undefined });
    await engine.start();
    h.engine = engine;
    const conv = h.kernel.conversation('behind-a-pooler', [ANNA, BERT]);
    await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
    await h.kernel.say(conv, 'anna', 'A');
    await h.kernel.say(conv, 'bert', 'A');
    await h.settle();
    await h.tick();
    assert.equal((await h.facilitation(conv)).phase, 'closed');
    assert.equal(h.kernel.groupPosts(conv).filter((p) => p.text.startsWith('Result for')).length, 1);
    const left = await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_locks');
    assert.equal(left.rows.length, 0, 'no lock row is left');
  } finally {
    pooled.close();
    await h.close();
  }
});

test('a holder that died is not waited for forever: its lease runs out', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const db = await openTestDb();
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
