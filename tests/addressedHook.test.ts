// One mention, one reply, decided by the kernel's question (1.5.0, kernel
// #2089 `onAddressedMessage`): in follow-up the engine takes "done N" and
// "status" and answers them without a model; everything else it declines and
// the facilitator's ordinary turn answers. Never both.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string, opts: { replyTo?: string } = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
async function mention(agent: string, conv: string, who: string, text: string, event?: 'known' | 'unnamed' | 'late' | 'none') {
  const result = await h.kernel.mention(conv, who, text, { agent, ...(event ? { event } : {}) });
  await h.settle();
  return result.answeredBy;
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const statuses = async (facilitationId: string): Promise<string[]> => (await store.listActionItems(h.db.pool, facilitationId)).map((a) => a.status);
const outcomes = async (facilitationId: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [facilitationId])).rows.map((r) => r.outcome);

/** A facilitation of `agent` that closed with action items of Anna in follow-up. */
async function followUp(agent: string, conv: string, count: number) {
  h.kernel.conversation(conv, [ANNA, BERT]);
  const at = { agent, conversation: conv };
  await h.tool('facilitation_start', { goal: `Next steps ${conv}`, followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true }, at);
  for (let n = 1; n <= count; n += 1) {
    await h.tool('facilitation_record_action_item', { description: `Task ${String(n)}`, owner: 'Anna', dueDate: inHours(48) }, at);
    await say(conv, 'anna', 'yes');
  }
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.tool('facilitation_step', { action: 'close' }, at);
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  const f = await h.facilitation(conv);
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

test('in follow-up the engine takes "done N" and "status" from the kernel\'s question and answers once; anything else is the turn\'s', { skip: PG_SKIP }, async () => {
  const conv = 'ah-take';
  const f = await followUp('mira', conv, 2);
  const before = posts(conv).length;
  const turns = h.kernel.turns.length;

  // Something the engine has no fixed answer for: declined, the turn answers.
  assert.equal(await mention('mira', conv, 'anna', 'the second one is nearly finished, is that fine?'), 'turn');
  assert.equal(posts(conv).length, before, 'the engine posts nothing for what it declined');
  // "status" of a participant.
  assert.equal(await mention('mira', conv, 'bert', 'Status'), 'engine');
  assert.match(posts(conv).at(-1) ?? '', /closed, action items are being followed up/);
  assert.equal(posts(conv).length, before + 1);
  // "done 2" of the owner.
  assert.equal(await mention('mira', conv, 'anna', 'done 2'), 'engine');
  assert.deepEqual(await statuses(f.id), ['confirmed', 'done']);
  assert.deepEqual(posts(conv).slice(before + 1), ['Done, thank you Anna: #2 Task 2']);
  // Somebody else's item: the engine says so, once.
  assert.equal(await mention('mira', conv, 'bert', 'done 1'), 'engine');
  assert.equal(posts(conv).at(-1), 'Bert, action item #1 is not yours to close.');
  // Bert owns nothing: a bare "done" is not the engine's.
  assert.equal(await mention('mira', conv, 'bert', 'erledigt'), 'turn');
  // Somebody who does not take part.
  assert.equal(await mention('mira', conv, 'zoe', 'status'), 'turn');
  assert.equal(posts(conv).length, before + 3, 'one reply per message the engine took, none for the others');
  assert.equal(h.kernel.turns.length, turns, 'no model turn of the engine in follow-up');

  // The stored events of all six mentions were not answered a second time:
  // the ones the engine took are in the ledger once, the others were left.
  await h.tick();
  await h.restart();
  await h.tick();
  assert.equal(posts(conv).length, before + 3, 'reading the stored events on a later pass changes nothing');
  const ledger = await outcomes(f.id);
  for (const once of ['action_done', 'action_not_owner', 'status']) assert.equal(ledger.filter((o) => o === once).length, 1, once);
  assert.ok(!ledger.includes('left_to_turn') && !ledger.includes('free_text'));
  assert.equal(h.kernel.addressedAsked.filter((r) => r.conversationId === conv).length, 6);
});

test('the event of a message the engine took is deduped however it arrives: named on the turn, unnamed, late, or never', { skip: PG_SKIP }, async () => {
  for (const event of ['known', 'unnamed', 'late', 'none'] as const) {
    const conv = `ah-event-${event}`;
    const f = await followUp('nora', conv, 1);
    const before = posts(conv).length;
    assert.equal(await mention('nora', conv, 'anna', 'done 1', event), 'engine', event);
    assert.deepEqual(await statuses(f.id), ['done'], event);
    const said = (): string[] => posts(conv).slice(before).filter((p) => /Done, thank you Anna/.test(p));
    assert.equal(said().length, 1, event);
    // The stored event shows up on later passes (and after a restart).
    await h.tick();
    await h.restart();
    await h.tick();
    assert.equal(said().length, 1, `${event}: the stored event is not answered again`);
    assert.equal((await outcomes(f.id)).filter((o) => o === 'action_done').length, 1, event);
  }
});

test('a reply to one of its messages starts no turn and is the engine\'s through the event, as before; with a mention on top the question decides and the event is left', { skip: PG_SKIP }, async () => {
  const conv = 'ah-reply';
  const f = await followUp('otto', conv, 2);
  const own = h.kernel.groupPosts(conv).at(-1)?.messageId ?? '';
  const before = posts(conv).length;
  await say(conv, 'anna', 'done 1', { replyTo: own });
  assert.deepEqual(await statuses(f.id), ['done', 'confirmed']);
  assert.equal((await outcomes(f.id)).at(-1), 'action_done');

  // A reply that also mentions: pushed as an event AND asked about.
  const result = await h.kernel.mention(conv, 'anna', 'done 2', { agent: 'otto', replyTo: own });
  await h.settle();
  assert.equal(result.answeredBy, 'engine');
  assert.deepEqual(await statuses(f.id), ['done', 'done']);
  assert.equal(posts(conv).slice(before).filter((p) => /Done, thank you Anna: #2/.test(p)).length, 1, 'one reply, not one per path');
});

test('next to a live facilitation the kernel asks nothing (no turn runs): the follow-up answers the mention through the event', { skip: PG_SKIP }, async () => {
  const conv = 'ah-live';
  const first = await followUp('pia', conv, 1);
  const second = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] }, 'pia');
  const before = posts(conv).length;
  const asked = h.kernel.addressedAsked.length;
  assert.equal(await mention('pia', conv, 'anna', 'done 1'), 'suppressed');
  assert.equal(h.kernel.addressedAsked.length, asked);
  assert.deepEqual(await statuses(first.id), ['done']);
  assert.deepEqual(posts(conv).slice(before).filter((p) => !/follow-up of the action items has ended/.test(p)), ['Done, thank you Anna: #1 Task 1']);
  assert.equal((await outcomes(second.id)).at(-1), 'left_to_followup');
});

test('two follow-ups in one conversation: the message goes to the one it is about', { skip: PG_SKIP }, async () => {
  const conv = 'ah-two';
  const first = await followUp('rita', conv, 1);
  h.clock.advance(60_000);
  const second = await followUp('rita', conv, 2);
  assert.notEqual(first.id, second.id);
  // Number 2 exists in the later one only.
  assert.equal(await mention('rita', conv, 'anna', 'done 2'), 'engine');
  assert.deepEqual(await statuses(second.id), ['confirmed', 'done']);
  assert.deepEqual(await statuses(first.id), ['confirmed']);
  // "status": the most recent one.
  const before = posts(conv).length;
  assert.equal(await mention('rita', conv, 'bert', 'status'), 'engine');
  assert.match(posts(conv).at(-1) ?? '', new RegExp(`Next steps ${conv}`));
  assert.equal(posts(conv).length, before + 1);
});
