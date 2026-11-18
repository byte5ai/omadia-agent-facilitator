// The engine after a middleware restart: the database may be published after
// the plugin activated. The engine must come up on its own and resume.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ENGINE_SERVICE_NAME, NO_DATABASE_REASON, activate } from '../src/plugin.js';
import type { FacilitationEngineInfo } from '../src/plugin.js';
import { FOUR, createHarness, startActive } from './harness.js';
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

test('the manifest orders activation after the pool provider', () => {
  const manifest = readFileSync(join(process.cwd(), 'manifest.yaml'), 'utf8');
  assert.match(manifest, /^requires:\n\s+- "graphPool@\^1"$/m);
  const optional = /optional_requires:\n((?:\s+- "[^"]+"\n)+)/.exec(manifest)?.[1] ?? '';
  assert.ok(!optional.includes('graphPool'), 'graphPool is a hard requirement, not an optional one');
});

test('a pool that is published after activation brings the engine up, and the running facilitation goes on', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rs-late-pool', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  // The middleware restarts; the pool provider activates after the engine.
  await h.engine.stop();
  h.kernel.absent.add('pool');
  const { ctx, provided, jobs } = kernelContext(h.kernel, h.db);
  const handle = await activate(ctx);
  try {
    const info = provided.get(ENGINE_SERVICE_NAME) as FacilitationEngineInfo;
    assert.equal(info.available, false);
    assert.equal(info.unavailableReason, NO_DATABASE_REASON);
    // A ballot arrives while the engine is down.
    await h.kernel.say(conv, 'bert', 'B');

    h.kernel.absent.delete('pool');
    // Nobody re-activates the plugin: the scheduler's next pass finds the pool.
    await jobs.get('facilitation-tick')?.();
    await handle.engine.idle();
    assert.equal(info.available, true, 'the published state follows without a new activation');
    assert.equal(info.unavailableReason, undefined);

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

test('a tool call also finds a database that appeared after activation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rs-tool', FOUR);
  h.kernel.absent.add('pool');
  const { ctx } = kernelContext(h.kernel, h.db);
  const handle = await activate(ctx);
  try {
    const { buildTools } = await import('../src/tools/index.js');
    const start = buildTools(handle.engine).find((t) => t.spec.name === 'facilitation_start');
    const args = { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen' };
    assert.match((await start?.handler(args, h.kernel.context('mira', conv, 'anna'))) ?? '', /^Not available/);
    h.kernel.absent.delete('pool');
    assert.doesNotMatch((await start?.handler(args, h.kernel.context('mira', conv, 'anna'))) ?? '', /^Not available/);
    assert.equal(handle.info.available, true);
  } finally {
    await handle.close();
  }
});
