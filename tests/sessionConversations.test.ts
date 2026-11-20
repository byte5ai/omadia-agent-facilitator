// Linked session conversations (spec 5.3; #2076, #2089; criteria 22, 45,
// 46, 48, 60): a meeting chat linked from inside it, with its own
// reservation, read as the session's state allows.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import type { FakeUser } from './fakeKernel.js';
import { ANNA, BERT, CARA, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';


let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-20T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();

/** A facilitation in `home` with one scheduled session, and a meeting chat
 *  `meeting` where Anna and Bert sit with a guest. */
async function withScheduledSession(name: string, goal = `Quarterly planning ${name}`) {
  const home = h.kernel.conversation(`${name}-home`, [ANNA, BERT, CARA]);
  // Each test has a guest of its own: a person in one meeting chat only.
  const guest: FakeUser = { id: `eva-${name}`, displayName: 'Eva Guest' };
  const meeting = h.kernel.conversation(`${name}-meeting`, [ANNA, BERT, guest]);
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Priorities are agreed', agenda: [{ kind: 'collect', title: 'Topics' }, { kind: 'discuss', title: 'Discuss', timeboxMinutes: 30 }, { kind: 'close', title: 'Close' }] });
  await tool(home, 'facilitation_open');
  await tool(home, 'facilitation_session', { action: 'schedule', title: 'Planning call', start: inMinutes(120), end: inMinutes(180), modality: 'online' });
  const f = await h.facilitation(home);
  return { home, meeting, f, goal, eva: guest.id };
}

async function link(meeting: string, who = 'anna', text = '@mira link this chat for the session') {
  const result = await h.kernel.linkRequest(meeting, who, text);
  await h.settle();
  return result;
}

const sessionOf = async (facilitationId: string) => (await store.listSessions(h.db.pool, facilitationId)).find((s) => s.kind === 'live');

test('criterion 48: only a home participant links a meeting chat, from inside it; a request from the home conversation takes nothing', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, goal, eva } = await withScheduledSession('lk48');
  const ask = `@mira link this chat to ${goal}`;
  // From the home conversation: the facilitation reads it, so it is no link request.
  assert.equal((await link(home, 'anna', ask)).handled, false);
  // A guest of the meeting chat: one short answer, nothing taken.
  const guest = await link(meeting, eva, ask);
  assert.equal(guest.answer, 'Only a participant of that facilitation can link this chat, from inside it.');
  assert.equal(h.kernel.reservations.some((r) => r.conversationId === meeting && r.releasedAt === undefined), false);
  assert.equal(h.kernel.modeOf(f.id, meeting), undefined, 'no read access');
  // Without a link request the kernel gives nothing either.
  const direct = await h.kernel.kernel().execution()?.reserveConversation({ agentSlug: 'mira', processId: f.id, channelType: 'teams', conversationId: meeting });
  assert.equal(direct?.outcome === 'refused' && direct.code, 'link_not_authorized');

  // A home participant inside the meeting chat: linked, confirmed in both.
  const linked = await link(meeting, 'anna', ask);
  assert.deepEqual([linked.handled, linked.answer], [true, undefined]);
  const reservation = h.kernel.reservations.find((r) => r.conversationId === meeting && r.releasedAt === undefined);
  assert.deepEqual([reservation?.processId, reservation?.role, reservation?.sessionState], [f.id, 'session', 'scheduled']);
  assert.match(posts(meeting).at(-1) ?? '', /^This chat is now linked to "Quarterly planning lk48" as the conversation of the session "Planning call"/);
  assert.equal(posts(home).at(-1), 'Anna linked the meeting chat for the session "Planning call". The session itself runs there.');
  assert.equal(h.kernel.modeOf(f.id, meeting), 'addressed', 'scheduled: only what is addressed to the facilitator');
  assert.equal((await sessionOf(f.id))?.conversationId, meeting);
});

test('criterion 45: linked during configuring and across a restart; a second process or a discussion gets neither the reservation nor read access', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('lk45-home', [ANNA, BERT]);
  const meeting = h.kernel.conversation('lk45-meeting', [ANNA, BERT]);
  await tool(home, 'facilitation_start', { goal: 'Offsite lk45', definitionOfDone: 'Plan agreed' });
  const f = await h.facilitation(home);
  assert.equal(f.phase, 'configuring');
  await link(meeting, 'anna', '@mira link this chat to Offsite lk45');
  assert.equal(h.kernel.reservations.find((r) => r.conversationId === meeting && r.releasedAt === undefined)?.processId, f.id);
  // Preparation there before the handshake: an addressed question is a turn of the facilitator, answered in the meeting chat.
  h.kernel.onTurn = () => 'We will collect topics before the call.';
  assert.equal((await h.kernel.mention(meeting, 'bert', 'what do we prepare?')).answeredBy, 'engine');
  await h.settle();
  assert.equal(posts(meeting).at(-1), 'We will collect topics before the call.');
  assert.ok(!posts(home).includes('We will collect topics before the call.'));
  h.kernel.onTurn = () => '[silent]';

  await h.restart();
  assert.equal(h.kernel.modeOf(f.id, meeting), 'addressed', 'still linked after a restart');
  assert.equal((await sessionOf(f.id))?.conversationId, meeting);

  // A chat that is linked already is read by its facilitation: a mention
  // there is no link request for another one.
  assert.equal((await link(meeting, 'anna', '@mira link this chat to Offsite lk45')).handled, false);

  // Two facilitations link the same chat at the same moment: exactly one
  // gets it; the other takes nothing and says so at home.
  const other = h.kernel.conversation('lk45-other', [ANNA, CARA]);
  await tool(other, 'facilitation_start', { goal: 'Budget lk45', definitionOfDone: 'Budget agreed' });
  const second = await h.facilitation(other);
  const contested = h.kernel.conversation('lk45-contested', [ANNA, BERT, CARA]);
  await Promise.all([link(contested, 'anna', '@mira link this chat to Offsite lk45'), link(contested, 'anna', '@mira link this chat to Budget lk45')]);
  const holders = h.kernel.reservations.filter((r) => r.conversationId === contested && r.releasedAt === undefined).map((r) => r.processId);
  assert.equal(holders.length, 1);
  const loser = holders[0] === f.id ? second : f;
  assert.equal(h.kernel.modeOf(loser.id, contested), undefined, 'the other gets no read access');
  assert.match(posts(loser.conversationId).at(-1) ?? '', /^I could not link the meeting chat for ".*": another facilitation runs there/);

  // A chat an agent discussion holds.
  const talk = h.kernel.conversation('lk45-talk', [ANNA, BERT]);
  h.kernel.discussions.add(talk);
  await link(talk, 'anna', '@mira link this chat to Offsite lk45');
  assert.equal(h.kernel.reservations.some((r) => r.conversationId === talk), false);
  assert.match(posts(home).at(-1) ?? '', /an agent discussion runs there/);
});

test('criterion 60: a meeting chat without permission for all messages does not go live and the home conversation is told; once granted, it runs without mentions', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, goal } = await withScheduledSession('lk60');
  h.kernel.notReady.set(`mira|${meeting}`, [{ code: 'rsc_missing', message: 'ChatMessage.Read.Chat is not consented in this chat' }]);
  await link(meeting, 'anna', `@mira link this chat to ${goal}`);
  assert.match(posts(home).at(-1) ?? '', /^The session "Planning call" cannot start in its meeting chat yet: rsc_missing: ChatMessage\.Read\.Chat is not consented/);
  // At the start: the kernel refuses `live`; the session stays scheduled, the home conversation is told.
  h.clock.advance(121 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionOf(f.id))?.status, 'scheduled');
  assert.equal(h.kernel.modeOf(f.id, meeting), 'addressed');
  assert.equal((await h.facilitation(home)).phase, 'active', 'the home conversation is not affected');

  h.kernel.notReady.delete(`mira|${meeting}`);
  h.clock.advance(6 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionOf(f.id))?.status, 'live');
  assert.equal(h.kernel.modeOf(f.id, meeting), 'all');
  assert.match(posts(meeting).join('\n'), /"Planning call" starts now/);
  // A contribution without a mention counts, from a home participant.
  await say(meeting, 'bert', 'Hiring plan');
  const ideas = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === 'user:bert');
  assert.equal(ideas.length, 1);
});

test('criterion 22 and 46: a person only in the meeting chat never sees the home history; asked privately, gets only the session status; nothing after leaving', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, goal, eva } = await withScheduledSession('lk22');
  await say(home, 'cara', 'Something only the home group knows');
  await link(meeting, 'anna', `@mira link this chat to ${goal}`);
  h.clock.advance(121 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionOf(f.id))?.status, 'live');
  // The guest writes: moderated, never counted, and listed as a session participant.
  await say(meeting, eva, 'Could we also talk about tooling?');
  assert.equal((await store.listContributions(h.db.pool, f.id)).some((c) => c.participantPrincipal === `user:${eva}`), false);
  assert.equal(await store.getParticipant(h.db.pool, f.id, `user:${eva}`), undefined, 'not a home participant');
  // The facilitator's turn there is told where it answers.
  assert.match(h.kernel.turns.at(-1)?.engineContext ?? '', /linked session conversation.*never quote, summarise or refer to messages/s);
  assert.ok(!posts(meeting).some((t) => t.includes('Something only the home group knows')));

  await h.tick();
  const guest = await h.kernel.privateMessage('mira', eva, 'status');
  assert.match(guest ?? '', /^Status of your session:\n- Planning call: running/);
  assert.doesNotMatch(guest ?? '', /Quarterly planning|Cara|Bert|Anna|tally|missing/i);
  const member = await h.kernel.privateMessage('mira', 'cara', 'status');
  assert.match(member ?? '', /Quarterly planning lk22/, 'a home participant gets the full status');

  h.kernel.leave(meeting, eva);
  await h.settle();
  await h.tick();
  assert.equal(await h.kernel.privateMessage('mira', eva, 'status'), undefined, 'after leaving, nothing more');

  // After the session: contributions from the meeting chat no longer count.
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  const before = (await store.listContributions(h.db.pool, f.id)).length;
  await say(meeting, 'bert', 'Late idea');
  assert.equal((await store.listContributions(h.db.pool, f.id)).length, before);
  assert.equal(h.kernel.modeOf(f.id, meeting), undefined, 'closed: nothing is read');
});

test('in a session conversation "status" gives the session status only, and a turn there knows nothing of the home conversation', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, goal, eva } = await withScheduledSession('lkst');
  await say(home, 'cara', 'Home-only remark');
  await link(meeting, 'anna', `@mira link this chat to ${goal}`);
  h.clock.advance(121 * MINUTE_MS);
  await h.tick();
  await say(meeting, 'anna', 'status');
  const answer = posts(meeting).at(-1) ?? '';
  assert.match(answer, /^Status of your session:\n- Planning call: running/);
  assert.doesNotMatch(answer, /Cara|Bert|Anna|Contributed|missing|tally/i);
  await say(meeting, eva, 'What are we doing now?');
  const context = h.kernel.turns.at(-1)?.engineContext ?? '';
  assert.match(context, /^# Session\nSession: Planning call \(live\)/);
  assert.doesNotMatch(context, /Cara|Home-only remark/);
  assert.equal((await h.facilitation(home)).id, f.id);
});

test('a meeting in the linked chat starts and ends its session; a session that cannot go live in its slot does not take place', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, goal } = await withScheduledSession('lkev');
  await link(meeting, 'anna', `@mira link this chat to ${goal}`);
  await h.kernel.sessionEvent('mira', meeting, 'meeting-lkev', 'session_started');
  await h.settle();
  assert.equal((await sessionOf(f.id))?.status, 'live');
  assert.equal(h.kernel.modeOf(f.id, meeting), 'all');
  await h.kernel.sessionEvent('mira', meeting, 'meeting-lkev', 'session_ended');
  await h.settle();
  assert.equal((await sessionOf(f.id))?.status, 'closed');
  assert.match(posts(meeting).at(-1) ?? '', /^Result status: published\n\nSummary of the session "Planning call"/);
  // Criterion 63: the home participants get the session protocol too; stakeholders and the
  // facilitation's own protocol wait for its close.
  assert.match(posts(home).at(-1) ?? '', /^Result status: published\n\nSummary of the session "Planning call"/);
  assert.equal(h.kernel.dms.filter((d) => d.text.includes('here is the protocol')).length, 0);

  const second = await withScheduledSession('lkmiss');
  h.kernel.notReady.set(`mira|${second.meeting}`, [{ code: 'rsc_missing', message: 'no permission' }]);
  await link(second.meeting, 'anna', `@mira link this chat to ${second.goal}`);
  const started = await h.tool('facilitation_session', { action: 'start' }, { conversation: second.home });
  assert.match(started, /could not go live/);
  assert.equal((await sessionOf(second.f.id))?.status, 'scheduled');
  h.clock.advance(181 * MINUTE_MS);
  await h.tick();
  await h.tick();
  assert.equal((await sessionOf(second.f.id))?.status, 'cancelled');
  assert.match(posts(second.home).at(-1) ?? '', /^The session "Planning call" did not take place in its meeting chat: rsc_missing: no permission/);
  assert.equal(home.length > 0, true);
});
