import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, FOUR, createHarness, startActive, validSummaries, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VENUES = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'] };
const last = (conv: string): string => h.kernel.groupPosts(conv).at(-1)?.text ?? '';
const status = (conv: string): Promise<string> => h.tool('facilitation_status', {}, { conversation: conv });
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const contributions = async (conv: string) => store.listContributions(h.db.pool, (await h.facilitation(conv)).id);

test('the handshake announces the method, the options and how to vote', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-handshake', FOUR);
  await startActive(h, conv, VENUES);
  const handshake = h.kernel.groupPosts(conv)[0]?.text ?? '';
  assert.match(handshake, /rank the options, best first, e\.g\. "A > C > B"/);
  assert.match(handshake, /A = Harbour, B = Old Town, C = Castle Hill/);
  assert.match(handshake, /Points per rank: 3\/2\/1/);
  assert.match(handshake, /"abstain" counts as a contribution/);
  assert.match(handshake, /A tie goes to a runoff/);
});

test('ranked vote: every ballot is recorded quietly without a model, the last one concludes, the result goes to the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-ranked', FOUR);
  await startActive(h, conv, VENUES);
  const turns = h.kernel.turns.length;

  const quiet = h.kernel.groupPosts(conv).length;
  await say(conv, 'anna', 'A > C > B');
  assert.equal(h.kernel.groupPosts(conv).length, quiet, 'no echo in the group (spec 5.14)');
  assert.deepEqual(await validSummaries(h, conv, 'anna'), ['A (Harbour) > C (Castle Hill) > B (Old Town)']);
  assert.match(await status(conv), /Contributed: 1 of 4\nStill open: 3 contributions/);
  await say(conv, 'bert', 'a, b');
  assert.match(await status(conv), /Contributed: 2 of 4\nStill open: 2 contributions/);
  await say(conv, 'cara', 'Castle Hill > Harbour');
  assert.match(await status(conv), /Still open: 1 contribution/);
  assert.equal((await h.facilitation(conv)).phase, 'active');

  await say(conv, 'dave', 'B > A > C');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal(f.closeReason, 'result');
  const posts = h.kernel.groupPosts(conv).map((p) => p.text);
  assert.match(posts.at(-1) ?? '', /^Result for "Pick a venue":\n- Pick a venue: Harbour \(Harbour 10, Old Town 6, Castle Hill 6\)/);
  assert.equal(h.kernel.turns.length, turns, 'no model was involved in recording or counting');
  const decisions = await store.listDecisions(h.db.pool, f.id);
  assert.deepEqual(decisions.map((d) => d.result['winner']), ['A']);

  await say(conv, 'anna', 'B > A');
  assert.equal(h.kernel.groupPosts(conv).length, posts.length, 'nothing is recorded or said after the conclusion');
  assert.equal((await contributions(conv)).filter((c) => c.status === 'valid').length, 4);
});

test('a ballot can be changed until the conclusion: by a new message and by editing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-change', FOUR);
  await startActive(h, conv, VENUES);
  const first = await say(conv, 'anna', 'A > B');
  const second = await say(conv, 'anna', 'C > B');
  assert.deepEqual(await validSummaries(h, conv, 'anna'), ['C (Castle Hill) > B (Old Town)']);
  // Spec 5.3: an edit only changes its own ballot while that ballot is the
  // effective one, and never displaces a newer ballot (criterion 64).
  await h.kernel.edit(conv, 'anna', first.messageId, 'A');
  await h.settle();
  assert.deepEqual(await validSummaries(h, conv, 'anna'), ['C (Castle Hill) > B (Old Town)'], 'the edit of a replaced ballot changes nothing');
  await h.kernel.edit(conv, 'anna', second.messageId, 'B');
  await h.settle();
  assert.deepEqual(await validSummaries(h, conv, 'anna'), ['B (Old Town)']);
  const all = await contributions(conv);
  assert.deepEqual(all.map((c) => c.status).sort(), ['superseded', 'superseded', 'valid']);
  assert.equal(all.find((c) => c.status === 'valid')?.sourceRevision, 1, 'the edited ballot counts in its latest revision');
  assert.match(await status(conv), /Contributed: 1 of \d+\n/);
});

test('a duplicate option is refused with one hint and does not count; a quoted ballot records nothing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-invalid', FOUR);
  await startActive(h, conv, VENUES);
  const bad = await say(conv, 'bert', 'A > A > C');
  assert.equal(last(conv), 'Bert, an option appears twice (A > A > C). Please name each option once.');
  const posts = h.kernel.groupPosts(conv).length;
  await h.engine.receive('mira', bad);
  assert.equal(h.kernel.groupPosts(conv).length, posts);
  assert.match(await status(conv), /Contributed: 0 of \d+/);

  await say(conv, 'cara', 'A > B > C', { quoted: true });
  await say(conv, 'cara', 'B > A', { forwarded: true });
  assert.deepEqual((await contributions(conv)).map((c) => c.status), ['ambiguous']);
  assert.match(await status(conv), /Still open: 4 contributions/);
});

test('a ballot the facilitator read from free text counts only after its author confirmed, then concludes', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-interpreted', [ANNA, BERT]);
  await startActive(h, conv, VENUES);
  await say(conv, 'anna', 'A');
  const free = await say(conv, 'bert', 'for me the old town, then the harbour I suppose');
  const answer = await h.tool('facilitation_record_contribution', { messageId: free.messageId, kind: 'vote', summary: 'Old Town first, then Harbour', ballot: 'B > A' }, { conversation: conv });
  assert.match(answer, /^Recorded for Bert as unconfirmed/);
  assert.match(last(conv), /^Bert, I read your message as: B \(Old Town\) > A \(Harbour\)/);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'a misread can never conclude a facilitation');
  assert.match(await h.tool('facilitation_record_contribution', { messageId: free.messageId, kind: 'vote', summary: 'x', ballot: 'Z > Q' }, { conversation: conv }), /^(Already recorded|Refused)/);

  await say(conv, 'bert', 'yes');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(last(conv), /Harbour 5, Old Town 3, Castle Hill 0/);
});

test('a tie starts a runoff among the tied options; the runoff decides', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-runoff', FOUR);
  await startActive(h, conv, { ...VENUES, deadline: '2026-11-25T09:00:00Z' });
  await say(conv, 'anna', 'A > B');
  await say(conv, 'bert', 'B > A');
  await say(conv, 'cara', 'A > B');
  await say(conv, 'dave', 'B > A');
  let f = await h.facilitation(conv);
  assert.equal(f.phase, 'active');
  assert.match(last(conv), /^The vote ended level between Harbour and Old Town\. Runoff among these, same method, until /);
  const step = (await store.listSteps(h.db.pool, f.id))[0];
  assert.equal(step?.round, 2);
  assert.deepEqual(step?.roundOptions?.map((o) => o.key), ['A', 'B']);
  assert.equal(step?.roundDeadline?.toISOString(), new Date(h.clock.now().getTime() + 12 * 3600_000).toISOString(), 'default runoff window: 12 h');
  assert.match(await status(conv), /Still open: 4 contributions/, 'the runoff is a new round');

  await say(conv, 'anna', 'C');
  assert.equal(last(conv), 'Anna, the runoff is only between Harbour and Old Town. Please choose among these.');
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  await say(conv, 'cara', 'B');
  await say(conv, 'dave', 'abstain');
  f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(last(conv), /Harbour \(Harbour 6, Old Town 3\)/);
});

test('consent: an objection keeps it open and is announced once; an amended proposal passes', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-consent', [ANNA, BERT, CARA]);
  await startActive(h, conv, { method: 'consent', statement: 'We meet every Monday at 9' });
  assert.match(h.kernel.groupPosts(conv)[0]?.text ?? '', /Proposal: We meet every Monday at 9\. Write "consent"/);
  await say(conv, 'anna', 'consent');
  await say(conv, 'bert', 'Objection: I am never in on Mondays');
  assert.deepEqual(await validSummaries(h, conv, 'bert'), ['objection: I am never in on Mondays']);
  await say(conv, 'cara', 'einverstanden');
  // Consent is decided when its window ends (spec 5.7), not when everybody answered.
  await passWindow(h, conv);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'active');
  const announced = () => h.kernel.groupPosts(conv).filter((p) => p.text.startsWith('An objection stands')).length;
  assert.equal(announced(), 1);
  assert.match(h.kernel.groupPosts(conv).find((p) => p.text.startsWith('An objection stands'))?.text ?? '', /- Bert: I am never in on Mondays/);
  await say(conv, 'cara', 'so what now?');
  assert.equal(announced(), 1, 'not repeated after every message');

  assert.match(await h.tool('facilitation_put_again', { statement: 'We meet every Tuesday at 9' }, { conversation: conv }), /posted/);
  assert.match(last(conv), /^Amended proposal: We meet every Tuesday at 9/);
  await say(conv, 'anna', 'consent');
  await say(conv, 'bert', 'consent');
  await say(conv, 'cara', 'consent');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'agreeing early does not end the window');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(last(conv), /- Agreed by consent: We meet every Tuesday at 9/);
});

test('assignment: one confirmed name per role; a declined nomination reopens the role', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-assign', [ANNA, BERT, CARA]);
  await startActive(h, conv, { goal: 'Roles for the workshop', method: 'assignment', options: ['Chair', 'Notes'] });
  await say(conv, 'anna', 'I take A');
  assert.deepEqual(await validSummaries(h, conv, 'anna'), ['A (Chair): Anna']);
  const nominated = await say(conv, 'anna', 'B: Bert');
  assert.equal(last(conv), 'Bert, Anna proposes you for Notes. Reply "yes" to take it or "no" to decline, here in the group.');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'a name somebody else gave does not bind');
  await say(conv, 'cara', 'yes');
  assert.equal((await h.facilitation(conv)).phase, 'active', "somebody else's yes confirms nothing");

  await say(conv, 'bert', 'no');
  assert.equal(last(conv), 'Bert declined Notes. It is open again.');
  await say(conv, 'bert', 'B: Cara');
  await say(conv, 'cara', 'A: Cara');
  assert.equal(last(conv), 'Cara, Chair is already taken by Anna.');
  await say(conv, 'cara', 'ja');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(last(conv), /- Roles for the workshop: Chair: Anna; Notes: Cara/);
  assert.ok(nominated.messageId);
});

test('"every participant" means every active one: the last missing person leaving completes the vote', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('de-leave', FOUR);
  await startActive(h, conv, VENUES);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  await say(conv, 'cara', 'B');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  h.kernel.leave(conv, 'dave');
  await h.settle();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(last(conv), /Harbour 6, Old Town 3/);
});
