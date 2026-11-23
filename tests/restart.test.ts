// The engine after a middleware restart: the database may be published after
// the plugin activated. The engine must come up on its own and resume.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ENGINE_SERVICE_NAME, NO_DATABASE_REASON, OLD_KERNEL_REASON, activate } from '../src/plugin.js';
import type { FacilitationEngineInfo } from '../src/plugin.js';
import { FOUR, createHarness, startActive, textOf } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';
import { kernelContext } from './pluginContext.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('the manifest asks for no shared pool: the database is the plugin\'s own accessor', () => {
  const manifest = readFileSync(join(process.cwd(), 'manifest.yaml'), 'utf8');
  assert.ok(!/^\s*- "graphPool/m.test(manifest), 'graphPool is not required, not even optionally');
  assert.match(manifest, /^requires: \[\]$/m);
  assert.match(manifest, /ledger: "plg_omadia_agent_facilitator_migrations"/);
});

test('without the operator\'s grant the engine is down; the activation that follows the grant resumes the running facilitation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rs-late-grant', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  // The middleware restarts, and the grant is not on record.
  await h.engine.stop();
  const down = kernelContext(h.kernel, h.db, { granted: false });
  const first = await activate(down.ctx);
  const info = down.provided.get(ENGINE_SERVICE_NAME) as FacilitationEngineInfo;
  assert.equal(info.available, false);
  assert.equal(info.unavailableReason, NO_DATABASE_REASON);
  // A ballot arrives while the engine is down.
  await h.kernel.say(conv, 'bert', 'B');
  await first.close();

  // The operator grants the database; the kernel activates the plugin anew.
  const up = kernelContext(h.kernel, h.db);
  const handle = await activate(up.ctx);
  try {
    await handle.engine.idle();
    assert.equal(handle.info.available, true);
    assert.ok(up.logs.some((l) => l.includes(`schema '${h.db.schema}'`)), 'the schema in use is in the log');
    const ballots = await h.db.pool.query<{ participant_principal: string }>(
      `SELECT participant_principal FROM plg_omadia_agent_facilitator_contributions WHERE facilitation_id = $1 AND status = 'valid' ORDER BY participant_principal`,
      [f.id],
    );
    assert.deepEqual(ballots.rows.map((r) => r.participant_principal), ['user:anna', 'user:bert'], 'the ballot from the downtime was caught up');
    // And it goes on live.
    await h.kernel.say(conv, 'cara', 'A');
    await handle.engine.idle();
    const after = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_contributions WHERE facilitation_id = $1 AND status = 'valid'`, [f.id]);
    assert.equal(after.rows.length, 3);
    assert.equal(h.kernel.groupPosts(conv).filter((p) => p.text.includes('I am Mira')).length, 1, 'no second handshake');
  } finally {
    await handle.close();
  }
});

test('a kernel that cannot give an archetype plugin its own database is named as the reason', { skip: PG_SKIP }, async () => {
  const { ctx } = kernelContext(h.kernel, h.db, { oldKernel: true });
  const handle = await activate(ctx);
  try {
    assert.equal(handle.info.available, false);
    assert.equal(handle.info.unavailableReason, OLD_KERNEL_REASON);
  } finally {
    await handle.close();
  }
});

test('migrations that failed at activation are tried again: the next pass of the scheduler, or a tool call, brings the engine up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rs-tool', FOUR);
  const migrations = { failing: true };
  const { ctx, jobs } = kernelContext(h.kernel, h.db, { migrations });
  const handle = await activate(ctx);
  try {
    assert.equal(handle.info.available, false);
    assert.match(handle.info.unavailableReason ?? '', /could not be migrated: lock timeout/);
    const { buildTools } = await import('../src/tools/index.js');
    const start = buildTools(handle.engine).find((t) => t.spec.name === 'facilitation_start');
    const args = { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen' };
    assert.match(textOf(await start?.handler(args, h.kernel.context('mira', conv, 'anna'))), /^Not available/);
    await jobs.get('facilitation-tick')?.();
    assert.equal(handle.info.available, false, 'still failing');
    migrations.failing = false;
    await jobs.get('facilitation-tick')?.();
    assert.equal(handle.info.available, true);
    assert.doesNotMatch(textOf(await start?.handler(args, h.kernel.context('mira', conv, 'anna'))), /^Not available/);
  } finally {
    await handle.close();
  }
});
