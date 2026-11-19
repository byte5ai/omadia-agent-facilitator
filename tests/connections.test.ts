// Connection behaviour on the kernel's shared pool (review finding 5). The
// kernel pool defaults to 5 connections; the engine must never need more than
// a few of them at once, never wait for a lock without a bound, and never keep
// a connection because a channel call does not answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LockTimeoutError, lockLimits } from '../src/db/tx.js';
import { sendLimits } from '../src/engine/outbox.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Thai', 'Pizza'] };

test('review 5: eight facilitations closing at once on a pool of three connections neither deadlock nor exhaust it', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const h = await createHarness({ poolMax: 3 });
  try {
    const convs = Array.from({ length: 8 }, (_v, i) => h.kernel.conversation(`cn-close-${String(i)}`, [ANNA, BERT]));
    for (const conv of convs) {
      await startActive(h, conv, VOTE);
      await h.kernel.say(conv, 'anna', 'A');
    }
    await h.settle();
    // The last vote in all eight at the same moment, with a tick on top.
    await Promise.all([...convs.map((conv) => h.kernel.say(conv, 'bert', 'A')), h.engine.tick()]);
    await h.settle();
    for (const conv of convs) assert.equal((await h.facilitation(conv)).phase, 'closed', conv);
    for (const conv of convs) assert.equal(h.kernel.groupPosts(conv).filter((p) => p.text.startsWith('Result for')).length, 1);

    // The same for eight that are stopped at once (the path that releases the conversation).
    const more = Array.from({ length: 8 }, (_v, i) => h.kernel.conversation(`cn-stop-${String(i)}`, [ANNA, BERT]));
    for (const conv of more) await startActive(h, conv, VOTE);
    await Promise.all(more.map((conv) => h.tool('facilitation_stop', { reason: 'stopped together' }, { conversation: conv })));
    for (const conv of more) assert.equal((await h.facilitation(conv)).phase, 'aborted', conv);
  } finally {
    await h.close();
  }
});

test('review 5: a lock somebody else holds is waited for with a bound, not forever', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const h = await createHarness({ poolMax: 4 });
  const before = { ...lockLimits };
  try {
    const conv = h.kernel.conversation('cn-lock', [ANNA, BERT]);
    const f = await startActive(h, conv, VOTE);
    lockLimits.acquireTimeoutMs = 300;
    let release: () => void = () => undefined;
    const held = (async () => {
      // Another process (another replica) holds the facilitation's lock.
      await h.db.pool.query(`INSERT INTO plg_omadia_agent_facilitator_locks (facilitation_id, owner, lease_until, acquired_at) VALUES ($1, 'other-replica', now() + interval '1 minute', now())`, [f.id]);
      await new Promise<void>((resolve) => (release = resolve));
      await h.db.pool.query(`DELETE FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = $1 AND owner = 'other-replica'`, [f.id]);
    })();
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await assert.rejects(h.engine.core.work(f.id, async () => undefined), (err: unknown) => err instanceof LockTimeoutError);
    assert.ok(Date.now() - started < 3000, 'gave up within its bound');
    release();
    await held;
    await h.engine.core.work(f.id, async () => undefined);
  } finally {
    Object.assign(lockLimits, before);
    await h.close();
  }
});

test('review 5: a channel call that never answers times out; the lock and its connection are given back', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  const h = await createHarness({ poolMax: 3 });
  const before = { ...sendLimits };
  try {
    const conv = h.kernel.conversation('cn-hang', [ANNA, BERT]);
    await startActive(h, conv, VOTE);
    sendLimits.timeoutMs = 200;
    h.kernel.sendFaults.push('hang');
    await h.kernel.say(conv, 'anna', 'A'); // its echo hangs in the channel
    await h.settle();
    await h.kernel.say(conv, 'bert', 'A');
    await h.settle();
    assert.equal((await h.facilitation(conv)).phase, 'closed', 'the facilitation went on after the timeout');
    assert.ok(h.logs.some((l) => l.includes('timeout')));
  } finally {
    Object.assign(sendLimits, before);
    await h.close();
  }
});
