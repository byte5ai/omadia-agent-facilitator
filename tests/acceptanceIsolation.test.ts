// Acceptance suite, spec B §9 (byte5ai/omadia#2068): the criteria about
// preparation, private status, isolation between processes, stakeholders,
// the end of a facilitator's service and one ballot per person and round
// (36, 41, 53, 55, 58, 64). End to end on the fake kernel with its simulated
// channel, a fake clock and a real Postgres; one test per (sub-)criterion
// not already covered elsewhere, named by its number. Criterion 33 is
// covered in full by cards.test.ts and contributions.test.ts (see
// docs/acceptance-matrix.md).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { resultClosingOf } from '../src/engine/closing.js';
import type { CardAnswerValue } from '../src/cards/types.js';
import { lifecycleOf } from '../src/model.js';
import { ANNA, BERT, CARA, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-16T08:00:00Z', config: { maxActivePerFacilitator: 40, maxActiveInstance: 100, startsPerHourPerFacilitator: 100 } });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const THREE = [ANNA, BERT, CARA];
const GUS = { id: 'gus', displayName: 'Gus', email: 'gus@example.com' };
const HAL = { id: 'hal', displayName: 'Hal', email: 'hal@example.com' };
const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, agent = 'mira', caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, agent, caller });
async function say(conv: string, who: string, text: string, opts: { replyTo?: string } = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const held = (processId: string): boolean => h.kernel.reservations.some((r) => r.processId === processId && r.releasedAt === undefined);
const ballotOf = async (conv: string, who: string): Promise<unknown[]> => {
  const f = await h.facilitation(conv);
  return (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid' && c.participantPrincipal === `user:${who}`).map((c) => c.payload['ballot']);
};

// ── 64. One ballot per person and round ────────────────────────────────────

test('64. one ballot per person and round: text A then card B counts B; a retried event and a late edit of the old text change nothing', { skip: PG_SKIP }, async () => {
  h.kernel.cardSupport = { kinds: ['single_choice'], maxQuestions: 5, update: true };
  try {
    const conv = h.kernel.conversation('ai-64-card', THREE);
    await tool(conv, 'facilitation_start', { goal: 'Pick a venue', ...VOTE, open: true });
    const card = h.kernel.cards(conv).at(-1);
    assert.ok(card, 'the vote is a card');
    const text = await say(conv, 'anna', 'A');
    assert.deepEqual(await ballotOf(conv, 'anna'), [{ type: 'single', choice: 'A' }]);
    const answers: CardAnswerValue[] = [{ questionId: 'vote', kind: 'single_choice', optionId: 'B' }];
    const clicked = await h.kernel.submitCard(conv, 'anna', card, answers);
    await h.settle();
    assert.deepEqual(await ballotOf(conv, 'anna'), [{ type: 'single', choice: 'B' }], 'the card answer replaces the text ballot');

    // The same event delivered again changes nothing.
    await h.engine.receive('mira', clicked);
    await h.engine.receive('mira', text);
    await h.settle();
    assert.deepEqual(await ballotOf(conv, 'anna'), [{ type: 'single', choice: 'B' }], 'a retry of an event is not counted again');

    // A late edit of the old text ballot does not bring it back.
    await h.kernel.edit(conv, 'anna', text.messageId, 'A!');
    await h.settle();
    assert.deepEqual(await ballotOf(conv, 'anna'), [{ type: 'single', choice: 'B' }], 'the edit of a replaced ballot changes nothing');
    const f = await h.facilitation(conv);
    assert.equal((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').length, 1, 'one effective ballot');
    await tool(conv, 'facilitation_stop', { reason: 'test over' });
  } finally {
    h.kernel.cardSupport = undefined;
  }
});

test('64. in a runoff only runoff ballots count: nobody has voted because of the first round, and an edit of a first-round ballot changes nothing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-64-runoff', [ANNA, BERT]);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  const bertFirst = await say(conv, 'bert', 'B');
  assert.match(posts(conv).join('\n'), /runoff/i, 'a tie between the two starts a runoff');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'active');
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: 0 of 2/, 'nobody counts as having voted in the runoff');

  // Bert changes his first-round ballot: it is not a runoff ballot.
  await h.kernel.edit(conv, 'bert', bertFirst.messageId, 'A');
  await h.settle();
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: 0 of 2/, 'an edit of a first-round ballot is no runoff ballot');

  await say(conv, 'anna', 'A');
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: 1 of 2/);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the runoff waits for Bert');
  await say(conv, 'bert', 'A');
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.match(posts(conv).find((t) => t.startsWith('Result for')) ?? '', /Harbour/);
});

// ── 36. Preparation ────────────────────────────────────────────────────────

test('36. a first request without definition of done or deadline opens `configuring` with the reservation and its scope; a preparation over several turns survives a restart; the handshake switches to `active` at once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-36-prep', THREE);
  assert.match(await tool(conv, 'facilitation_start', { goal: 'Prepare our retrospective', format: 'retrospective' }), /^Facilitation created/);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'configuring');
  assert.equal(f.deadline, null);
  assert.ok(held(f.id), 'the conversation is reserved for the preparation');
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['configuring']);
  assert.equal(h.kernel.modeOf(f.id, conv), 'all');
  assert.deepEqual(posts(conv), [], 'nothing is posted before the handshake');

  // A later turn adds what was agreed; a restart in between loses nothing.
  await h.restart();
  const deadline = inHours(48);
  assert.match(await tool(conv, 'facilitation_start', { goal: 'Prepare our retrospective', format: 'retrospective', definitionOfDone: 'Two actions with owners', deadline }), /^Setup updated, phase: configuring/);
  await h.restart();
  const prepared = await h.facilitation(conv);
  assert.equal(prepared.id, f.id, 'the same preparation');
  assert.equal(prepared.phase, 'configuring');
  assert.equal(prepared.deadline?.toISOString(), deadline);

  // The handshake: one call, and the phase, the scopes and the post change together.
  assert.match(await tool(conv, 'facilitation_open'), /^Opened/);
  const opened = await h.facilitation(conv);
  assert.equal(opened.phase, 'active');
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['active']);
  assert.equal(h.kernel.scopeOf(f.id, 'configuring')?.state, 'ended');
  assert.match(posts(conv)[0] ?? '', /Done when \(version 1\): Two actions with owners/);
  assert.ok(held(f.id), 'the reservation passes from configuring to active without a gap');
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('36. an abandoned preparation ends `aborted` with one note after its 72 h and frees the conversation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-36-abandoned', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Prepare our retrospective' });
  const f = await h.facilitation(conv);
  h.clock.advance(70 * HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'configuring', 'still being prepared before its 72 h');
  await h.restart();
  h.clock.advance(3 * HOUR_MS);
  await h.tick();
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  const notes = posts(conv).filter((t) => /not opened within the time a facilitation may take to be set up/.test(t));
  assert.equal(notes.length, 1, 'one note');
  assert.equal(posts(conv).length, 1, 'and nothing else');
  assert.equal(held(f.id), false, 'the conversation is free');
  assert.equal(h.kernel.modeOf(f.id, conv), undefined);
  const next = await startActive(h, conv, { ...VOTE, goal: 'Something else' });
  assert.notEqual(next.id, f.id, 'a new facilitation can start there');
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('36. a question to the facilitator outside a facilitation is answered without taking a reservation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-36-question', [GUS, HAL]);
  const reservations = h.kernel.reservations.length;
  const scopes = h.kernel.scopes.length;
  const { answeredBy } = await h.kernel.mention(conv, 'gus', 'what can you do as a facilitator?');
  await h.settle();
  assert.equal(answeredBy, 'turn', 'the ordinary turn answers');
  assert.equal(h.kernel.reservations.length, reservations, 'no reservation');
  assert.equal(h.kernel.scopes.length, scopes, 'no scope');
  const rows = await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1', [conv]);
  assert.equal(rows.rows.length, 0, 'no facilitation');
  assert.equal(await h.kernel.privateMessage('mira', 'gus', 'status'), undefined, 'and privately: the ordinary answer');
});

// ── 41. Private status in every phase ──────────────────────────────────────

test('41. a participant who is neither initiator nor owner asks privately in `configuring`, `active`, `concluding` and `following_up` and gets the status each time', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-41', THREE);
  const agent = 'pia'; // a facilitator of its own: Bert takes part in nothing else of it
  const at = (name: string, args: Record<string, unknown> = {}): Promise<string> => tool(conv, name, args, agent);
  const ask = async (): Promise<string> => (await h.kernel.privateMessage(agent, 'bert', 'status')) ?? '';
  const phases: string[] = [];

  await at('facilitation_start', { goal: 'Plan the offsite', definitionOfDone: 'Everybody can live with the plan', followUp: true });
  phases.push(lifecycleOf(await h.facilitation(conv)));
  assert.match(await ask(), /Plan the offsite/, 'configuring');

  await at('facilitation_open');
  phases.push(lifecycleOf(await h.facilitation(conv)));
  assert.match(await ask(), /Plan the offsite/, 'active');

  await at('facilitation_record_action_item', { description: 'Book the boat', owner: 'Anna', dueDate: inHours(72) });
  await say(conv, 'anna', 'yes');
  await at('facilitation_close');
  phases.push(lifecycleOf(await h.facilitation(conv)));
  assert.match(await ask(), /Plan the offsite/, 'concluding');

  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const closed = await h.facilitation(conv);
  phases.push(lifecycleOf(closed));
  assert.match(await ask(), /Plan the offsite/, 'following_up');

  assert.deepEqual(phases, ['configuring', 'active', 'concluding', 'following_up']);
  const items = await store.listActionItems(h.db.pool, closed.id);
  assert.ok(items.length > 0 && items.every((i) => i.ownerPrincipal !== 'user:bert'), 'Bert owns no action item');
  assert.equal(closed.initiatorPrincipal, 'user:anna', 'and did not start it');
  const answers = h.kernel.authorizations.filter((a) => a.processId === closed.id && a.purpose === 'status' && a.action === 'direct_message');
  assert.deepEqual(answers.map((a) => a.kind), ['configuring', 'active', 'closing', 'follow_up'], 'each answer is a private status drawn from the scope of its phase');
});

// ── 53. No reading across processes ────────────────────────────────────────

const inboundOf = async (facilitationId: string): Promise<string[]> =>
  (await h.db.pool.query<{ message_id: string }>('SELECT message_id FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [facilitationId])).rows.map((r) => r.message_id);
const readable = async (agent: string, conv: string, processId: string): Promise<string[]> =>
  ((await h.engine.core.deps.kernel.messages()?.listSince({ agentSlug: agent, channelType: 'teams', conversationId: conv, processId }))?.events ?? []).map((e) => e.messageId);
const turnsOf = (processId: string): string[] => h.kernel.turns.filter((t) => t.processId === processId).map((t) => JSON.stringify(t));

test('53. two facilitations one after another with the old events still stored: the second gets none of the first\'s on any read path; the first still resumes its own closing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-53-seq', [ANNA, BERT]);
  const agent = 'quin';
  const first = await startActive(h, conv, { ...VOTE, goal: 'Name the boat' }, agent);
  const own = [await say(conv, 'anna', 'A')];
  // Bert cannot be reached privately: the first's protocol dispatch stays open.
  h.kernel.dmBlocked.set('user:bert', 'throttled');
  own.push(await say(conv, 'bert', 'A'));
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal((await resultClosingOf(h.db.pool, first.id))?.part, 'dispatch', 'the first facilitation\'s closing is still running');
  assert.ok(h.kernel.events.some((e) => e.conversationId === conv && e.messageId === own[0]?.messageId), 'the old events are still stored');

  const second = await startActive(h, conv, { ...VOTE, goal: 'Pick the colour' }, agent);
  assert.notEqual(second.id, first.id);
  h.kernel.onTurn = () => 'Noted.';
  try {
    await say(conv, 'anna', 'what colours are allowed?');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  await h.restart();
  h.clock.advance(MINUTE_MS);
  await h.tick();

  const oldIds = own.map((r) => r.messageId);
  for (const read of [await readable(agent, conv, second.id), await inboundOf(second.id)]) {
    assert.deepEqual(read.filter((id) => oldIds.includes(id)), [], 'delivery and replay of the second hold nothing of the first');
  }
  assert.deepEqual(await store.listContributions(h.db.pool, second.id), []);
  assert.ok(turnsOf(second.id).length > 0, 'the second asked its model');
  assert.ok(turnsOf(second.id).every((t) => !t.includes('Name the boat') && !oldIds.some((id) => t.includes(id))), 'nothing of the first in the model context of the second');

  // The first resumes its own closing: its protocol reaches Bert, as the first.
  h.kernel.dmBlocked.delete('user:bert');
  const dms = h.kernel.dms.length;
  h.clock.advance(HOUR_MS);
  await h.tick();
  const protocol = h.kernel.dms.slice(dms).filter((d) => d.principal === 'user:bert' && d.text.includes('Name the boat'));
  assert.equal(protocol.length, 1, 'the first delivers its own protocol after the restart');
  assert.equal(protocol[0]?.processId, first.id);
  assert.equal((await resultClosingOf(h.db.pool, first.id))?.part, 'done');
  assert.equal((await h.facilitation(conv)).id, second.id);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the second runs on, untouched');
  await tool(conv, 'facilitation_stop', { reason: 'test over' }, agent);
});

test('53. overlap: F1 follows up while F2 runs in the same conversation; a completion and a status request bound to F1 change only F1 and reach neither F2\'s events, replay nor model context, also after a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-53-overlap', [ANNA, BERT]);
  const agent = 'rolf';
  const at = (name: string, args: Record<string, unknown> = {}): Promise<string> => tool(conv, name, args, agent);
  await at('facilitation_start', { goal: 'Next steps of the offsite', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true });
  await at('facilitation_record_action_item', { description: 'Book the boat', owner: 'Anna', dueDate: inHours(48) });
  await say(conv, 'anna', 'yes');
  await at('facilitation_step', { action: 'close' });
  await at('facilitation_step', { action: 'close' });
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  await passWindow(h, conv);
  const f1 = await h.facilitation(conv);
  assert.equal(lifecycleOf(f1), 'following_up');
  const f1Message = h.kernel.groupPosts(conv).filter((p) => p.processId === f1.id).at(-1);

  const f2 = await startActive(h, conv, { ...VOTE, goal: 'Pick the colour' }, agent);
  await say(conv, 'anna', 'A');
  const status = await say(conv, 'bert', 'status', { replyTo: f1Message?.messageId ?? '' });
  assert.match(h.kernel.groupPosts(conv).filter((p) => p.processId === f1.id).at(-1)?.text ?? '', /Next steps of the offsite/, 'F1 answers its status');
  const done = await say(conv, 'anna', 'done 1', { replyTo: f1Message?.messageId ?? '' });
  assert.deepEqual((await store.listActionItems(h.db.pool, f1.id)).map((a) => a.status), ['done'], 'F1 changes');

  const bound = [status.messageId, done.messageId];
  const check = async (): Promise<void> => {
    assert.deepEqual((await readable(agent, conv, f2.id)).filter((id) => bound.includes(id)), [], 'not in F2\'s event list');
    assert.deepEqual((await inboundOf(f2.id)).filter((id) => bound.includes(id)), [], 'not replayed into F2');
    assert.deepEqual((await store.listContributions(h.db.pool, f2.id)).filter((c) => c.status === 'valid').map((c) => c.participantPrincipal), ['user:anna'], 'F2 holds only its ballot');
    assert.ok(turnsOf(f2.id).every((t) => !bound.some((id) => t.includes(id)) && !t.includes('Book the boat')), 'not in F2\'s model context');
  };
  await check();
  await h.restart();
  h.clock.advance(MINUTE_MS);
  await h.tick();
  h.kernel.onTurn = () => 'Noted.';
  try {
    await say(conv, 'bert', 'which colours do we have?');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  assert.ok(turnsOf(f2.id).length > 0);
  await check();
  assert.equal((await h.facilitation(conv)).phase, 'active', 'F2 runs on');
  await tool(conv, 'facilitation_stop', { reason: 'test over' }, agent);
});

// ── 55. Stakeholders ───────────────────────────────────────────────────────

test('55. a confirmed stakeholder receives an agreed invitation and the final protocol, but no contribution, status or anything else of the running facilitation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ai-55', THREE);
  const agent = 'sina';
  const at = (name: string, args: Record<string, unknown> = {}): Promise<string> => tool(conv, name, args, agent);
  const agreed = async (): Promise<void> => {
    for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
    await passWindow(h, conv);
  };
  const toStakeholders = (): number =>
    followup.mails.filter((m) => m.recipients.some((r) => ['sam@example.com', 'vera@example.com'].includes(r))).length +
    followup.invitations.filter((i) => i.attendees.some((r) => ['sam@example.com', 'vera@example.com'].includes(r))).length;
  const mails = followup.mails.length;

  await at('facilitation_start', { goal: 'Offsite plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await at('facilitation_open');
  await at('facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam@example.com', role: 'receives_protocol' });
  await agreed();
  await at('facilitation_stakeholder', { name: 'Vera Venue', address: 'vera@example.com', role: 'invited_to_followups' });
  await agreed();
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listStakeholders(h.db.pool, f.id)).filter((s) => s.confirmed).map((s) => s.address).sort(), ['sam@example.com', 'vera@example.com'], 'both confirmed by the group');

  // While it runs: contributions, a status, a reminder-worthy wait; nothing reaches a stakeholder.
  await say(conv, 'anna', 'A boat trip');
  await say(conv, 'bert', 'A secret budget line');
  await say(conv, 'cara', 'status');
  await at('facilitation_plan_followup_meeting', { subject: 'Offsite follow-up', durationMinutes: 60, earliest: h.clock.now().toISOString(), latest: inHours(8 * 24) });
  await agreed();
  h.clock.advance(HOUR_MS);
  await h.tick();
  assert.equal(toStakeholders(), 0, 'nothing of the running facilitation goes to a stakeholder');
  const targets = h.kernel.scopes.filter((s) => s.processId === f.id).flatMap((s) => s.targets).map((t) => JSON.stringify(t));
  assert.ok(targets.every((t) => !/sam|vera/i.test(t)), 'no scope lets the facilitator write to a stakeholder in the channel');

  // The close: the agreed invitation and the final protocol, nothing more.
  await at('facilitation_step', { action: 'close' });
  await at('facilitation_step', { action: 'close' });
  await agreed();
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  const sams = followup.mails.slice(mails).filter((m) => m.recipients.includes('sam@example.com'));
  assert.equal(sams.length, 1, 'Sam gets the final protocol, once');
  assert.match(sams[0]?.body ?? '', /^Protocol: Offsite plan\nResult status: published/);
  assert.doesNotMatch(sams[0]?.body ?? '', /A boat trip|secret budget|Contributed|Still open/, 'no contribution and no status');
  assert.equal(followup.mails.slice(mails).filter((m) => m.recipients.includes('vera@example.com')).length, 0, 'a stakeholder for follow-ups gets no protocol');
  const invitation = followup.invitations.find((i) => i.subject === 'Offsite follow-up');
  assert.ok(invitation?.attendees.includes('vera@example.com'), 'Vera gets the agreed invitation');
  assert.ok(!invitation?.attendees.includes('sam@example.com'), 'Sam is not invited');
  assert.doesNotMatch(invitation?.body ?? '', /A boat trip|secret budget/, 'the invitation carries no contribution');
});

// ── 58. Agent disabled or deleted ──────────────────────────────────────────

/** One facilitation of `agent` in each phase of criterion 58. */
async function fourPhases(agent: string): Promise<Record<'configuring' | 'active' | 'concluding' | 'following_up', string>> {
  const conv = (phase: string): string => h.kernel.conversation(`ai-58-${agent}-${phase}`, THREE);
  const at = (c: string, name: string, args: Record<string, unknown> = {}): Promise<string> => tool(c, name, args, agent);
  const agreed = async (c: string): Promise<void> => {
    for (const who of ['anna', 'bert', 'cara']) await say(c, who, 'agreed');
    await passWindow(h, c);
  };

  const configuring = conv('configuring');
  await at(configuring, 'facilitation_start', { goal: `Prepare ${agent}`, ...VOTE });

  // Active, with an agreed follow-up meeting whose invitation is sent only at the close.
  const active = conv('active');
  await startActive(h, active, { goal: `Decide ${agent}`, definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] }, agent);
  await at(active, 'facilitation_plan_followup_meeting', { subject: `Follow-up ${agent}`, durationMinutes: 60, earliest: h.clock.now().toISOString(), latest: inHours(8 * 24) });
  await agreed(active);

  const following = conv('following');
  await at(following, 'facilitation_start', { goal: `Next steps ${agent}`, definitionOfDone: 'Everybody can live with it', followUp: true });
  await at(following, 'facilitation_open');
  await at(following, 'facilitation_record_action_item', { description: 'Book the boat', owner: 'Anna', dueDate: inHours(72) });
  await say(following, 'anna', 'yes');
  await at(following, 'facilitation_close');
  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();

  // Last: its confirmation window must still run.
  const concluding = conv('concluding');
  await startActive(h, concluding, { goal: `Align ${agent}`, definitionOfDone: 'Everybody can live with it' }, agent);
  await at(concluding, 'facilitation_close');

  const phases = { configuring, active, concluding, following_up: following };
  for (const [phase, c] of Object.entries(phases)) assert.equal(lifecycleOf(await h.facilitation(c)), phase, `${agent}: ${phase}`);
  return phases;
}

test('58. a facilitator is disabled and another deleted while processes are in `configuring`, `active`, `concluding` and `following_up`; after a restart and re-enabling nothing resumes', { skip: PG_SKIP }, async () => {
  const cases = [
    { agent: 'tara', reason: 'agent_disabled' as const, words: /this facilitator was disabled by an operator/ },
    { agent: 'ugo', reason: 'agent_deleted' as const, words: /this facilitator is being deleted by an operator/ },
  ];
  const all: Array<(typeof cases)[number] & { convs: Record<string, string> }> = [];
  const ids: string[] = [];
  for (const spec of cases) {
    const c = { ...spec, convs: await fourPhases(spec.agent) };
    all.push(c);
    for (const conv of Object.values(c.convs)) ids.push((await h.facilitation(conv)).id);
    // As the kernel does it: first the plugin ends the processes, then the agent is off.
    const sent = [followup.invitations.length, followup.calls.filter((x) => x.method === 'freeBusy').length, h.kernel.turns.length];
    const report = await h.engine.endProcessesOfAgent({ agentSlug: c.agent, reason: c.reason });
    await h.settle();
    await h.tick();
    assert.deepEqual([followup.invitations.length, followup.calls.filter((x) => x.method === 'freeBusy').length, h.kernel.turns.length], sent, `${c.agent}: no invitation, free/busy query or model call at the end`);
    const listed = await Promise.all(Object.values(c.convs).map(async (conv) => (await h.facilitation(conv)).id));
    assert.deepEqual(report.ended.map((e) => e.processId).sort(), listed.sort(), `${c.agent}: every process is ended`);
    assert.ok(report.ended.every((e) => e.outcome === 'aborted'));
    h.kernel.disabled.add(c.agent);
    h.kernel.endService(c.agent, c.reason);
  }
  await h.restart();
  const turns = h.kernel.turns.length;
  const invitations = followup.invitations.length;
  const freeBusy = followup.calls.filter((x) => x.method === 'freeBusy').length;
  const counts = new Map<string, number>();
  for (const c of all) for (const conv of Object.values(c.convs)) counts.set(conv, h.kernel.groupPosts(conv).length);

  for (const c of all) {
    for (const [phase, conv] of Object.entries(c.convs)) {
      const f = await h.facilitation(conv);
      assert.equal(held(f.id), false, `${c.agent}/${phase}: no reservation is left`);
      assert.deepEqual(h.kernel.openScopesOf(f.id), [], `${c.agent}/${phase}: no scope is left`);
      assert.equal(lifecycleOf(f), phase === 'following_up' ? 'ended' : 'aborted', `${c.agent}/${phase}`);
      if (phase !== 'following_up') {
        assert.match(f.closeReason ?? '', c.words, `${c.agent}/${phase}: aborted with its reason`);
        assert.ok(h.kernel.groupPosts(conv).some((p) => p.as === c.agent && c.words.test(p.text)), `${c.agent}/${phase}: the group is told why`);
      }
      if (phase === 'concluding') {
        // The result that waited for its confirmation ends aborted with the process, never confirmed.
        assert.equal((await resultClosingOf(h.db.pool, f.id))?.resultStatus, 'aborted', `${c.agent}/concluding`);
      }
    }
  }

  // Re-enabled: the clock passes every deadline, reminder, window and due date.
  for (const c of all) h.kernel.disabled.delete(c.agent);
  for (let i = 0; i < 9; i += 1) {
    h.clock.advance(DAY_MS);
    await h.tick();
  }
  for (const c of all) for (const conv of Object.values(c.convs)) await say(conv, 'anna', 'A');
  await h.restart();
  await h.tick();

  assert.equal(h.kernel.turns.length, turns, 'no model call');
  assert.equal(followup.invitations.length, invitations, 'no invitation');
  assert.equal(followup.calls.filter((x) => x.method === 'freeBusy').length, freeBusy, 'no free/busy query');
  for (const c of all) {
    for (const [phase, conv] of Object.entries(c.convs)) {
      assert.equal(h.kernel.groupPosts(conv).length, counts.get(conv), `${c.agent}/${phase}: nothing resumes`);
      const f = await h.facilitation(conv);
      assert.equal(held(f.id), false);
      assert.equal(lifecycleOf(f), phase === 'following_up' ? 'ended' : 'aborted');
      if (phase === 'concluding') assert.equal((await resultClosingOf(h.db.pool, f.id))?.resultStatus, 'aborted', 'not confirmed after the window');
    }
  }
  assert.equal(h.kernel.dms.filter((d) => /still open|Reminder/.test(d.text) && ids.includes(d.processId ?? '')).length, 0, 'no reminder');
});
