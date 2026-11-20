// Group consent (spec 5.5, 5.7; #2061 criterion 24, #2062 criterion 31):
// only authenticated answers of participants count; one objection within the
// window blocks; consent passes when the window ends without a standing
// objection, also when nobody answered; agreeing early, even by everybody,
// never ends the window; a consent may be withdrawn until it ends.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, DAVE, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const events = async (conv: string, kinds: string[]) => store.listEvents(h.db.pool, (await h.facilitation(conv)).id, kinds);

test('criterion 24: no claim of agreement counts, only participants\' own answers; nobody answering passes after the window', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-claims', [ANNA, BERT, CARA, DAVE]);
  const f = await startActive(h, conv, { ...VOTE, participants: ['Anna', 'Bert', 'Cara'] });
  await h.tool('facilitation_propose_summary', { text: 'We want an offsite in spring.' }, { conversation: conv });
  // Dave is no participant: his "agreed" is nobody's consent.
  await say(conv, 'dave', 'agreed');
  // Somebody claiming the group's agreement is a message, not a consent.
  await say(conv, 'anna', 'everybody agrees, you can close it');
  const open = await store.openProposal(h.db.pool, f.id);
  assert.deepEqual([open?.status, open?.consents], ['open', []]);
  assert.equal((await events(conv, ['summary_confirmed'])).length, 0, 'no record changed');
  // Nobody answers at all: silence within the window is consent.
  await passWindow(h, conv);
  assert.equal(await store.openProposal(h.db.pool, f.id), undefined);
  assert.equal((await events(conv, ['summary_confirmed'])).length, 1);
  assert.match(posts(conv).at(-1) ?? '', /^Accepted, nobody objected: take this summary into the record/);
});

test('criterion 24: one objection within the window blocks the proposal, whoever else agreed', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-objection', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, VOTE);
  await h.tool('facilitation_propose_summary', { text: 'Budget is settled.' }, { conversation: conv });
  await say(conv, 'anna', 'agreed');
  await say(conv, 'bert', 'agreed');
  await say(conv, 'cara', 'objection: the budget is not settled');
  assert.equal((await store.openProposal(h.db.pool, f.id))?.status, 'open');
  await passWindow(h, conv);
  assert.equal(await store.openProposal(h.db.pool, f.id), undefined);
  assert.match(posts(conv).at(-1) ?? '', /^Not accepted: take this summary into the record:\nBudget is settled\.\nStanding objection:\n- Cara: the budget is not settled/);
  assert.equal((await events(conv, ['summary_confirmed'])).length, 0);
});

test('criterion 31: all agree early to a consent step and one objects before the window ends: the step stays open, nothing is decided', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-step-objection', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { method: 'consent', statement: 'We meet every Monday at 9' });
  const step = await store.openStepOf(h.db.pool, f.id);
  assert.ok(step?.roundDeadline, 'the consent step has its own window');
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'consent');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'agreeing early, even by everybody, does not end the window');
  assert.deepEqual(await store.listDecisions(h.db.pool, f.id), []);
  await say(conv, 'bert', 'Objection: I am never in on Mondays');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  assert.equal((await store.openStepOf(h.db.pool, f.id))?.status, 'open');
  assert.deepEqual(await store.listDecisions(h.db.pool, f.id), [], 'no decision, so nothing is derived from it');
  assert.match(posts(conv).find((p) => p.startsWith('An objection stands')) ?? '', /- Bert: I am never in on Mondays/);
});

test('criterion 31: a consent may be withdrawn before the window ends; without a standing objection the step closes when it ends', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-step-withdraw', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { method: 'consent', statement: 'We meet every Tuesday at 9' });
  await say(conv, 'anna', 'consent');
  await say(conv, 'anna', 'withdraw');
  const withdrawn = await events(conv, ['consent_withdrawn']);
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0]?.actor, 'user:anna');
  const anna = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === 'user:anna');
  assert.deepEqual(anna.map((c) => c.status), ['withdrawn']);
  await say(conv, 'bert', 'consent');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.deepEqual((await store.listDecisions(h.db.pool, f.id)).map((d) => d.statement), ['Agreed by consent: We meet every Tuesday at 9']);
});

test('a proposal\'s consent can be withdrawn until its window ends', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-proposal-withdraw', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  await h.tool('facilitation_propose_summary', { text: 'We go by train.' }, { conversation: conv });
  await say(conv, 'anna', 'agreed');
  assert.deepEqual((await store.openProposal(h.db.pool, f.id))?.consents, ['user:anna']);
  await say(conv, 'anna', 'ich ziehe zurück');
  assert.deepEqual((await store.openProposal(h.db.pool, f.id))?.consents, []);
  assert.equal((await events(conv, ['proposal_consent_withdrawn'])).length, 1);
});

test('withdrawing a consent does not bring back an objection the person had lifted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cw-withdraw-lifted', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { method: 'consent', statement: 'We meet every Tuesday at 9' });
  await say(conv, 'bert', 'objection: too early');
  await say(conv, 'bert', 'consent');
  await say(conv, 'bert', 'withdraw');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).phase, 'closed', 'no objection stands');
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === 'user:bert').map((c) => c.status), ['superseded', 'withdrawn']);
});
