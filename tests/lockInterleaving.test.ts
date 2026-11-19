// D23, the part 1.0.5 did not exercise live: a reminder directly followed by
// a mention, on the lease lock. On 1.0.4 the reminder's unit of work left the
// lock taken and the mention after it was never processed.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { ANNA, BERT, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-18T09:00:00Z', config: { maxActivePerFacilitator: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const outcomes = async (conv: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id])).rows.map((r) => r.outcome);
const lockRows = async (conv: string): Promise<number> =>
  (await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = $1', [(await h.facilitation(conv)).id])).rows.length;

async function withReminderDue(id: string): Promise<string> {
  const conv = h.kernel.conversation(id, [ANNA, BERT]);
  const deadline = new Date(h.clock.now().getTime() + 3 * HOUR_MS).toISOString();
  await h.tool('facilitation_start', { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], deadline, reminderMinutesBefore: [60], open: true }, { conversation: conv });
  // As live: the private reminder cannot arrive, which adds a neutral note.
  h.kernel.dmBlocked.set('user:anna', 'app_not_installed');
  h.kernel.dmBlocked.set('user:bert', 'app_not_installed');
  h.clock.advance(2 * HOUR_MS + MINUTE_MS);
  return conv;
}

test('a mention right after a reminder is processed, and the lock is free afterwards', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  try {
    const conv = await withReminderDue('li-after');
    await h.tick();
    assert.ok(posts(conv).some((p) => /^Reminder: 2 contributions are still open/.test(p)));
    const answered = h.kernel.turns.length;
    await h.kernel.say(conv, 'anna', 'Mira, how long is the vote still open?');
    await h.settle();
    assert.equal(h.kernel.turns.length, answered + 1, 'the mention reached the facilitator');
    await h.kernel.say(conv, 'anna', 'A');
    await h.settle();
    assert.deepEqual((await outcomes(conv)).slice(-2), ['free_text', 'ballot']);
    assert.equal(await lockRows(conv), 0);
    assert.ok(!h.logs.some((l) => /lock was not free|could not be processed/.test(l)), h.logs.join('\n'));
  } finally {
    h.kernel.dmBlocked.clear();
  }
});

test('a mention that arrives while the reminder runs waits its turn and is processed', { skip: PG_SKIP, timeout: 30_000 }, async () => {
  try {
    const conv = await withReminderDue('li-during');
    // Both at once: the reminder's work (with its sends) and two messages.
    await Promise.all([h.tick(), h.kernel.say(conv, 'bert', 'Mira, is this still running?'), h.kernel.say(conv, 'anna', 'A')]);
    await h.settle();
    assert.ok(posts(conv).some((p) => /^Reminder: /.test(p)));
    assert.deepEqual([...(await outcomes(conv))].sort(), ['ballot', 'free_text']);
    assert.equal(await lockRows(conv), 0);
    assert.ok(!h.logs.some((l) => /lock was not free|could not be processed/.test(l)), h.logs.join('\n'));
    // And the next reminder cycle is not blocked either.
    await h.kernel.say(conv, 'bert', 'B');
    await h.settle();
    assert.equal((await outcomes(conv)).at(-1), 'ballot');
  } finally {
    h.kernel.dmBlocked.clear();
  }
});
