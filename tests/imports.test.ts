// Imported contributions belong to the person they were imported for: the
// importer's own message, edited or recorded again, never takes them away.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const tool = (conv: string, name: string, args: Record<string, unknown>, caller = 'bert'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
async function say(conv: string, who: string, text: string, replyTo?: string) {
  const record = await h.kernel.say(conv, who, text, replyTo ? { replyTo } : {});
  await h.settle();
  return record;
}
const byStatus = async (conv: string, who: string) => {
  const f = await h.facilitation(conv);
  return (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === `user:${who}`).map((c) => [c.status, c.payload['summary']]);
};

test('an import survives an edit of the message it came in; the importer\'s own contribution in that message is recorded too', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('im-edit', [ANNA, BERT, CARA]);
  await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] });
  const brought = await say(conv, 'bert', 'Last week Anna said Garden; I am still unsure myself');
  assert.match(await tool(conv, 'facilitation_record_import', { messageId: brought.messageId, person: 'Anna', origin: 'last week\'s chat', summary: 'Garden', ballot: 'B' }), /^Recorded for Anna as imported/);
  // Bert's own reading of the same message is not "already recorded".
  assert.match(await tool(conv, 'facilitation_record_contribution', { messageId: brought.messageId, kind: 'position', summary: 'still unsure' }), /^Recorded for Bert as unconfirmed/);
  const asked = h.kernel.groupPosts(conv).find((p) => p.text.startsWith('Anna, Bert recorded this for you'));
  await say(conv, 'anna', 'yes', asked?.messageId);
  assert.deepEqual(await byStatus(conv, 'anna'), [['valid', 'Garden']]);
  // Bert fixes a typo in his message: Anna's confirmed vote stays.
  await h.kernel.edit(conv, 'bert', brought.messageId, 'Last week Anna said Garden; I am still undecided myself');
  await h.settle();
  assert.deepEqual(await byStatus(conv, 'anna'), [['valid', 'Garden']]);
  assert.deepEqual((await byStatus(conv, 'bert')).map(([status]) => status), ['superseded'], 'only Bert\'s own reading of the old revision is retired');
});
