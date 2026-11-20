// Spec B §9 criterion 37 (#2070): acceptance stays personal. A nomination
// the named owner has not accepted when the result is frozen is an open
// point, never an action item: no reminder, no follow-up, also after a
// restart; an acceptance before `concluding` turns it into an action item;
// an acceptance after the freeze changes nothing and is answered once; with
// only unaccepted nominations the facilitation goes from `closed` to `ended`.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { lifecycleOf } from '../src/model.js';
import { FOUR, createHarness, startActive } from './harness.js';
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

const VENUES = { method: 'single', options: ['Harbour', 'Old Town'], followUp: true };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv, agent: 'mira', caller: 'anna' });

async function promptOf(conv: string, number: number): Promise<string> {
  const f = await h.facilitation(conv);
  const item = (await store.listActionItems(h.db.pool, f.id)).find((a) => a.number === number);
  const ack = await h.db.pool.query<{ prompt_message_id: string }>(`SELECT prompt_message_id FROM plg_omadia_agent_facilitator_acks WHERE ref_id = $1`, [item?.id]);
  return ack.rows[0]?.prompt_message_id ?? '';
}

test('37. with only unaccepted nominations the facilitation goes from `closed` to `ended`; the protocol lists them as open points', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('c37-only', FOUR);
  await startActive(h, conv, VENUES);
  const due = new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString();
  await tool(conv, 'facilitation_record_action_item', { description: 'Book the venue', owner: 'Bert', dueDate: due });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await h.kernel.say(conv, who, 'A');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal(lifecycleOf(f), 'ended');
  assert.equal(f.followupState, 'none');
  const result = posts(conv).find((t) => t.startsWith('Result for')) ?? '';
  assert.match(result, /#1 Book the venue: proposed for Bert, not accepted/);
  assert.doesNotMatch(result, /waiting for the owner/);
  const protocol = await buildProtocol(h.db.pool, f);
  assert.match(protocol, /Open points:\n- #1 Book the venue: proposed for Bert, not accepted/);
  assert.match(protocol, /Action items:\n- none/);
  const dms = h.kernel.dms.length;
  h.clock.advance(10 * DAY_MS);
  await h.tick();
  assert.equal(h.kernel.dms.length, dms, 'no reminder ever');
});

test('37. a "yes" after the freeze changes nothing and is answered once, also after a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('c37-late', FOUR);
  await startActive(h, conv, VENUES);
  const due = new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString();
  await tool(conv, 'facilitation_record_action_item', { description: 'Book the venue', owner: 'Bert', dueDate: due });
  const prompt = await promptOf(conv, 1);
  await tool(conv, 'facilitation_record_action_item', { description: 'Order drinks', owner: 'Cara', dueDate: due });
  await h.kernel.say(conv, 'cara', 'yes', { replyTo: await promptOf(conv, 2) });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await h.kernel.say(conv, who, 'A');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(lifecycleOf(f), 'following_up');

  await h.restart();
  const before = posts(conv).length;
  await h.kernel.say(conv, 'bert', 'yes', { replyTo: prompt });
  await h.settle();
  assert.equal(posts(conv).slice(before).filter((t) => t.includes('stays an open point')).length, 1, posts(conv).slice(before).join(' | '));
  await h.restart();
  await h.kernel.say(conv, 'bert', 'yes', { replyTo: prompt });
  await h.settle();
  assert.equal(posts(conv).slice(before).filter((t) => t.includes('stays an open point')).length, 1, 'said once');
  const items = await store.listActionItems(h.db.pool, f.id);
  assert.deepEqual(items.map((a) => [a.number, a.status]), [[1, 'proposed'], [2, 'confirmed']]);
  const dms = h.kernel.dms.length;
  h.clock.advance(5 * DAY_MS);
  await h.tick();
  const reminders = h.kernel.dms.slice(dms).filter((d) => d.text.includes('action item #'));
  assert.ok(reminders.some((d) => d.principal === 'user:cara'), 'the accepted item is reminded');
  assert.ok(!reminders.some((d) => d.principal === 'user:bert'), 'no reminder for the open point');
});

test('37. an acceptance before `concluding` makes an action item; the unaccepted one stays open without reminders', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('c37-early', FOUR);
  await startActive(h, conv, VENUES);
  const due = new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString();
  await tool(conv, 'facilitation_record_action_item', { description: 'Book the venue', owner: 'Bert', dueDate: due });
  await h.kernel.say(conv, 'bert', 'yes', { replyTo: await promptOf(conv, 1) });
  await h.settle();
  await tool(conv, 'facilitation_record_action_item', { description: 'Order drinks', owner: 'Cara', dueDate: due });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await h.kernel.say(conv, who, 'B');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(lifecycleOf(f), 'following_up');
  assert.deepEqual((await store.listActionItems(h.db.pool, f.id)).map((a) => [a.number, a.status]), [[1, 'confirmed'], [2, 'proposed']]);
  const protocol = await buildProtocol(h.db.pool, f);
  assert.match(protocol, /Action items:\n- #1 Book the venue \(Bert, due .*\): open/);
  assert.match(protocol, /Open points:\n- #2 Order drinks: proposed for Cara, not accepted/);
  const dms = h.kernel.dms.length;
  await h.restart();
  h.clock.advance(5 * DAY_MS);
  await h.tick();
  const reminded = h.kernel.dms.slice(dms).filter((d) => d.text.includes('action item #'));
  assert.ok(reminded.some((d) => d.principal === 'user:bert'), 'the accepted item is reminded');
  assert.ok(!reminded.some((d) => d.principal === 'user:cara'), 'the unaccepted nomination is not');
});
