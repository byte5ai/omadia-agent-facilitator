// Several contributions per message (criterion 50) and content authenticity
// (criterion 23): a message yields one contribution per point; a retry adds
// nothing; an edit replaces exactly that message's parts; a tool call cannot
// record a ballot the message does not say, nor read an outdated revision.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { pointsOf } from '../src/engine/process.js';
import { FOUR, createHarness, startActive } from './harness.js';
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
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
const live = async (conv: string) => {
  const f = await h.facilitation(conv);
  return (await store.listContributions(h.db.pool, f.id)).filter((c) => ['valid', 'unconfirmed', 'ambiguous'].includes(c.status));
};

test('a list is several points; anything else is one', () => {
  assert.deepEqual(pointsOf('- Too many meetings\n- Standups ran long\n* No focus time'), ['Too many meetings', 'Standups ran long', 'No focus time']);
  assert.deepEqual(pointsOf('1. a\n2) b'), ['a', 'b']);
  assert.deepEqual(pointsOf('Too many meetings'), ['Too many meetings']);
  assert.deepEqual(pointsOf('Too many meetings\n- and long ones'), ['Too many meetings\n- and long ones'], 'a list only when every line is an item');
});

test('criterion 50: three ideas in one message are three contributions in different clusters; a retry adds nothing; an edit replaces exactly its parts', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-retro', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Retrospective sprint 12', definitionOfDone: 'Actions with owners are agreed', format: 'retrospective' });
  await tool(conv, 'facilitation_open');
  const said = await say(conv, 'bert', '- Too many meetings\n- Standups ran long\n- No focus time');
  await say(conv, 'anna', 'Releases were calm');
  let parts = (await live(conv)).filter((c) => c.sourceMessageId === said.messageId);
  assert.deepEqual(parts.map((c) => [c.partIndex, c.payload['summary'], c.status]), [
    [0, 'Too many meetings', 'valid'],
    [1, 'Standups ran long', 'valid'],
    [2, 'No focus time', 'valid'],
  ]);
  // The model records the same message again: nothing new.
  assert.match(await tool(conv, 'facilitation_record_contribution', { messageId: said.messageId, kind: 'idea', summary: 'meetings' }), /^Already recorded for Bert/);
  assert.equal((await live(conv)).length, 4);

  // An edit before the step closes replaces exactly that message's parts.
  await h.kernel.edit(conv, 'bert', said.messageId, '- Too many meetings\n- No focus time');
  await h.settle();
  parts = (await live(conv)).filter((c) => c.sourceMessageId === said.messageId);
  assert.deepEqual(parts.map((c) => [c.partIndex, c.payload['summary'], c.sourceRevision]), [
    [0, 'Too many meetings', 1],
    [1, 'No focus time', 1],
  ]);
  assert.deepEqual((await live(conv)).filter((c) => c.participantPrincipal === 'user:anna').map((c) => c.payload['summary']), ['Releases were calm'], 'nothing of another message changes');

  // The first close invites the silent ones; the second closes.
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Closed/);
  const listing = await tool(conv, 'facilitation_contributions');
  assert.match(listing, /#1 Anna \(idea\): Releases were calm\n#2 Bert \(idea\): Too many meetings\n#3 Bert \(idea\): No focus time/);
  await tool(conv, 'facilitation_propose_clusters', { clusters: [{ label: 'Meetings', members: [2] }, { label: 'Focus', members: [3, 1] }] });
  const f = await h.facilitation(conv);
  const clusters = await store.listClusters(h.db.pool, f.id);
  const ids = parts.map((c) => c.id);
  assert.deepEqual(clusters.map((c) => c.memberContributionIds.filter((id) => ids.includes(id)).length), [1, 1], 'the two parts of one message are in different clusters');
});

test('criterion 50: points read from free text are confirmed in one question and count together', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-free', FOUR);
  await startActive(h, conv, { goal: 'Ideas for the offsite', format: 'ideas' });
  // Addressed to the facilitator, so the collecting step leaves it to the
  // model, which reads two points from it.
  const said = await say(conv, 'cara', '@mira maybe a boat trip, and a cooking class would be fun too?');
  const answer = await tool(conv, 'facilitation_record_contribution', { messageId: said.messageId, parts: [{ kind: 'idea', summary: 'a boat trip' }, { kind: 'idea', summary: 'a cooking class' }] });
  assert.match(answer, /^Recorded 2 points for Cara as unconfirmed/);
  const question = h.kernel.groupPosts(conv).at(-1)?.text ?? '';
  assert.match(question, /^Cara, I read your message as: a boat trip; a cooking class\. Reply "yes"/);
  assert.deepEqual((await live(conv)).map((c) => [c.partIndex, c.status]), [[0, 'unconfirmed'], [1, 'unconfirmed']]);
  await say(conv, 'cara', 'yes');
  assert.deepEqual((await live(conv)).map((c) => [c.partIndex, c.status]), [[0, 'valid'], [1, 'valid']]);
});

test('criterion 23: a tool-call ballot that differs from the message is refused; an outdated revision is refused, and so is its confirmation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-authentic', FOUR);
  await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] });
  const ballot = await say(conv, 'anna', 'A');
  assert.match(await tool(conv, 'facilitation_record_contribution', { messageId: ballot.messageId, kind: 'vote', summary: 'Garden', ballot: 'B' }), /^Refused \(content_mismatch\)/);
  const f = await h.facilitation(conv);
  const anna = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === 'user:anna' && c.status === 'valid');
  assert.deepEqual(anna.map((c) => c.payload['summary']), ['A (Harbour)'], 'what the message says stands');

  // Free text the engine cannot parse: the model's reading waits for its author.
  const free = await say(conv, 'bert', 'I lean towards the place by the water');
  assert.match(await tool(conv, 'facilitation_record_contribution', { messageId: free.messageId, revision: 0, kind: 'vote', summary: 'Harbour', ballot: 'A' }, 'bert'), /as unconfirmed/);
  // Bert edits his message; the reading of revision 0 is void.
  await h.kernel.edit(conv, 'bert', free.messageId, 'Actually the garden');
  await h.settle();
  assert.match(await tool(conv, 'facilitation_record_contribution', { messageId: free.messageId, revision: 0, kind: 'vote', summary: 'Harbour', ballot: 'A' }, 'bert'), /^Refused \(outdated_revision\)/);
  await say(conv, 'bert', 'yes');
  const bert = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === 'user:bert' && c.status === 'valid');
  assert.deepEqual(bert, [], 'a confirmation of the reading of an older revision counts nothing');
});
