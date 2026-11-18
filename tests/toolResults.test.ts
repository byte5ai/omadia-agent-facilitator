// What the tools tell the model. A tool result is read by a model that may
// repeat it to the group, so it must say plainly what did and did not happen.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { FOUR, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const SETUP = { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Garden'] };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('facilitation_start says unmistakably that nothing is open yet', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-start', FOUR);
  const answer = await h.tool('facilitation_start', SETUP, { conversation: conv });
  assert.match(answer, /^Facilitation created/);
  assert.match(answer, /NOT open/);
  assert.match(answer, /Do not tell the group that it started/);
  assert.match(answer, /facilitation_open/);
  assert.equal(h.kernel.groupPosts(conv).length, 0);
  const again = await h.tool('facilitation_start', { ...SETUP, goal: 'Pick a place' }, { conversation: conv });
  assert.match(again, /^Setup updated/);
  assert.match(again, /NOT open/);
});

test('facilitation_start with open: true opens in the same call when the request fixed everything', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-open', FOUR);
  const answer = await h.tool('facilitation_start', { ...SETUP, open: true }, { conversation: conv });
  assert.match(answer, /^Facilitation created and opened/);
  assert.doesNotMatch(answer, /NOT open/);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  const posts = h.kernel.groupPosts(conv);
  assert.equal(posts.filter((p) => p.text.includes('I am Mira')).length, 1, 'the handshake was posted once');
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  const recorded = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_contributions WHERE status = 'valid' AND facilitation_id = $1`, [(await h.facilitation(conv)).id]);
  assert.equal(recorded.rows.length, 1, 'ballots are recorded from then on');
});

test('open: true on a setup that cannot be posted does not claim that it is open', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-open-fail', FOUR);
  h.kernel.sendFaults.push({ code: 'channel_error', message: 'the channel is down' });
  const answer = await h.tool('facilitation_start', { ...SETUP, open: true }, { conversation: conv });
  assert.doesNotMatch(answer, /and opened/);
  assert.match(answer, /NOT posted/);
});

// ── facilitation_propose_change ─────────────────────────────────────────────

async function decisionAgenda(conv: string): Promise<void> {
  h.kernel.conversation(conv, FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', format: 'decision', method: 'single', options: ['Harbour', 'Garden', 'Old Town'], open: true }, { conversation: conv });
}
const proposals = async (conv: string): Promise<number> =>
  (await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_proposals WHERE facilitation_id = $1', [(await h.facilitation(conv)).id])).rows.length;

test('a method change is refused for a step that is not decided by a vote, and points to facilitation_step', { skip: PG_SKIP }, async () => {
  await decisionAgenda('tr-change-step');
  // Step 2 is "collect": "go to the vote" is not a change of its method.
  const answer = await h.tool('facilitation_propose_change', { change: 'method', step: 2, method: 'ranked', options: ['Fits for all', 'Collect options', 'Discuss'] }, { conversation: 'tr-change-step' });
  assert.match(answer, /^Refused \(not_a_deciding_step\)/);
  assert.match(answer, /facilitation_step/);
  assert.equal(await proposals('tr-change-step'), 0);
  assert.equal(h.kernel.groupPosts('tr-change-step').filter((p) => /^Proposal/.test(p.text)).length, 0);
});

test('a method change keeps the options of the step unless it says that they are replaced', { skip: PG_SKIP }, async () => {
  await decisionAgenda('tr-change-options');
  const foreign = await h.tool('facilitation_propose_change', { change: 'method', method: 'ranked', options: ['Fits for all', 'Collect options', 'Discuss'] }, { conversation: 'tr-change-options' });
  assert.match(foreign, /^Refused \(foreign_options\)/);
  assert.match(foreign, /Harbour, Garden, Old Town/);
  assert.equal(await proposals('tr-change-options'), 0);
  // The step's own options, in any order and case, are no change of options.
  const same = await h.tool('facilitation_propose_change', { change: 'method', method: 'ranked', options: ['garden', 'Harbour', 'Old Town'] }, { conversation: 'tr-change-options' });
  assert.match(same, /^Put to the group/);
});

test('replacing the options is possible when the change says so', { skip: PG_SKIP }, async () => {
  await decisionAgenda('tr-change-replace');
  const answer = await h.tool('facilitation_propose_change', { change: 'method', options: ['Harbour', 'Lakeside'], replaceOptions: true }, { conversation: 'tr-change-replace' });
  assert.match(answer, /^Put to the group/);
  assert.match(h.kernel.groupPosts('tr-change-replace').at(-1)?.text ?? '', /Lakeside/);
});

test('the tool descriptions tell a rule change from moving on', async () => {
  const { buildTools } = await import('../src/tools/index.js');
  const tools = buildTools({} as never);
  const describe = (name: string): string => tools.find((t) => t.spec.name === name)?.spec.description ?? '';
  assert.match(describe('facilitation_propose_change'), /facilitation_step/);
  assert.match(describe('facilitation_step'), /move on|skip/);
});
