// Closing scopes against the kernel's bounds (kernel #2090, ADR 0030; spec B
// §0, §5.2, §5.6): a closing scope is opened with the time of its closing
// event, it carries the essential messages also across a restart, and it
// never re-opens the moderation.
//
// Spec B §9 criteria 27, 32 and the parts of 34 that closing.test.ts does
// not cover (a delivery one hour before the 7-day limit, dispatch after the
// window with a failed first send and a restart in between).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { resultClosingOf } from '../src/engine/closing.js';
import { listClosings } from '../src/engine/resultStatus.js';
import type { Closing, Session } from '../src/model.js';
import { ANNA, BERT, CARA, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-20T08:00:00Z', config: { maxActivePerFacilitator: 40, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const THREE = [ANNA, BERT, CARA];
const FREE = { goal: 'Align on the roadmap', definitionOfDone: 'Everybody can live with the roadmap' };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
const say = async (conv: string, who: string, text: string): Promise<void> => {
  await h.kernel.say(conv, who, text);
  await h.settle();
};
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const sessionNamed = async (facilitationId: string, title: string): Promise<Session | undefined> => (await store.listSessions(h.db.pool, facilitationId)).find((s) => s.title === title);
const closingByEvent = async (facilitationId: string, eventId: string): Promise<Closing | undefined> => (await listClosings(h.db.pool, facilitationId)).find((c) => c.eventId === eventId);

/** ADR 0030: the closing scope was opened with the time of its closing event. */
function assertOpenedAtEvent(closing: Closing | undefined): void {
  assert.ok(closing, 'the closing exists');
  // The record is shared by every facilitation of the harness ('result' and
  // 'abort' repeat across them): one of them is this closing's, with its time.
  const opened = h.kernel.openedWithEventAt.filter((o) => o.kind === 'closing' && o.eventId === closing.eventId);
  assert.ok(opened.every((o) => o.eventAt !== undefined), 'every closing scope names its event time');
  assert.ok(opened.some((o) => o.eventAt === closing.startedAt.toISOString()), 'eventAt is the closing event, not the moment the scope was opened');
}

test('criterion 27: an abort without action items still delivers its report to the home conversation under its closing scope after a failed send and a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cs-27-abort', FOUR);
  const f = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] });
  for (let i = 0; i < 3; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await say(conv, 'anna', 'stop');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  assert.equal(posts(conv).filter((t) => /asked to stop/.test(t)).length, 0, 'the first send failed');
  assert.equal((await store.listActionItems(h.db.pool, f.id)).length, 0, 'no action items');
  await h.restart();
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(10 * MINUTE_MS);
    await h.tick();
  }
  assert.equal(posts(conv).filter((t) => /asked to stop/.test(t)).length, 1, 'delivered once after the restart');
  const reports = h.kernel.authorizations.filter((a) => a.processId === f.id && a.kind === 'closing' && a.action === 'post');
  assert.ok(reports.length > 0 && reports.every((a) => a.purpose !== 'moderation'), JSON.stringify(reports.map((a) => a.purpose)));
  assertOpenedAtEvent(await closingByEvent(f.id, 'abort'));
});

test('criterion 27: a session summary that needs consent is confirmed in its linked chat after the slot ended while the facilitation stays active; a late vote there is refused', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('cs-27-home', THREE);
  const chat = h.kernel.conversation('cs-27-chat', THREE);
  const goal = 'Offsite plan cs-27';
  // A free-text definition of done: a session summary needs the group's consent.
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Everybody can live with the plan', agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(home, 'facilitation_open');
  await tool(home, 'facilitation_session', { action: 'schedule', title: 'Planning call', start: inMinutes(60), end: inMinutes(120), modality: 'online' });
  await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal}`);
  await h.settle();
  const f = await h.facilitation(home);
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Planning call'))?.status, 'live');
  // The slot ends: the session closes with its summary, which waits for consent.
  h.clock.advance(60 * MINUTE_MS);
  await h.tick();
  await h.tick();
  const session = await sessionNamed(f.id, 'Planning call');
  assert.equal(session?.status, 'confirming');
  const closing = await closingByEvent(f.id, `session:${session?.id ?? ''}`);
  assert.deepEqual([closing?.requiresConfirmation, closing?.deliveryStatus], [true, 'delivered']);
  assertOpenedAtEvent(closing);

  // A consent answer without a mention after the slot counts.
  await say(chat, 'cara', 'objection: we never discussed the budget');
  assert.match(posts(chat).at(-1) ?? '', /^Objection from Cara: we never discussed the budget/);
  await h.restart();
  await say(chat, 'cara', 'agreed');
  assert.deepEqual((await closingByEvent(f.id, closing?.eventId ?? ''))?.objections, [], 'the objection is lifted');
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  await h.tick();
  const confirmed = await closingByEvent(f.id, closing?.eventId ?? '');
  assert.equal(confirmed?.resultStatus, 'confirmed');
  assert.equal((await h.facilitation(home)).phase, 'active', 'the facilitation stays active');
  // A late vote on the summary, after its window, changes nothing.
  await say(chat, 'bert', 'objection: I missed the window');
  const late = await closingByEvent(f.id, closing?.eventId ?? '');
  assert.deepEqual([late?.resultStatus, late?.objections], ['confirmed', []], 'the late vote is refused');
  // The consent answers and the summary were drawn from the session's own closing, never as moderation.
  const underClosing = h.kernel.authorizations.filter((a) => a.processId === f.id && a.kind === 'closing');
  assert.ok(underClosing.length > 0);
  assert.ok(underClosing.every((a) => a.purpose !== 'moderation'), JSON.stringify(underClosing.map((a) => a.purpose)));
});

test('criterion 32: a result whose send fails shortly before the deadline, restart after it: published once, no moderation re-opens, no abort', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cs-32', FOUR);
  const deadline = new Date(h.clock.now().getTime() + 72 * HOUR_MS);
  const f = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'], deadline: deadline.toISOString() });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.clock.set(new Date(deadline.getTime() - 5 * MINUTE_MS));
  for (let i = 0; i < 3; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await say(conv, 'dave', 'A');
  assert.equal(posts(conv).filter((t) => t.startsWith('Result for')).length, 0, 'the result send failed before the deadline');
  await h.restart();
  h.clock.set(new Date(deadline.getTime() + 10 * MINUTE_MS));
  const mark = h.kernel.authorizations.length;
  const turns = h.kernel.turns.length;
  for (let i = 0; i < 4; i += 1) {
    await h.tick();
    h.clock.advance(10 * MINUTE_MS);
  }
  await say(conv, 'bert', 'can we vote again on the venue?');
  await h.tick();
  const g = await h.facilitation(conv);
  assert.equal(g.phase, 'closed');
  assert.equal(posts(conv).filter((t) => t.startsWith('Result for')).length, 1, 'published once');
  assert.equal(posts(conv).filter((t) => t.startsWith('This facilitation ends without')).length, 0, 'no abort');
  const later = h.kernel.authorizations.slice(mark).filter((a) => a.processId === f.id);
  assert.ok(!later.some((a) => a.purpose === 'moderation' || a.action === 'model_turn'), JSON.stringify(later.map((a) => [a.kind, a.action, a.purpose])));
  assert.equal(h.kernel.turns.length, turns, 'no facilitator turn after the deadline');
  assert.equal((await resultClosingOf(h.db.pool, f.id))?.resultStatus, 'published');
  assertOpenedAtEvent(await resultClosingOf(h.db.pool, f.id));
});

test('criterion 34: a delivery confirmed one hour before the 7-day limit still gets its full window; the dispatch after the window runs, with a failed first send and a restart in between', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cs-34-late', THREE);
  const f = await startActive(h, conv, FREE);
  for (let i = 0; i < 400; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(conv, 'facilitation_close');
  const c0 = await resultClosingOf(h.db.pool, f.id);
  assert.equal(c0?.deliveryStatus, 'pending');
  const deliveryLimit = (c0?.partStartedAt.getTime() ?? 0) + 7 * DAY_MS;
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(DAY_MS);
    await h.tick();
  }
  // The last failed attempt; its retry (backoff at most one hour) falls one hour before the limit.
  h.clock.set(new Date(deliveryLimit - 2 * HOUR_MS));
  await h.tick();
  assert.equal((await resultClosingOf(h.db.pool, f.id))?.deliveryStatus, 'pending', 'still failing');
  h.kernel.sendFaults.length = 0;
  h.clock.set(new Date(deliveryLimit - HOUR_MS));
  await h.tick();
  const c = await resultClosingOf(h.db.pool, f.id);
  assert.equal(c?.deliveryStatus, 'delivered');
  assert.ok(c?.deliveredAt && c.deliveredAt.getTime() <= deliveryLimit - HOUR_MS + MINUTE_MS, 'delivered about one hour before the limit');
  assert.equal(c?.part, 'confirmation');
  assert.equal(c?.windowEndsAt?.getTime(), (c?.deliveredAt?.getTime() ?? 0) + 24 * HOUR_MS, 'the full window, past the delivery limit');
  assertOpenedAtEvent(c);

  // Still open 23 hours later, past the delivery limit.
  h.clock.advance(23 * HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'open', 'the closing scope is valid while the window runs');

  // The window ends; the initiator's report with the protocol cannot be sent at first.
  h.kernel.dmBlocked.set('user:anna', 'throttled');
  const dms = h.kernel.dms.length;
  h.clock.advance(HOUR_MS + MINUTE_MS);
  await h.tick();
  await h.tick();
  const confirmed = await resultClosingOf(h.db.pool, f.id);
  assert.equal(confirmed?.resultStatus, 'confirmed');
  assert.equal(confirmed?.part, 'dispatch');
  assert.ok(!h.kernel.dms.slice(dms).some((d) => d.principal === 'user:anna'), 'the first send failed');
  await h.restart();
  h.kernel.dmBlocked.delete('user:anna');
  h.clock.advance(HOUR_MS);
  await h.tick();
  await h.tick();
  assert.ok(h.kernel.dms.slice(dms).some((d) => d.principal === 'user:anna' && d.processId === f.id), 'retried after the restart');
  const done = await resultClosingOf(h.db.pool, f.id);
  assert.equal(done?.part, 'done');
  const dispatched = h.kernel.authorizations.filter((a) => a.processId === f.id && a.kind === 'closing' && a.action === 'direct_message');
  assert.ok(dispatched.length > 0 && dispatched.every((a) => a.purpose !== 'moderation'));
});
