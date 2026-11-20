// Small things the second integration run showed (S8).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { de } from '../src/texts/de.js';
import { en } from '../src/texts/en.js';
import { ANNA, BERT, FOUR, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
/** A reply to the facilitator's last message: what it hears in follow-up
 *  without a turn of the facilitator being started (a mention starts one). */
async function reply(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text, { replyTo: h.kernel.groupPosts(conv).at(-1)?.messageId ?? '' });
  await h.settle();
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();

test('a reminder offset below one hour is printed in minutes', () => {
  assert.equal(en.reminderTimes([24, 2, 0.5, 0.04]), '24 h, 2 h, 30 min, 2 min');
  assert.equal(de.reminderTimes([24, 0.04]), '24 Std., 2 Min.');
});

test('a bare "yes" in a collecting step is not a collected point', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st-yes', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Next steps', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }], open: true });
  const f = await h.facilitation(conv);
  await tool(conv, 'facilitation_record_action_item', { description: 'Write the summary', owner: 'Anna', dueDate: inHours(48) });
  await say(conv, 'cara', 'ja');
  await say(conv, 'bert', 'No');
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).map((c) => c.payload['text']), []);
  assert.ok(!posts(conv).some((p) => /^Recorded for you/.test(p)));
  assert.equal((await store.listActionItems(h.db.pool, f.id))[0]?.status, 'proposed');
});

test('a close at the deadline counts who voted, not who said anything earlier', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('st-count', FOUR);
  await tool(conv, 'facilitation_start', {
    goal: 'Pick a venue',
    deadline: inHours(3),
    reminderOffsetsHours: [],
    agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'decide', title: 'Vote', method: 'single', options: ['Harbour', 'Garden'] }],
    open: true,
  });
  await say(conv, 'cara', 'The harbour has more room');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.equal((await store.openStepOf(h.db.pool, (await h.facilitation(conv)).id))?.kind, 'decide');
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  h.clock.advance(3 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const result = posts(conv).find((p) => /deadline has passed|deadline was reached|The deadline/.test(p) && /contributed/.test(p)) ?? '';
  assert.match(result, /2 of 4 contributed/);
});

async function followUp(conv: string, items: number): Promise<void> {
  h.kernel.conversation(conv, [ANNA, BERT]);
  await tool(conv, 'facilitation_start', { goal: 'Next steps', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true });
  for (let n = 1; n <= items; n += 1) {
    await tool(conv, 'facilitation_record_action_item', { description: `Task ${String(n)}`, owner: 'Anna', dueDate: inHours(48) });
    await say(conv, 'anna', 'yes');
  }
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  await passWindow(h, conv);
  assert.equal((await h.facilitation(conv)).followupState, 'active');
}

test('the reminder of an action item goes to its owner privately, not also into the group', { skip: PG_SKIP }, async () => {
  await followUp('st-reminder', 1);
  const before = posts('st-reminder').length;
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  assert.equal(h.kernel.dms.filter((d) => d.principal === 'user:anna' && /action item #1 is due/.test(d.text)).length, 1);
  assert.deepEqual(posts('st-reminder').slice(before).filter((p) => /action item #1 is due/.test(p)), []);
});

test('an owner who cannot be reached privately is reminded in the group instead', { skip: PG_SKIP }, async () => {
  await followUp('st-reminder-group', 1);
  h.kernel.dmBlocked.set('user:anna', 'app_not_installed');
  try {
    const before = posts('st-reminder-group').length;
    h.clock.advance(25 * HOUR_MS);
    await h.tick();
    assert.equal(posts('st-reminder-group').slice(before).filter((p) => /^Anna, action item #1 is due/.test(p)).length, 1);
  } finally {
    h.kernel.dmBlocked.delete('user:anna');
  }
});

// In follow-up the facilitator hears what is addressed to it (a mention, a
// reply to one of its messages, a card button): spec 2043 §6.2.
test('"done" without a number closes the only open item of its owner, and asks which one when there are several', { skip: PG_SKIP }, async () => {
  await followUp('st-done-one', 1);
  await reply('st-done-one', 'bert', 'erledigt');
  assert.equal((await store.listActionItems(h.db.pool, (await h.facilitation('st-done-one')).id))[0]?.status, 'confirmed', 'not the owner: nothing happens');
  await reply('st-done-one', 'anna', 'erledigt');
  assert.equal((await store.listActionItems(h.db.pool, (await h.facilitation('st-done-one')).id))[0]?.status, 'done');

  await followUp('st-done-two', 2);
  await reply('st-done-two', 'anna', 'Done!');
  assert.equal(posts('st-done-two').at(-1), 'Anna, which one is done? Reply with "done 1" or "done 2".');
  assert.deepEqual((await store.listActionItems(h.db.pool, (await h.facilitation('st-done-two')).id)).map((a) => a.status), ['confirmed', 'confirmed']);
});
