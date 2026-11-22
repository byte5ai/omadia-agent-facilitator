// Scope targets of #2090 (spec 2043 §0 table, §9): follow-up replies to a
// reminder (criterion 28), the preparation under `configuring` (criterion 36)
// and private status answers in every phase (criterion 41).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import type { Facilitation } from '../src/model.js';
import { lifecycleOf } from '../src/model.js';
import { ANNA, BERT, CARA, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string, replyTo?: string): Promise<void> {
  await h.kernel.say(conv, who, text, replyTo ? { replyTo } : {});
  await h.settle();
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const followupStates = async (ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => {
    const f = await store.getFacilitation(h.db.pool, id);
    return { followup: f?.followupState, items: (await store.listActionItems(h.db.pool, id)).map((a) => a.status) };
  }));

/** A facilitation of `agent` that closed with one action item of Anna's, in follow-up. */
async function inFollowup(agent: string, conv: string, goal: string): Promise<Facilitation> {
  const at = { agent, conversation: conv };
  await h.tool('facilitation_start', { goal, definitionOfDone: 'Owners agreed', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }] }, at);
  await h.tool('facilitation_open', {}, at);
  await h.tool('facilitation_record_action_item', { description: `${goal}: the task`, owner: 'Anna', dueDate: inHours(48) }, at);
  await say(conv, 'anna', 'yes');
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.tool('facilitation_step', { action: 'close' }, at);
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  await passWindow(h, conv);
  const f = (await store.getFacilitation(h.db.pool, (await h.facilitation(conv)).id)) as Facilitation;
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

/** The reminders are due: run the scheduler past their time. */
async function remindersDue(): Promise<void> {
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  await h.tick();
}

/** The reminder of a facilitation in the group (the owner cannot be reached privately). */
const reminderIn = (conv: string, processId: string) =>
  h.kernel.groupPosts(conv).filter((p) => p.processId === processId && /^Anna, action item #1 is due/.test(p.text)).at(-1);

// ── criterion 28 ───────────────────────────────────────────────────────────

test('criterion 28: one facilitator follows up two facilitations for Anna; a reply to each reminder completes only the item of that reminder, in both orders', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st28-done', [ANNA, BERT]);
  const first = await inFollowup('ivo', conv, 'Offsite');
  const second = await inFollowup('ivo', conv, 'Budget');
  // Anna has no private chat with the facilitator: both reminders are said
  // in the group, each as a message of its own facilitation.
  h.kernel.dmBlocked.set('user:anna', 'app_not_installed');
  try {
    await remindersDue();
  } finally {
    h.kernel.dmBlocked.delete('user:anna');
  }
  const ofFirst = reminderIn(conv, first.id);
  const ofSecond = reminderIn(conv, second.id);
  assert.ok(ofFirst && ofSecond, 'one reminder per facilitation');

  // The reminder of the second one first.
  await say(conv, 'anna', 'erledigt', ofSecond.messageId);
  assert.deepEqual(await followupStates([first.id, second.id]), [
    { followup: 'active', items: ['confirmed'] },
    { followup: 'ended', items: ['done'] },
  ]);
  // Then the first one's.
  await say(conv, 'anna', 'done', ofFirst.messageId);
  assert.deepEqual((await followupStates([first.id]))[0]?.items, ['done']);
  assert.ok(!posts(conv).some((t) => /several facilitations/i.test(t)), 'no question: the reply says which');
});

test('criterion 28: "stop" in reply to one reminder ends only that facilitation\'s follow-up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st28-stop', [ANNA, BERT]);
  const first = await inFollowup('jana', conv, 'Offsite');
  const second = await inFollowup('jana', conv, 'Budget');
  h.kernel.dmBlocked.set('user:anna', 'app_not_installed');
  try {
    await remindersDue();
  } finally {
    h.kernel.dmBlocked.delete('user:anna');
  }
  const ofFirst = reminderIn(conv, first.id);
  assert.ok(ofFirst);
  await say(conv, 'anna', 'stop', ofFirst.messageId);
  const [a, b] = await followupStates([first.id, second.id]);
  assert.equal(a?.followup, 'ended', 'the follow-up the reminder belongs to ended');
  assert.deepEqual(b, { followup: 'active', items: ['confirmed'] }, 'the other one runs on');
});

// GAP (#2090 criterion 28, private reminders): a reminder goes to its owner
// privately (src/engine/actionItems.ts `action_reminder_direct`), but a
// private message reaches the engine without any reference to the message it
// answers (`PrivateMessageRequest` in @omadia/plugin-api has no reply id),
// and the private handler (src/engine/privateMessages.ts `answerDone`) only
// takes "done [N]" with the item's number, which is #1 in both
// facilitations, and never takes "stop". So a direct reply to one of two
// private reminders cannot complete only its item, and a private "stop" ends
// nothing.
test('criterion 28 (private reminders): a direct reply to each private reminder completes only its item, in both orders; a private "stop" in reply to one ends only that follow-up', { skip: PG_SKIP }, async () => {
  for (const order of ['second first', 'first first'] as const) {
    const tag = order.split(' ')[0] ?? '';
    const one = h.kernel.conversation(`st28-private-${tag}-1`, [ANNA, BERT]);
    const two = h.kernel.conversation(`st28-private-${tag}-2`, [ANNA, CARA]);
    const first = await inFollowup('kai', one, `Offsite ${tag}`);
    const second = await inFollowup('kai', two, `Budget ${tag}`);
    await remindersDue();
    const reminderOf = (processId: string) => h.kernel.dms.filter((d) => d.as === 'kai' && d.principal === 'user:anna' && d.processId === processId && /action item #1 is due/.test(d.text)).at(-1);
    const reminders = { first: reminderOf(first.id), second: reminderOf(second.id) };
    assert.ok(reminders.first?.messageId && reminders.second?.messageId, 'two private reminders, each with its message id');
    // Without a reply reference "done 1" names two items: one question, with
    // choices that tell them apart, and nothing changes.
    const question = await h.kernel.privateMessage('kai', 'anna', 'done 1');
    assert.match(question ?? '', /Which of your action items is done\?/);
    assert.match(question ?? '', /1a\. .*Offsite/);
    assert.match(question ?? '', /1b\. .*Budget/);
    assert.deepEqual((await followupStates([first.id, second.id])).map((s) => s.items), [['confirmed'], ['confirmed']]);
    // A direct reply to a reminder completes exactly the item of that reminder.
    const [a, b] = order === 'second first' ? [second, first] : [first, second];
    const firstReply = await h.kernel.privateMessage('kai', 'anna', 'done', { replyToMessageId: (a.id === first.id ? reminders.first : reminders.second)?.messageId as string });
    assert.match(firstReply ?? '', /^Noted/);
    const afterOne = await followupStates([first.id, second.id]);
    assert.deepEqual(afterOne.map((s) => s.items), a.id === first.id ? [['done'], ['confirmed']] : [['confirmed'], ['done']]);
    // The other one stays open; "stop" in reply to its reminder ends only its follow-up.
    const other = b.id === first.id ? reminders.first : reminders.second;
    const stopped = await h.kernel.privateMessage('kai', 'anna', 'stop', { replyToMessageId: other?.messageId as string });
    assert.match(stopped ?? '', /no longer follow up/);
    const states = await followupStates([first.id, second.id]);
    assert.equal(states[b.id === first.id ? 0 : 1]?.followup, 'ended', 'the stopped follow-up ended');
    assert.deepEqual(states[b.id === first.id ? 0 : 1]?.items, ['confirmed'], 'stop completes nothing');
    // A private stop that replies to nothing, or to a private message that is
    // no reminder, is not taken.
    const statusDm = h.kernel.dms.filter((d) => d.as === 'kai' && d.principal === 'user:anna' && !/action item #1 is due/.test(d.text)).at(-1);
    if (statusDm?.messageId) assert.equal(await h.kernel.privateMessage('kai', 'anna', 'stop', { replyToMessageId: statusDm.messageId }), undefined);
    // A private stop that replies to nothing is not taken.
    assert.equal(await h.kernel.privateMessage('kai', 'anna', 'stop'), undefined);
  }
});

test('criterion 28 (private reminders): without a reply reference the choice with the facilitation\'s letter completes exactly that item', { skip: PG_SKIP }, async () => {
  const one = h.kernel.conversation('st28-letter-1', [ANNA, BERT]);
  const two = h.kernel.conversation('st28-letter-2', [ANNA, CARA]);
  const first = await inFollowup('kai', one, 'Offsite letters');
  const second = await inFollowup('kai', two, 'Budget letters');
  await remindersDue();
  assert.match((await h.kernel.privateMessage('kai', 'anna', 'done 1b')) ?? '', /^Noted/);
  assert.deepEqual((await followupStates([first.id, second.id])).map((s) => s.items), [['confirmed'], ['done']]);
  // One open item left: a plain "done" is unambiguous now.
  assert.match((await h.kernel.privateMessage('kai', 'anna', 'done')) ?? '', /^Noted/);
  assert.deepEqual((await followupStates([first.id, second.id])).map((s) => s.items), [['done'], ['done']]);
});

// ── criterion 36 ───────────────────────────────────────────────────────────

test('criterion 36: a request without goal or deadline opens configuring with reservation and scope; a preparation over several turns survives a restart; the handshake switches to active at once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st36-prepare', [ANNA, BERT, CARA]);
  const at = { agent: 'lena', conversation: conv };
  // "Help us prepare a retrospective": only what it is about.
  assert.match(await h.tool('facilitation_start', { goal: 'Prepare a retrospective' }, at), /^Facilitation created/);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'configuring');
  assert.equal(f.deadline, null);
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['configuring']);
  const held = h.kernel.reservations.filter((r) => r.processId === f.id && r.releasedAt === undefined);
  assert.deepEqual(held.map((r) => [r.conversationId, r.role]), [[conv, 'home']]);

  // The next turn adds a deadline; then the engine restarts; the turn after
  // that adds the definition of done. Still one facilitation, one scope.
  const deadline = inHours(72);
  await h.tool('facilitation_start', { goal: 'Prepare a retrospective', deadline }, at);
  await h.restart();
  await h.tool('facilitation_start', { goal: 'Prepare a retrospective', deadline, definitionOfDone: 'Three topics are chosen' }, at);
  const prepared = await h.facilitation(conv);
  assert.equal(prepared.id, f.id);
  assert.equal(prepared.phase, 'configuring');
  assert.equal(prepared.deadline?.toISOString(), deadline);
  assert.equal(h.kernel.scopes.filter((s) => s.processId === f.id).length, 1, 'the restart opened nothing twice');
  assert.equal(h.kernel.reservations.filter((r) => r.processId === f.id).length, 1);

  // The handshake: configuring ends in the same step as active opens.
  assert.match(await h.tool('facilitation_open', {}, at), /^Opened/);
  assert.match(posts(conv)[0] ?? '', /Done when \(version 1\): Three topics are chosen/, 'what the earlier turns agreed is kept');
  const configuring = h.kernel.scopeOf(f.id, 'configuring');
  const active = h.kernel.scopeOf(f.id, 'active');
  assert.equal(configuring?.state, 'ended');
  assert.equal(active?.state, 'open');
  assert.equal(configuring?.endedAt, active?.openedAt, 'no moment with both or neither');
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['active']);
  assert.equal(h.kernel.reservations.filter((r) => r.processId === f.id && r.releasedAt === undefined).length, 1, 'the reservation is kept across the switch');
});

test('criterion 36: an abandoned preparation ends aborted with exactly one note after 72 h and frees the conversation, also across a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st36-abandoned', [ANNA, BERT]);
  const at = { agent: 'mona', conversation: conv };
  await h.tool('facilitation_start', { goal: 'Prepare a retrospective' }, at);
  const f = await h.facilitation(conv);
  h.clock.advance(70 * HOUR_MS);
  await h.tick();
  await h.restart();
  h.clock.advance(3 * HOUR_MS);
  await h.tick();
  await h.tick();
  await h.restart();
  await h.tick();
  const ended = await h.facilitation(conv);
  assert.equal(ended.phase, 'aborted');
  const notes = posts(conv).filter((t) => /not opened within the time a facilitation may take to be set up/.test(t));
  assert.equal(notes.length, 1, 'one note, not one per pass or restart');
  assert.equal(posts(conv).filter((t) => t.length > 0).length, 1, 'and nothing else');
  assert.ok(h.kernel.reservations.filter((r) => r.processId === f.id).every((r) => r.releasedAt !== undefined), 'the conversation is free');
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  // A new facilitation may start there at once.
  assert.match(await h.tool('facilitation_start', { goal: 'Prepare the next one' }, at), /^Facilitation created/);
});

test('criterion 36: a question to the facilitator outside a facilitation is answered by its turn without taking a reservation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st36-question', [ANNA, BERT]);
  const reservationsBefore = h.kernel.reservations.length;
  const scopesBefore = h.kernel.scopes.length;
  const answered = await h.kernel.mention(conv, 'bert', 'what is a retrospective?', { agent: 'nina' });
  await h.settle();
  assert.equal(answered.answeredBy, 'turn', 'the ordinary turn answers');
  assert.equal(h.kernel.reservations.length, reservationsBefore, 'no reservation');
  assert.equal(h.kernel.scopes.length, scopesBefore, 'no scope');
  assert.ok(!h.kernel.reservations.some((r) => r.conversationId === conv));
  const facilitations = await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1', [conv]);
  assert.equal(facilitations.rows.length, 0, 'nothing was created');
});

// ── criterion 41 ───────────────────────────────────────────────────────────

test('criterion 41: a participant who is neither initiator nor owner asks privately in configuring, active, concluding and following_up and gets the status each time', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st41-phases', [ANNA, BERT, CARA]);
  const at = { agent: 'olga', conversation: conv };
  const goal = 'Next steps of the offsite';
  const ask = async (): Promise<string | undefined> => h.kernel.privateMessage('olga', 'bert', 'status');
  const seen: Array<[string, string | undefined]> = [];

  await h.tool('facilitation_start', { goal, definitionOfDone: 'Owners agreed', followUp: true }, at);
  const f = await h.facilitation(conv);
  seen.push([lifecycleOf(await h.facilitation(conv)), await ask()]);

  await h.tool('facilitation_open', {}, at);
  await h.tool('facilitation_record_action_item', { description: 'Book the venue', owner: 'Anna', dueDate: inHours(72) }, at);
  await say(conv, 'anna', 'yes');
  seen.push([lifecycleOf(await h.facilitation(conv)), await ask()]);

  // The result is frozen and waits for the group's final confirmation.
  await h.tool('facilitation_close', {}, at);
  seen.push([lifecycleOf(await h.facilitation(conv)), await ask()]);

  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  await h.tick();
  seen.push([lifecycleOf(await h.facilitation(conv)), await ask()]);

  assert.deepEqual(seen.map(([phase]) => phase), ['configuring', 'active', 'concluding', 'following_up']);
  for (const [phase, answer] of seen) assert.match(answer ?? '', new RegExp(goal), `the status in ${phase}`);
  // Each answer is a status answer drawn from the scope of that phase.
  // (Bert also gets the protocol privately, a dispatch under the closing.)
  const drawn = h.kernel.authorizations.filter((a) => a.processId === f.id && a.action === 'direct_message' && a.target?.kind === 'person' && a.target.principalId === 'bert' && a.purpose === 'status');
  assert.deepEqual(drawn.map((a) => [a.kind, a.phase]), [['configuring', 'configuring'], ['active', 'active'], ['closing', 'concluding'], ['follow_up', 'following_up']]);
});
