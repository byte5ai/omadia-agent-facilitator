// Reading bound to the facilitation, the follow-up behind the mention gate,
// private requests of participants, and the take-over of a facilitation from
// before execution scopes (spec 2043 §5.3 and §6.2; kernel #2089).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { statusText } from '../src/engine/status.js';
import { lifecycleOf } from '../src/model.js';
import { ANNA, BERT, CARA, DAVE, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const EVE = { id: 'eve', displayName: 'Eve', email: 'eve@example.com' };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string, opts: { replyTo?: string } = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const items = async (conv: string): Promise<string[]> => (await store.listActionItems(h.db.pool, (await h.facilitation(conv)).id)).map((a) => a.status);
const people = (processId: string, kind: 'active' | 'follow_up'): string[] =>
  (h.kernel.scopeOf(processId, kind)?.targets ?? []).flatMap((t) => (t.kind === 'person' ? [`${t.principalId}${t.restriction ? `:${t.restriction}` : ''}`] : [])).sort();

/** A facilitation that closed with action items of Anna in follow-up. */
async function followUp(conv: string, count: number, members = [ANNA, BERT]) {
  h.kernel.conversation(conv, members);
  await tool(conv, 'facilitation_start', { goal: `Next steps ${conv}`, followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true });
  for (let n = 1; n <= count; n += 1) {
    await tool(conv, 'facilitation_record_action_item', { description: `Task ${String(n)}`, owner: 'Anna', dueDate: inHours(48) });
    await say(conv, 'anna', 'yes');
  }
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  for (const who of members) await say(conv, who.id, 'agreed');
  const f = await h.facilitation(conv);
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

test('in follow-up the mention gate is back on: the facilitator hears what is addressed to it, under a follow-up scope, and nothing after it ended', { skip: PG_SKIP }, async () => {
  const conv = 'pb-followup';
  const f = await followUp(conv, 1);
  assert.equal(lifecycleOf(f), 'following_up');
  assert.match(await statusText(h.db.pool, f), /closed, action items are being followed up/);

  // The conversation was given back at the close; the follow-up keeps a
  // permission to hear what is addressed to the facilitator.
  assert.notEqual(h.kernel.reservations.find((r) => r.processId === f.id)?.releasedAt, undefined);
  assert.equal(h.kernel.modeOf(f.id, conv), 'addressed');
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['follow_up']);
  // The owner of an open item may be written to; the others may ask for the status.
  assert.deepEqual(people(f.id, 'follow_up'), ['anna', 'bert:status_only']);

  // Not addressed: the kernel does not even store it for the facilitation.
  const stored = h.kernel.events.length;
  await say(conv, 'anna', 'done 1');
  assert.equal(h.kernel.events.length, stored);
  assert.deepEqual(await items(conv), ['confirmed']);

  // A reply to one of the facilitation's messages is addressed to it.
  const own = h.kernel.groupPosts(conv).at(-1);
  await say(conv, 'anna', 'done 1', { replyTo: own?.messageId ?? '' });
  assert.deepEqual(await items(conv), ['done']);
  const ended = await h.facilitation(conv);
  assert.equal(ended.followupState, 'ended');
  assert.equal(lifecycleOf(ended), 'ended');
  assert.equal(posts(conv).at(-1), 'The follow-up of the action items has ended. I am no longer reading this conversation.');
  const last = h.kernel.authorizations.filter((a) => a.processId === f.id).at(-1);
  assert.deepEqual([last?.kind, last?.phase], ['follow_up', 'following_up'], 'the closing line of the follow-up is drawn from its scope');
  // The scope ends on the next pass, once that line is out.
  await h.tick();
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  assert.equal(h.kernel.modeOf(f.id, conv), undefined, 'reads end with the last scope');
});

test('a new facilitation next to a follow-up: each reads for itself, and a reply reaches the facilitation whose message it answers', { skip: PG_SKIP }, async () => {
  const conv = 'pb-two';
  const first = await followUp(conv, 1);
  const reminderOf = h.kernel.groupPosts(conv).filter((p) => p.processId === first.id).at(-1);
  const second = await startActive(h, conv, VOTE);
  assert.notEqual(second.id, first.id);
  assert.equal(h.kernel.modeOf(second.id, conv), 'all');
  assert.equal(h.kernel.modeOf(first.id, conv), 'addressed');

  // A ballot goes to the facilitation that reads everything, not to the follow-up.
  await say(conv, 'anna', 'A');
  assert.equal((await store.listContributions(h.db.pool, second.id)).length, 1);
  assert.equal(h.kernel.events.filter((e) => (e as { processId?: string }).processId === first.id && e.text === 'A').length, 0);

  // A reply to a message of the first one reaches the first one alone.
  await say(conv, 'anna', 'done 1', { replyTo: reminderOf?.messageId ?? '' });
  assert.deepEqual((await store.listActionItems(h.db.pool, first.id)).map((a) => a.status), ['done']);
  assert.equal((await store.listContributions(h.db.pool, second.id)).length, 1, 'the second facilitation did not see it');
  assert.equal((await h.facilitation(conv)).phase, 'active');
});

test('a participant asks for the status in a private chat and gets the status of their facilitation; anybody else, and anything else, gets the ordinary answer', { skip: PG_SKIP }, async () => {
  // A facilitator of its own: nobody here takes part in another facilitation of it.
  const conv = h.kernel.conversation('pb-status', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { ...VOTE, goal: 'Pick the venue for the offsite' }, 'rita');
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  const groupBefore = posts(conv).length;

  const answer = await h.kernel.privateMessage('rita', 'bert', 'Status');
  assert.match(answer ?? '', /Pick the venue for the offsite/);
  assert.match(answer ?? '', /running/);
  const drawn = h.kernel.authorizations.filter((a) => a.processId === f.id).at(-1);
  assert.deepEqual([drawn?.action, drawn?.purpose, drawn?.kind, drawn?.emission], ['direct_message', 'status', 'active', 'template']);
  assert.deepEqual(drawn?.target, { kind: 'person', channelType: 'teams', principalId: 'bert' });
  assert.equal(posts(conv).length, groupBefore, 'nothing of it in the group');

  // The id as the channel states it (an Entra object id in upper case).
  assert.match((await h.kernel.privateMessage('rita', 'BERT', 'stand')) ?? '', /Pick the venue for the offsite/);
  // Not a participant: the kernel does not even ask the engine.
  assert.equal(await h.kernel.privateMessage('rita', 'dave', 'status'), undefined);
  // Not a status request: handed back.
  assert.equal(await h.kernel.privateMessage('rita', 'bert', 'Can you summarise my mails?'), undefined);
  assert.equal(await h.kernel.privateMessage('rita', 'bert', 'A'), undefined, 'a ballot is cast in the group, not privately');
  assert.equal((await store.listContributions(h.db.pool, f.id)).length, 1);

  // While it is being set up, a participant who is not the initiator may
  // still ask for the status, and gets that only.
  const setup = h.kernel.conversation('pb-status-setup', [DAVE, EVE]);
  await h.tool('facilitation_start', { goal: 'Plan the retro', ...VOTE }, { agent: 'rita', conversation: setup, caller: 'dave' });
  assert.match((await h.kernel.privateMessage('rita', 'eve', 'status')) ?? '', /Plan the retro/);
  const setupId = (await h.facilitation(setup)).id;
  assert.deepEqual(h.kernel.authorizations.filter((a) => a.processId === setupId).at(-1)?.purpose, 'status');
});

test('somebody who takes part in several facilitations is asked which one is meant', { skip: PG_SKIP }, async () => {
  const one = h.kernel.conversation('pb-several-1', [ANNA, BERT]);
  const two = h.kernel.conversation('pb-several-2', [ANNA, CARA]);
  // Anna takes part in other facilitations of this file as well: a
  // facilitator of her own keeps this test to these two.
  await startActive(h, one, { ...VOTE, goal: 'Name the team' }, 'nora');
  h.clock.advance(1000);
  await startActive(h, two, { ...VOTE, goal: 'Choose the logo' }, 'nora');

  const asked = await h.kernel.privateMessage('nora', 'anna', 'status');
  assert.equal(asked, 'You take part in several facilitations of mine. Which one do you mean? Answer with "status" and its number:\n1. Name the team\n2. Choose the logo');
  const second = await h.kernel.privateMessage('nora', 'anna', 'status 2');
  assert.match(second ?? '', /Choose the logo/);
  assert.doesNotMatch(second ?? '', /Name the team/, 'the status of that facilitation only');
  assert.match((await h.kernel.privateMessage('nora', 'anna', 'status 1')) ?? '', /Name the team/);
  // Bert takes part in one of them: no question.
  assert.match((await h.kernel.privateMessage('nora', 'bert', 'status')) ?? '', /Name the team/);
});

test('an owner reports an item as done in the private chat: decided from the state, asked which when there are several, and the group is told', { skip: PG_SKIP }, async () => {
  const single = 'pb-done-one';
  h.kernel.conversation(single, [ANNA, BERT]);
  await followUpAs('otto', single, 1);
  // A private chat has no reply reference: "done" means the one open item.
  const noted = await h.kernel.privateMessage('otto', 'anna', 'Erledigt');
  assert.equal(noted, 'Noted: action item 1 ("Task 1") is done. I tell the group.');
  assert.deepEqual(await items(single), ['done']);
  assert.ok(posts(single).includes('Done, thank you Anna: #1 Task 1'));
  assert.equal((await h.facilitation(single)).followupState, 'ended');

  const several = 'pb-done-two';
  h.kernel.conversation(several, [ANNA, BERT]);
  await followUpAs('otto', several, 2);
  const which = await h.kernel.privateMessage('otto', 'anna', 'done');
  assert.equal(which, 'Which of your action items is done? Answer with "done" and its number:\n1. Task 1\n2. Task 2');
  assert.deepEqual(await items(several), ['confirmed', 'confirmed'], 'nothing is closed on a guess');
  assert.match((await h.kernel.privateMessage('otto', 'anna', 'done 2')) ?? '', /^Noted: action item 2/);
  assert.deepEqual(await items(several), ['confirmed', 'done']);
  // Somebody without an item of their own has nothing to report, but may ask for the status.
  assert.equal(await h.kernel.privateMessage('otto', 'bert', 'done 1'), undefined);
  assert.deepEqual(await items(several), ['confirmed', 'done']);
  assert.match((await h.kernel.privateMessage('otto', 'bert', 'status')) ?? '', /Next steps/);
});

async function followUpAs(agent: string, conv: string, count: number): Promise<void> {
  const at = { agent, conversation: conv };
  await h.tool('facilitation_start', { goal: `Next steps ${conv}`, followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true }, at);
  for (let n = 1; n <= count; n += 1) {
    await h.tool('facilitation_record_action_item', { description: `Task ${String(n)}`, owner: 'Anna', dueDate: inHours(48) }, at);
    await say(conv, 'anna', 'yes');
  }
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.tool('facilitation_step', { action: 'close' }, at);
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  assert.equal((await h.facilitation(conv)).followupState, 'active');
}

test('a kernel without private status requests: the engine runs as before and nothing is answered privately', { skip: PG_SKIP }, async () => {
  h.kernel.privateMessages = false;
  try {
    await h.restart();
    const conv = h.kernel.conversation('pb-no-private', [ANNA, BERT]);
    await startActive(h, conv, VOTE, 'pia');
    assert.equal(await h.kernel.privateMessage('pia', 'bert', 'status'), undefined);
    await say(conv, 'anna', 'A');
    await say(conv, 'bert', 'A');
    assert.equal((await h.facilitation(conv)).phase, 'closed');
  } finally {
    h.kernel.privateMessages = true;
    await h.restart();
  }
});

test('a facilitation from before execution scopes is taken over: its scopes are opened in the kernel\'s order, it reads as itself, and the old subscription is given back', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pb-takeover', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE, 'lena');
  await say(conv, 'anna', 'A');
  // As 1.3.0 left it: no scope, no process subscription, a subscription of the first major.
  await h.engine.stop();
  await h.db.pool.query('DELETE FROM plg_omadia_agent_facilitator_scopes WHERE facilitation_id = $1', [f.id]);
  await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings - 'scoped' - 'readMode', inbound_cursor = 'evt-of-the-first-major' WHERE id = $1`, [f.id]);
  h.kernel.forget(f.id, 'lena', conv);
  assert.equal(h.kernel.legacySubscriptions.has(`lena|teams|${conv}`), true);

  await h.restart();
  const taken = await h.facilitation(conv);
  assert.equal(taken.settings.scoped, true);
  assert.equal(taken.phase, 'active', 'it goes on');
  assert.deepEqual(h.kernel.scopes.filter((s) => s.processId === f.id).map((s) => [s.kind, s.state]), [['configuring', 'ended'], ['active', 'open']]);
  assert.equal(h.kernel.modeOf(f.id, conv), 'all');
  assert.equal(h.kernel.legacySubscriptions.size, 0, 'the old subscription is given back');
  assert.ok(h.logs.some((l) => l.includes(f.id) && l.includes('taken over under execution scopes')));

  // It records and concludes as any other.
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
});

// ── 1.5.3: a kernel without the first majors (K6.3) ─────────────────────────

for (const [kernel, arrange] of [
  ['answers nothing for conversationMessages@1', (k: Harness['kernel']) => void k.absent.add('legacyMessages')],
  ['answers the name with a service that has no unsubscribe', (k: Harness['kernel']) => void (k.legacyAnswer = { subscribe: async () => ({ outcome: 'subscribed', mode: 'all' }) })],
] as const) {
  test(`take-over on a kernel that ${kernel}: no give-back is attempted, nothing fails, the facilitation goes on`, { skip: PG_SKIP }, async () => {
    const agent = kernel.startsWith('answers nothing') ? 'ines' : 'jana';
    const conv = h.kernel.conversation(`pb-takeover-${agent}`, [ANNA, BERT]);
    const f = await startActive(h, conv, VOTE, agent);
    await say(conv, 'anna', 'A');
    // As 1.3.0 left it; the kernel has ended the old subscription itself.
    await h.engine.stop();
    await h.db.pool.query('DELETE FROM plg_omadia_agent_facilitator_scopes WHERE facilitation_id = $1', [f.id]);
    await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings - 'scoped' - 'readMode', inbound_cursor = 'evt-of-the-first-major' WHERE id = $1`, [f.id]);
    h.kernel.forget(f.id, agent, conv);
    h.kernel.legacySubscriptions.clear();
    arrange(h.kernel);
    const logged = h.logs.length;
    try {
      await h.restart();
      const taken = await h.facilitation(conv);
      assert.equal(taken.settings.scoped, true);
      assert.equal(taken.phase, 'active');
      assert.deepEqual(h.kernel.scopes.filter((s) => s.processId === f.id).map((s) => [s.kind, s.state]), [['configuring', 'ended'], ['active', 'open']]);
      assert.equal(h.kernel.modeOf(f.id, conv), 'all');
      const since = h.logs.slice(logged);
      assert.ok(since.some((l) => l.includes(f.id) && l.includes('taken over under execution scopes')));
      assert.deepEqual(since.filter((l) => /could not be given back|failed|is not a function/i.test(l)), [], 'no error, and no attempt that could fail');
      // A facilitation started on this kernel, and the one taken over, run as usual.
      await say(conv, 'bert', 'A');
      assert.equal((await h.facilitation(conv)).phase, 'closed');
      const fresh = h.kernel.conversation(`pb-fresh-${agent}`, [ANNA, BERT]);
      await startActive(h, fresh, VOTE, agent);
      await say(fresh, 'anna', 'B');
      await say(fresh, 'bert', 'B');
      assert.equal((await h.facilitation(fresh)).phase, 'closed');
      await h.tick();
      assert.deepEqual(h.logs.slice(logged).filter((l) => /could not be given back|is not a function/i.test(l)), []);
    } finally {
      h.kernel.absent.delete('legacyMessages');
      h.kernel.legacyAnswer = undefined;
    }
  });
}
