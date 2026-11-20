// Criterion 57 (#2062): the vote is closed and the assignment runs; the group
// changes the voting method. A linked repeat step opens without a restart,
// old votes do not count in it, the decision and what followed from it are
// pending until the repeat closes and are then replaced; owners are told.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
async function say(conv: string, who: string, text: string) {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();

async function setUp(conv: string): Promise<string> {
  await startActive(h, conv, {
    goal: 'Venue and roles for the offsite',
    definitionOfDone: 'Venue and roles are decided',
    deadline: inHours(96),
    agenda: [
      { kind: 'decide', title: 'Venue', method: 'single', options: ['Harbour', 'Garden'] },
      { kind: 'assign', title: 'Roles', method: 'assignment', options: ['Booking', 'Transport'] },
      { kind: 'close', title: 'Close' },
    ],
  });
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  await say(conv, 'cara', 'B');
  const f = await h.facilitation(conv);
  const steps = await store.listSteps(h.db.pool, f.id);
  assert.equal(steps[0]?.status, 'closed', 'the vote closed with Harbour');
  assert.equal(steps[1]?.status, 'open', 'the assignment runs');
  await say(conv, 'bert', 'I take A');
  // The group changes how the venue is decided: a ranked vote.
  await tool(conv, 'facilitation_propose_change', { change: 'method', step: 1, method: 'ranked' });
  assert.match(posts(conv).at(-1) ?? '', /repeat the closed step "Venue" as a new step/);
  const proposal = await store.openProposal(h.db.pool, f.id);
  assert.ok(proposal);
  h.clock.set(new Date(proposal.windowEndsAt.getTime() + MINUTE_MS));
  await h.tick();
  return f.id;
}

test('criterion 57: a changed method repeats the closed vote as a linked step; the old decision and the running assignment are pending; the same outcome keeps them', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rp-same', [ANNA, BERT, CARA]);
  const id = await setUp(conv);
  const steps = await store.listSteps(h.db.pool, id);
  const [vote, repeat, roles] = steps;
  assert.equal(vote?.status, 'closed', 'the old step is never re-opened');
  assert.equal(repeat?.repeatsStepId, vote?.id);
  assert.equal(repeat?.status, 'open');
  assert.equal(repeat?.method, 'ranked');
  assert.equal(repeat?.title, 'Venue (repeat)');
  assert.equal(roles?.status, 'pending', 'the assignment waits for the repeat');
  assert.deepEqual((await store.listDecisions(h.db.pool, id)).map((d) => d.status), ['pending_repeat']);
  assert.ok(posts(conv).some((p) => /^"Venue" is repeated as a new step/.test(p)));
  assert.ok(posts(conv).some((p) => /^Bert: what you took on depends on "Venue"/.test(p)), 'the affected owner is told');
  // Old votes do not count in the repeat.
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: 0 of 3/);
  await say(conv, 'anna', 'A > B');
  await say(conv, 'bert', 'A > B');
  await say(conv, 'cara', 'B > A');
  const decisions = await store.listDecisions(h.db.pool, id);
  assert.deepEqual(decisions.map((d) => d.status), ['replaced', 'valid']);
  assert.equal(decisions[0]?.replacedBy, decisions[1]?.id);
  assert.ok(posts(conv).some((p) => /^The repeat of "Venue" closed with the same result/.test(p)));
  // The assignment resumes with what was said in it.
  const after = await store.listSteps(h.db.pool, id);
  assert.equal(after[2]?.status, 'open');
  const bert = (await store.listContributions(h.db.pool, id, after[2]?.id)).filter((c) => c.status === 'valid' && c.participantPrincipal === 'user:bert');
  assert.equal(bert.length, 1, 'Bert\'s assignment still holds');
});

test('criterion 57: a different outcome replaces the old decision; what followed from it no longer holds and its people are asked again', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rp-different', [ANNA, BERT, CARA]);
  const id = await setUp(conv);
  await say(conv, 'anna', 'B > A');
  await say(conv, 'bert', 'B > A');
  await say(conv, 'cara', 'B > A');
  const decisions = await store.listDecisions(h.db.pool, id);
  assert.deepEqual(decisions.map((d) => d.status), ['replaced', 'valid']);
  assert.match(decisions[1]?.statement ?? '', /Garden/);
  assert.ok(posts(conv).some((p) => /^The repeat of "Venue" closed with a different result/.test(p)));
  assert.ok(posts(conv).some((p) => /Please contribute again: Bert/.test(p)), 'Bert\'s assignment no longer fits');
  const roles = (await store.listSteps(h.db.pool, id))[2];
  assert.deepEqual((await store.listContributions(h.db.pool, id, roles?.id)).filter((c) => c.status === 'valid'), []);
  const protocol = await tool(conv, 'facilitation_protocol');
  assert.match(protocol, /Harbour.*\[replaced by the repeat\]/);
});

test('a second change while the repeat is open changes the repeat itself; an abort during a repeat leaves nothing pending', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rp-twice', [ANNA, BERT, CARA]);
  const id = await setUp(conv);
  await tool(conv, 'facilitation_propose_change', { change: 'method', step: 1, method: 'approval' });
  const proposal = await store.openProposal(h.db.pool, id);
  assert.ok(proposal);
  h.clock.set(new Date(proposal.windowEndsAt.getTime() + MINUTE_MS));
  await h.tick();
  const steps = await store.listSteps(h.db.pool, id);
  assert.equal(steps.filter((s) => s.repeatsStepId !== null).length, 1, 'no second repeat');
  assert.equal(steps[1]?.method, 'approval', 'the open repeat changed in place');
  await say(conv, 'anna', 'stop');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  assert.deepEqual((await store.listDecisions(h.db.pool, id)).map((d) => d.status), ['void']);
});
