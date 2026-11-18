// Visibility, retention, quotas, operator access (spec 5.8, 5.10; acceptance 11, 12).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS } from '../src/clock.js';
import { Refusal } from '../src/engine/core.js';
import { listAudit, protocolFor } from '../src/engine/governance.js';
import { handle, router } from '../src/http/operatorApi.js';
import type { ApiResponse } from '../src/http/operatorApi.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-18T09:00:00Z', config: { maxActivePerFacilitator: 3, startsPerHourPerFacilitator: 5, maxMessagesPerFacilitation: 6 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
const api = (method: string, path: string, body?: unknown, query: Record<string, unknown> = {}): Promise<ApiResponse> =>
  handle(h.engine, { method, path, query, body, actor: 'op@example.com' });

test('visibility: an active participant sees everything, one who left sees what was there until they left, anybody else nothing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-visible', FOUR);
  const f = await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  h.kernel.leave(conv, 'dave');
  await h.settle();
  await say(conv, 'bert', 'B > A');

  const full = await protocolFor(h.db.pool, f, 'user:anna');
  assert.match(full, /Anna: A \(Harbour\)/);
  assert.match(full, /Bert: B \(Old Town\) > A \(Harbour\)/);

  const untilLeft = await protocolFor(h.db.pool, f, 'user:dave');
  assert.match(untilLeft, /Anna: A \(Harbour\)/);
  assert.doesNotMatch(untilLeft, /Bert: B/, 'nothing from after they left');

  await assert.rejects(protocolFor(h.db.pool, f, 'user:mallory'), (err: unknown) => err instanceof Refusal && err.code === 'not_visible');
  const outsider = await h.tool('facilitation_protocol', {}, { conversation: conv, caller: 'mallory' });
  assert.match(outsider, /^Refused \(not_visible\): You are not a participant/);
  await h.tool('facilitation_stop', { reason: 'test over' }, { conversation: conv });
});

test('operator: metadata without contents; contents only with a reason, and every access is audited', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-operator', FOUR);
  const f = await startActive(h, conv, { ...VOTE, goal: 'Confidential reorganisation' });
  await say(conv, 'anna', 'A');

  const list = await api('GET', '/facilitations', undefined, { phase: 'active' });
  assert.equal(list.status, 200);
  const meta = (list.body.data as Array<Record<string, unknown>>).find((m) => m['id'] === f.id) as Record<string, unknown>;
  assert.deepEqual(
    { facilitator: meta['facilitator'], phase: meta['phase'], conversationId: meta['conversationId'], counts: meta['counts'] },
    { facilitator: 'mira', phase: 'active', conversationId: conv, counts: { participants: 4, activeParticipants: 4, contributions: 1, decisions: 0, actionItems: 0, steps: 1, messagesSent: 2 } },
  );
  assert.ok(!JSON.stringify(list.body).includes('Confidential'), 'no goal, no contents, no names in the metadata');
  assert.ok(!JSON.stringify(list.body).includes('Anna'));
  assert.equal((await api('GET', `/facilitations/${f.id}`)).status, 200);

  const noReason = await api('POST', `/facilitations/${f.id}/content`, {});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error?.code, 'reason_required');
  assert.equal((await api('POST', `/facilitations/${f.id}/content`, { reason: 'look' })).status, 400, 'a token reason is not a reason');
  assert.deepEqual(await listAudit(h.db.pool, f.id), [], 'a refused access reads nothing and audits nothing');

  const content = await api('POST', `/facilitations/${f.id}/content`, { reason: 'Complaint from a participant, ticket 4711' });
  assert.equal(content.status, 200);
  assert.match(String((content.body.data as Record<string, unknown>)['protocol']), /Protocol: Confidential reorganisation/);
  const audit = await listAudit(h.db.pool, f.id);
  assert.deepEqual(audit.map((a) => [a.action, a.actor, a.reason]), [['content_read', 'op@example.com', 'Complaint from a participant, ticket 4711']]);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['operator_access'])).length, 1, 'the facilitation itself records that an operator looked');
  const shown = await api('GET', `/facilitations/${f.id}/audit`);
  assert.equal((shown.body.data as unknown[]).length, 1);

  assert.equal((await api('GET', '/facilitations/not-a-uuid')).status, 400);
  assert.equal((await api('GET', '/facilitations/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await api('GET', '/facilitations', undefined, { phase: "active' OR 1=1" })).status, 400);
  assert.equal((await api('DELETE', '/facilitations')).status, 405);
});

test('operator: terminate needs a reason, is audited and ends with an abort report in the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-terminate', FOUR);
  const f = await startActive(h, conv, VOTE);
  assert.equal((await api('POST', `/facilitations/${f.id}/terminate`, {})).status, 400);
  const done = await api('POST', `/facilitations/${f.id}/terminate`, { reason: 'Requested by the works council' });
  assert.deepEqual(done.body.data, { id: f.id, phase: 'aborted' });
  assert.equal(posts(conv).at(-1), 'This facilitation ends without a result. Reason: an operator ended it (Requested by the works council)');
  assert.deepEqual((await listAudit(h.db.pool, f.id)).map((a) => a.action), ['terminate']);
  assert.equal((await api('POST', `/facilitations/${f.id}/terminate`, { reason: 'Requested by the works council' })).status, 409);
});

test('the HTTP adapter refuses an audited action when the operator cannot be named', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-adapter', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  const call = (actor: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: ApiResponse['body'] }> =>
    new Promise((resolve) => {
      const res = {
        code: 200,
        status(code: number) {
          this.code = code;
          return this;
        },
        json(payload: unknown) {
          resolve({ status: this.code, body: payload as ApiResponse['body'] });
          return undefined;
        },
      };
      router(h.engine, async () => actor)({ method, path, query: {}, body, headers: { cookie: 'session=x' } }, res);
    });
  assert.equal((await call(undefined, 'GET', '/facilitations')).status, 200);
  const anonymous = await call(undefined, 'POST', `/facilitations/${f.id}/content`, { reason: 'Complaint from a participant' });
  assert.equal(anonymous.status, 403);
  assert.deepEqual(await listAudit(h.db.pool, f.id), []);
  const named = await call('ops@example.com', 'POST', `/facilitations/${f.id}/content`, { reason: 'Complaint from a participant' });
  assert.equal(named.status, 200);
  assert.equal((await listAudit(h.db.pool, f.id))[0]?.actor, 'ops@example.com');
  await h.tool('facilitation_stop', { reason: 'test over' }, { conversation: conv });
});

test('quota per facilitator: the limit of active facilitations produces a system notice; another facilitator is not affected', { skip: PG_SKIP }, async () => {
  const start = (agent: string, conv: string): Promise<string> => h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { agent, conversation: conv });
  for (const n of [1, 2, 3]) assert.match(await start('quinn', h.kernel.conversation(`go-quota-${String(n)}`, [ANNA, BERT])), /^Facilitation created/);
  const refused = await start('quinn', h.kernel.conversation('go-quota-4', [ANNA, BERT]));
  assert.match(refused, /^Refused \(quota_active\): System notice: this facilitator already runs 3 facilitations, which is its limit/);
  await assert.rejects(h.facilitation('go-quota-4'), /no facilitation/, 'nothing was created');
  assert.match(await start('rosa', h.kernel.conversation('go-quota-other', [ANNA, BERT])), /^Facilitation created/, 'several facilitators work in parallel');

  await h.tool('facilitation_stop', { reason: 'frees a slot' }, { agent: 'quinn', conversation: 'go-quota-1' });
  assert.match(await start('quinn', 'go-quota-4'), /^Facilitation created/);
  // Five starts within the hour (three, one refused does not count, one more): the next is refused.
  await h.tool('facilitation_stop', { reason: 'frees a slot' }, { agent: 'quinn', conversation: 'go-quota-2' });
  assert.match(await start('quinn', h.kernel.conversation('go-quota-5', [ANNA, BERT])), /^Facilitation created/);
  await h.tool('facilitation_stop', { reason: 'frees a slot' }, { agent: 'quinn', conversation: 'go-quota-3' });
  assert.match(await start('quinn', h.kernel.conversation('go-quota-6', [ANNA, BERT])), /^Refused \(quota_starts\): System notice: this facilitator has started 5 facilitations within the last hour/);
  h.clock.advance(HOUR_MS + 1000);
  assert.match(await start('quinn', 'go-quota-6'), /^Facilitation created/);
});

test('quota of messages per facilitation: one system notice, then only essential messages', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-messages', [ANNA, BERT, CARA]);
  await startActive(h, conv, VOTE);
  for (let i = 0; i < 6; i += 1) await say(conv, 'anna', i % 2 === 0 ? 'A' : 'B');
  const notices = posts(conv).filter((t) => t.startsWith('System notice: this facilitation has reached its limit of 6 messages'));
  assert.equal(notices.length, 1);
  const before = posts(conv).length;
  await say(conv, 'bert', 'A');
  assert.equal(posts(conv).length, before, 'the echo is no longer posted');
  await say(conv, 'cara', 'A');
  assert.match(posts(conv).at(-1) ?? '', /^Result for "Pick a venue"/, 'the result is always sent');
  assert.equal((await store.listEvents(h.db.pool, (await h.facilitation(conv)).id, ['quota_reached'])).length, 1);
});

test('retention: records are deleted 90 days after the close; the audit of an operator access stays', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-retention', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  await api('POST', `/facilitations/${f.id}/content`, { reason: 'Routine check before retention test' });
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.purgeAfter?.getTime(), (closed.closedAt as Date).getTime() + 90 * DAY_MS);

  h.clock.advance(89 * DAY_MS);
  await h.tick();
  assert.ok(await store.getFacilitation(h.db.pool, f.id), 'still there on day 89');
  h.clock.advance(2 * DAY_MS);
  await h.tick();
  assert.equal(await store.getFacilitation(h.db.pool, f.id), undefined);
  for (const table of ['plg_omadia_agent_facilitator_contributions', 'plg_omadia_agent_facilitator_events', 'plg_omadia_agent_facilitator_participants', 'plg_omadia_agent_facilitator_outbox', 'plg_omadia_agent_facilitator_decisions']) {
    const left = await h.db.pool.query(`SELECT 1 FROM ${table} WHERE facilitation_id = $1`, [f.id]);
    assert.equal(left.rows.length, 0, table);
  }
  assert.equal((await listAudit(h.db.pool, f.id)).length, 1);
  assert.ok(h.logs.some((l) => l.includes(f.id) && l.includes('retention')));
});

test('no silent end: a facilitation that reaches its maximum duration ends with an abort report', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('go-lifetime', [ANNA, BERT]);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  h.clock.advance(29 * DAY_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'active');
  h.clock.advance(2 * DAY_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  assert.equal(posts(conv).at(-1), 'This facilitation ends without a result. Reason: the maximum duration of 30 days was reached');
});

test('review: retention deletes in bounded batches', { skip: PG_SKIP }, async () => {
  const { purgeExpired, PURGE_BATCH } = await import('../src/engine/governance.js');
  const { createFacilitation } = await import('../src/db/store.js');
  const past = new Date(h.clock.now().getTime() - DAY_MS);
  const total = PURGE_BATCH * 2 + 7;
  for (let i = 0; i < total; i += 1) {
    const f = await createFacilitation(h.db.pool, {
      facilitatorAgent: 'bulk', channelType: 'teams', conversationId: `go-bulk-${String(i)}`, initiatorPrincipal: 'user:anna', goal: 'g', format: 'custom', language: 'en', timezone: 'Europe/Berlin',
      closeRule: 'all_contributed', reminderPolicy: { offsetsHours: [] }, followupPolicy: { actionItems: false, leadHours: 24 }, settings: { changeWindowHours: 12, runoffWindowHours: 12, confirmWindowMinutes: 30 }, createdAt: past,
    });
    await store.patchFacilitation(h.db.pool, f.id, { phase: 'closed', closedAt: past, purgeAfter: past });
  }
  const first = await purgeExpired(h.engine.core, { maxBatches: 1 });
  assert.equal(first.length, PURGE_BATCH, 'one statement deletes at most one batch');
  const rest = await purgeExpired(h.engine.core);
  assert.equal(rest.length, total - PURGE_BATCH);
});
