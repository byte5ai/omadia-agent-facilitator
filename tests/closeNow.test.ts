// D28 (live run): a vote that closes at the deadline could not be ended by the
// group. "weiter" and "einverstanden" were dropped without an answer, and the
// facilitator said it cannot close by hand. Closing early changes a rule, so
// it goes the way every rule change goes: a proposal the group consents to.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import { ANNA, BERT, CARA, createHarness, passWindow, validSummaries } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const outcomes = async (conv: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id])).rows.map((r) => r.outcome);
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
const atDeadline = (): Record<string, unknown> => ({ goal: 'Pick the name', method: 'ranked', options: ['Alpha', 'Bravo', 'Charlie'], open: true, closeRule: 'at_deadline', deadline: new Date(h.clock.now().getTime() + 48 * HOUR_MS).toISOString() });

test('D28: "next" in a vote proposes to close it now, and the group consents', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-next', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', atDeadline());
  await say(conv, 'anna', 'A > B > C');
  await say(conv, 'bert', 'A > C > B');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'it closes at the deadline');

  const turns = h.kernel.turns.length;
  await say(conv, 'anna', 'weiter');
  assert.equal((await outcomes(conv)).at(-1), 'move_on');
  assert.equal(h.kernel.turns.length, turns, 'read without a model');
  assert.match(posts(conv).at(-1) ?? '', /close the vote on "Pick the name" now and count the 2 of 3 votes cast/i);
  await say(conv, 'bert', 'yes');
  await say(conv, 'cara', 'yes');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'agreeing early does not end the window (spec 5.7)');
  await passWindow(h, conv);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(posts(conv).find((p) => /^Result for/.test(p)) ?? '', /Alpha/);
});

test('D28: an objection keeps the vote open until its deadline', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-objection', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', atDeadline());
  await say(conv, 'anna', 'A > B > C');
  await say(conv, 'anna', 'next');
  await say(conv, 'cara', 'no');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  // The vote goes on: a ballot still counts.
  await say(conv, 'cara', 'B > A > C');
  assert.equal((await validSummaries(h, conv, 'cara')).length, 1);
});

test('D28: nobody objects within the window: the vote closes with the votes cast, and a tie goes to a runoff instead of an abort', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-window', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', atDeadline());
  await say(conv, 'anna', 'A > B > C');
  await say(conv, 'bert', 'B > A > C');
  await say(conv, 'bert', 'next');
  h.clock.advance(31 * 60_000);
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'active', 'a tie is not a reason to end without a result');
  assert.ok(posts(conv).some((p) => /runoff/i.test(p)), 'the tied options go to a runoff');
});

test('D28: "next" before anybody voted, and a bare "agreed" with nothing to agree to, are answered once with what is possible', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-hint', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', atDeadline());
  const turns = h.kernel.turns.length;
  await say(conv, 'anna', 'weiter');
  assert.equal((await outcomes(conv)).at(-1), 'vote_open_hint');
  const hint = posts(conv).at(-1) ?? '';
  assert.match(hint, /closes at the deadline/i);
  assert.match(hint, /write "next"/i);
  assert.match(hint, /nobody has voted yet/i);

  await say(conv, 'bert', 'einverstanden');
  await say(conv, 'cara', 'ok');
  assert.deepEqual((await outcomes(conv)).slice(-2), ['vote_open_hint', 'vote_open_hint']);
  assert.equal(posts(conv).filter((p) => /closes at the deadline/i.test(p)).length, 2, 'once for "next" without votes, once for an agreement to nothing; not again');
  assert.equal(h.kernel.turns.length, turns, 'no model turn');
});

test('D28: the facilitator can put "close now" to the group; the tool never closes a vote by itself', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-tool', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', atDeadline());
  const none = await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(none, /^Refused \(no_votes\)/);
  assert.match(none, /closes at the deadline/);
  await say(conv, 'anna', 'A > B > C');
  const proposed = await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(proposed, /^Proposed to the group/);
  assert.match(proposed, /not closed yet/i);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'yes');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the group closes it when the window ends');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('D28: a vote that closes when everybody voted says so, and can be closed early the same way', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-all', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', { goal: 'Pick the name', method: 'single', options: ['Thai', 'Pizza'], open: true });
  await say(conv, 'bert', 'einverstanden');
  assert.match(posts(conv).at(-1) ?? '', /closes when everybody has voted/i);
  await say(conv, 'anna', 'A');
  await say(conv, 'anna', 'next');
  await say(conv, 'bert', 'yes');
  await say(conv, 'cara', 'yes');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('D28, as in the live run: the only participant has voted and writes "weiter": the vote closes when the window of that consent ends', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cn-alone', [ANNA]);
  await tool(conv, 'facilitation_start', atDeadline());
  await say(conv, 'anna', 'A > B > C');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await say(conv, 'anna', 'weiter');
  // Asking to close is agreeing to it; the window still runs (spec 5.7).
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(posts(conv).find((p) => /^Result for/.test(p)) ?? '', /Alpha/);
});
