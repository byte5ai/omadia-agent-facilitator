import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
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

const record = (conv: string, messageId: string, summary = 'prefers the old town', kind = 'position') =>
  h.tool('facilitation_record_contribution', { messageId, kind, summary }, { conversation: conv });

async function contributionsOf(conv: string) {
  const f = await h.facilitation(conv);
  return store.listContributions(h.db.pool, f.id);
}

test('authorship is copied from the kernel record: author, revision, time, event', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-author', FOUR);
  await startActive(h, conv);
  const said = await h.kernel.say(conv, 'bert', 'I would rather go to the old town');
  await h.settle();
  // A model argument naming somebody else has no effect: there is no such parameter.
  const answer = await h.tool('facilitation_record_contribution', { messageId: said.messageId, kind: 'position', summary: 'prefers the old town', participant: 'anna', author: 'Anna' }, { conversation: conv, caller: 'anna' });
  assert.match(answer, /^Recorded for Bert as unconfirmed/);
  const [c] = await contributionsOf(conv);
  assert.equal(c?.participantPrincipal, 'user:bert');
  assert.equal(c?.sourceMessageId, said.messageId);
  assert.equal(c?.sourceRevision, 0);
  assert.equal(c?.sourceEventId, said.eventId);
  assert.equal(c?.sourceOccurredAt?.toISOString(), said.occurredAt);
  assert.equal(c?.status, 'unconfirmed');
});

test('a contribution read from free text counts only after its author confirmed the echo', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-confirm', FOUR);
  await startActive(h, conv);
  const said = await h.kernel.say(conv, 'bert', 'old town I guess');
  await h.settle();
  await record(conv, said.messageId);
  const echo = h.kernel.groupPosts(conv).at(-1);
  assert.match(echo?.text ?? '', /^Bert, I read your message as: prefers the old town\. Reply "yes"/);
  assert.deepEqual(echo?.mentions, [{ user: 'user:bert', text: 'Bert' }]);
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Contributed: nobody yet/);

  // Somebody else's "yes" confirms nothing.
  await h.kernel.say(conv, 'anna', 'yes');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'unconfirmed');

  await h.kernel.say(conv, 'bert', 'Yes!');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'valid');
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /^Confirmed, Bert: prefers the old town/);
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Contributed: Bert/);
});

test('a reaction on the echo confirms; "no" withdraws the reading', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-react', FOUR);
  await startActive(h, conv);
  const a = await h.kernel.say(conv, 'anna', 'harbour maybe');
  await h.settle();
  await record(conv, a.messageId, 'prefers the harbour');
  const echoA = h.kernel.groupPosts(conv).at(-1);
  await h.kernel.react(conv, 'bert', echoA?.messageId ?? '', 'like');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'unconfirmed', "another person's reaction confirms nothing");
  await h.kernel.react(conv, 'anna', echoA?.messageId ?? '', 'like');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'valid');

  const b = await h.kernel.say(conv, 'bert', 'whatever is cheapest, or not');
  await h.settle();
  await record(conv, b.messageId, 'prefers the cheapest option');
  await h.kernel.say(conv, 'bert', 'no');
  await h.settle();
  const all = await contributionsOf(conv);
  assert.equal(all.find((c) => c.participantPrincipal === 'user:bert')?.status, 'withdrawn');
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /I did not record that/);
});

test('refused: foreign message, message from before the start, non-participant, quoted, forwarded, after the end', { skip: PG_SKIP }, async () => {
  const other = h.kernel.conversation('co-foreign', FOUR);
  await startActive(h, other);
  const foreign = await h.kernel.say(other, 'anna', 'a vote in another chat');

  const conv = h.kernel.conversation('co-refuse', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { conversation: conv });
  const early = await h.kernel.say(conv, 'anna', 'my opinion from before the start');
  h.clock.advance(60_000);
  await h.tool('facilitation_open', {}, { conversation: conv });
  await h.settle();

  assert.match(await record(conv, foreign.messageId), /^Refused \(unknown_message\)/);
  assert.match(await record(conv, 'msg-does-not-exist'), /^Refused \(unknown_message\)/);
  assert.match(await record(conv, early.messageId), /^Refused \(before_start\)/);

  h.kernel.conversation(conv, [ANNA, BERT, { id: 'guest', displayName: 'Guest' }]);
  const guest = await h.kernel.say(conv, 'guest', 'I vote for the harbour');
  assert.match(await record(conv, guest.messageId), /^Refused \(not_participant\)/);

  const quoted = await h.kernel.say(conv, 'bert', '> Anna: harbour\nsee above', { quoted: true });
  assert.match(await record(conv, quoted.messageId), /^Refused \(not_own_words\)/);
  const forwarded = await h.kernel.say(conv, 'bert', 'FW: Cara says harbour', { forwarded: true });
  assert.match(await record(conv, forwarded.messageId), /^Refused \(not_own_words\)/);

  const late = await h.kernel.say(conv, 'anna', 'one more thing');
  await h.settle();
  await h.tool('facilitation_stop', { reason: 'test' }, { conversation: conv });
  assert.match(await record(conv, late.messageId), /^Refused \(no_facilitation\)/);
  assert.equal((await contributionsOf(conv)).length, 0);
});

test('"Anna agrees too" from Bert records nothing for Anna', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-proxy', FOUR);
  await startActive(h, conv);
  const said = await h.kernel.say(conv, 'bert', 'Anna agrees too');
  await h.settle();
  await record(conv, said.messageId, 'Anna agrees');
  const all = await contributionsOf(conv);
  assert.deepEqual(all.map((c) => c.participantPrincipal), ['user:bert']);
  // Anna cannot confirm what was recorded from Bert's message.
  await h.kernel.say(conv, 'anna', 'yes');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'unconfirmed');
  assert.doesNotMatch(await h.tool('facilitation_status', {}, { conversation: conv }), /Contributed: .*Anna/);
});

test('an edit retires the older revision; a deleted message withdraws what it carried', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-edit', FOUR);
  await startActive(h, conv);
  const said = await h.kernel.say(conv, 'anna', 'harbour');
  await h.settle();
  await record(conv, said.messageId, 'prefers the harbour');
  await h.kernel.say(conv, 'anna', 'yes');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'valid');

  const turns = h.kernel.turns.length;
  await h.kernel.edit(conv, 'anna', said.messageId, 'old town, on second thought');
  await h.settle();
  assert.equal((await contributionsOf(conv))[0]?.status, 'superseded', 'the old revision no longer counts');
  assert.equal(h.kernel.turns.length, turns + 1, 'the new text is read again');
  await record(conv, said.messageId, 'prefers the old town');
  let all = await contributionsOf(conv);
  assert.deepEqual(all.map((c) => [c.sourceRevision, c.status]), [
    [0, 'superseded'],
    [1, 'unconfirmed'],
  ]);

  await h.kernel.remove(conv, 'anna', said.messageId);
  await h.settle();
  all = await contributionsOf(conv);
  assert.equal(all[1]?.status, 'withdrawn');
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /you deleted your message/);
});

test('an unclear message gets exactly one clarifying question and does not count', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-clarify', FOUR);
  await startActive(h, conv);
  const said = await h.kernel.say(conv, 'cara', 'the first one or maybe the other');
  await h.settle();
  const before = h.kernel.groupPosts(conv).length;
  const ask = () => h.tool('facilitation_clarify', { messageId: said.messageId, question: 'which one do you mean?' }, { conversation: conv });
  assert.match(await ask(), /^Asked Cara/);
  assert.match(await ask(), /already asked/);
  const posts = h.kernel.groupPosts(conv).slice(before);
  assert.deepEqual(posts.map((p) => p.text), ['Cara, which one do you mean?']);
  assert.equal((await contributionsOf(conv))[0]?.status, 'ambiguous');
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Still open: Anna, Bert, Cara, Dave/);
});

test('several things waiting for one person: a bare "yes" asks which, a reply settles it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-which', FOUR);
  await startActive(h, conv);
  const one = await h.kernel.say(conv, 'dave', 'cheap would be good');
  const two = await h.kernel.say(conv, 'dave', 'and close to the station');
  await h.settle();
  await record(conv, one.messageId, 'wants it cheap', 'concern');
  await record(conv, two.messageId, 'wants it near the station', 'concern');
  const prompts = h.kernel.groupPosts(conv).slice(-2);
  await h.kernel.say(conv, 'dave', 'yes');
  await h.settle();
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /several things wait for your confirmation/);
  assert.deepEqual((await contributionsOf(conv)).map((c) => c.status), ['unconfirmed', 'unconfirmed']);
  await h.kernel.say(conv, 'dave', 'yes', { replyTo: prompts[1]?.messageId ?? '' });
  await h.settle();
  assert.deepEqual((await contributionsOf(conv)).map((c) => c.status), ['unconfirmed', 'valid']);
});

test('review 9: after the conclusion an edit or a deletion changes nothing that was counted; it is only recorded', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('co-frozen', [ANNA, BERT]);
  await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
  const a = await h.kernel.say(conv, 'anna', 'A');
  const b = await h.kernel.say(conv, 'bert', 'A');
  await h.settle();
  // Follow-up keeps the conversation readable after the close in real life; here the
  // late events are delivered directly.
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  const before = (await store.listContributions(h.db.pool, f.id)).map((c) => [c.id, c.status, c.sourceRevision]);
  const posts = h.kernel.groupPosts(conv).length;
  const { handleInbound } = await import('../src/engine/inbound.js');
  const late = (kind: 'edited' | 'deleted', source: typeof a, eventId: string) => ({ ...source, eventId, kind, revision: 1, ...(kind === 'edited' ? { text: 'B' } : {}), occurredAt: h.clock.now().toISOString() });
  await h.engine.core.work(f.id, (w) => handleInbound(w, late('edited', a, 'late-edit')));
  await h.engine.core.work(f.id, (w) => handleInbound(w, late('deleted', b, 'late-delete')));
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).map((c) => [c.id, c.status, c.sourceRevision]), before, 'frozen');
  assert.equal(h.kernel.groupPosts(conv).length, posts, 'and nothing is said about it');
  const events = (await store.listEvents(h.db.pool, f.id, ['late_change'])).map((e) => e.payload['kind']);
  assert.deepEqual(events, ['edited', 'deleted']);
});
