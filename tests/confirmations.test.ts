// Confirmation requests and later votes (review finding 1).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import type { Ballot } from '../src/methods/ballot.js';
import { ANNA, BERT, FOUR, createHarness, startActive } from './harness.js';
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
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const read = (conv: string, messageId: string, ballot: string): Promise<string> =>
  h.tool('facilitation_record_contribution', { messageId, kind: 'vote', summary: 'x', ballot }, { conversation: conv });
async function counted(conv: string, principal: string): Promise<Ballot | undefined> {
  const f = await h.facilitation(conv);
  const step = (await store.listSteps(h.db.pool, f.id))[0];
  const valid = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid' && c.participantPrincipal === principal && c.round === step?.round);
  assert.ok(valid.length <= 1, 'one counted ballot per person and round');
  return valid[0]?.payload['ballot'] as Ballot | undefined;
}
const pending = async (conv: string, principal: string) => store.pendingAcks(h.db.pool, (await h.facilitation(conv)).id, principal);

test('review 1: a direct vote cancels the open confirmation request; a later "ja" does not bring the old reading back', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cf-leftover', FOUR);
  await startActive(h, conv, VENUES);
  const free = await say(conv, 'anna', 'the old town, I think');
  await read(conv, free.messageId, 'B');
  assert.equal((await pending(conv, 'user:anna')).length, 1);

  await say(conv, 'anna', 'A > C'); // votes directly instead of confirming
  assert.deepEqual(await counted(conv, 'user:anna'), { type: 'ranked', ranking: ['A', 'C'] });
  assert.equal((await pending(conv, 'user:anna')).length, 0, 'the request is cancelled by the vote');

  await say(conv, 'anna', 'ja');
  assert.deepEqual(await counted(conv, 'user:anna'), { type: 'ranked', ranking: ['A', 'C'] }, 'the newer ballot stands');
  await say(conv, 'anna', 'ok');
  assert.deepEqual(await counted(conv, 'user:anna'), { type: 'ranked', ranking: ['A', 'C'] });
});

test('review 1: a confirmation from round one does not wipe the ballot of the runoff', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cf-runoff', [ANNA, BERT]);
  await startActive(h, conv, VENUES);
  const stale = await say(conv, 'anna', 'maybe the castle');
  await read(conv, stale.messageId, 'C');
  // Anna never confirms; both vote directly and tie.
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'B');
  assert.match(last(conv), /^The vote ended level between Harbour and Old Town/);
  await say(conv, 'anna', 'B'); // round two
  await say(conv, 'anna', 'ja', { replyTo: h.kernel.groupPosts(conv).find((p) => p.text.includes('I read your message as'))?.messageId ?? '' });
  assert.deepEqual(await counted(conv, 'user:anna'), { type: 'ranked', ranking: ['B'] }, 'even a reply to the old request changes nothing in the runoff');
});

test('review 1: confirming replaces only what was recorded before the request', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cf-before', FOUR);
  await startActive(h, conv, VENUES);
  await say(conv, 'bert', 'A'); // recorded first
  const free = await say(conv, 'bert', 'actually the old town suits me better');
  await read(conv, free.messageId, 'B'); // the request comes after it
  assert.deepEqual(await counted(conv, 'user:bert'), { type: 'ranked', ranking: ['A'] }, 'nothing changes before the confirmation');
  await say(conv, 'bert', 'yes');
  assert.deepEqual(await counted(conv, 'user:bert'), { type: 'ranked', ranking: ['B'] }, 'the confirmed reading replaces the older ballot');
});

test('review 1: a bare "ja" confirms only the most recent thing the facilitator asked that person', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cf-recent', FOUR);
  await startActive(h, conv, VENUES);
  const free = await say(conv, 'cara', 'castle hill sounds nice');
  await read(conv, free.messageId, 'C');
  const prompt = h.kernel.groupPosts(conv).at(-1);
  // The facilitator then asks Cara something else.
  const other = await say(conv, 'cara', 'or was it the other one');
  await h.tool('facilitation_clarify', { messageId: other.messageId, question: 'do you mean the harbour?' }, { conversation: conv });
  await say(conv, 'cara', 'ja');
  assert.equal(await counted(conv, 'user:cara'), undefined, '"ja" answered the question, not the older request');
  assert.equal((await pending(conv, 'user:cara')).length, 1);
  await say(conv, 'cara', 'ja', { replyTo: prompt?.messageId ?? '' });
  assert.deepEqual(await counted(conv, 'user:cara'), { type: 'ranked', ranking: ['C'] }, 'a reply to the request confirms it');
});
