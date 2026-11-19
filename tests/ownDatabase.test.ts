// The engine in its own database (kernel #2088, K3): its tables live in the
// plugin's schema, it works as a role that owns nothing, and it reaches the
// database through one statement and one transaction, never a connection.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { dbOf } from '../src/db/pool.js';
import type { KernelSql } from '../src/db/pool.js';
import { heldLockConnections, lockLimits } from '../src/db/tx.js';
import { ANNA, BERT, CARA, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { KERNEL_RUNTIME_POOL_MAX, PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, maxActiveInstance: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Thai', 'Pizza'] };

test('the engine works as a role that owns nothing: no attribute, no membership, DML on its schema only', { skip: PG_SKIP }, async () => {
  const who = await h.db.pool.query<{ cu: string; path: string }>(`SELECT current_user AS cu, current_setting('search_path') AS path`);
  assert.equal(who.rows[0]?.cu, h.db.runtimeRole);
  assert.equal(who.rows[0]?.path, h.db.schema, 'the search path is the schema, set on the role');
  const role = await h.db.admin.query<{ elevated: boolean; memberships: number }>(
    `SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS elevated,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
       FROM pg_roles r WHERE r.rolname = $1`,
    [h.db.runtimeRole],
  );
  assert.deepEqual(role.rows[0], { elevated: false, memberships: 0 });
  const owned = await h.db.admin.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tableowner = $2`, [h.db.schema, h.db.runtimeRole]);
  assert.equal(owned.rows.length, 0, 'it owns no table');

  // What the runtime role cannot do, the engine never needs.
  await assert.rejects(h.db.pool.query('CREATE TABLE plg_omadia_agent_facilitator_x (id int)'), /permission denied/);
  await assert.rejects(h.db.pool.query('ALTER TABLE plg_omadia_agent_facilitator_jobs ADD COLUMN x int'), /must be owner/);
  await assert.rejects(h.db.pool.query('TRUNCATE plg_omadia_agent_facilitator_jobs'), /permission denied/);
  await assert.rejects(h.db.pool.query(`INSERT INTO plg_omadia_agent_facilitator_migrations (filename) VALUES ('x.sql')`), /permission denied/);
  // A table outside its schema, as a kernel table would be.
  await h.db.admin.query(`CREATE TABLE IF NOT EXISTS public.fac_test_kernel_table (id int)`);
  await assert.rejects(h.db.pool.query('SELECT * FROM public.fac_test_kernel_table'), /permission denied/);
});

test('a whole facilitation runs as that role: start, votes, result, protocol, retention', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('od-whole', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, VOTE);
  for (const who of ['anna', 'bert', 'cara']) await h.kernel.say(conv, who, 'A');
  await h.settle();
  await h.tick();
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.ok(h.kernel.groupPosts(conv).some((p) => p.text.startsWith('Result for')));
  // Every table the engine wrote lives in the schema, none in public.
  const elsewhere = await h.db.admin.query<{ schemaname: string }>(`SELECT schemaname FROM pg_tables WHERE tablename LIKE 'plg_omadia_agent_facilitator_%' AND schemaname <> $1 AND schemaname NOT LIKE 'fac_test_%'`, [h.db.schema]);
  assert.deepEqual(elsewhere.rows, []);
  assert.ok((await store.listEvents(h.db.pool, f.id)).length > 0);
  // Retention deletes as the runtime role.
  h.clock.advance(400 * 24 * 3600_000);
  await h.tick();
  assert.equal(await store.getFacilitation(h.db.pool, f.id), undefined, 'purged after retention');
});

test('nothing holds a connection: more facilitations busy at once than the database has connections', { skip: PG_SKIP, timeout: 60_000 }, async () => {
  const convs = Array.from({ length: 3 * KERNEL_RUNTIME_POOL_MAX }, (_v, i) => h.kernel.conversation(`od-busy-${String(i)}`, [ANNA, BERT]));
  for (const conv of convs) {
    await startActive(h, conv, VOTE);
    await h.kernel.say(conv, 'anna', 'A');
  }
  await h.settle();
  let most = 0;
  const watch = setInterval(() => {
    most = Math.max(most, heldLockConnections());
  }, 1);
  try {
    await Promise.all([...convs.map((conv) => h.kernel.say(conv, 'bert', 'A')), h.engine.tick(), ...convs.map((conv) => h.tool('facilitation_status', {}, { conversation: conv }))]);
    await h.settle();
  } finally {
    clearInterval(watch);
  }
  for (const conv of convs) assert.equal((await h.facilitation(conv)).phase, 'closed', conv);
  assert.ok(most <= lockLimits.maxConnections, `at most ${String(lockLimits.maxConnections)} units of locked work at a time, saw ${String(most)}`);
  assert.equal(h.db.runtime.totalCount <= KERNEL_RUNTIME_POOL_MAX, true);
  assert.equal(h.db.runtime.waitingCount, 0);
  assert.equal(heldLockConnections(), 0);
});

test('a lock is held across a long channel send without any connection, and its lease is renewed statement by statement', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const before = { ...lockLimits };
  Object.assign(lockLimits, { leaseMs: 300, renewMs: 60 });
  try {
    const conv = h.kernel.conversation('od-lease', [ANNA, BERT]);
    const f = await startActive(h, conv, VOTE);
    let idleWhileLocked = -1;
    let leaseAhead = false;
    await h.engine.core.work(f.id, async () => undefined);
    const { withFacilitationLock } = await import('../src/db/tx.js');
    await withFacilitationLock(h.db.pool, f.id, async () => {
      // As long as a slow channel call: several leases.
      await new Promise((r) => setTimeout(r, 900));
      idleWhileLocked = h.db.runtime.totalCount - h.db.runtime.idleCount;
      const row = await h.db.pool.query<{ ahead: boolean }>(`SELECT lease_until > now() AS ahead FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = $1`, [f.id]);
      leaseAhead = row.rows[0]?.ahead === true;
    });
    assert.equal(idleWhileLocked, 0, 'no connection is checked out while the lock is only being held');
    assert.equal(leaseAhead, true, 'the lease was renewed while the work ran');
    assert.equal((await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = $1', [f.id])).rows.length, 0);
  } finally {
    Object.assign(lockLimits, before);
  }
});

test('a transaction commits when its work resolves, rolls back when it throws, and its handle is dead afterwards', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('od-tx', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  const version = (await store.getFacilitation(h.db.pool, f.id))?.stateVersion ?? -1;
  await assert.rejects(
    h.db.pool.transaction(async (tx) => {
      await store.bumpStateVersion(tx, f.id);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal((await store.getFacilitation(h.db.pool, f.id))?.stateVersion, version);
  let leaked: { query(text: string): Promise<unknown> } | undefined;
  await h.db.pool.transaction(async (tx) => {
    leaked = tx;
    await store.bumpStateVersion(tx, f.id);
  });
  assert.equal((await store.getFacilitation(h.db.pool, f.id))?.stateVersion, version + 1);
  await assert.rejects(leaked?.query('SELECT 1') ?? Promise.resolve(), /transaction has ended/);
});

test('the accessor of the kernel is all the engine needs; without query and transaction there is no database', async () => {
  assert.equal(dbOf(undefined), undefined);
  assert.equal(dbOf({ schema: 'x' }), undefined);
  assert.equal(dbOf({ query: async () => ({ rows: [], rowCount: 0 }) } as unknown as KernelSql), undefined);
  const whole = { schema: 'x', query: async () => ({ rows: Object.freeze([{ a: 1 }]), rowCount: 1 }), transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: async () => ({ rows: [], rowCount: 0 }) }) } as unknown as KernelSql;
  const db = dbOf(whole);
  assert.ok(db);
  const rows = (await db.query('SELECT 1')).rows;
  rows.push({ a: 2 });
  assert.equal(rows.length, 2, 'the rows are a copy the engine may change');
});
