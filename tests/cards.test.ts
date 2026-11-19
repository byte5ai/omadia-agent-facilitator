// Question cards (1.1.0): a deciding step is put to the group as a card where
// the channel declares the kind, and as chat ballots otherwise. Both stay
// valid in one step, the newest answer of a person wins, and nothing a client
// sends back is trusted.

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import * as store from '../src/db/store.js';
import type { CardAnswerValue, CardSupport } from '../src/cards/types.js';
import { CARD_ID_PATTERN } from '../src/cards/types.js';
import { readExpected } from '../src/engine/cards.js';
import { ANNA, BERT, CARA, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const ALL_KINDS: CardSupport = { kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text', 'number', 'date'], maxQuestions: 5, update: true };
const THREE = [ANNA, BERT, CARA];
const RANKED = { goal: 'Pick the name', method: 'ranked', options: ['Alpha', 'Bravo', 'Charlie'], open: true };

let h: Harness;
before(async () => {
  // Many facilitations stay open in this file: the quotas are not its subject.
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, maxActiveInstance: 100, startsPerHourPerFacilitator: 100 } });
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

test('assignment on a card: volunteering counts at once, naming somebody else waits for that person', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-assign', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Who does what', method: 'assignment', options: ['Notes', 'Room'], open: true });
  const posted = card(conv).card;
  assert.deepEqual(
    posted.questions.map((q) => [q.id, q.kind, q.label, q.required, 'candidates' in q ? q.candidates : undefined, 'allowVolunteer' in q ? q.allowVolunteer : undefined]),
    [
      ['A', 'assignment', 'Notes', false, [{ id: 'anna', label: 'Anna' }, { id: 'bert', label: 'Bert' }, { id: 'cara', label: 'Cara' }], false],
      ['B', 'assignment', 'Room', false, [{ id: 'anna', label: 'Anna' }, { id: 'bert', label: 'Bert' }, { id: 'cara', label: 'Cara' }], false],
    ],
  );
  await submit(conv, 'anna', [{ questionId: 'A', kind: 'assignment', assignee: { kind: 'teams-aad', id: 'anna' } }]);
  assert.match(posts(conv).at(-1) ?? '', /Anna/);
  // Somebody who does not take part cannot be named, whatever the client sends.
  const before = (await outcomes(conv)).length;
  await submit(conv, 'bert', [{ questionId: 'B', kind: 'assignment', assignee: { kind: 'teams-aad', id: 'mallory' } }]);
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_invalid']);
  await submit(conv, 'bert', [{ questionId: 'B', kind: 'assignment', assignee: { kind: 'teams-aad', id: 'cara' } }]);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'Cara has not confirmed yet');
  assert.match(posts(conv).at(-1) ?? '', /Cara/);
  await say(conv, 'cara', 'yes');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(posts(conv).find((p) => /^Result for/.test(p)) ?? '', /Notes: Anna[\s\S]*Room: Cara/);
});

test('collecting ideas: a text field next to the chat, one idea per submission', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-ideas', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Agenda topics', agenda: [{ kind: 'collect', title: 'Collect topics' }, { kind: 'close', title: 'Close' }], open: true });
  const posted = card(conv);
  assert.deepEqual(posted.card.questions, [{ id: 'idea', kind: 'text', label: 'Your idea (one per submission)', multiline: true, maxLength: 2000, mode: 'append', required: true }]);
  await submit(conv, 'anna', [{ questionId: 'idea', kind: 'text', text: 'Budget for the offsite' }]);
  await submit(conv, 'anna', [{ questionId: 'idea', kind: 'text', text: 'Who books the venue' }]);
  await say(conv, 'bert', 'Catering');
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').map((c) => [c.participantPrincipal, c.payload['text'], c.source]), [
    ['user:anna', 'Budget for the offsite', 'card'],
    ['user:anna', 'Who books the venue', 'card'],
    ['user:bert', 'Catering', 'message'],
  ]);
  const before = (await outcomes(conv)).length;
  await submit(conv, 'cara', [{ questionId: 'idea', kind: 'text', text: 'x'.repeat(2001) }]);
  await submit(conv, 'cara', [{ questionId: 'idea', kind: 'text', text: '   ' }]);
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_invalid', 'card_answer_invalid']);
  // The step closes: the card has no inputs any more.
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.equal(h.kernel.cardUpdates.filter((u) => u.cardMessageId === posted.cardMessageId).length, 1);
});

test('a questionnaire: up to five structured questions on one card, answers read back by the facilitator', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-questionnaire', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Plan the offsite' });
  const asked = await tool(conv, 'facilitation_questionnaire', {
    title: 'Before we start',
    questions: [
      { id: 'day', label: 'Which day suits you?', kind: 'single_choice', options: ['Tuesday', 'Friday'] },
      { id: 'people', label: 'How many people do you bring?', kind: 'number', min: 0, max: 20 },
      { id: 'note', label: 'Anything I should know?', kind: 'text', required: false },
    ],
  });
  assert.match(asked, /^Posted as a card/);
  const posted = card(conv).card;
  assert.equal(posted.title, 'Before we start');
  assert.deepEqual(posted.questions.map((q) => [q.id, q.kind, q.required]), [['day', 'single_choice', true], ['people', 'number', true], ['note', 'text', false]]);

  await submit(conv, 'anna', [{ questionId: 'day', kind: 'single_choice', optionId: 'A' }, { questionId: 'people', kind: 'number', value: 3 }]);
  await submit(conv, 'bert', [{ questionId: 'day', kind: 'single_choice', optionId: 'B' }, { questionId: 'people', kind: 'number', value: 1 }, { questionId: 'note', kind: 'text', text: 'Vegetarian' }]);
  // Changed: the newest submission of a person replaces the earlier one.
  await submit(conv, 'anna', [{ questionId: 'day', kind: 'single_choice', optionId: 'B' }, { questionId: 'people', kind: 'number', value: 2 }]);
  // Out of range, a missing required answer, an unverified sender: not counted.
  await submit(conv, 'cara', [{ questionId: 'day', kind: 'single_choice', optionId: 'A' }, { questionId: 'people', kind: 'number', value: 99 }]);
  await submit(conv, 'cara', [{ questionId: 'people', kind: 'number', value: 2 }]);
  await submit(conv, 'cara', [{ questionId: 'day', kind: 'single_choice', optionId: 'A' }, { questionId: 'people', kind: 'number', value: 2 }], { verified: false });

  const answers = await tool(conv, 'facilitation_questionnaire_answers');
  assert.match(answers, /2 of 3 participants answered/);
  assert.match(answers, /Which day suits you\?: Tuesday 0, Friday 2/);
  assert.match(answers, /How many people do you bring\?: Anna: 2; Bert: 1/);
  assert.match(answers, /Anything I should know\?: Bert: Vegetarian/);
  assert.doesNotMatch(answers, /Cara/);

  // Asking again replaces the card; five questions are the limit; no cards, no questionnaire.
  assert.match(await tool(conv, 'facilitation_questionnaire', { title: 'x', questions: Array.from({ length: 6 }, (_v, i) => ({ id: `q${String(i)}`, label: 'q', kind: 'text' })) }), /^Refused \(bad_input\)/);
  h.kernel.cardSupport = undefined;
  assert.match(await tool(conv, 'facilitation_questionnaire', { title: 'x', questions: [{ id: 'a', label: 'q', kind: 'text' }] }), /^Refused \(no_cards\)/);
});

test('what does not fit a card stays a chat ballot, and what is too long is shortened', { skip: PG_SKIP }, async () => {
  const many = h.kernel.conversation('cd-many', THREE);
  await tool(many, 'facilitation_start', { ...RANKED, method: 'single', options: Array.from({ length: 25 }, (_v, i) => `Option ${String(i + 1)}`) });
  assert.equal(h.kernel.cards(many).length, 0, 'the abstention would be the 26th option');

  const long = h.kernel.conversation('cd-long', THREE);
  await tool(long, 'facilitation_start', { ...RANKED, goal: 'g'.repeat(400), method: 'single' });
  assert.equal(card(long).card.title.length, 300);

  // An Entra object id in its own case names the participant all the same.
  const GUID = '9F0C2A11-0b7e-4c1d-8a55-6d2e7b0a4c90';
  const people = h.kernel.conversation('cd-guid', [ANNA, { id: GUID, displayName: 'Teresita' }]);
  await tool(people, 'facilitation_start', { goal: 'Who does what', method: 'assignment', options: ['Notes'], open: true });
  const q = card(people).card.questions[0] as unknown as { candidates: { id: string }[] };
  assert.deepEqual(q.candidates.map((c) => c.id), ['anna', GUID.toLowerCase()]);
  await submit(people, 'anna', [{ questionId: 'A', kind: 'assignment', assignee: { kind: 'teams-aad', id: GUID } }]);
  assert.match(posts(people).at(-1) ?? '', /Teresita/);
});

test('somebody who does not take part cannot answer a card', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-outsider', THREE);
  await tool(conv, 'facilitation_start', { ...RANKED, participants: ['Anna', 'Bert'] });
  const before = (await outcomes(conv)).length;
  await submit(conv, 'cara', rank('A', 'B', 'C'));
  await submit(conv, 'mallory', rank('A', 'B', 'C'));
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_not_participant', 'card_answer_not_participant']);
  assert.deepEqual(await ballots(conv), {});
});

// ── 1.2.0: live finding D27 ─────────────────────────────────────────────────

const eventKinds = async (conv: string): Promise<string[]> => {
  const f = await h.facilitation(conv);
  const result = await h.db.pool.query<{ kind: string }>('SELECT kind FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 ORDER BY id', [f.id]);
  return result.rows.map((r) => r.kind);
};

test('D27: one task and one candidate is a card of its own with the volunteer button', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-assign-one', [ANNA]);
  await tool(conv, 'facilitation_start', { goal: 'Proofread the protocol', method: 'assignment', options: ['Proofread'], open: true });
  const posted = card(conv).card;
  assert.deepEqual(posted.questions.map((q) => [q.kind, (q as { candidates?: unknown }).candidates, (q as { allowVolunteer?: boolean }).allowVolunteer]), [['assignment', [{ id: 'anna', label: 'Anna' }], true]]);
  const kinds = await eventKinds(conv);
  assert.ok(kinds.includes('card_posted'));
  assert.ok(!kinds.includes('card_refused'));
  await submit(conv, 'anna', [{ questionId: 'A', kind: 'assignment', assignee: 'self' }]);
  assert.equal((await h.facilitation(conv)).phase, 'closed', 'the volunteer click counts');
});

test('D27: several tasks and one candidate never go on one card; the question is in the chat', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-assign-one-many', [ANNA]);
  await tool(conv, 'facilitation_start', { goal: 'Who does what', method: 'assignment', options: ['Notes', 'Room'], open: true });
  assert.equal(h.kernel.cards(conv).length, 0);
  const kinds = await eventKinds(conv);
  assert.ok(!kinds.includes('card_posted') && !kinds.includes('card_refused'), 'no card was tried');
});

test('D27: on a card with several tasks the volunteer button is not offered, and a click on it is not accepted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-assign-many', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Who does what', method: 'assignment', options: ['Notes', 'Room'], open: true });
  assert.deepEqual(card(conv).card.questions.map((q) => (q as { allowVolunteer?: boolean }).allowVolunteer), [false, false]);
  await submit(conv, 'anna', [{ questionId: 'A', kind: 'assignment', assignee: 'self' }]);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  const f = await h.facilitation(conv);
  assert.equal((await store.listContributions(h.db.pool, f.id)).length, 0);
});

test('D27: a card the channel refuses is recorded as refused, never as posted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-refused-record', THREE);
  h.kernel.refuseCards = 1;
  await tool(conv, 'facilitation_start', RANKED);
  assert.equal(h.kernel.cards(conv).length, 0);
  const f = await h.facilitation(conv);
  const events = await h.db.pool.query<{ kind: string; payload: Record<string, unknown> }>('SELECT kind, payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 ORDER BY id', [f.id]);
  const kinds = events.rows.map((r) => r.kind);
  assert.ok(!kinds.includes('card_posted'), 'nothing was posted as a card');
  const refused = events.rows.find((r) => r.kind === 'card_refused');
  assert.equal(refused?.payload['reason'], 'the card is too large');
  assert.equal(refused?.payload['postedAsText'], true);
});

// ── 1.2.0: live finding D29 ─────────────────────────────────────────────────

test('D29: a number or date question on a channel without those fields is a text field that says what is expected, and the answer is checked', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cd-number-text', THREE);
  // Teams declares no number and no date.
  h.kernel.cardSupport = { kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text'], maxQuestions: 5, update: true };
  await tool(conv, 'facilitation_start', { goal: 'Plan the test run' });
  const asked = await tool(conv, 'facilitation_questionnaire', {
    title: 'Test run',
    questions: [
      { id: 'minutes', label: 'How many minutes should the test run take?', kind: 'number', min: 1, max: 120 },
      { id: 'day', label: 'Which day?', kind: 'date', required: false },
    ],
  });
  assert.match(asked, /^Posted as a card/);
  const posted = card(conv).card;
  assert.deepEqual(posted.questions.map((q) => [q.id, q.kind]), [['minutes', 'text'], ['day', 'text']]);
  assert.match(posted.questions[0]?.help ?? '', /A number only, for example 15.*between 1 and 120/);
  assert.match(posted.questions[1]?.help ?? '', /2026-11-24 or 24\.11\.2026/);
  assert.ok(!JSON.stringify(posted).includes('expects'), "the engine's own note is not sent to the channel");

  // "15min" is read as 15; a date in the German form becomes the ISO date.
  await submit(conv, 'anna', [{ questionId: 'minutes', kind: 'text', text: '15min' }, { questionId: 'day', kind: 'text', text: '24.11.2026' }]);
  await submit(conv, 'bert', [{ questionId: 'minutes', kind: 'text', text: ' 7,5 Minuten ' }]);
  // No number, two numbers, out of range, no real date: refused with a hint to the person.
  const before = (await outcomes(conv)).length;
  const dms = h.kernel.dms.length;
  await submit(conv, 'cara', [{ questionId: 'minutes', kind: 'text', text: 'a quarter of an hour' }]);
  await submit(conv, 'cara', [{ questionId: 'minutes', kind: 'text', text: '10-15' }]);
  await submit(conv, 'cara', [{ questionId: 'minutes', kind: 'text', text: '500' }]);
  await submit(conv, 'cara', [{ questionId: 'minutes', kind: 'text', text: '15' }, { questionId: 'day', kind: 'text', text: '31.02.2026' }]);
  assert.deepEqual((await outcomes(conv)).slice(before), ['card_answer_invalid', 'card_answer_invalid', 'card_answer_invalid', 'card_answer_invalid']);
  const hints = h.kernel.dms.slice(dms).map((d) => d.text);
  assert.equal(hints.length, 4);
  assert.match(hints[0] ?? '', /"How many minutes should the test run take\?".*a number only, for example 15/i);
  assert.match(hints[2] ?? '', /between 1 and 120/);
  assert.match(hints[3] ?? '', /"Which day\?".*2026-11-24/);

  const answers = await tool(conv, 'facilitation_questionnaire_answers');
  assert.match(answers, /2 of 3 participants answered/);
  assert.match(answers, /How many minutes should the test run take\?: Anna: 15; Bert: 7\.5/);
  assert.match(answers, /Which day\?: Anna: 2026-11-24/);
  assert.doesNotMatch(answers, /Cara|15min|Minuten/);
});

test('D29: reading a number or a date out of what somebody typed', () => {
  const number = (text: string, min?: number, max?: number) => readExpected({ kind: 'number', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }, text);
  assert.equal(number('15'), '15');
  assert.equal(number('15min'), '15');
  assert.equal(number('ca. 15 Minuten'), '15');
  assert.equal(number('1,5'), '1.5');
  assert.equal(number('-3'), '-3');
  for (const bad of ['', 'viele', '10-15', '10 bis 15', '1.2.3']) assert.equal(number(bad), undefined, bad);
  assert.equal(number('0', 1), undefined);
  assert.equal(number('121', 1, 120), undefined);
  const date = (text: string) => readExpected({ kind: 'date' }, text);
  assert.equal(date('2026-11-24'), '2026-11-24');
  assert.equal(date('24.11.2026'), '2026-11-24');
  assert.equal(date('4.1.2027'), '2027-01-04');
  for (const bad of ['31.02.2026', '2026-13-01', 'next Tuesday', '24.11.', '24.11.26 or 25.11.26']) assert.equal(date(bad), undefined, bad);
});
