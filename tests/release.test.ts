// Releasing a conversation and starting again in it (review finding 3).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Thai', 'Pizza'] };
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
const subscribed = (conv: string): boolean => h.kernel.subscriptions.has(`mira|teams|${conv}`);

test('review 3: after a normal close the conversation is released at once, not on some later delivery', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-close', [ANNA, BERT]);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  assert.equal(subscribed(conv), true);
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(subscribed(conv), false);
});

test('review 3: a new facilitation in a conversation that is still being read does not replay the earlier chat', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-again', [ANNA, BERT]);
  // The first facilitation closes with action items in follow-up: the subscription stays.
  await h.tool('facilitation_start', { goal: 'First', definitionOfDone: 'd', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'decide', title: 'Vote', method: 'single', options: ['Thai', 'Pizza'] }] }, { conversation: conv });
  await h.tool('facilitation_open', {}, { conversation: conv });
  await h.tool('facilitation_record_action_item', { description: 'Book it', owner: 'Anna', dueDate: new Date(h.clock.now().getTime() + 5 * DAY_MS).toISOString() }, { conversation: conv });
  await say(conv, 'anna', 'yes');
  await h.tool('facilitation_step', { action: 'close' }, { conversation: conv });
  await h.tool('facilitation_step', { action: 'close' }, { conversation: conv });
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  const first = await h.facilitation(conv);
  assert.deepEqual([first.phase, first.followupState], ['closed', 'active']);
  assert.equal(subscribed(conv), true, 'kept for the follow-up');

  // A second facilitation in the same conversation, same options.
  const turns = h.kernel.turns.length;
  const second = await startActive(h, conv, VOTE);
  assert.notEqual(second.id, first.id);
  assert.ok((await h.facilitation(conv)).inboundCursor, 'the cursor starts at the head of what the kernel stored');
  await h.restart(); // catch-up after downtime replays from the cursor
  await h.tick();
  assert.deepEqual(await store.listContributions(h.db.pool, second.id), [], 'no vote of the earlier facilitation is counted');
  assert.equal(h.kernel.turns.length, turns, 'and none of its messages is given to the model again');
  assert.equal((await h.facilitation(conv)).phase, 'active');

  // A redelivered old message is dropped by every reading, also by "stop".
  const old = h.kernel.events.find((e) => e.conversationId === conv && e.text === 'yes');
  await h.engine.receive('mira', { ...(old as NonNullable<typeof old>), eventId: 'redelivered-1', text: 'stop' });
  await h.engine.receive('mira', { ...(old as NonNullable<typeof old>), eventId: 'redelivered-2', text: 'A' });
  await h.settle();
  assert.equal((await h.facilitation(conv)).phase, 'active');
  assert.deepEqual(await store.listContributions(h.db.pool, second.id), []);

  // Ending the second one does not take the first one's follow-up subscription away.
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'B');
  await say(conv, 'bert', 'A');
  assert.equal(subscribed(conv), true, 'the follow-up of the first facilitation still reads the conversation');
});

test('review 3: catch-up after downtime processes what arrived meanwhile, once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-downtime', [ANNA, BERT]);
  await startActive(h, conv, VOTE);
  await h.engine.stop();
  await h.kernel.say(conv, 'anna', 'A');
  await h.kernel.say(conv, 'bert', 'A');
  await h.restart();
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').length, 2);
  assert.equal(h.kernel.groupPosts(conv).filter((p) => p.text.startsWith('Result for')).length, 1);
});

test('review 8: a message that fails to process is retried and not skipped; the cursor waits for it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-retry', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  let failures = 0;
  h.hooks.beforeInbound = (record) => {
    if (record.text === 'A' && failures < 2) {
      failures += 1;
      throw new Error('database hiccup');
    }
  };
  try {
    const lost = await say(conv, 'anna', 'A'); // fails
    const fine = await say(conv, 'bert', 'B'); // succeeds
    assert.equal((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').length, 1);
    assert.notEqual((await h.facilitation(conv)).inboundCursor, fine.eventId, 'the cursor does not jump over the failed message');
    await h.tick(); // second failure
    await h.tick(); // third attempt succeeds
    const votes = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
    assert.deepEqual(votes.map((c) => c.participantPrincipal).sort(), ['user:anna', 'user:bert'], "Anna's vote was not lost");
    assert.equal(votes.find((c) => c.participantPrincipal === 'user:anna')?.sourceEventId, lost.eventId);
    await h.tick();
    assert.equal((await h.facilitation(conv)).inboundCursor, fine.eventId, 'once it is through, the cursor is at the head');
    assert.equal(h.kernel.groupPosts(conv).filter((p) => p.text.includes('could not be processed')).length, 0);
  } finally {
    delete h.hooks.beforeInbound;
  }
});

test('review 8: a message that keeps failing is given up after a bound, and the group is told once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-giveup', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  h.hooks.beforeInbound = (record) => {
    if (record.text === 'poison') throw new Error('cannot be processed');
  };
  try {
    await say(conv, 'anna', 'poison');
    for (let i = 0; i < 5; i += 1) await h.tick();
    const notices = h.kernel.groupPosts(conv).filter((p) => p.text.startsWith('One message here could not be processed'));
    assert.equal(notices.length, 1);
    const ledger = await h.db.pool.query<{ outcome: string; attempts: number }>('SELECT outcome, attempts FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 AND message_id IN (SELECT message_id FROM plg_omadia_agent_facilitator_inbound WHERE outcome = $2)', [f.id, 'gave_up']);
    assert.deepEqual(ledger.rows.map((r) => [r.outcome, r.attempts]), [['gave_up', 3]]);
    // Life goes on after it.
    await say(conv, 'anna', 'A');
    const done = await say(conv, 'bert', 'A');
    assert.equal((await h.facilitation(conv)).phase, 'closed');
    assert.equal((await h.facilitation(conv)).inboundCursor, done.eventId);
  } finally {
    delete h.hooks.beforeInbound;
  }
});
