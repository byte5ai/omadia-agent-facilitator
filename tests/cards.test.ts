// Question cards (1.1.0): a deciding step is put to the group as a card where
// the channel declares the kind, and as chat ballots otherwise. Both stay
// valid in one step, the newest answer of a person wins, and nothing a client
// sends back is trusted.

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import * as store from '../src/db/store.js';
import type { CardAnswerValue, CardSupport } from '../src/cards/types.js';
import { CARD_ID_PATTERN } from '../src/cards/types.js';
import { ANNA, BERT, CARA, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const ALL_KINDS: CardSupport = { kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text', 'number', 'date'], maxQuestions: 5, update: true };
const THREE = [ANNA, BERT, CARA];
const RANKED = { goal: 'Pick the name', method: 'ranked', options: ['Alpha', 'Bravo', 'Charlie'], open: true };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});
beforeEach(() => {
  if (!PG_SKIP) h.kernel.cardSupport = ALL_KINDS;
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const card = (conv: string, n = -1) => {
  const found = h.kernel.cards(conv).at(n);
  if (!found) throw new Error(`no card in ${conv}`);
  return found;
};
async function submit(conv: string, who: string, answers: CardAnswerValue[], forged: Parameters<Harness['kernel']['submitCard']>[4] = {}, n = -1): Promise<void> {
  await h.kernel.submitCard(conv, who, card(conv, n), answers, forged);
  await h.settle();
}
const outcomes = async (conv: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id])).rows.map((r) => r.outcome);
const ballots = async (conv: string): Promise<Record<string, unknown>> => {
  const f = await h.facilitation(conv);
  const valid = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
  return Object.fromEntries(valid.map((c) => [c.participantPrincipal, c.payload['ballot']]));
};
const rank = (...ranking: string[]): CardAnswerValue[] => [{ questionId: 'vote', kind: 'ranking', ranking }];

test('a ranked vote is a card where the channel has cards, chat ballots count next to it, and the card closes with the result', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-ranked', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  const f = await h.facilitation(conv);
  const step = await store.openStepOf(h.db.pool, f.id);
  const posted = card(conv);
  assert.match(posted.card.cardId, CARD_ID_PATTERN);
  assert.equal(posted.card.proposalId, step?.id);
  assert.equal(posted.card.proposalVersion, 1);
  assert.equal(posted.card.title, 'Pick the name');
  assert.deepEqual(posted.card.questions, [
    {
      id: 'vote',
      kind: 'ranking',
      label: 'Rank the options, best first.',
      options: [{ id: 'A', label: 'Alpha' }, { id: 'B', label: 'Bravo' }, { id: 'C', label: 'Charlie' }],
      ranks: 3,
      rankLabels: ['1st place (3 points)', '2nd place (2 points)', '3rd place (1 point)'],
      required: true,
    },
  ]);
  // The text of the same message says that the chat counts as well.
  assert.match(posted.text, /Pick the name/);
  assert.match(posted.text, /in the chat/);
  assert.equal(h.kernel.groupPosts(conv).filter((p) => p.poll !== undefined).length, 0, 'no poll next to the card');

  await submit(conv, 'anna', rank('A', 'C', 'B'));
  assert.equal(posts(conv).at(-1), 'Recorded for you, Anna: A (Alpha) > C (Charlie) > B (Bravo)');
  await say(conv, 'bert', 'A > B > C');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await submit(conv, 'cara', rank('B', 'A'));
  assert.equal((await h.facilitation(conv)).phase, 'closed');

  const updates = h.kernel.cardUpdates.filter((u) => u.conversationId === conv);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.cardMessageId, posted.cardMessageId);
  assert.equal(updates[0]?.update.state, 'closed');
  const closed = updates[0]?.update as unknown as { title: string; resultLines: string[]; closedAt: string };
  assert.equal(closed.title, 'Pick the name');
  assert.match(closed.resultLines.join('\n'), /Alpha/);
  assert.ok(!Number.isNaN(Date.parse(closed.closedAt)));
});

test('the newest answer of a person wins, whether typed or clicked', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-newest', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  await submit(conv, 'anna', rank('A', 'B', 'C'));
  await say(conv, 'anna', 'B > A > C');
  assert.deepEqual((await ballots(conv))['user:anna'], { type: 'ranked', ranking: ['B', 'A', 'C'] });
  await submit(conv, 'anna', rank('C', 'B', 'A'));
  assert.deepEqual((await ballots(conv))['user:anna'], { type: 'ranked', ranking: ['C', 'B', 'A'] });
  assert.equal(Object.keys(await ballots(conv)).length, 1, 'one effective answer per person');
});

test('a kernel or a channel without cards: chat ballots as before', { skip: PG_SKIP }, async () => {
  h.kernel.cardSupport = undefined;
  const conv = h.kernel.conversation('cd-none', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  assert.equal(h.kernel.cards(conv).length, 0);
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A > B > C');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(h.kernel.cardUpdates.filter((u) => u.conversationId === conv).length, 0);

  // A channel that has cards but not this kind.
  h.kernel.cardSupport = { kinds: ['single_choice', 'text'], maxQuestions: 5, update: true };
  const partial = h.kernel.conversation('cd-partial', THREE);
  await tool(partial, 'facilitation_start', RANKED);
  assert.equal(h.kernel.cards(partial).length, 0);
});

test('single choice and approval are cards too, with an abstention', { skip: PG_SKIP }, async () => {
  const single = h.kernel.conversation('cd-single', THREE);
  await tool(single, 'facilitation_start', { ...RANKED, method: 'single' });
  assert.deepEqual(card(single).card.questions.map((q) => [q.kind, 'options' in q ? q.options.map((o) => o.id) : []]), [['single_choice', ['A', 'B', 'C', 'abstain']]]);
  await submit(single, 'anna', [{ questionId: 'vote', kind: 'single_choice', optionId: 'B' }]);
  await submit(single, 'bert', [{ questionId: 'vote', kind: 'single_choice', optionId: 'abstain' }]);
  assert.deepEqual(await ballots(single), { 'user:anna': { type: 'single', choice: 'B' }, 'user:bert': { type: 'abstention' } });

  const approval = h.kernel.conversation('cd-approval', THREE);
  await tool(approval, 'facilitation_start', { ...RANKED, method: 'approval' });
  assert.equal(card(approval).card.questions[0]?.kind, 'multiple_choice');
  await submit(approval, 'anna', [{ questionId: 'vote', kind: 'multiple_choice', optionIds: ['A', 'C'] }]);
  assert.deepEqual((await ballots(approval))['user:anna'], { type: 'approval', choices: ['A', 'C'] });
  await submit(approval, 'bert', [{ questionId: 'vote', kind: 'multiple_choice', optionIds: ['A', 'abstain'] }]);
  assert.equal((await ballots(approval))['user:bert'], undefined, 'abstaining and choosing at once is not an answer');
});

test('nothing a client sends back is trusted: a forged answer is dropped, on record', { skip: PG_SKIP }, async () => {
  const other = h.kernel.conversation('cd-other', THREE);
  await tool(other, 'facilitation_start', RANKED);
  const conv = h.kernel.conversation('cd-forged', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  const before = (await outcomes(conv)).length;

  await submit(conv, 'anna', rank('A', 'B', 'C'), { proposalVersion: 7 });
  await submit(conv, 'anna', rank('A', 'B', 'C'), { proposalId: 'another-proposal' });
  await submit(conv, 'anna', rank('A', 'B', 'C'), { cardId: card(other).card.cardId });
  await submit(conv, 'anna', rank('A', 'B', 'Z'));
  await submit(conv, 'anna', rank('A', 'A', 'B'));
  await submit(conv, 'anna', rank('A', 'B', 'C', 'A'));
  await submit(conv, 'anna', [{ questionId: 'vote', kind: 'single_choice', optionId: 'A' }]);
  await submit(conv, 'anna', [{ questionId: 'another', kind: 'ranking', ranking: ['A'] }]);
  await submit(conv, 'anna', []);
  await submit(conv, 'anna', [...rank('A', 'B', 'C'), ...rank('C', 'B', 'A')]);
  assert.deepEqual((await outcomes(conv)).slice(before), [
    'card_answer_stale',
    'card_answer_stale',
    'card_answer_foreign',
    'card_answer_invalid',
    'card_answer_invalid',
    'card_answer_invalid',
    'card_answer_invalid',
    'card_answer_invalid',
    'card_answer_invalid',
    'card_answer_invalid',
  ]);
  assert.deepEqual(await ballots(conv), {});
  assert.deepEqual(await ballots(other), {}, 'and nothing lands in the other facilitation');

  // An answer after the close does not reopen anything.
  for (const who of ['anna', 'bert', 'cara']) await submit(conv, who, rank('A', 'B', 'C'));
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  await submit(conv, 'anna', rank('C', 'B', 'A'));
  assert.deepEqual((await ballots(conv))['user:anna'], { type: 'ranked', ranking: ['A', 'B', 'C'] });
});

test('an answer the platform could not verify does not count until its owner confirmed it in the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-unverified', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  await submit(conv, 'anna', rank('A', 'B', 'C'), { verified: false });
  assert.deepEqual(await ballots(conv), {});
  assert.match(posts(conv).at(-1) ?? '', /^Anna, an answer on the card came in under your name, and the channel could not confirm that it is yours: A \(Alpha\) > B \(Bravo\) > C \(Charlie\)\. Reply "yes"/);
  await say(conv, 'anna', 'yes');
  assert.deepEqual((await ballots(conv))['user:anna'], { type: 'ranked', ranking: ['A', 'B', 'C'] });
});

test('consent on a card: an objection needs its reason', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-consent', THREE);
  await tool(conv, 'facilitation_start', { goal: 'We go with plan B', method: 'consent', statement: 'Plan B from December', open: true });
  const q = card(conv).card.questions[0];
  assert.deepEqual(q, { id: 'vote', kind: 'consent', label: 'Plan B from December', agreeLabel: 'consent', objectLabel: 'objection', reasonRequiredOnObject: true, required: true });
  const before = (await outcomes(conv)).length;
  await submit(conv, 'anna', [{ questionId: 'vote', kind: 'consent', decision: 'object' }]);
  await submit(conv, 'anna', [{ questionId: 'vote', kind: 'consent', decision: 'object', reason: '   ' }]);
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_invalid', 'card_answer_invalid']);
  await submit(conv, 'anna', [{ questionId: 'vote', kind: 'consent', decision: 'object', reason: 'Too early for the team' }]);
  assert.deepEqual((await ballots(conv))['user:anna'], { type: 'consent', consent: false, reason: 'Too early for the team' });
  await submit(conv, 'bert', [{ questionId: 'vote', kind: 'consent', decision: 'agree' }]);
  assert.deepEqual((await ballots(conv))['user:bert'], { type: 'consent', consent: true });
});

test('a change of the method by consent posts a new version of the card and marks the old one superseded', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-version', THREE);
  await tool(conv, 'facilitation_start', RANKED);
  const first = card(conv);
  await submit(conv, 'anna', rank('A', 'B', 'C'));
  await tool(conv, 'facilitation_propose_change', { change: 'method', method: 'single' });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  const second = card(conv);
  assert.notEqual(second.card.cardId, first.card.cardId);
  assert.equal(second.card.proposalId, first.card.proposalId);
  assert.equal(second.card.proposalVersion, 2);
  assert.equal(second.card.questions[0]?.kind, 'single_choice');
  const superseded = h.kernel.cardUpdates.filter((u) => u.cardMessageId === first.cardMessageId);
  assert.equal(superseded.length, 1);
  assert.deepEqual((superseded[0]?.update as unknown as { resultLines: string[] }).resultLines, ['Replaced by a new version of this vote. Please answer on the new card.']);
  // The old card is still on people's screens: an answer on it never counts.
  const before = (await outcomes(conv)).length;
  await submit(conv, 'bert', rank('A', 'B', 'C'), {}, 0);
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_closed']);
  await submit(conv, 'bert', [{ questionId: 'vote', kind: 'single_choice', optionId: 'C' }]);
  assert.deepEqual((await ballots(conv))['user:bert'], { type: 'single', choice: 'C' });
});

test('a runoff is a new card for the options that are tied', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-runoff', [ANNA, BERT]);
  await tool(conv, 'facilitation_start', { ...RANKED, method: 'single', options: ['Alpha', 'Bravo'] });
  await submit(conv, 'anna', [{ questionId: 'vote', kind: 'single_choice', optionId: 'A' }]);
  await submit(conv, 'bert', [{ questionId: 'vote', kind: 'single_choice', optionId: 'B' }]);
  assert.equal(h.kernel.cards(conv).length, 2);
  assert.equal(card(conv).card.proposalVersion, 2);
  assert.equal(h.kernel.cardUpdates.filter((u) => u.cardMessageId === card(conv, 0).cardMessageId).length, 1);
  for (const who of ['anna', 'bert']) await submit(conv, who, [{ questionId: 'vote', kind: 'single_choice', optionId: 'A' }]);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('a card the channel refuses or cannot update costs nothing: the question and the result are in the chat', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-refused', THREE);
  // The channel declares the kind and still refuses this card.
  h.kernel.refuseCards = 1;
  await tool(conv, 'facilitation_start', RANKED);
  const afterStart = posts(conv);
  assert.equal(h.kernel.cards(conv).length, 0);
  assert.ok(afterStart.some((p) => /Rank the options|rank the options/.test(p)), 'the rules are in the chat');
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A > B > C');
  assert.equal((await h.facilitation(conv)).phase, 'closed');

  const noUpdate = h.kernel.conversation('cd-no-update', THREE);
  await tool(noUpdate, 'facilitation_start', RANKED);
  h.kernel.cardUpdateFaults.push({ code: 'channel_error', message: 'the message is gone' });
  for (const who of ['anna', 'bert', 'cara']) await submit(noUpdate, who, rank('A', 'B', 'C'));
  assert.equal((await h.facilitation(noUpdate)).phase, 'closed');
  assert.ok(posts(noUpdate).some((p) => /^Result for "Pick the name"/.test(p)));
});
