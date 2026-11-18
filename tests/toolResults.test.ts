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

// ── what a turn says after a tool already made the facilitator post ─────────

test('when a tool of the turn posted in the group, the text of the turn is dropped, whatever the model wrote', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-turn-drop', FOUR);
  await h.tool('facilitation_start', SETUP, { conversation: conv });
  const { buildTools } = await import('../src/tools/index.js');
  h.kernel.onTurn = async (request) => {
    const open = buildTools(h.engine).find((t) => t.spec.name === 'facilitation_open');
    await open?.handler({}, h.kernel.context('mira', conv, 'anna', request.inboundEventId));
    // The model does not answer [silent], and it talks about the machinery.
    return 'The facilitation is open. The engine posted the opening handshake. We start now.';
  };
  try {
    await h.kernel.say(conv, 'anna', 'Fits, please open it');
    await h.settle();
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  const posts = h.kernel.groupPosts(conv).map((p) => p.text);
  assert.equal(posts.length, 1, 'only the handshake');
  assert.ok(posts[0]?.includes('I am Mira'));
  assert.ok(!posts.some((p) => /engine/i.test(p)));
});

test('a turn whose tools posted nothing still says what the model wrote', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-turn-keep', FOUR);
  await h.tool('facilitation_start', SETUP, { conversation: conv });
  const { buildTools } = await import('../src/tools/index.js');
  h.kernel.onTurn = async (request) => {
    const status = buildTools(h.engine).find((t) => t.spec.name === 'facilitation_status');
    await status?.handler({}, h.kernel.context('mira', conv, 'anna', request.inboundEventId));
    return 'Shall I open it with these two options?';
  };
  try {
    await h.kernel.say(conv, 'anna', 'What is still missing?');
    await h.settle();
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  assert.deepEqual(h.kernel.groupPosts(conv).map((p) => p.text), ['Shall I open it with these two options?']);
});

test('a tool that cannot work says so without naming the machinery', async () => {
  const { buildTools } = await import('../src/tools/index.js');
  const { FacilitationEngine } = await import('../src/engine/engine.js');
  const { FakeKernel, fakeClock } = await import('./fakeKernel.js');
  const { CONFIG_DEFAULTS } = await import('../src/config.js');
  const { INTERNALS } = await import('./harness.js');
  const clock = fakeClock();
  const kernel = new FakeKernel(undefined, clock);
  const engine = new FacilitationEngine({ kernel: kernel.kernel(), config: CONFIG_DEFAULTS, clock, log: () => undefined });
  const start = buildTools(engine).find((t) => t.spec.name === 'facilitation_start');
  const noDatabase = (await start?.handler({ goal: 'g', definitionOfDone: 'd' }, kernel.context('mira', 'c1', 'anna'))) ?? '';
  assert.match(noDatabase, /^Not available/);
  assert.doesNotMatch(noDatabase, INTERNALS);
  const noContext = (await start?.handler({ goal: 'g', definitionOfDone: 'd' })) ?? '';
  assert.match(noContext, /^Refused/);
  assert.doesNotMatch(noContext, INTERNALS);
});

// ── S2: a setup that is only described is lost ──────────────────────────────

test('S2: facilitation_start can be called with what is known so far, so that a setup is stored before anything is asked', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-draft', FOUR);
  const answer = await h.tool('facilitation_start', { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'] }, { conversation: conv });
  assert.match(answer, /^Facilitation created/);
  assert.match(answer, /No definition of done was given/);
  assert.match(answer, /"A decision is made on: Pick a venue"/);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'configuring');
  // The confirming message finds the stored setup: it can simply be opened.
  assert.match(await h.tool('facilitation_open', {}, { conversation: conv }), /^Opened/);
  assert.match(h.kernel.groupPosts(conv)[0]?.text ?? '', /Done when \(version 1\): A decision is made on: Pick a venue/);
});

test('S2: a later call without a definition of done keeps the one that was agreed', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-draft-keep', FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'Everybody can live with the venue', method: 'single', options: ['Harbour', 'Garden'] }, { conversation: conv });
  const again = await h.tool('facilitation_start', { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden', 'Old Town'] }, { conversation: conv });
  assert.doesNotMatch(again, /No definition of done was given/);
  await h.tool('facilitation_open', {}, { conversation: conv });
  assert.match(h.kernel.groupPosts(conv)[0]?.text ?? '', /Done when \(version 1\): Everybody can live with the venue/);
});

test('S2: the description of facilitation_start says to call it first, because nothing is remembered between messages', async () => {
  const { buildTools } = await import('../src/tools/index.js');
  const start = buildTools({} as never).find((t) => t.spec.name === 'facilitation_start');
  assert.match(start?.spec.description ?? '', /^Call this FIRST/);
  assert.match(start?.spec.description ?? '', /no memory between messages/);
  assert.deepEqual((start?.spec.input_schema as { required?: string[] }).required, ['goal']);
});
