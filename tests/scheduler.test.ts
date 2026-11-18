// Time, reminders, races and delivery classes (spec 5.6, acceptance 2, 3, 12).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { rows } from '../src/db/sql.js';
import * as store from '../src/db/store.js';
import { withFacilitationLock } from '../src/db/tx.js';
import { MAX_ESSENTIAL_ATTEMPTS } from '../src/engine/outbox.js';
import { MAX_JOB_ATTEMPTS } from '../src/engine/scheduler.js';
import type { Job, OutboxRow } from '../src/model.js';
import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-18T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const count = (conv: string, prefix: string): number => posts(conv).filter((t) => t.startsWith(prefix)).length;
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
const outbox = async (conv: string) => rows<OutboxRow>(h.db.pool, 'SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id]);
const jobs = async (conv: string) => rows<Job>(h.db.pool, `SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND kind NOT IN ('lifetime', 'grant_revoke') ORDER BY due_at`, [(await h.facilitation(conv)).id]);
const jobsOf = async (conv: string, kind: string) => rows<Job>(h.db.pool, 'SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND kind = $2', [(await h.facilitation(conv)).id, kind]);
/** A deadline `hours` from the current clock, ISO. */
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
async function at(deadline: Date, hoursBefore: number, plusMs = 1000): Promise<void> {
  h.clock.set(new Date(deadline.getTime() - hoursBefore * HOUR_MS + plusMs));
  await h.tick();
}

test('deadline scenario: one reminder at -24 h and one at -2 h, neutral in the group and private to the missing person, honest close at the deadline', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-deadline', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  const deadline = f.deadline as Date;
  assert.deepEqual((await jobs(conv)).map((j) => [j.kind, j.status]), [['reminder', 'pending'], ['reminder', 'pending'], ['deadline', 'pending']]);
  await say(conv, 'anna', 'A > B');
  await say(conv, 'bert', 'A');
  await say(conv, 'cara', 'B > A');

  h.clock.set(new Date(deadline.getTime() - 30 * HOUR_MS));
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 0, 'nothing before its time');

  await at(deadline, 24);
  assert.equal(count(conv, 'Reminder:'), 1);
  const reminder = posts(conv).find((t) => t.startsWith('Reminder:')) ?? '';
  assert.match(reminder, /^Reminder: one contribution is still open\. Deadline: /);
  assert.doesNotMatch(reminder, /Dave/, 'nobody is named in the group');
  assert.deepEqual(h.kernel.dms.map((d) => [d.as, d.principal]), [['mira', 'user:dave']]);
  assert.match(h.kernel.dms[0]?.text ?? '', /Hello Dave, your contribution to "Pick a venue" is still open\..*Please answer in the group/);

  await h.tick();
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 1, 'a reminder is sent once');

  await at(deadline, 2);
  assert.equal(count(conv, 'Reminder:'), 2);
  assert.equal(h.kernel.dms.length, 2);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'no abort before the deadline');

  await at(deadline, 0);
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  const result = posts(conv).at(-1) ?? '';
  assert.match(result, /- Pick a venue: Harbour \(Harbour 8, Old Town 5, Castle Hill 0\)/);
  assert.match(result, /The deadline has passed; 3 of 4 contributed/);
  assert.equal(count(conv, 'Result for'), 1);
  assert.equal(count(conv, 'This facilitation ends without'), 0);
});

test('no reminder after completion: concluding cancels every job in the same transaction', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-done', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await say(conv, who, 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.deepEqual([...new Set((await jobs(conv)).map((j) => j.status))], ['cancelled']);
  const before = posts(conv).length;
  const dms = h.kernel.dms.length;
  h.clock.set(new Date((f.deadline as Date).getTime() + HOUR_MS));
  await h.tick();
  assert.equal(posts(conv).length, before);
  assert.equal(h.kernel.dms.length, dms);
});

test('race: the last vote lands between "reminder is due" and "reminder runs": no reminder is delivered', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-race', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.clock.set(new Date((f.deadline as Date).getTime() - 24 * HOUR_MS + 1000));
  h.kernel.tickMs = 0; // the vote and the reminder in the same second
  const reminders = (): number => h.kernel.dms.filter((d) => d.text.includes('is still open')).length;
  const dmsBefore = reminders();
  h.hooks.beforeJob = async (job) => {
    if (job.kind !== 'reminder' || job.facilitationId !== f.id) return;
    delete h.hooks.beforeJob;
    await h.kernel.say(conv, 'dave', 'B');
  };
  await h.tick();
  h.kernel.tickMs = 1000;
  assert.equal(count(conv, 'Reminder:'), 0);
  assert.equal(reminders(), dmsBefore, 'and nobody is reminded privately');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('race: a reminder already written to the outbox is not sent after the vote that made it stale', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-stale', FOUR);
  const f = await startActive(h, conv, VOTE);
  // Commit a reminder without delivering it: the moment between commit and send.
  await withFacilitationLock(h.db.pool, f.id, (client) =>
    h.engine.core.workOn(client, f.id, async (w) => {
      w.post({ purpose: 'reminder', key: 'stale', to: 'group', deliveryClass: 'droppable', text: 'Reminder: 4 contributions are still open.' });
    }),
  );
  await say(conv, 'anna', 'A');
  assert.equal(count(conv, 'Reminder:'), 0);
  const row = (await outbox(conv)).find((r) => r.purpose === 'reminder');
  assert.equal(row?.status, 'dropped');
  assert.match(row?.dropReason ?? '', /state moved from version/);
});

test('crash after commit and before send: after the restart the essential message is sent, the reminder is not', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-crash', FOUR);
  const f = await startActive(h, conv, VOTE);
  await withFacilitationLock(h.db.pool, f.id, (client) =>
    h.engine.core.workOn(client, f.id, async (w) => {
      w.post({ purpose: 'reminder', key: 'crash', to: 'group', deliveryClass: 'droppable', versionBound: false, text: 'Reminder: lost in the crash' });
      w.post({ purpose: 'runoff', key: 'crash', to: 'group', deliveryClass: 'essential', text: 'Essential: survives the crash' });
    }),
  );
  assert.equal(count(conv, 'Essential:'), 0);
  await h.restart();
  assert.equal(count(conv, 'Essential:'), 1);
  assert.equal(count(conv, 'Reminder: lost'), 0);
  const byPurpose = Object.fromEntries((await outbox(conv)).filter((r) => r.idempotencyKey.endsWith(':crash')).map((r) => [r.purpose, r.status]));
  assert.deepEqual(byPurpose, { reminder: 'dropped', runoff: 'sent' });
});

test('crash during the channel call: unknown outcome is retried for an essential message, never for a reminder', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-midcall', FOUR);
  const f = await startActive(h, conv, VOTE);
  h.hooks.afterChannelCall = () => {
    throw new Error('process killed');
  };
  await assert.rejects(
    h.engine.core.work(f.id, async (w) => {
      w.post({ purpose: 'reminder', key: 'mid', to: 'group', deliveryClass: 'droppable', versionBound: false, text: 'Reminder: mid-call' });
    }),
    /process killed/,
  );
  await assert.rejects(
    h.engine.core.work(f.id, async (w) => {
      w.post({ purpose: 'runoff', key: 'mid', to: 'group', deliveryClass: 'essential', text: 'Essential: mid-call' });
    }),
    /process killed/,
  );
  delete h.hooks.afterChannelCall;
  await h.restart();
  // The reminder reached the channel once (outcome unknown to the engine) and is not sent again;
  // the essential message is sent again, accepting the duplicate.
  assert.equal(count(conv, 'Reminder: mid-call'), 1);
  assert.equal(count(conv, 'Essential: mid-call'), 2);
});

test('lost send confirmation: the result is retried, a reminder is not', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-lost', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.kernel.sendFaults.push('lost');
  await at(f.deadline as Date, 24);
  assert.equal(count(conv, 'Reminder:'), 1, 'it did reach the channel');
  h.clock.advance(10 * MINUTE_MS);
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 1, 'and is not sent a second time');

  // The echo of Dave's ballot goes out first and takes the first fault; the result is "lost".
  h.kernel.sendFaults.push({ code: 'throttled', message: 'echo not delivered' }, 'lost');
  await say(conv, 'dave', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'concluding', 'not closed before the result is confirmed delivered');
  assert.equal(count(conv, 'Result for'), 1);
  await h.tick();
  assert.equal(count(conv, 'Result for'), 1, 'the retry waits for its backoff');
  h.clock.advance(MINUTE_MS);
  await h.tick();
  assert.equal(count(conv, 'Result for'), 2, 'retried, accepting a duplicate');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('last vote and deadline at the same time: one evaluation, one report', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-same', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.clock.set(new Date((f.deadline as Date).getTime()));
  h.kernel.tickMs = 0;
  await Promise.all([h.kernel.say(conv, 'dave', 'B'), h.engine.tick()]);
  await h.settle();
  h.kernel.tickMs = 1000;
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(count(conv, 'Result for'), 1);
  assert.equal(count(conv, 'This facilitation ends without'), 0);
  assert.equal((await store.listDecisions(h.db.pool, f.id)).length, 1);
});

test('two replicas tick at once: the lease lets one of them send the reminder', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-lease', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  await say(conv, 'anna', 'A');
  h.clock.set(new Date((f.deadline as Date).getTime() - 24 * HOUR_MS + 1000));
  const other = h.replica();
  await Promise.all([h.engine.tick(), other.tick(), h.engine.tick(), other.tick()]);
  await h.settle();
  await other.stop();
  assert.equal(count(conv, 'Reminder:'), 1);
  assert.equal(h.kernel.dms.filter((d) => d.text.includes('Hello Bert')).length >= 1, true);
  const reminderJobs = (await jobs(conv)).filter((j) => j.kind === 'reminder');
  assert.deepEqual(reminderJobs.map((j) => j.status), ['done', 'pending']);
});

test('a private reminder that cannot be delivered: the group is told once, without a name', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-dm', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.kernel.dmBlocked.set('user:dave', 'app_not_installed');
  await at(f.deadline as Date, 24);
  await at(f.deadline as Date, 2);
  h.kernel.dmBlocked.delete('user:dave');
  assert.equal(count(conv, 'Reminder:'), 2);
  assert.equal(count(conv, 'I cannot reach everybody privately here'), 1);
  assert.ok(!posts(conv).some((t) => t.includes('I cannot reach') && t.includes('Dave')));
  assert.equal((await store.listEvents(h.db.pool, f.id, ['direct_unreachable'])).length, 1, 'a private message is tried once per person and not again');
});

test('runoff timeout: the facilitation ends with a report that names the tie', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-runoff', FOUR);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'B');
  await say(conv, 'cara', 'A');
  await say(conv, 'dave', 'B');
  assert.equal(count(conv, 'The vote ended level'), 1);
  await say(conv, 'anna', 'A');
  h.clock.advance(12 * HOUR_MS + 5000);
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed', 'one vote in the runoff decides it at the timeout');
  assert.match(posts(conv).at(-1) ?? '', /Harbour \(Harbour 3, Old Town 0\)/);

  const tied = h.kernel.conversation('sc-runoff-tied', FOUR);
  await startActive(h, tied, VOTE);
  for (const [who, vote] of [['anna', 'A'], ['bert', 'B'], ['cara', 'A'], ['dave', 'B']] as const) await say(tied, who, vote);
  h.clock.advance(12 * HOUR_MS + 5000);
  await h.tick();
  assert.equal((await h.facilitation(tied)).phase, 'aborted');
  assert.match(posts(tied).at(-1) ?? '', /ends without a result\. Reason: the deadline passed with the vote level between Harbour and Old Town/);
});

test('no silent end: a job that keeps failing ends the facilitation with an abort report', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-jobfail', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.db.pool.query(
    `INSERT INTO plg_omadia_agent_facilitator_jobs (facilitation_id, kind, dedupe_key, due_at, created_at) VALUES ($1, 'no_such_kind', $2, $3, $3)`,
    [f.id, `${f.id}:broken`, h.clock.now()],
  );
  for (let i = 0; i < MAX_JOB_ATTEMPTS - 1; i += 1) {
    await h.tick();
    assert.equal((await h.facilitation(conv)).phase, 'active');
  }
  await h.tick();
  const ended = await h.facilitation(conv);
  assert.equal(ended.phase, 'aborted');
  assert.match(posts(conv).at(-1) ?? '', /ends without a result\. Reason: an internal step failed repeatedly/);
  assert.equal((await jobs(conv)).find((j) => j.kind === 'no_such_kind')?.status, 'failed');
});

test('a deadline without a result: honest abort report, and the deadline of a facilitation still being set up ends it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-nothing', FOUR);
  const f = await startActive(h, conv, { deadline: inHours(5) });
  h.clock.set(new Date((f.deadline as Date).getTime() + 1000));
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  assert.match(posts(conv).at(-1) ?? '', /Reason: the deadline passed and the definition of done was not met/);
});

test('review 2: a result that cannot be posted does not leave the facilitation concluding forever', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-giveup', FOUR);
  const f = await startActive(h, conv, VOTE);
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  for (let i = 0; i < MAX_ESSENTIAL_ATTEMPTS + 2; i += 1) h.kernel.sendFaults.push({ code: 'throttled', message: 'try later' });
  await say(conv, 'dave', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  assert.ok((await jobsOf(conv, 'lifetime')).some((j) => j.status === 'pending'), 'the maximum duration still applies while concluding');
  // The echo of Dave's ballot took the first fault; the result takes the rest.
  for (let i = 0; i < MAX_ESSENTIAL_ATTEMPTS + 2; i += 1) {
    h.clock.advance(2 * HOUR_MS);
    await h.tick();
  }
  h.kernel.sendFaults.length = 0;
  await h.tick();
  const result = (await outbox(conv)).find((r) => r.purpose === 'result');
  assert.equal(result?.status, 'failed');
  assert.equal(result?.attempts, MAX_ESSENTIAL_ATTEMPTS);
  const ended = await h.facilitation(conv);
  assert.equal(ended.phase, 'aborted', 'an end state, not concluding');
  assert.match(ended.closeReason ?? '', /result could not be posted/);
  assert.ok(ended.purgeAfter, 'retention is scheduled');
  assert.ok(ended.result, 'the result itself is kept');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['result_undelivered'])).length, 1);
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false, 'the conversation is released');
  assert.match(await h.tool('facilitation_start', { goal: 'again', definitionOfDone: 'd' }, { conversation: conv }), /^Facilitation created/, 'a new facilitation can start there');
});

test('review 2: a crash between "result sent" and the close is finished by the next tick', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-close-crash', FOUR);
  await startActive(h, conv, VOTE);
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  h.hooks.beforeClose = () => {
    throw new Error('process killed before the close was committed');
  };
  await say(conv, 'dave', 'A');
  delete h.hooks.beforeClose;
  assert.equal((await h.facilitation(conv)).phase, 'concluding');
  assert.equal(count(conv, 'Result for'), 1);
  await h.restart();
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(count(conv, 'Result for'), 1, 'the result is not posted again');
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false);
});

test('review 6: after downtime overdue reminders are not sent late, and never after the deadline', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sc-burst', FOUR);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  const deadline = f.deadline as Date;
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  const dms = h.kernel.dms.filter((d) => d.text.includes('is still open')).length;

  // Down from before -24 h until three hours after it: that reminder is stale.
  h.clock.set(new Date(deadline.getTime() - 21 * HOUR_MS));
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 0, 'three hours late is not sent');

  // A few minutes late is still a reminder.
  h.clock.set(new Date(deadline.getTime() - 2 * HOUR_MS + 5 * MINUTE_MS));
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 1);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['reminder_skipped'])).length, 1);

  // Down across the whole end: both reminders and the deadline are overdue at once.
  const late = h.kernel.conversation('sc-burst-late', FOUR);
  const g = await startActive(h, late, { ...VOTE, deadline: inHours(72) });
  for (const who of ['anna', 'bert', 'cara']) await say(late, who, 'A');
  h.clock.set(new Date((g.deadline as Date).getTime() + HOUR_MS));
  await h.tick();
  assert.equal(count(late, 'Reminder:'), 0, 'no reminder after the deadline');
  assert.equal(count(late, 'Result for'), 1);
  assert.equal((await h.facilitation(late)).phase, 'closed');
  assert.equal(h.kernel.dms.filter((d) => d.text.includes('is still open')).length, dms + 1, 'one private reminder in all');
});
