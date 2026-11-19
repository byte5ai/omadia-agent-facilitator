// One mention, one reply, on a kernel that does not ask the engine (1.4.1).
//
// In follow-up the kernel delivers a mention to the engine as an event AND
// lets the facilitator's ordinary turn answer it. The engine leaves the
// mention to that turn; the turn closes an action item through a tool. Where
// no turn runs (a reply without a mention, a card button, another
// facilitation of the facilitator live in the conversation) the engine answers.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness();
  // A kernel before `onAddressedMessage` (plugin-api 1.73): the engine cannot
  // claim a mention, so in follow-up it leaves it to the ordinary turn.
  h.kernel.addressedMessages = false;
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
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const statuses = async (facilitationId: string): Promise<string[]> => (await store.listActionItems(h.db.pool, facilitationId)).map((a) => a.status);
const outcomes = async (facilitationId: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY processed_at', [facilitationId])).rows.map((r) => r.outcome);

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

test('in follow-up a mention is left to the ordinary turn: the engine posts nothing for it, and the turn closes the item through a tool, with one reply', { skip: PG_SKIP }, async () => {
  const conv = 'or1-mention';
  const f = await followUp('mira', conv, 1);
  assert.equal(h.kernel.ordinaryTurnRuns('mira', conv), true, 'the kernel lets the ordinary turn answer a mention here');

  // The event reaches the engine. It is not the engine's to answer.
  const before = posts(conv).length;
  const turns = h.kernel.turns.length;
  const mention = await say(conv, 'anna', '@Mira done 1');
  assert.equal((await outcomes(f.id)).at(-1), 'left_to_turn');
  assert.equal(posts(conv).length, before, 'no reply from the engine');
  assert.equal(h.kernel.turns.length, turns, 'and no turn of its own');
  assert.deepEqual(await statuses(f.id), ['confirmed'], 'nothing changes behind the back of the turn that answers');

  // The ordinary turn answers the mention, and closes the item for its author.
  const answer = await h.tool('facilitation_action_done', { number: 1 }, { conversation: conv, caller: 'anna' });
  assert.match(answer, /^Action item 1 is closed and that was said in the group\. Do not repeat it\. Answer \[silent\] now\.$/);
  assert.deepEqual(await statuses(f.id), ['done']);
  // One reply in the group: the tool's line (the kernel drops the turn's own
  // text when the engine posted in that turn), then the end of the follow-up.
  assert.deepEqual(posts(conv).slice(before), ['Done, thank you Anna: #1 Task 1', 'The follow-up of the action items has ended. I am no longer reading this conversation.']);
  assert.equal(mention.kind, 'created');
});

test('the tool closes an item only for its owner, and never on a guess', { skip: PG_SKIP }, async () => {
  const conv = 'or1-tool';
  const f = await followUp('nora', conv, 2);
  const at = (caller: string) => ({ agent: 'nora', conversation: conv, caller });
  const before = posts(conv).length;

  assert.match(await h.tool('facilitation_action_done', { number: 2 }, at('bert')), /^Refused \(not_owner\): Action item 2 is not theirs to close/);
  assert.match(await h.tool('facilitation_action_done', {}, at('bert')), /^Refused \(no_open_item\)/);
  assert.match(await h.tool('facilitation_action_done', { number: 7 }, at('anna')), /^Refused \(no_open_item\): There is no open action item 7 here/);
  // Two open items and no number: nothing is closed, the turn asks.
  assert.match(await h.tool('facilitation_action_done', {}, at('anna')), /^Nothing was closed: several of their action items are open \(1: Task 1; 2: Task 2\)\. Ask which one is done\.$/);
  assert.deepEqual(await statuses(f.id), ['confirmed', 'confirmed']);
  assert.equal(posts(conv).length, before, 'none of that posted anything');

  assert.match(await h.tool('facilitation_action_done', { number: 2 }, at('anna')), /^Action item 2 is closed/);
  assert.deepEqual(await statuses(f.id), ['confirmed', 'done']);
  assert.deepEqual(posts(conv).slice(before), ['Done, thank you Anna: #2 Task 2']);
  // The one that is left needs no number.
  assert.match(await h.tool('facilitation_action_done', {}, at('anna')), /^Action item 1 is closed/);
  assert.equal((await h.facilitation(conv)).followupState, 'ended');

  // Where nothing is followed up the tool says so.
  const idle = h.kernel.conversation('or1-idle', [ANNA, BERT]);
  assert.match(await h.tool('facilitation_action_done', {}, { agent: 'nora', conversation: idle, caller: 'anna' }), /^Refused \(no_followup\)/);
  // And the status is there for the turn that answers a mention in follow-up.
  const third = await followUp('nora', 'or1-status', 1);
  assert.match(await h.tool('facilitation_status', {}, { agent: 'nora', conversation: 'or1-status' }), /closed, action items are being followed up/);
  assert.equal(third.followupState, 'active');
});

test('a reply without a mention starts no turn: the engine answers it, as before', { skip: PG_SKIP }, async () => {
  const conv = 'or1-reply';
  const f = await followUp('otto', conv, 1);
  const own = h.kernel.groupPosts(conv).at(-1);
  const before = posts(conv).length;
  await say(conv, 'anna', 'done 1', { replyTo: own?.messageId ?? '' });
  assert.equal((await outcomes(f.id)).at(-1), 'action_done');
  assert.deepEqual(await statuses(f.id), ['done']);
  assert.equal(posts(conv).slice(before)[0], 'Done, thank you Anna: #1 Task 1');
});

test('next to a live facilitation no ordinary turn runs: the follow-up answers the mention itself, and the live facilitation starts no turn for it', { skip: PG_SKIP }, async () => {
  const conv = 'or1-live';
  const first = await followUp('pia', conv, 1);
  const second = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] }, 'pia');
  assert.equal(h.kernel.ordinaryTurnRuns('pia', conv), false, 'the kernel suppresses the ordinary turn where the engine reads everything');

  const before = posts(conv).length;
  const turns = h.kernel.turns.length;
  await say(conv, 'anna', '@Pia done 1');
  assert.deepEqual(await statuses(first.id), ['done']);
  assert.equal((await outcomes(first.id)).at(-1), 'action_done');
  assert.equal((await outcomes(second.id)).at(-1), 'left_to_followup');
  assert.equal(h.kernel.turns.length, turns, 'no model turn on top');
  assert.deepEqual(posts(conv).slice(before).filter((p) => !/follow-up of the action items has ended/.test(p)), ['Done, thank you Anna: #1 Task 1'], 'one reply');
  assert.equal((await h.facilitation(conv)).phase, 'active');
});
