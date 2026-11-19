// End of service: the kernel ends the facilitations of a facilitator before
// it disables or deletes the agent or removes the plugin (kernel #2088).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { DAY_MS } from '../src/clock.js';
import { ARCHETYPE_PROCESSES_SERVICE_NAME, endOfServiceReason } from '../src/engine/endOfService.js';
import type { ArchetypeProcessesService } from '../src/engine/endOfService.js';
import { activate } from '../src/plugin.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Thai', 'Pizza'] };
const subscribed = (conv: string, agent = 'mira'): boolean => h.kernel.subscriptions.has(`${agent}|teams|${conv}`);
const lastPost = (conv: string): string => h.kernel.groupPosts(conv).at(-1)?.text ?? '';

test('the plugin provides the process service of its archetype, also without a database', async () => {
  const provided = new Map<string, unknown>();
  const ctx = {
    agentId: '@omadia/agent-facilitator',
    log: () => undefined,
    config: { get: () => undefined },
    routes: { register: () => () => undefined },
    jobs: { register: () => () => undefined },
    uiRoutes: { register: () => () => undefined, registerNav: () => () => undefined },
    tools: { register: () => () => undefined },
    services: {
      get: () => undefined,
      getOptional: () => undefined,
      has: () => false,
      provide: (name: string, impl: unknown) => {
        provided.set(name, impl);
        return () => provided.delete(name);
      },
    },
  } as unknown as PluginContext;
  const handle = await activate(ctx);
  try {
    assert.equal(ARCHETYPE_PROCESSES_SERVICE_NAME, 'archetypeProcesses:facilitator');
    const service = provided.get(ARCHETYPE_PROCESSES_SERVICE_NAME) as ArchetypeProcessesService | undefined;
    assert.equal(typeof service?.endProcessesOfAgent, 'function');
    assert.deepEqual(await service?.endProcessesOfAgent({ agentSlug: 'mira', reason: 'agent_disabled' }), { ended: [] }, 'nothing can run without a database');
  } finally {
    await handle.close();
  }
});

test('a disabled facilitator ends every running facilitation with its abort report, as the facilitator', { skip: PG_SKIP }, async () => {
  const one = h.kernel.conversation('eos-one', [ANNA, BERT]);
  const two = h.kernel.conversation('eos-two', [ANNA, BERT]);
  const other = h.kernel.conversation('eos-other', [ANNA, BERT]);
  const first = await startActive(h, one, VOTE);
  const second = await startActive(h, two, VOTE);
  await startActive(h, other, VOTE, 'nora');

  const report = await h.engine.endProcessesOfAgent({ agentSlug: 'mira', reason: 'agent_disabled' });
  assert.deepEqual(report.ended.map((e) => e.processId).sort(), [first.id, second.id].sort());
  for (const ended of report.ended) {
    assert.equal(ended.outcome, 'aborted');
    assert.equal(ended.reportPosted, true);
    assert.equal(ended.channelType, 'teams');
  }
  assert.deepEqual(report.ended.map((e) => e.conversationId).sort(), [one, two].sort());
  for (const conv of [one, two]) {
    const f = await h.facilitation(conv);
    assert.equal(f.phase, 'aborted');
    assert.match(lastPost(conv), /ends without a result\. Reason: this facilitator was disabled by an operator/);
    assert.equal(h.kernel.groupPosts(conv).at(-1)?.as, 'mira', 'posted as the facilitator itself');
    assert.equal(subscribed(conv), false, 'the conversation is released');
  }
  assert.equal((await h.facilitation(other)).phase, 'active', "another facilitator's facilitation goes on");

  assert.deepEqual(await h.engine.endProcessesOfAgent({ agentSlug: 'mira', reason: 'agent_disabled' }), { ended: [] }, 'idempotent');
  const posts = h.kernel.groupPosts(one).length;
  await h.kernel.say(one, 'anna', 'A');
  await h.settle();
  await h.tick();
  assert.equal(h.kernel.groupPosts(one).length, posts, 'nothing resumes');
});

test('the reason is said in words: deleted, and archetype removed', { skip: PG_SKIP }, async () => {
  const gone = h.kernel.conversation('eos-deleted', [ANNA, BERT]);
  const removed = h.kernel.conversation('eos-removed', [ANNA, BERT]);
  await startActive(h, gone, VOTE, 'gina');
  await startActive(h, removed, VOTE, 'rosa');
  await h.engine.endProcessesOfAgent({ agentSlug: 'gina', reason: 'agent_deleted' });
  await h.engine.endProcessesOfAgent({ agentSlug: 'rosa', reason: 'archetype_plugin_removed' });
  assert.match(lastPost(gone), /Reason: this facilitator is being deleted by an operator/);
  assert.match(lastPost(removed), /Reason: the facilitator archetype is being removed from this instance/);
  assert.match(endOfServiceReason('de', 'agent_disabled'), /deaktiviert/);
  assert.match(endOfServiceReason('de', 'agent_deleted'), /gelöscht/);
  assert.match(endOfServiceReason('de', 'archetype_plugin_removed'), /Archetyp Facilitator wird von dieser Instanz entfernt/);
  await assert.rejects(h.engine.endProcessesOfAgent({ agentSlug: 'gina', reason: 'whatever' as never }), /unknown reason/);
});

test('a closed facilitation that still follows up action items ends its follow-up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('eos-followup', [ANNA, BERT]);
  const at = { conversation: conv, agent: 'fiona' };
  await h.tool('facilitation_start', { goal: 'First', definitionOfDone: 'd', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'decide', title: 'Vote', method: 'single', options: ['Thai', 'Pizza'] }] }, at);
  await h.tool('facilitation_open', {}, at);
  await h.tool('facilitation_record_action_item', { description: 'Book it', owner: 'Anna', dueDate: new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString() }, at);
  await h.kernel.say(conv, 'anna', 'yes');
  await h.settle();
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.kernel.say(conv, 'anna', 'A');
  await h.kernel.say(conv, 'bert', 'A');
  await h.settle();
  const closed = await h.facilitation(conv);
  assert.deepEqual([closed.phase, closed.followupState], ['closed', 'active']);

  const report = await h.engine.endProcessesOfAgent({ agentSlug: 'fiona', reason: 'agent_disabled' });
  assert.deepEqual(report.ended.map((e) => [e.processId, e.outcome]), [[closed.id, 'aborted']]);
  const after = await h.facilitation(conv);
  assert.deepEqual([after.phase, after.followupState], ['closed', 'ended'], 'the result stands; only the follow-up ends');
  assert.equal(subscribed(conv, 'fiona'), false);
});

test('the answer leaves in time when a channel does not answer; that facilitation is reported as failed', { skip: PG_SKIP }, async () => {
  const stuck = h.kernel.conversation('eos-stuck', [ANNA, BERT]);
  const f = await startActive(h, stuck, VOTE, 'hanna');
  h.kernel.sendFaults.push('hang');
  const started = Date.now();
  const report = await h.engine.endProcessesOfAgent({ agentSlug: 'hanna', reason: 'agent_deleted' }, 300);
  assert.ok(Date.now() - started < 5_000, 'did not wait for the channel');
  assert.deepEqual(report.ended.map((e) => [e.processId, e.outcome]), [[f.id, 'failed']]);
  assert.match(report.ended[0]?.detail ?? '', /not finished within/);
});
