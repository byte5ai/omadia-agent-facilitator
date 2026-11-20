// The closing procedure of spec B §5.2 (#2064, #2065, #2078): the window of
// a final confirmation starts with its confirmed delivery, an unverifiable
// electorate and a failed delivery give "not confirmed" with their reason, a
// stop after `concluding` delivers the frozen result as "not confirmed
// (facilitation stopped)", follow-up ends after its grace, and retention
// counts from `ended` and waits for every running closing.
//
// Spec B §9 criteria 26, 34, 39 (result status on what is sent), 42, 43, 44,
// 52, 56, 61.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { resultClosingOf } from '../src/engine/closing.js';
import { listMetadata, purgeExpired } from '../src/engine/governance.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { CLOSING_LIMITS } from '../src/engine/resultStatus.js';
import { lifecycleOf } from '../src/model.js';
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

const FREE = { goal: 'Align on the roadmap', definitionOfDone: 'Everybody can live with the roadmap' };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
const say = async (conv: string, who: string, text: string): Promise<void> => {
  await h.kernel.say(conv, who, text);
  await h.settle();
};
const results = (conv: string): string[] => posts(conv).filter((t) => t.startsWith('Result for'));
const closingOf = async (conv: string) => {
  const c = await resultClosingOf(h.db.pool, (await h.facilitation(conv)).id);
  if (!c) throw new Error('no result closing');
  return c;
};

test('34. the confirmation window starts when the delivery is confirmed, after a restart; nobody answers: confirmed; moderation never re-opens', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-34', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  // The result's first send fails; the engine restarts before the retry.
  h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  assert.match(await tool(conv, 'facilitation_close'), /posted in the group for confirmation/);
  const concludedAt = (await h.facilitation(conv)).concludedAt;
  assert.equal((await closingOf(conv)).deliveryStatus, 'pending');
  await h.restart();
  h.clock.advance(3 * HOUR_MS);
  await h.tick();
  const c = await closingOf(conv);
  assert.equal(c.deliveryStatus, 'delivered');
  assert.equal(c.part, 'confirmation');
  assert.ok(c.deliveredAt && concludedAt && c.deliveredAt.getTime() > concludedAt.getTime() + 2 * HOUR_MS);
  assert.equal(c.windowEndsAt?.getTime(), (c.deliveredAt?.getTime() ?? 0) + 24 * HOUR_MS, 'the window counts from the delivery');
  assert.equal(results(conv).length, 1, 'one result document');
  // Another message is no moderation any more.
  await say(conv, 'bert', 'can we add a point about hiring?');
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  const f = await h.facilitation(conv);
  assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'open', 'the closing scope is valid while the window runs');
  // 23 h after the delivery it is still open; at the window's end confirmed.
  h.clock.advance(20 * HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  h.clock.advance(5 * HOUR_MS);
  await h.restart();
  await h.tick();
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  const final = await closingOf(conv);
  assert.deepEqual([final.resultStatus, final.resultReason, final.deliveryStatus], ['confirmed', null, 'delivered']);
  assert.match(posts(conv).at(-1) ?? '', /^Result status: confirmed\.$/m);
  assert.match(await buildProtocol(h.db.pool, closed), /^Protocol: Align on the roadmap\nResult status: confirmed\nDelivery: delivered\n/);
});

test('34. a standing objection at the window\'s end closes "not confirmed (objection)"; a withdrawn one does not count', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-34-objection', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_close');
  await say(conv, 'cara', 'objection: hiring is missing');
  await say(conv, 'bert', 'objection: no budget');
  await say(conv, 'cara', 'agreed'); // withdraws Cara's objection
  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const c = await closingOf(conv);
  assert.deepEqual([c.resultStatus, c.resultReason], ['not_confirmed', 'objection']);
  assert.deepEqual(c.objections.map((o) => o.principal), ['user:bert']);
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(posts(conv).join('\n'), /Result status: not confirmed \(objection\)\. Standing objections: Bert: no budget/);
});

test('44. a roster that stays partial after the window: retried hourly for a day, then "not confirmed (participants could not be verified)"', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-44', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_close');
  // From now on the channel can only list a lower bound of the members.
  h.kernel.conversation(conv, [ANNA, BERT, CARA], { partialRoster: true });
  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'concluding', 'no automatic decision on a partial roster');
  assert.equal(posts(conv).filter((t) => t.includes('could not be verified')).length, 1, 'said once');
  for (let i = 0; i < 25; i += 1) {
    h.clock.advance(HOUR_MS);
    await h.tick();
  }
  const c = await closingOf(conv);
  assert.deepEqual([c.resultStatus, c.resultReason], ['not_confirmed', 'electorate_unverified']);
  assert.equal(posts(conv).filter((t) => t.includes('could not be verified')).length, 2, 'the notice and the final status');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('44. a result that never gets delivered: delivery status "not delivered", result status "not confirmed (not delivered)" where confirmation was required', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-44-undelivered', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  for (let i = 0; i < 40; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(conv, 'facilitation_close');
  // Retried for the whole delivery part (7 days), not for a retry count.
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(DAY_MS);
    await h.tick();
  }
  assert.equal((await closingOf(conv)).deliveryStatus, 'pending', 'still within its 7 days');
  for (let i = 0; i < 2; i += 1) {
    h.clock.advance(DAY_MS);
    await h.tick();
  }
  h.kernel.sendFaults.length = 0;
  await h.tick();
  const c = await closingOf(conv);
  assert.deepEqual([c.deliveryStatus, c.resultStatus, c.resultReason], ['not_delivered', 'not_confirmed', 'not_delivered']);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['result_undelivered'])).length, 1);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['initiator_report'])).length, 1, 'the initiator is told where possible');
});

test('52. stop during the final consent window, restart: exactly one result document marked "not confirmed (facilitation stopped)", no abort report, later answers refused', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-52-window', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_close');
  assert.equal((await closingOf(conv)).part, 'confirmation');
  await say(conv, 'bert', 'stop');
  await h.restart();
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal(f.closeReason, 'stopped');
  const c = await closingOf(conv);
  assert.deepEqual([c.resultStatus, c.resultReason, c.documentVersion, c.deliveryStatus], ['not_confirmed', 'stopped', 2, 'delivered']);
  const stopped = results(conv).filter((t) => t.endsWith('Result status: not confirmed (facilitation stopped)'));
  assert.equal(stopped.length, 1, 'the frozen result, re-delivered without a consent request');
  assert.ok(!stopped[0]?.includes('Please check this summary'));
  assert.ok(!posts(conv).some((t) => t.startsWith('This facilitation ends without a result')), 'no abort report');
  // Nothing is confirmed later: an objection or the window's end change nothing.
  await say(conv, 'cara', 'objection: too late');
  h.clock.advance(2 * DAY_MS);
  await h.tick();
  assert.deepEqual([(await closingOf(conv)).resultStatus, (await closingOf(conv)).resultReason], ['not_confirmed', 'stopped']);
  assert.equal(lifecycleOf(await h.facilitation(conv)), 'ended');
});

test('52. stop before the final summary is delivered, restart: it goes out once, without a consent request, as "not confirmed (facilitation stopped)"', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-52-undelivered', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  for (let i = 0; i < 3; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(conv, 'facilitation_close');
  await say(conv, 'anna', 'stop');
  await h.restart();
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(10 * MINUTE_MS);
    await h.tick();
  }
  const sent = results(conv);
  assert.equal(sent.length, 1, sent.join(' || '));
  assert.ok(sent[0]?.endsWith('Result status: not confirmed (facilitation stopped)'));
  assert.ok(!sent[0]?.includes('Please check this summary'), 'no request that can no longer be answered');
  const f = await h.facilitation(conv);
  assert.ok(f.endedAt, 'ended once the delivery part ended');
});

test('56. stop with confirmed action items during `concluding`: the result is delivered, no follow-up, no reminder, `ended`', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-56', FOUR);
  await startActive(h, conv, { ...FREE, followUp: true });
  const due = new Date(h.clock.now().getTime() + 3 * DAY_MS).toISOString();
  await tool(conv, 'facilitation_record_action_item', { description: 'Draft the roadmap', owner: 'Bert', dueDate: due });
  await say(conv, 'bert', 'yes');
  await tool(conv, 'facilitation_close');
  await say(conv, 'cara', 'stop');
  await h.restart();
  const dms = h.kernel.dms.length;
  h.clock.advance(5 * DAY_MS);
  await h.tick();
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.followupState, 'none', 'never `following_up`');
  assert.equal(lifecycleOf(f), 'ended');
  assert.ok(!h.kernel.dms.slice(dms).some((d) => d.text.includes('is due')), 'no reminder');
  assert.equal((await closingOf(conv)).resultStatus, 'not_confirmed');
});

test('26. follow-up horizon: a due date beyond horizon minus grace is refused when agreed; one just inside is followed up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-26', [ANNA, BERT]);
  await startActive(h, conv, { ...FREE, followUp: true });
  const late = new Date(h.clock.now().getTime() + 84 * DAY_MS).toISOString();
  assert.match(await tool(conv, 'facilitation_record_action_item', { description: 'Review in spring', owner: 'Bert', dueDate: late }), /^Refused \(due_beyond_horizon\): That due date is too late: follow-up runs at most 90 days/);
  const f = await h.facilitation(conv);
  assert.equal((await store.listActionItems(h.db.pool, f.id)).length, 0, 'not accepted silently');
  const inside = new Date(h.clock.now().getTime() + 82 * DAY_MS).toISOString();
  assert.doesNotMatch(await tool(conv, 'facilitation_record_action_item', { description: 'Review in winter', owner: 'Bert', dueDate: inside }), /^Refused/);
  await say(conv, 'bert', 'yes');
  await tool(conv, 'facilitation_close');
  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const closed = await h.facilitation(conv);
  assert.equal(lifecycleOf(closed), 'following_up');
  assert.ok(closed.followupEndsAt && closed.closedAt && closed.followupEndsAt.getTime() <= closed.closedAt.getTime() + 90 * DAY_MS, 'capped by the horizon');
  assert.equal(closed.endedAt, null, 'retention has not started');
});

test('61. retention of one day, a failed closing send, restart, a later attempt inside the closing: nothing is deleted early; after the closing ended it is', { skip: PG_SKIP }, async () => {
  const short = await createHarness({ start: '2026-11-20T08:00:00Z', config: { retentionDays: 1 } });
  try {
    const conv = short.kernel.conversation('cl-61', [ANNA, BERT]);
    await startActive(short, conv, { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Old Town'] });
    await short.kernel.say(conv, 'anna', 'A');
    await short.settle();
    // The last ballot's echo and then the result fail for a while.
    for (let i = 0; i < 6; i += 1) short.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
    await short.kernel.say(conv, 'bert', 'A');
    await short.settle();
    const f = await short.facilitation(conv);
    await short.restart();
    // Two days later: the retention of a day would have passed, but the
    // closing still runs (its document is not out yet).
    for (let i = 0; i < 4; i += 1) {
      short.clock.advance(12 * HOUR_MS);
      if (i === 3) short.kernel.sendFaults.length = 0;
      await purgeExpired(short.engine.core);
      assert.ok(await store.getFacilitation(short.db.pool, f.id), `not deleted early (step ${String(i)})`);
      await short.tick();
    }
    const meta = (await listMetadata(short.db.pool, { id: f.id }))[0];
    assert.ok(meta?.effectiveDeletionAt && meta.purgeAfter && meta.effectiveDeletionAt >= meta.purgeAfter, 'the effective time is shown, never before the retention end');
    const c = await resultClosingOf(short.db.pool, f.id);
    assert.equal(c?.deliveryStatus, 'delivered');
    short.clock.advance(2 * DAY_MS);
    await short.tick();
    await short.tick();
    await purgeExpired(short.engine.core);
    assert.equal(await store.getFacilitation(short.db.pool, f.id), undefined, 'deleted after every closing and scope ended');
  } finally {
    await short.close();
  }
});

test('the absolute limit: nothing of a closing is sent after 30 days', { skip: PG_SKIP }, async () => {
  assert.equal(CLOSING_LIMITS.absoluteMs, 30 * DAY_MS);
  const conv = h.kernel.conversation('cl-absolute', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  for (let i = 0; i < 200; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(conv, 'facilitation_close');
  h.clock.advance(31 * DAY_MS);
  await h.tick();
  h.kernel.sendFaults.length = 0;
  await h.tick();
  assert.equal(results(conv).length, 0);
  const c = await closingOf(conv);
  assert.equal(c.deliveryStatus, 'not_delivered');
});

test('38. a closing document survives later changes: its send fails, the state moves on, after a restart the same version is delivered; a stale reminder is not', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-38', [ANNA, BERT, CARA]);
  await startActive(h, conv, FREE);
  const f0 = await h.facilitation(conv);
  // A reminder computed now, bound to this state.
  await h.db.pool.query(
    `INSERT INTO plg_omadia_agent_facilitator_outbox (facilitation_id, idempotency_key, purpose, target_kind, payload, delivery_class, required_state_version, owner, created_at)
     VALUES ($1, $2, 'reminder', 'group', '{"text":"Reminder: two contributions are still open."}'::jsonb, 'droppable', $3, 'other-engine', $4)`,
    [f0.id, `${f0.id}:reminder:stale`, f0.stateVersion, h.clock.now()],
  );
  for (let i = 0; i < 2; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(conv, 'facilitation_close');
  const row = (await h.db.pool.query<{ closing_id: string; document_version: number; required_state_version: number | null; status: string }>(
    `SELECT closing_id, document_version, required_state_version, status FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'result'`,
    [f0.id],
  )).rows[0];
  const c = await closingOf(conv);
  assert.deepEqual([row?.closing_id, row?.document_version, row?.required_state_version], [c.id, 1, null], 'closing event id and document version instead of a state version');
  // The state moves on (an objection, a status request) before the retry.
  await h.db.pool.query('UPDATE plg_omadia_agent_facilitator_facilitations SET state_version = state_version + 5 WHERE id = $1', [f0.id]);
  await h.restart();
  for (let i = 0; i < 3; i += 1) {
    h.clock.advance(HOUR_MS);
    await h.tick();
  }
  const after = await closingOf(conv);
  assert.deepEqual([after.deliveryStatus, after.documentVersion], ['delivered', 1]);
  assert.equal(results(conv).length, 1);
  assert.ok(!posts(conv).some((t) => t.startsWith('Reminder: two contributions')), 'the stale reminder is not sent');
});

test('40. the result waits for a session closing that needs confirmation; only after it ended the final summary goes out', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-40', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, FREE);
  // A session whose summary waits for its consent window (F1 opens these).
  const session = (await h.db.pool.query<{ id: string }>(
    `INSERT INTO plg_omadia_agent_facilitator_sessions (facilitation_id, kind, status, created_at) VALUES ($1, 'live', 'confirming', $2) RETURNING id`,
    [f.id, h.clock.now()],
  )).rows[0];
  const sessionClosing = (await h.db.pool.query<{ id: string }>(
    `INSERT INTO plg_omadia_agent_facilitator_closings (facilitation_id, kind, session_id, event_id, document, requires_confirmation, part, part_started_at, absolute_until, started_at)
     VALUES ($1, 'session', $2, $3, 'Session summary', true, 'confirmation', $4, $5, $4) RETURNING id`,
    [f.id, session?.id, `session:${session?.id ?? ''}`, h.clock.now(), new Date(h.clock.now().getTime() + 30 * DAY_MS)],
  )).rows[0];
  await tool(conv, 'facilitation_close');
  assert.equal((await closingOf(conv)).part, 'waiting');
  assert.equal(results(conv).length, 0, 'the final summary waits');
  // The session closes "not confirmed" (an objection counted).
  await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_closings SET result_status = 'not_confirmed', result_reason = 'objection', final_at = $2, part = 'done', ended_at = $2 WHERE id = $1`, [sessionClosing?.id, h.clock.now()]);
  await h.restart();
  await h.tick();
  assert.equal((await closingOf(conv)).part, 'confirmation');
  assert.equal(results(conv).length, 1, 'only then the final summary goes out');
});

test('robustness: a window whose job is gone is decided at its end anyway; the kernel ending a concluding process ends its result closing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-robust-window', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, FREE);
  await tool(conv, 'facilitation_close');
  await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'failed' WHERE facilitation_id = $1 AND kind = 'closing_window'`, [f.id]);
  h.clock.advance(24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal((await closingOf(conv)).resultStatus, 'confirmed');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['closing_window_recovered'])).length, 1);

  const other = h.kernel.conversation('cl-robust-kernel', [ANNA, BERT, CARA]);
  const g = await startActive(h, other, FREE);
  for (let i = 0; i < 3; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await tool(other, 'facilitation_close');
  const { abortInWork } = await import('../src/engine/lifecycle.js');
  await h.engine.core.work(g.id, (w) => abortInWork(w, { reason: 'the facilitator was disabled', actor: 'kernel' }));
  h.clock.advance(HOUR_MS);
  await h.tick();
  const c = await closingOf(other);
  assert.deepEqual([c.resultStatus, c.part], ['aborted', 'done']);
  assert.equal((await h.facilitation(other)).phase, 'aborted');
  assert.equal(results(other).length, 0, 'the result is not sent after the process was aborted');
  assert.ok((await store.listEvents(h.db.pool, g.id, ['closing_send_dropped'])).length > 0, 'its dropped send is on record');
});

test('robustness: a stop on a facilitation that concluded before 1.6 (no closing row) still delivers the frozen result', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cl-legacy-stop', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, FREE);
  // As 1.5.x left it: concluding, the result in the outbox, no closing.
  await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET phase = 'concluding', concluded_at = $2, result = '{"text":"Result for \\"Align on the roadmap\\":\\n- old"}'::jsonb WHERE id = $1`, [f.id, h.clock.now()]);
  await say(conv, 'anna', 'stop');
  await h.tick();
  const c = await closingOf(conv);
  assert.deepEqual([c.resultStatus, c.deliveryStatus], ['published', 'delivered']);
  assert.equal(results(conv).length, 1);
  assert.ok((await h.facilitation(conv)).endedAt);
});
