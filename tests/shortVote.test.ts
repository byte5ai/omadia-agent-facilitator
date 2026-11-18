// A request that is just a vote gets the shortest process (first live run,
// item 2): one deciding step, open right after the handshake. The live run
// got the five-step "decision" agenda and the initiator had to write "weiter"
// and "einverstanden" four times before anybody could vote.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { agendaFor } from '../src/engine/lifecycle.js';
import { buildTools } from '../src/tools/index.js';
import { ANNA, BERT, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const CONFIG = { rankedPoints: [3, 2, 1], language: 'en' as const };
const RANKED = { method: 'ranked' as const, options: ['Alpha', 'Bravo', 'Charlie'] };

test('a complete vote is one deciding step, whatever template was named with it', () => {
  for (const format of ['decision', 'prioritisation', undefined] as const) {
    const agenda = agendaFor({ goal: 'Pick the name', decision: RANKED, ...(format ? { format } : {}) }, CONFIG);
    assert.deepEqual(agenda.map((s) => [s.kind, s.title, s.options?.length]), [['decide', 'Pick the name', 3]], String(format));
  }
  assert.deepEqual(agendaFor({ goal: 'Who does what', format: 'assignment', decision: { method: 'assignment', options: ['Notes'] } }, CONFIG).map((s) => s.kind), ['assign']);
  assert.deepEqual(agendaFor({ goal: 'We go with plan B', format: 'decision', decision: { method: 'consent', options: [], statement: 'Plan B' } }, CONFIG).map((s) => s.kind), ['decide']);
});

test('a template stays when there is something to do before the vote', () => {
  // The options are still to be found.
  assert.equal(agendaFor({ goal: 'Pick a name', format: 'decision' }, CONFIG).length, 5);
  assert.equal(agendaFor({ goal: 'Pick a name', format: 'decision', decision: { method: 'ranked', options: [] } }, CONFIG).length, 5);
  // These formats are about what happens before a decision.
  assert.equal(agendaFor({ goal: 'Look back', format: 'retrospective', decision: RANKED }, CONFIG).length, 7);
  assert.equal(agendaFor({ goal: 'Align', format: 'alignment', decision: { method: 'consent', options: [], statement: 'x' } }, CONFIG).length, 5);
  // An agenda the group asked for is kept as it is.
  const own = agendaFor({ goal: 'Pick', format: 'decision', decision: RANKED, agenda: [{ kind: 'discuss', title: 'Talk first' }, { kind: 'decide', title: 'Vote', decision: RANKED }] }, CONFIG);
  assert.deepEqual(own.map((s) => s.kind), ['discuss', 'decide']);
});

test('the tool says how a plain vote is set up', () => {
  const spec = buildTools({} as never).find((t) => t.spec.name === 'facilitation_start')?.spec;
  const text = JSON.stringify(spec);
  assert.match(text, /just a vote/i);
  assert.match(text, /one deciding step/i);
});

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('a ranked vote asked for with the "decision" format: the vote is open after the handshake and the first ballots conclude it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sv-live', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'Pick the name', format: 'decision', method: 'ranked', options: ['Alpha', 'Bravo', 'Charlie'], open: true }, { conversation: conv });
  const f = await h.facilitation(conv);
  const steps = await store.listSteps(h.db.pool, f.id);
  assert.deepEqual(steps.map((s) => [s.kind, s.status]), [['decide', 'open']]);
  const posts = (): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
  assert.equal(posts().length, 1, 'the handshake and nothing to confirm before voting');
  assert.doesNotMatch(posts()[0] ?? '', /Agenda:/);
  assert.match(posts()[0] ?? '', /rank the options/);
  for (const who of ['anna', 'bert']) {
    await h.kernel.say(conv, who, 'A > C > B');
    await h.settle();
  }
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});
