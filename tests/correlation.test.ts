// One process per message (spec 5.3; #2061 criterion 29): with two
// facilitations in follow-up and a new one active in the same conversation,
// an unreferenced "stop" and an unreferenced "erledigt" each get exactly one
// question and change nothing; a reply to one follow-up's message closes
// exactly that one's item.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import type { Facilitation } from '../src/model.js';
import { ANNA, BERT, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ config: { maxActivePerFacilitator: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string, replyTo?: string): Promise<void> {
  await h.kernel.say(conv, who, text, replyTo ? { replyTo } : {});
  await h.settle();
}
const inDays = (days: number): string => new Date(h.clock.now().getTime() + days * 24 * 3_600_000).toISOString();

/** A facilitation that closed with one action item of Anna's, in follow-up. */
async function inFollowup(conv: string, goal: string): Promise<Facilitation> {
  await tool(conv, 'facilitation_start', { goal, definitionOfDone: 'Owners agreed', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await tool(conv, 'facilitation_record_action_item', { description: `${goal}: the task`, owner: 'Anna', dueDate: inDays(5) });
  await say(conv, 'anna', 'yes');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  for (const who of ['anna', 'bert']) await say(conv, who, 'agreed');
  await passWindow(h, conv);
  const f = await h.facilitation(conv);
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

const states = async (ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => {
    const f = await store.getFacilitation(h.db.pool, id);
    const items = await store.listActionItems(h.db.pool, id);
    return [f?.phase, f?.followupState, items.map((a) => a.status)];
  }));

test('criterion 29: two follow-ups and an active facilitation; an unreferenced "stop" and "erledigt" get one question each and change nothing; a reply decides', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cr-three', [ANNA, BERT]);
  const first = await inFollowup(conv, 'Offsite');
  const second = await inFollowup(conv, 'Budget');
  await tool(conv, 'facilitation_start', { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true });
  const live = await h.facilitation(conv);
  assert.equal(live.phase, 'active');
  const ids = [first.id, second.id, live.id];
  const before = await states(ids);
  const questions = (): number => h.kernel.groupPosts(conv).filter((p) => /several facilitations/i.test(p.text)).length;

  await say(conv, 'anna', 'stop');
  assert.equal(questions(), 1, 'exactly one question for "stop"');
  assert.deepEqual(await states(ids), before, 'nothing changed');

  await say(conv, 'anna', 'erledigt');
  assert.equal(questions(), 2, 'exactly one question for "erledigt"');
  assert.deepEqual(await states(ids), before, 'nothing changed');

  // A reply to a message of the first follow-up is about that one alone.
  const ofFirst = h.kernel.groupPosts(conv).filter((p) => p.processId === first.id).at(-1);
  assert.ok(ofFirst, 'the first facilitation posted in this conversation');
  await say(conv, 'anna', 'erledigt', ofFirst.messageId);
  const after = await states(ids);
  assert.deepEqual((after[0]?.[2] as string[]) ?? [], ['done'], "the first follow-up's item is done");
  assert.deepEqual(after[1], before[1], 'the second follow-up is unchanged');
  assert.equal(after[2]?.[0], 'active', 'the live facilitation is unchanged');
  assert.equal(questions(), 2, 'no further question');
});

test('in follow-up, "stop" as a reply to its message ends only that follow-up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('cr-stop-followup', [ANNA, BERT]);
  const first = await inFollowup(conv, 'Offsite');
  const second = await inFollowup(conv, 'Budget');
  const ofSecond = h.kernel.groupPosts(conv).filter((p) => p.processId === second.id).at(-1);
  assert.ok(ofSecond);
  await say(conv, 'anna', 'stop', ofSecond.messageId);
  const after = await states([first.id, second.id]);
  assert.deepEqual([after[0]?.[1], after[1]?.[1]], ['active', 'ended']);
});
