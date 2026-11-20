// Protocol dispatch (spec B §5.8, §5.11; #2078, #2065): stakeholders get the
// facilitation protocol filtered per recipient by disclosure, marked with
// its result status, only at the facilitation's close or abort; a stop
// before invitations sends none; each grant ends at its own revocation
// event, also after a restart.
//
// Spec B §9 criteria 20 (revocation events), 30, 39, 47, 52, 55, 63.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { resultClosingOf } from '../src/engine/closing.js';
import { listClosings } from '../src/engine/resultStatus.js';
import { ANNA, BERT, CARA, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-20T08:00:00Z', config: { maxActivePerFacilitator: 40, startsPerHourPerFacilitator: 100 } });
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
const say = async (conv: string, who: string, text: string): Promise<void> => {
  await h.kernel.say(conv, who, text);
  await h.settle();
};
const all = async (conv: string, text: string): Promise<void> => {
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, text);
  // Group consent is decided when its window ends, never early (spec 5.7).
  if (text === 'agreed' && (await h.facilitation(conv)).phase === 'active') await passWindow(h, conv);
};
const stakeholder = async (conv: string, name: string, address: string, disclosure?: string): Promise<void> => {
  await tool(conv, 'facilitation_stakeholder', { name, address, role: 'receives_protocol', ...(disclosure ? { disclosure } : {}) });
  await all(conv, 'agreed');
};
const mailTo = (address: string, since: number) => followup.mails.slice(since).filter((m) => m.recipients.includes(address));

test('30. a mixed protocol to stakeholders with full, existence and none: full gets every part it may know, existence a note, none neither content nor a hint', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('dp-30', THREE);
  await startActive(h, conv, { goal: 'Offsite plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await say(conv, 'anna', 'A boat trip');
  await tool(conv, 'facilitation_propose_summary', { text: 'The group leans towards an outdoor day' });
  await all(conv, 'agreed');
  await stakeholder(conv, 'Fay Full', 'fay@example.com', 'full');
  await stakeholder(conv, 'Eli Exists', 'eli@example.com', 'existence');
  await stakeholder(conv, 'Nia None', 'nia@example.com', 'none');
  const since = followup.mails.length;
  assert.equal(followup.mails.length, since, 'nothing to stakeholders while it runs (criterion 63)');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await all(conv, 'agreed');
  await h.tick();

  const [fay] = mailTo('fay@example.com', since);
  const [eli] = mailTo('eli@example.com', since);
  const [nia] = mailTo('nia@example.com', since);
  for (const mail of [fay, eli, nia]) {
    assert.deepEqual(mail?.recipients.length, 1, 'each stakeholder their own protocol');
    assert.match(mail?.body ?? '', /^Protocol: Offsite plan\nResult status: published\n/);
    assert.doesNotMatch(mail?.body ?? '', /A boat trip|Contributions:/, 'never contributions');
  }
  assert.match(fay?.body ?? '', /Summaries confirmed by the group:\n- The group leans towards an outdoor day/);
  assert.match(fay?.body ?? '', /Some parts of this protocol are not shared with you/);
  assert.doesNotMatch(eli?.body ?? '', /outdoor day/, 'a model-written summary is withheld as a whole');
  assert.match(eli?.body ?? '', /Some parts of this protocol are not shared with you/);
  assert.doesNotMatch(nia?.body ?? '', /outdoor day|not shared with you|Participants:/, 'none: neither content nor a hint');
  const f = await h.facilitation(conv);
  const logged = (await store.listEvents(h.db.pool, f.id, ['protocol_mail'])).at(-1)?.payload['recipients'] as Array<{ address: string; disclosure?: string; withheld?: string[] }>;
  assert.deepEqual(logged.find((r) => r.address === 'nia@example.com')?.withheld?.sort(), ['contributions', 'participants', 'summaries']);
});

test('39. stakeholders receive a published, a confirmed, a not-confirmed and an aborted protocol, each marked with its status', { skip: PG_SKIP }, async () => {
  const marked: string[] = [];
  const run = async (id: string, setup: Record<string, unknown>, finish: (conv: string) => Promise<void>): Promise<void> => {
    const conv = h.kernel.conversation(`dp-39-${id}`, THREE);
    await startActive(h, conv, setup);
    await stakeholder(conv, 'Sam Sponsor', `sam-${id}@example.com`);
    const since = followup.mails.length;
    await finish(conv);
    await h.tick();
    const mail = mailTo(`sam-${id}@example.com`, since)[0];
    marked.push(/Result status: ([^\n]+)/.exec(mail?.body ?? '')?.[1] ?? 'nothing');
  };
  const FREE = { goal: 'Align', definitionOfDone: 'Everybody can live with it' };
  await run('published', { goal: 'Venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Old Town'] }, async (conv) => {
    await all(conv, 'A');
  });
  await run('confirmed', FREE, async (conv) => {
    await tool(conv, 'facilitation_close');
    h.clock.advance(24 * HOUR_MS + MINUTE_MS);
    await h.tick();
  });
  await run('objection', FREE, async (conv) => {
    await tool(conv, 'facilitation_close');
    await say(conv, 'bert', 'objection: not yet');
    h.clock.advance(24 * HOUR_MS + MINUTE_MS);
    await h.tick();
  });
  await run('aborted', FREE, async (conv) => {
    await say(conv, 'cara', 'stop');
  });
  assert.deepEqual(marked, ['published', 'confirmed', 'not confirmed (objection)', 'aborted']);
});

test('47. a follow-up meeting is agreed, its invitations not sent; stop and restart: no free/busy, no invitation; the abort report lists what was already sent', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('dp-47', THREE);
  const f = await startActive(h, conv, { goal: 'Offsite plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_plan_followup_meeting', { subject: 'Offsite follow-up', durationMinutes: 60, earliest: h.clock.now().toISOString(), latest: new Date(h.clock.now().getTime() + 8 * DAY_MS).toISOString() });
  await all(conv, 'agreed');
  // An invitation of this meeting that already went out (by an earlier engine).
  await h.db.pool.query(
    `INSERT INTO plg_omadia_agent_facilitator_jobs (facilitation_id, kind, dedupe_key, due_at, payload, status, created_at, finished_at)
     VALUES ($1, 'followup_meeting', $2, $3, $4::jsonb, 'done', $3, $3)`,
    [f.id, `${f.id}:followup_meeting:earlier`, h.clock.now(), JSON.stringify({ result: { outcome: 'created', start: '2026-11-24T09:00:00Z' } })],
  );
  const calls = followup.calls.length;
  await say(conv, 'anna', 'stop');
  await h.restart();
  h.clock.advance(HOUR_MS);
  await h.tick();
  assert.ok(!followup.calls.slice(calls).some((c) => c.method === 'freeBusy' || c.method === 'createInvitation'), 'no free/busy and no invitation after the stop');
  const report = posts(conv).find((t) => t.startsWith('Anna asked to stop') || t.includes('ends without a result') || t.includes('stop')) ?? '';
  assert.match(posts(conv).join('\n'), /Invitations already sent \(they stay; cancelling them is a separate request\): Offsite follow-up \(Tue, 24\/11\/2026, 10:00/);
  assert.ok(report !== '');
  assert.equal(h.kernel.scopeOf(f.id, 'scheduling', 'followup_meeting')?.state ?? 'ended', 'ended', 'the scheduling scope is revoked');
});

test('52. a pending follow-up invitation survives a regular close but not a stop after `concluding`', { skip: PG_SKIP }, async () => {
  const plan = { subject: 'Review', durationMinutes: 30, earliest: h.clock.now().toISOString(), latest: new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString() };
  for (const [id, stop] of [['regular', false], ['stopped', true]] as const) {
    const conv = h.kernel.conversation(`dp-52-${id}`, THREE);
    const f = await startActive(h, conv, { goal: 'Align', definitionOfDone: 'Everybody can live with it' });
    await tool(conv, 'facilitation_plan_followup_meeting', plan);
    await all(conv, 'agreed');
    await tool(conv, 'facilitation_close');
    if (stop) await say(conv, 'bert', 'stop');
    h.clock.advance(24 * HOUR_MS + MINUTE_MS);
    await h.restart();
    await h.tick();
    await h.tick();
    const jobs = (await h.db.pool.query<{ status: string }>(`SELECT status FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND kind = 'followup_meeting'`, [f.id])).rows;
    assert.equal(jobs.length, stop ? 0 : 1, `${id}: ${JSON.stringify(jobs)}`);
  }
});

test('20. the dispatch grant ends 7 days after the protocol became final when sends never get through, also across a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('dp-20-seven', THREE);
  const f = await startActive(h, conv, { goal: 'Venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Old Town'] });
  // Bert cannot be reached privately right now: his protocol keeps failing.
  h.kernel.dmBlocked.set('user:bert', 'throttled');
  await all(conv, 'A');
  const c0 = await resultClosingOf(h.db.pool, f.id);
  assert.equal(c0?.part, 'dispatch');
  await h.restart();
  for (let i = 0; i < 8; i += 1) {
    h.clock.advance(DAY_MS);
    await h.tick();
  }
  const c = await resultClosingOf(h.db.pool, f.id);
  assert.equal(c?.part, 'done');
  assert.ok(c?.endedAt && c.finalAt && c.endedAt.getTime() >= c.finalAt.getTime() + 7 * DAY_MS, 'ended at the dispatch limit');
  h.kernel.dmBlocked.delete('user:bert');
  const before = h.kernel.dms.length;
  await h.tick();
  assert.ok(!h.kernel.dms.slice(before).some((d) => d.principal === 'user:bert'), 'nothing is sent after the dispatch limit');
  assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'ended');
});

test('20. without action items: the dispatch grant is revoked when its sends are confirmed; the closing ends and its scope with it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('dp-20-confirmed', THREE);
  const f = await startActive(h, conv, { goal: 'Venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Old Town'] });
  await stakeholder(conv, 'Sam Sponsor', 'sam-20@example.com');
  await all(conv, 'B');
  await h.restart();
  await h.tick();
  const dispatch = h.kernel.grants.filter((g) => g.processId === f.id && g.kind === 'protocol_dispatch');
  assert.ok(dispatch.length > 0 && dispatch.every((g) => /protocol mail done/.test(g.revokeReason ?? '')), 'revoked once the send is confirmed');
  const closings = await listClosings(h.db.pool, f.id);
  assert.deepEqual(closings.map((c) => [c.kind, c.part]), [['result', 'done']]);
  assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'ended');
});
