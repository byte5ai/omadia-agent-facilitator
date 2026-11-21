// Acceptance suite, follow-up and scopes: spec B §9 criteria 20 (the
// sub-clauses not covered elsewhere), 21, 25, 27 and 28 (#2068).
//
// End to end on the fake kernel with its simulated channel, a fake clock and
// a real Postgres. Each test is named by its criterion; what other files
// already cover is listed in docs/acceptance-matrix.md.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { scoped } from '../src/engine/capabilities.js';
import { listClosings } from '../src/engine/resultStatus.js';
import { lifecycleOf } from '../src/model.js';
import type { Facilitation } from '../src/model.js';
import { ANNA, BERT, CARA, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-23T08:00:00Z', config: { maxActivePerFacilitator: 40, startsPerHourPerFacilitator: 100 } });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
  h.kernel.names.set('mira', 'Mira');
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const THREE = [ANNA, BERT, CARA];
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
async function say(conv: string, who: string, text: string, opts: { replyTo?: string } = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const all = async (conv: string, text: string, who = ['anna', 'bert', 'cara']): Promise<void> => {
  for (const person of who) await say(conv, person, text);
  if (text === 'agreed') await passWindow(h, conv);
};
const inDays = (days: number): Date => new Date(h.clock.now().getTime() + days * DAY_MS);
const items = async (id: string): Promise<string[]> => (await store.listActionItems(h.db.pool, id)).map((a) => a.status);
const authorized = (processId: string) => h.kernel.authorizations.filter((a) => a.processId === processId);
const reminderDmsTo = (principal: string, since: number) => h.kernel.dms.slice(since).filter((d) => d.principal === principal && /action item #\d+ is due/.test(d.text));

/** Close the remaining steps until the binding close is proposed. */
async function toBindingClose(conv: string): Promise<void> {
  const proposed = (): boolean => /^Proposal: /.test(posts(conv).at(-1) ?? '');
  for (let i = 0; i < 6 && !proposed() && (await h.facilitation(conv)).phase === 'active'; i++) await tool(conv, 'facilitation_step', { action: 'close' });
  assert.ok(proposed(), JSON.stringify(posts(conv).slice(-3)));
}

/** Close the remaining steps and the facilitation with the group's consent. */
async function closeAll(conv: string, who = ['anna', 'bert', 'cara']): Promise<Facilitation> {
  await toBindingClose(conv);
  await all(conv, 'agreed', who);
  return h.facilitation(conv);
}

// ── 20: the scheduling grant ends when the date passed ──────────────────────

test('20. the scheduling grant ends when the agreed dates passed without invitations: after a restart nothing is asked of the calendar and no invitation goes out', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-20-date', THREE);
  for (const who of ['anna', 'bert', 'cara']) followup.calendars.set(`${who}@example.com`, []);
  await tool(conv, 'facilitation_start', { goal: 'Offsite plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await say(conv, 'anna', 'A boat trip');
  await tool(conv, 'facilitation_plan_followup_meeting', { subject: 'Offsite follow-up', durationMinutes: 60, earliest: h.clock.now().toISOString(), latest: inDays(2).toISOString() });
  await all(conv, 'agreed');
  const f = await h.facilitation(conv);
  assert.equal(h.kernel.scopeOf(f.id, 'scheduling', 'followup_meeting')?.state, 'open', 'the scheduling scope is opened once the meeting is agreed');
  // The group agrees to close; the middleware is down while the window and
  // the agreed dates pass, and comes back after them.
  await toBindingClose(conv);
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  const calls = followup.calls.filter((c) => c.grant.facilitationId === f.id).length;
  await h.engine.stop();
  h.clock.set(inDays(3));
  await h.restart();
  await h.tick();
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  const after = followup.calls.filter((c) => c.grant.facilitationId === f.id);
  assert.ok(!after.slice(calls).some((c) => c.method === 'freeBusy' || c.method === 'createInvitation'), 'no calendar call after the agreed dates');
  assert.equal(followup.invitations.filter((i) => i.subject === 'Offsite follow-up').length, 0);
  // Whatever scheduling grant exists is no longer live, and none can be drawn.
  const grants = (await h.engine.core.deps.kernel.grants()?.listGrants(f.id)) ?? [];
  assert.ok(grants.filter((g) => g.kind === 'followup_scheduling').every((g) => !g.live));
  const late = await (await scoped(h.engine.core, f.id)).freeBusy(['anna@example.com'], inDays(1), inDays(2));
  assert.equal(late.ok, false);
  assert.equal(followup.calls.filter((c) => c.grant.facilitationId === f.id).length, after.length, 'the integration is not even asked');
  assert.notEqual(h.kernel.scopeOf(f.id, 'scheduling', 'followup_meeting')?.state, 'open');
});

// ── 20 (reminder grant) and 21 ──────────────────────────────────────────────

/**
 * A prioritisation step that closes with a winner, then an assignment step
 * on the agenda, then the close: the facilitation goes on to the assignment
 * instead of concluding.
 */
async function prioritiseThenAssign(conv: string, statusAt?: Date): Promise<Facilitation> {
  await tool(conv, 'facilitation_start', {
    goal: 'Next quarter',
    definitionOfDone: 'A focus is chosen and its tasks have owners',
    followUp: true,
    ...(statusAt ? { followUpStatusAt: statusAt.toISOString() } : {}),
    agenda: [
      { kind: 'prioritise', title: 'Pick the focus', method: 'single', options: ['Onboarding', 'Billing'] },
      { kind: 'assign', title: 'Owners' },
      { kind: 'close', title: 'Close' },
    ],
  });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  await all(conv, 'A');
  const decided = await store.listDecisions(h.db.pool, f.id);
  assert.equal(decided[0]?.result['winner'], 'A', 'the prioritisation closes with a winner');
  const now = await h.facilitation(conv);
  assert.equal(now.phase, 'active', 'the agenda continues instead of concluding');
  assert.equal((await store.openStepOf(h.db.pool, f.id))?.title, 'Owners', 'the assignment step is open');
  return now;
}

test('21. multi-step and follow-up: a prioritisation closes with a winner and the agenda continues to the assignment; after the close, a restart and the owner\'s completion in the home conversation, the pending reminder is not sent and the status post shows the item done', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-21', THREE);
  const statusAt = inDays(4);
  const f = await prioritiseThenAssign(conv, statusAt);
  await tool(conv, 'facilitation_record_action_item', { description: 'Write the onboarding guide', owner: 'Bert', dueDate: inDays(6).toISOString() });
  await say(conv, 'bert', 'yes');
  await tool(conv, 'facilitation_record_action_item', { description: 'Record the demo', owner: 'Cara', dueDate: inDays(6).toISOString() });
  await say(conv, 'cara', 'yes');
  await closeAll(conv);
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed', JSON.stringify(posts(conv).slice(-6), null, 1));
  assert.equal(lifecycleOf(closed), 'following_up');

  await h.restart();
  // Bert reports his item done in the home conversation, by a reply to the
  // facilitator's message (in follow-up it hears what is addressed to it).
  const own = h.kernel.groupPosts(conv).filter((p) => p.processId === f.id).at(-1);
  await say(conv, 'bert', 'done 1', { replyTo: own?.messageId ?? '' });
  assert.deepEqual(await items(f.id), ['done', 'confirmed']);
  assert.ok(posts(conv).includes('Done, thank you Bert: #1 Write the onboarding guide'));

  const dms = h.kernel.dms.length;
  h.clock.set(new Date(statusAt.getTime() + MINUTE_MS));
  await h.tick();
  const status = posts(conv).filter((t) => t.startsWith('Status of the action items:')).at(-1) ?? '';
  assert.match(status, /#1 Write the onboarding guide.*: done/);
  assert.match(status, /#2 Record the demo.*: open/);
  h.clock.set(inDays(2)); // past the 24 h lead before the due date
  await h.tick();
  assert.equal(reminderDmsTo('user:bert', dms).length, 0, "the done item's reminder is not sent");
  assert.equal(reminderDmsTo('user:cara', dms).length, 1, 'the open one is');
});

test('20. the reminder grant ends at `ended`, also across a restart: no reminder after it, nothing drawn from the follow-up scope', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-20-reminder', THREE);
  const f = await prioritiseThenAssign(conv);
  await tool(conv, 'facilitation_record_action_item', { description: 'Write the onboarding guide', owner: 'Bert', dueDate: inDays(6).toISOString() });
  await say(conv, 'bert', 'yes');
  await closeAll(conv);
  assert.equal(lifecycleOf(await h.facilitation(conv)), 'following_up');
  assert.equal(h.kernel.scopeOf(f.id, 'follow_up')?.state, 'open');
  await h.restart();
  const own = h.kernel.groupPosts(conv).filter((p) => p.processId === f.id).at(-1);
  await say(conv, 'bert', 'done 1', { replyTo: own?.messageId ?? '' });
  assert.equal(lifecycleOf(await h.facilitation(conv)), 'ended');
  await h.restart();
  await h.tick();
  assert.equal(h.kernel.scopeOf(f.id, 'follow_up')?.state, 'ended', 'the follow-up scope ends at `ended`');
  const drawn = authorized(f.id).length;
  const dms = h.kernel.dms.length;
  h.clock.set(inDays(7));
  await h.tick();
  assert.equal(reminderDmsTo('user:bert', dms).length, 0);
  assert.equal(authorized(f.id).length, drawn, 'nothing more is drawn for this facilitation');
});

// ── 25: execution scopes ────────────────────────────────────────────────────

test('25. after the deadline no moderation action runs, the abort report is delivered within `closing` also after a restart during its delivery, and a later follow-up reminder runs within `follow_up`', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-25', THREE);
  const deadline = new Date(h.clock.now().getTime() + 3 * HOUR_MS);
  await tool(conv, 'facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Garden'], deadline: deadline.toISOString(), reminderMinutesBefore: [] });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  // Nobody votes. The first send at the deadline (the abort report) fails
  // with the process gone: a restart during its delivery.
  h.kernel.sendFaults.push('throw');
  h.clock.set(new Date(deadline.getTime() + MINUTE_MS));
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  await h.restart();
  h.clock.advance(MINUTE_MS);
  await h.tick();
  const reports = posts(conv).filter((t) => /deadline/i.test(t) && /Pick a venue/.test(t));
  assert.equal(reports.length, 1, `exactly one abort report: ${JSON.stringify(posts(conv).slice(-3))}`);
  const report = h.kernel.groupPosts(conv).find((p) => p.text === reports[0]);
  const drawn = authorized(f.id).find((a) => a.action === 'post' && a.phase === 'aborted');
  assert.deepEqual([drawn?.kind, h.kernel.scopes.find((s) => s.id === drawn?.scopeId)?.eventId], ['closing', 'abort'], 'drawn from the closing scope of the abort');
  assert.equal(report?.processId, f.id);
  assert.equal(h.kernel.scopeOf(f.id, 'active')?.state, 'ended');

  // No moderation action runs any more: no turn, no post, no tool.
  const turns = h.kernel.turns.length;
  const drawnBefore = authorized(f.id).length;
  const before = posts(conv).length;
  h.kernel.onTurn = () => 'This must never be posted.';
  try {
    await say(conv, 'anna', '@Mira can we still vote?');
    await say(conv, 'bert', 'A');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  assert.equal(h.kernel.turns.filter((t) => t.processId === f.id).length, h.kernel.turns.slice(0, turns).filter((t) => t.processId === f.id).length, 'no turn of this facilitation');
  assert.equal(posts(conv).length, before);
  assert.deepEqual(await store.listContributions(h.db.pool, f.id), [], 'the late vote is not recorded');
  assert.equal(authorized(f.id).length, drawnBefore, 'nothing is drawn for this facilitation after its closing');
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Refused/);

  // A follow-up reminder of another facilitation runs within `follow_up`.
  const other = h.kernel.conversation('af-25-followup', THREE);
  const g = await prioritiseThenAssign(other);
  await tool(other, 'facilitation_record_action_item', { description: 'Book the room', owner: 'Cara', dueDate: inDays(3).toISOString() }, 'anna');
  await say(other, 'cara', 'yes');
  await closeAll(other);
  const dms = h.kernel.dms.length;
  h.clock.set(inDays(2));
  await h.restart();
  await h.tick();
  assert.equal(reminderDmsTo('user:cara', dms).length, 1);
  const reminder = authorized(g.id).filter((a) => a.action === 'direct_message').at(-1);
  assert.deepEqual([reminder?.kind, reminder?.phase], ['follow_up', 'following_up']);
});

// ── 27: closing and session confirmation ────────────────────────────────────

test('27. an abort without action items still delivers its report to the home conversation within `closing`, also when its first send fails and the middleware restarts', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-27-abort', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Team rules', definitionOfDone: 'Rules agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }], followUp: true });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  h.kernel.sendFaults.push({ code: 'channel_error', message: 'the channel is down' });
  await say(conv, 'anna', 'stop');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  assert.ok(!posts(conv).some((t) => /asked to stop/.test(t)), 'the first send failed');
  assert.deepEqual(await store.listActionItems(h.db.pool, f.id), []);
  await h.restart();
  h.clock.advance(MINUTE_MS);
  await h.tick();
  await h.tick();
  const reports = h.kernel.groupPosts(conv).filter((p) => /asked to stop/.test(p.text));
  assert.equal(reports.length, 1, 'delivered once after the restart');
  assert.equal(reports[0]?.processId, f.id);
  const drawn = authorized(f.id).filter((a) => a.action === 'post' && a.phase === 'aborted');
  assert.ok(drawn.length > 0 && drawn.every((a) => a.kind === 'closing' && h.kernel.scopes.find((s) => s.id === a.scopeId)?.eventId === 'abort'), 'drawn from the closing scope of the abort');
  const ended = await h.facilitation(conv);
  assert.deepEqual([lifecycleOf(ended), ended.followupState], ['aborted', 'none'], 'never `following_up`');
  assert.deepEqual(h.kernel.openScopesOf(f.id), [], 'the closing scope ends once its report is out');
});

test('27. a session summary that needs consent is confirmed in its linked conversation after the slot ended while the facilitation stays `active`; a late vote there is refused', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('af-27-home', THREE);
  const chat = h.kernel.conversation('af-27-chat', THREE);
  const goal = 'Charter af-27';
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Everybody can live with the charter', agenda: [{ kind: 'decide', title: 'Pick the motto' }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(home, 'facilitation_open');
  const start = new Date(h.clock.now().getTime() + 60 * MINUTE_MS);
  const end = new Date(start.getTime() + 60 * MINUTE_MS);
  await tool(home, 'facilitation_session', { action: 'schedule', title: 'Motto call', start: start.toISOString(), end: end.toISOString(), modality: 'online' });
  await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal}`);
  await h.settle();
  const f = await h.facilitation(home);
  const session = async () => (await store.listSessions(h.db.pool, f.id)).find((s) => s.title === 'Motto call');
  h.clock.set(new Date(start.getTime() + MINUTE_MS));
  await h.tick();
  assert.equal((await session())?.status, 'live');
  // The options are set in the session; the definition of done stays free
  // text, so the session summary needs the group's confirmation.
  assert.match(await tool(home, 'facilitation_set_decision', { method: 'single', options: ['Calm', 'Bold'] }), /^Set\./);
  await say(chat, 'anna', 'A');
  const during = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
  assert.deepEqual(during.map((c) => c.participantPrincipal), ['user:anna'], 'a vote in the session counts during the session');

  // The slot ends: the summary needs consent, the facilitation stays active.
  h.clock.set(new Date(end.getTime() + MINUTE_MS));
  await h.tick();
  await h.tick();
  assert.equal((await session())?.status, 'confirming', JSON.stringify(posts(chat).slice(-4), null, 1));
  assert.match(posts(chat).find((t) => t.startsWith('Summary of the session "Motto call"')) ?? '', /Please confirm this summary/);
  assert.equal((await h.facilitation(home)).phase, 'active');

  // A late vote in the session conversation is refused: nothing recorded.
  await say(chat, 'bert', 'B');
  const valid = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
  assert.deepEqual(valid.map((c) => c.participantPrincipal), ['user:anna'], 'the late vote does not count');

  // Consent answers there, without a mention and without a reply, count.
  await say(chat, 'cara', 'objection: the motto is missing');
  assert.match(posts(chat).at(-1) ?? '', /^Objection from Cara/);
  await say(chat, 'cara', 'agreed');
  await h.restart();
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  await h.tick();
  const closed = await session();
  assert.equal(closed?.status, 'closed');
  const closing = (await listClosings(h.db.pool, f.id)).find((c) => c.sessionId === closed?.id);
  assert.deepEqual([closing?.resultStatus, closing?.objections], ['confirmed', []], "Cara's agreement lifted her objection");
  assert.equal((await h.facilitation(home)).phase, 'active', 'the facilitation goes on');
  await tool(home, 'facilitation_stop', { reason: 'test over' });
});

// ── 28: follow-up replies ───────────────────────────────────────────────────

/** A facilitation in `conv` that closed with action items of Anna, in follow-up. */
async function annasFollowUp(conv: string, goal: string, tasks: readonly string[]): Promise<Facilitation> {
  await tool(conv, 'facilitation_start', { goal, definitionOfDone: 'Owners agreed', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true });
  for (const task of tasks) {
    await tool(conv, 'facilitation_record_action_item', { description: task, owner: 'Anna', dueDate: inDays(3).toISOString() });
    await say(conv, 'anna', 'yes');
  }
  const f = await closeAll(conv, ['anna', 'bert']);
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

test('28. one facilitator follows up three facilitations for the same person: each direct reply completes only the item of its reminder, and a stop in reply to one reminder ends only that follow-up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('af-28', [ANNA, BERT]);
  const offsite = await annasFollowUp(conv, 'Offsite', ['Book the boat']);
  const budget = await annasFollowUp(conv, 'Budget', ['Ask finance', 'Draft the budget']);
  const party = await annasFollowUp(conv, 'Party', ['Order drinks']);
  // Anna cannot be reached privately: every reminder is in the group.
  h.kernel.dmBlocked.set('user:anna', 'blocked');
  try {
    h.clock.set(inDays(2));
    await h.restart();
    await h.tick();
    const reminderOf = (f: Facilitation, task: string) => h.kernel.groupPosts(conv).find((p) => p.processId === f.id && p.text.includes('is due') && p.text.includes(task));
    for (const [f, task] of [[offsite, 'Book the boat'], [budget, 'Ask finance'], [budget, 'Draft the budget'], [party, 'Order drinks']] as const) assert.ok(reminderOf(f, task), `reminder for ${task}`);
    const state = async () => Promise.all([offsite, budget, party].map(async (f) => [(await store.getFacilitation(h.db.pool, f.id))?.followupState, await items(f.id)]));

    // A bare "erledigt" in reply to the reminder of Budget #2.
    await say(conv, 'anna', 'erledigt', { replyTo: reminderOf(budget, 'Draft the budget')?.messageId ?? '' });
    assert.deepEqual(await state(), [['active', ['confirmed']], ['active', ['confirmed', 'done']], ['active', ['confirmed']]], JSON.stringify(posts(conv).slice(-3), null, 1));
    // "done" in reply to the reminder of Offsite: only Offsite's item.
    await say(conv, 'anna', 'done', { replyTo: reminderOf(offsite, 'Book the boat')?.messageId ?? '' });
    assert.deepEqual(await state(), [['ended', ['done']], ['active', ['confirmed', 'done']], ['active', ['confirmed']]]);
    // "stop" in reply to the reminder of Party ends only Party's follow-up.
    await say(conv, 'anna', 'stop', { replyTo: reminderOf(party, 'Order drinks')?.messageId ?? '' });
    assert.deepEqual(await state(), [['ended', ['done']], ['active', ['confirmed', 'done']], ['ended', ['confirmed']]]);
    assert.equal(h.kernel.groupPosts(conv).filter((p) => /several facilitations/i.test(p.text)).length, 0, 'no question was needed');
  } finally {
    h.kernel.dmBlocked.delete('user:anna');
  }
});
