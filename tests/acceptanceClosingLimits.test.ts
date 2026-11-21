// Acceptance suite: spec B §9, the closing limits (byte5ai/omadia#2068).
//
// Criteria 31 (second half), 32, 34 (the parts not in closing.test.ts), 42,
// 43 and 59 (the failed-delivery and unknown-roster variants), end to end on
// the fake kernel with its simulated channel, a fake clock and a real
// Postgres. Already covered elsewhere and not repeated here:
//   34  window from the confirmed delivery, nobody answers, a standing
//       objection: closing.test.ts "34. ..."; nothing after the absolute
//       limit: closing.test.ts "the absolute limit ..."; a last session
//       ending exactly at the deadline gets its window: sessionClose.test.ts
//       "criterion 59 ..." (consent variant)
//   59  objection and consent: sessionClose.test.ts "criterion 59 ..."

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { resultClosingOf } from '../src/engine/closing.js';
import { CLOSING_LIMITS, listClosings } from '../src/engine/resultStatus.js';
import type { Closing, Session } from '../src/model.js';
import { ANNA, BERT, CARA, FOUR, createHarness, passWindow, startActive } from './harness.js';
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
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const THREE = [ANNA, BERT, CARA];
const FREE = { goal: 'Align on the roadmap', definitionOfDone: 'Everybody can live with the roadmap' };
const VENUES = { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Old Town'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const results = (conv: string): string[] => posts(conv).filter((t) => t.startsWith('Result for'));
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
const say = async (conv: string, who: string, text: string): Promise<void> => {
  await h.kernel.say(conv, who, text);
  await h.settle();
};
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const resultClosing = async (conv: string): Promise<Closing> => {
  const c = await resultClosingOf(h.db.pool, (await h.facilitation(conv)).id);
  if (!c) throw new Error('no result closing');
  return c;
};
const sessionNamed = async (facilitationId: string, title: string): Promise<Session | undefined> => (await store.listSessions(h.db.pool, facilitationId)).find((s) => s.title === title);
const sessionClosing = async (facilitationId: string, title: string): Promise<Closing | undefined> => {
  const session = await sessionNamed(facilitationId, title);
  return (await listClosings(h.db.pool, facilitationId)).find((c) => c.sessionId === session?.id && c.kind === 'session');
};
const aborts = (conv: string): string[] => posts(conv).filter((t) => t.includes('ends without a result'));
/** Tick in steps until `until` (ms from now), one scheduler pass per step. */
async function runFor(ms: number, step = 6 * HOUR_MS): Promise<void> {
  const end = h.clock.now().getTime() + ms;
  while (h.clock.now().getTime() + step <= end) {
    h.clock.advance(step);
    await h.tick();
  }
  h.clock.set(new Date(end));
  await h.tick();
}

/** A facilitation in `home` with sessions in linked meeting chats, scheduled
 *  at the given minutes from now (each 60 minutes long unless `end`). */
async function withSessions(name: string, setup: Record<string, unknown>, sessions: Array<{ title: string; start: number; end?: string }>) {
  const home = h.kernel.conversation(`${name}-home`, THREE);
  const goal = String(setup['goal']);
  await tool(home, 'facilitation_start', setup);
  await tool(home, 'facilitation_open');
  const chats: Record<string, string> = {};
  for (const s of sessions) {
    await tool(home, 'facilitation_session', { action: 'schedule', title: s.title, start: inMinutes(s.start), ...(s.end ? { end: s.end } : {}), modality: 'online' });
    const chat = h.kernel.conversation(`${name}-${s.title.split(' ')[0]?.toLowerCase() ?? ''}`, THREE);
    chats[s.title] = chat;
    await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal} for ${s.title}`);
    await h.settle();
  }
  return { home, f: await h.facilitation(home), chats };
}

test('31. two sessions close during the same active facilitation: each summary under its own closing scope and its own 7-day limit, independently, also across a restart', { skip: PG_SKIP }, async () => {
  const setup = { goal: 'Offsite ideas 31', definitionOfDone: 'Ideas are collected', agenda: [{ kind: 'collect', title: 'Ideas' }, { kind: 'close', title: 'Close' }] };
  const { home, f, chats } = await withSessions('al31', setup, [{ title: 'Gamma call', start: 60 }, { title: 'Beta call', start: 180 }]);
  const gamma = chats['Gamma call'] as string;
  const beta = chats['Beta call'] as string;
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'live');
  // Gamma's chat cannot be reached from now on: its summary keeps failing.
  h.kernel.blockedConversations.set(gamma, 'throttled');
  await tool(home, 'facilitation_session', { action: 'end' });
  const gammaClosing = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([gammaClosing?.requiresConfirmation, gammaClosing?.deliveryStatus], [false, 'pending']);
  h.clock.advance(2 * HOUR_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Beta call'))?.status, 'live');
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  await h.tick();
  const betaClosing = await sessionClosing(f.id, 'Beta call');
  assert.deepEqual([betaClosing?.deliveryStatus, betaClosing?.resultStatus, betaClosing?.part], ['delivered', 'published', 'done'], 'Beta does not wait for Gamma');
  assert.equal(posts(beta).filter((t) => t.includes('Summary of the session "Beta call"')).length, 1);
  // Two closing events, two scopes of their own.
  const gammaScope = h.kernel.scopeOf(f.id, 'closing', gammaClosing?.eventId);
  const betaScope = h.kernel.scopeOf(f.id, 'closing', betaClosing?.eventId);
  assert.ok(gammaScope && betaScope && gammaScope.id !== betaScope.id, 'each closing event has its own scope');
  assert.equal(betaScope.state, 'ended', 'Beta\'s scope ends with its closing');
  assert.equal(gammaScope.state, 'open', 'Gamma\'s scope runs on');

  await h.restart();
  // Six days later Gamma is still within its own delivery limit.
  await runFor(6 * DAY_MS - 3 * HOUR_MS);
  assert.equal((await sessionClosing(f.id, 'Gamma call'))?.deliveryStatus, 'pending');
  // Its limit counts from its own start, not from Beta's or the facilitation's.
  const limit = (gammaClosing?.partStartedAt.getTime() ?? 0) + CLOSING_LIMITS.deliveryMs;
  h.clock.set(new Date(limit + MINUTE_MS));
  await h.tick();
  await h.tick();
  const gammaAfter = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([gammaAfter?.deliveryStatus, gammaAfter?.resultStatus, gammaAfter?.part], ['not_delivered', 'published', 'done'], 'not delivered at its own 7-day limit');
  assert.equal(h.kernel.scopeOf(f.id, 'closing', gammaClosing?.eventId)?.state, 'ended');
  // Once the chat is reachable again nothing of that closing is sent.
  h.kernel.blockedConversations.delete(gamma);
  h.clock.advance(HOUR_MS);
  await h.tick();
  assert.equal(posts(gamma).filter((t) => t.includes('Summary of the session "Gamma call"')).length, 0);
  assert.equal((await h.facilitation(home)).phase, 'active', 'the facilitation runs on');
});

test('32. a valid result evaluated exactly at the deadline is published: no abort, no moderation re-opens', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('al-32-exact', FOUR);
  const f = await startActive(h, conv, { ...VENUES, deadline: new Date(h.clock.now().getTime() + 2 * DAY_MS).toISOString() });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  h.clock.set(f.deadline as Date);
  await h.tick();
  await h.tick();
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.equal(results(conv).length, 1);
  assert.match(results(conv)[0] ?? '', /Harbour/);
  assert.deepEqual([(await resultClosing(conv)).resultStatus, (await resultClosing(conv)).deliveryStatus], ['published', 'delivered']);
  assert.deepEqual(aborts(conv), [], 'no abort report');
  const contributions = (await store.listContributions(h.db.pool, f.id)).length;
  await say(conv, 'dave', 'B');
  assert.equal((await store.listContributions(h.db.pool, f.id)).length, contributions, 'a late ballot counts nothing');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('32. a result whose send fails shortly before the deadline is delivered after a restart past it: published, no abort, no moderation re-opens', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('al-32-late', FOUR);
  const f = await startActive(h, conv, { ...VENUES, deadline: new Date(h.clock.now().getTime() + 2 * DAY_MS).toISOString() });
  const deadline = f.deadline as Date;
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'B');
  h.clock.set(new Date(deadline.getTime() - 10 * MINUTE_MS));
  // The last ballot concludes; the result's send fails for now.
  h.kernel.blockedConversations.set(conv, 'throttled');
  await say(conv, 'dave', 'B');
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  assert.equal((await resultClosing(conv)).deliveryStatus, 'pending');
  await h.restart();
  h.kernel.blockedConversations.delete(conv);
  h.clock.set(new Date(deadline.getTime() + 30 * MINUTE_MS));
  await h.tick();
  await h.tick();
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.equal(results(conv).length, 1);
  assert.match(results(conv)[0] ?? '', /Old Town/);
  assert.deepEqual([(await resultClosing(conv)).resultStatus, (await resultClosing(conv)).deliveryStatus], ['published', 'delivered']);
  assert.deepEqual(aborts(conv), [], 'the deadline passing during delivery needs no abort');
  await say(conv, 'anna', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed', 'nothing re-opens');
});

test('34. the closing scope stays valid while the window runs, also when every send was confirmed at once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('al-34-scope', THREE);
  const f = await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_close');
  await h.tick();
  const c = await resultClosing(conv);
  assert.deepEqual([c.deliveryStatus, c.part], ['delivered', 'confirmation'], 'delivered at once');
  const pending = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status IN ('pending', 'sending')`, [f.id]);
  assert.equal(pending.rows.length, 0, 'nothing of it is waiting to be sent');
  for (let hour = 0; hour < 23; hour += 1) {
    h.clock.advance(HOUR_MS);
    await h.tick();
    assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'open', `the scope is valid ${String(hour + 1)} h into the window`);
  }
  // An objection inside the window is still taken, under that scope.
  await say(conv, 'cara', 'objection: the hiring plan is missing');
  assert.match(posts(conv).at(-1) ?? '', /Cara/);
  h.clock.advance(2 * HOUR_MS);
  await h.tick();
  const final = await resultClosing(conv);
  assert.deepEqual([final.resultStatus, final.resultReason], ['not_confirmed', 'objection']);
  assert.match(posts(conv).join('\n'), /Result status: not confirmed \(objection\)/);
});

test('34. a delivery confirmed one hour before the 7-day limit still gets its full window; the stakeholder dispatch after it runs, retried after a failed first send and a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('al-34-late', THREE);
  await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam-34@example.com', role: 'receives_protocol' });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  await passWindow(h, conv);
  h.kernel.blockedConversations.set(conv, 'throttled');
  await tool(conv, 'facilitation_close');
  const start = (await resultClosing(conv)).partStartedAt.getTime();
  await runFor(start + CLOSING_LIMITS.deliveryMs - 2 * HOUR_MS - h.clock.now().getTime());
  assert.equal((await resultClosing(conv)).deliveryStatus, 'pending');
  await h.restart();
  // The channel is back one hour before the delivery limit.
  h.kernel.blockedConversations.delete(conv);
  h.clock.set(new Date(start + CLOSING_LIMITS.deliveryMs - HOUR_MS));
  await h.tick();
  const delivered = await resultClosing(conv);
  assert.equal(delivered.deliveryStatus, 'delivered');
  assert.equal(delivered.part, 'confirmation');
  assert.equal(delivered.windowEndsAt?.getTime(), (delivered.deliveredAt?.getTime() ?? 0) + 24 * HOUR_MS, 'the full window, past the delivery limit');
  // Past the delivery limit the window still runs.
  h.clock.set(new Date(start + CLOSING_LIMITS.deliveryMs + 2 * HOUR_MS));
  await h.tick();
  assert.equal((await resultClosing(conv)).resultStatus, null);
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  // The stakeholder's protocol fails first; a restart follows.
  followup.mailRefusals.push('provider_error');
  const mails = followup.mails.length;
  h.clock.set(new Date((delivered.windowEndsAt?.getTime() ?? 0) + MINUTE_MS));
  await h.tick();
  await h.tick();
  const final = await resultClosing(conv);
  assert.deepEqual([final.resultStatus, final.part], ['confirmed', 'dispatch']);
  assert.equal(followup.mails.length, mails, 'the first send failed');
  await h.restart();
  await runFor(3 * HOUR_MS, HOUR_MS);
  const toSam = followup.mails.slice(mails).filter((m) => m.recipients.includes('sam-34@example.com'));
  assert.equal(toSam.length, 1, 'sent once, on the retry');
  assert.match(toSam[0]?.body ?? '', /^Protocol: Align on the roadmap\nResult status: confirmed\n/);
  const done = await resultClosing(conv);
  assert.equal(done.part, 'done', 'the dispatch ends once its sends are confirmed');
  assert.ok(done.endedAt && done.dispatchUntil && done.endedAt <= done.dispatchUntil, 'within its own limit');
});

test('42. a session summary delivered one hour before its 7-day limit while the facilitation is concluding: its full window runs, then the final summary is delivered and dispatched within its own limits, across a restart', { skip: PG_SKIP }, async () => {
  const { home, f, chats } = await withSessions('al42', { goal: 'Team charter 42', ...{ definitionOfDone: 'Everybody can live with the charter' }, agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] }, [{ title: 'Gamma call', start: 60 }]);
  const gamma = chats['Gamma call'] as string;
  await tool(home, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam-42@example.com', role: 'receives_protocol' });
  for (const who of ['anna', 'bert', 'cara']) await say(home, who, 'agreed');
  await passWindow(h, home);
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'live');
  h.kernel.blockedConversations.set(gamma, 'throttled');
  await tool(home, 'facilitation_session', { action: 'end' });
  const opened = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([opened?.requiresConfirmation, opened?.deliveryStatus], [true, 'pending']);
  // The facilitation concludes meanwhile: its result waits for the session.
  await tool(home, 'facilitation_close');
  assert.equal((await h.facilitation(home)).phase, 'concluding');
  assert.equal((await resultClosing(home)).part, 'waiting');
  const start = opened?.partStartedAt.getTime() ?? 0;
  await runFor(start + CLOSING_LIMITS.deliveryMs - 2 * HOUR_MS - h.clock.now().getTime());
  await h.restart();
  h.kernel.blockedConversations.delete(gamma);
  h.clock.set(new Date(start + CLOSING_LIMITS.deliveryMs - HOUR_MS));
  await h.tick();
  const delivered = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([delivered?.deliveryStatus, delivered?.part], ['delivered', 'confirmation']);
  assert.equal(delivered?.windowEndsAt?.getTime(), (delivered?.deliveredAt?.getTime() ?? 0) + 24 * HOUR_MS, 'its full window');
  assert.equal(results(home).length, 0, 'the final summary waits');
  // An answer in the window still counts.
  await say(gamma, 'bert', 'agreed');
  h.clock.set(new Date(start + CLOSING_LIMITS.deliveryMs + 12 * HOUR_MS));
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'confirming', 'still in its window past the delivery limit');
  assert.equal((await resultClosing(home)).part, 'waiting');
  await h.restart();
  h.clock.set(new Date((delivered?.windowEndsAt?.getTime() ?? 0) + MINUTE_MS));
  await h.tick();
  await h.tick();
  assert.equal((await sessionClosing(f.id, 'Gamma call'))?.resultStatus, 'confirmed');
  const result = await resultClosing(home);
  assert.deepEqual([result.part, result.deliveryStatus], ['confirmation', 'delivered'], 'then the final summary goes out, with its own window');
  assert.equal(results(home).length, 1);
  const mails = followup.mails.length;
  h.clock.set(new Date((result.windowEndsAt?.getTime() ?? 0) + MINUTE_MS));
  await h.tick();
  await h.tick();
  const final = await resultClosing(home);
  assert.deepEqual([final.resultStatus, final.part], ['confirmed', 'done']);
  assert.equal(followup.mails.slice(mails).filter((m) => m.recipients.includes('sam-42@example.com')).length, 1, 'dispatched to the stakeholder');
  assert.ok(final.endedAt && final.endedAt.getTime() <= final.absoluteUntil.getTime());
});

/** A session summary whose first send fails, then a stop and a restart. */
async function stopDuringSessionClosing(name: string, setup: Record<string, unknown>) {
  const { home, f, chats } = await withSessions(name, setup, [{ title: 'Gamma call', start: 60 }]);
  const gamma = chats['Gamma call'] as string;
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  h.kernel.blockedConversations.set(gamma, 'throttled');
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  const before = await sessionClosing(f.id, 'Gamma call');
  assert.equal(before?.deliveryStatus, 'pending');
  await say(home, 'bert', 'stop');
  assert.equal((await h.facilitation(home)).phase, 'aborted');
  await h.restart();
  h.kernel.blockedConversations.delete(gamma);
  h.clock.advance(HOUR_MS);
  await h.tick();
  await h.tick();
  const attempts = await h.db.pool.query<{ purpose: string; status: string }>(
    `SELECT purpose, status FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND closing_id = $2 ORDER BY seq`,
    [f.id, before?.id],
  );
  return { home, f, gamma, closing: await sessionClosing(f.id, 'Gamma call'), sent: attempts.rows.filter((r) => r.purpose.startsWith('session_summary') && r.status === 'sent').length };
}

test('43. session close, failed send, stop, restart: with confirmation it goes out "not confirmed (facilitation stopped)", without as published, the same delivery history; nothing is confirmed later', { skip: PG_SKIP }, async () => {
  const needs = await stopDuringSessionClosing('al43-needs', { goal: 'Team charter 43a', definitionOfDone: 'Everybody can live with the charter', agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] });
  const plain = await stopDuringSessionClosing('al43-plain', { goal: 'Team charter 43b', definitionOfDone: 'Ideas are collected', agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'close', title: 'Close' }] });
  const summaries = (chat: string): string[] => posts(chat).filter((t) => t.includes('Summary of the session "Gamma call"'));
  assert.equal(summaries(needs.gamma).length, 1);
  assert.match(summaries(needs.gamma)[0] ?? '', /^Result status: not confirmed \(facilitation stopped\)/);
  assert.doesNotMatch(summaries(needs.gamma)[0] ?? '', /Please confirm/);
  assert.equal(summaries(plain.gamma).length, 1);
  assert.match(summaries(plain.gamma)[0] ?? '', /^Result status: published/);
  for (const run of [needs, plain]) {
    assert.equal(run.sent, 1, 'delivered once after the restart');
    assert.deepEqual([run.closing?.deliveryStatus, run.closing?.part], ['delivered', 'done'], 'the same delivery history: pending, then delivered');
  }
  assert.deepEqual([needs.closing?.resultStatus, needs.closing?.resultReason], ['not_confirmed', 'stopped']);
  assert.deepEqual([plain.closing?.resultStatus, plain.closing?.resultReason], ['published', null]);
  // Nothing is confirmed automatically after the stop.
  await say(needs.gamma, 'cara', 'agreed');
  h.clock.advance(2 * DAY_MS);
  await h.tick();
  assert.deepEqual([(await sessionClosing(needs.f.id, 'Gamma call'))?.resultStatus, (await sessionClosing(needs.f.id, 'Gamma call'))?.resultReason], ['not_confirmed', 'stopped']);
});

test('43. stop while a session summary\'s window is open: later answers are refused, nothing is confirmed automatically', { skip: PG_SKIP }, async () => {
  const { home, f, chats } = await withSessions('al43-window', { goal: 'Team charter 43c', definitionOfDone: 'Everybody can live with the charter', agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] }, [{ title: 'Gamma call', start: 60 }]);
  const gamma = chats['Gamma call'] as string;
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  assert.equal((await sessionClosing(f.id, 'Gamma call'))?.part, 'confirmation', 'the window is open');
  await say(home, 'anna', 'stop');
  await h.restart();
  const closing = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([closing?.resultStatus, closing?.resultReason, closing?.part], ['not_confirmed', 'stopped', 'done']);
  const before = posts(gamma).length;
  await say(gamma, 'bert', 'objection: we never agreed');
  await say(gamma, 'cara', 'agreed');
  h.clock.advance(2 * DAY_MS);
  await h.tick();
  const after = await sessionClosing(f.id, 'Gamma call');
  assert.deepEqual([after?.resultStatus, after?.resultReason], ['not_confirmed', 'stopped'], 'nothing changes it');
  assert.deepEqual(after?.objections ?? [], [], 'the objection was not taken');
  assert.ok(!posts(gamma).slice(before).some((t) => t.startsWith('Objection from')), 'no answer is acknowledged');
});

/** The last session ends at the deadline; `spoil` makes its confirmation fail. */
async function lastSessionAtDeadline(name: string, spoil: (chat: string) => void) {
  const home = h.kernel.conversation(`${name}-home`, THREE);
  const chat = h.kernel.conversation(`${name}-chat`, THREE);
  const goal = `Charter ${name}`;
  const deadline = inMinutes(180);
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Everybody can live with the charter', deadline, agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(home, 'facilitation_open');
  await tool(home, 'facilitation_session', { action: 'schedule', title: 'Last call', start: inMinutes(60), end: deadline, modality: 'online' });
  await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal}`);
  await h.settle();
  const f = await h.facilitation(home);
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Last call'))?.status, 'live');
  spoil(chat);
  h.clock.set(new Date(deadline));
  await h.tick();
  await h.tick();
  assert.equal((await h.facilitation(home)).phase, 'active', 'the evaluation waits for the session closing');
  await h.restart();
  return { home, chat, f };
}

test('59. the last session ends at the deadline and its summary is never delivered: an abort report names it, also across a restart', { skip: PG_SKIP }, async () => {
  const { home, chat, f } = await lastSessionAtDeadline('al59-undelivered', (c) => h.kernel.blockedConversations.set(c, 'throttled'));
  await runFor(CLOSING_LIMITS.deliveryMs + HOUR_MS);
  h.kernel.blockedConversations.delete(chat);
  await h.tick();
  await h.tick();
  const closing = await sessionClosing(f.id, 'Last call');
  assert.deepEqual([closing?.deliveryStatus, closing?.resultStatus, closing?.resultReason], ['not_delivered', 'not_confirmed', 'not_delivered']);
  const after = await h.facilitation(home);
  assert.equal(after.phase, 'aborted');
  assert.match(after.closeReason ?? '', /the summary of the session "Last call" is not confirmed \(not delivered\)/);
  assert.equal(aborts(home).length, 1);
  assert.match(aborts(home)[0] ?? '', /Last call/);
});

test('59. the last session ends at the deadline and the roster stays partial: after the bounded retries an abort report names it, also across a restart', { skip: PG_SKIP }, async () => {
  const { home, f } = await lastSessionAtDeadline('al59-roster', () => undefined);
  const delivered = await sessionClosing(f.id, 'Last call');
  assert.deepEqual([delivered?.deliveryStatus, delivered?.part], ['delivered', 'confirmation']);
  // From now on the home conversation's member list is only a lower bound.
  h.kernel.conversation(home, THREE, { partialRoster: true });
  h.clock.set(new Date((delivered?.windowEndsAt?.getTime() ?? 0) + MINUTE_MS));
  await h.tick();
  assert.equal((await sessionClosing(f.id, 'Last call'))?.resultStatus, null, 'no automatic confirmation on a partial roster');
  assert.equal((await h.facilitation(home)).phase, 'active');
  await h.restart();
  await runFor(25 * HOUR_MS, HOUR_MS);
  const closing = await sessionClosing(f.id, 'Last call');
  assert.deepEqual([closing?.resultStatus, closing?.resultReason], ['not_confirmed', 'electorate_unverified']);
  const after = await h.facilitation(home);
  assert.equal(after.phase, 'aborted');
  assert.match(after.closeReason ?? '', /the summary of the session "Last call" is not confirmed \(participants could not be verified\)/);
  assert.equal(aborts(home).length, 1);
});
