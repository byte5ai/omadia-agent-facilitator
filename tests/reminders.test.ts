// D16 (live runs on 1.0.1): the group could not set reminders, and the
// handshake announced "24 h, 2 h" for a deadline 13 minutes away.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { rows } from '../src/db/sql.js';
import { reminderOffsetsFor } from '../src/engine/reminders.js';
import type { Job } from '../src/model.js';
import { ANNA, BERT, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true };

test('default reminders follow from the time to the deadline and never lie outside it', () => {
  const offsets = (minutes: number): number[] => reminderOffsetsFor(minutes * MINUTE_MS, [24, 2]).map((h) => Math.round(h * 60));
  assert.deepEqual(offsets(3 * 24 * 60), [24 * 60, 120]);
  assert.deepEqual(offsets(180), [120]);
  assert.deepEqual(offsets(60), [15], 'none of the configured ones fits: one in the last quarter');
  assert.deepEqual(offsets(13), [3]);
  assert.deepEqual(offsets(5), [], 'too close to the deadline for any reminder');
});

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const start = (conv: string, extra: Record<string, unknown>): Promise<string> => h.tool('facilitation_start', { ...VOTE, ...extra }, { conversation: conv });
const reminderJobs = async (conv: string): Promise<Job[]> =>
  rows<Job>(h.db.pool, `SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND kind = 'reminder' AND status = 'pending' ORDER BY due_at`, [(await h.facilitation(conv)).id]);
const line = (conv: string): string => (posts(conv)[0] ?? '').split('\n').find((l) => l.startsWith('Reminders:')) ?? '';

test('the handshake announces only reminders that will be sent', { skip: PG_SKIP }, async () => {
  const far = h.kernel.conversation('rm-far', [ANNA, BERT]);
  await start(far, { deadline: inMinutes(3 * 24 * 60) });
  assert.match(line(far), /^Reminders: 24 h, 2 h before the deadline/);

  const near = h.kernel.conversation('rm-near', [ANNA, BERT]);
  await start(near, { deadline: inMinutes(13) });
  assert.match(line(near), /^Reminders: 3 min before the deadline/);
  assert.equal((await reminderJobs(near)).length, 1);

  const now = h.kernel.conversation('rm-now', [ANNA, BERT]);
  await start(now, { deadline: inMinutes(5) });
  assert.equal(line(now), 'Reminders: none, the deadline is in 5 minutes.');
  assert.equal((await reminderJobs(now)).length, 0);
});

test('reminders asked for in the request are the ones that are sent, in minutes', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rm-asked', [ANNA, BERT]);
  await start(conv, { deadline: inMinutes(13), reminderMinutesBefore: [4] });
  assert.match(line(conv), /^Reminders: 4 min before the deadline/);
  const due = (await reminderJobs(conv)).map((j) => j.dueAt.getTime());
  assert.deepEqual(due, [(await h.facilitation(conv)).deadline!.getTime() - 4 * MINUTE_MS]);
  h.clock.advance(9 * MINUTE_MS + 1000);
  await h.tick();
  assert.match(posts(conv).at(-1) ?? '', /^Reminder: 2 contributions are still open/);

  const none = h.kernel.conversation('rm-none', [ANNA, BERT]);
  await start(none, { deadline: inMinutes(600), reminderMinutesBefore: [] });
  assert.equal(line(none), 'Reminders: none.');
  assert.equal((await reminderJobs(none)).length, 0);
});

test('a reminder that cannot happen is refused, not announced', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rm-refused', [ANNA, BERT]);
  assert.match(await start(conv, { deadline: inMinutes(13), reminderMinutesBefore: [30] }), /^Refused \(bad_reminder\)/);
  assert.match(await start(conv, { reminderMinutesBefore: [30] }), /^Refused \(bad_reminder\)/);
  assert.match(await start(conv, { deadline: inMinutes(13), reminderMinutesBefore: [0] }), /^Refused \(bad_reminder\)/);
  assert.equal(posts(conv).length, 0);
});

test('the group changes the reminders by consent', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rm-change', [ANNA, BERT]);
  await start(conv, { deadline: inMinutes(48 * 60) });
  const put = await h.tool('facilitation_propose_change', { change: 'reminders', reminderMinutesBefore: [90, 10] }, { conversation: conv });
  assert.match(put, /^Put to the group/);
  assert.match(posts(conv).at(-1) ?? '', /remind 90 min, 10 min before the deadline/);
  for (const who of ['anna', 'bert']) {
    await h.kernel.say(conv, who, 'agreed');
    await h.settle();
  }
  await passWindow(h, conv);
  assert.ok(posts(conv).some((p) => p === 'Reminders are now sent 90 min, 10 min before the deadline.'));
  const f = await h.facilitation(conv);
  assert.deepEqual((await reminderJobs(conv)).map((j) => (f.deadline!.getTime() - j.dueAt.getTime()) / MINUTE_MS), [90, 10]);
  assert.match(await h.tool('facilitation_propose_change', { change: 'reminders', reminderMinutesBefore: [72 * 60] }, { conversation: conv }), /^Refused \(bad_reminder\)/);
  void HOUR_MS;
});
