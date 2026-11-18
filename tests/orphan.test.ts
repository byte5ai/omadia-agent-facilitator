// A facilitation whose subscription the kernel ended (grant revoked, engine
// reinstalled, agent disabled). Nothing tells the engine; it has to notice,
// and it must never leave the facilitation active without being able to read
// or post.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import { operatorTerminate } from '../src/engine/governance.js';
import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const REFUSAL = { code: 'unavailable' as const, message: "plugin is no longer the facilitation engine of this instance" };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const valid = async (facilitationId: string): Promise<number> =>
  (await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_contributions WHERE facilitation_id = $1 AND status = 'valid'`, [facilitationId])).rows.length;

test('a lost subscription is taken again on the next pass; the group is told once that it continues', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-restore', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  h.kernel.endSubscription('mira', conv);
  await h.kernel.say(conv, 'bert', 'B'); // nobody hears it

  await h.tick();
  assert.ok(h.kernel.subscriptions.has(`mira|teams|${conv}`), 'subscribed again');
  const told = (): number => h.kernel.groupPosts(conv).filter((p) => /continues/.test(p.text)).length;
  assert.equal(told(), 1);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await h.tick();
  await h.tick();
  assert.equal(told(), 1, 'said once, not on every pass');

  await h.kernel.say(conv, 'cara', 'A');
  await h.settle();
  assert.equal(await valid(f.id), 2, 'it records again');
});

test('a subscription that is still there is left alone: nothing is said', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-fine', FOUR);
  await startActive(h, conv, VOTE);
  await h.tick();
  await h.kernel.say(conv, 'anna', 'A');
  await h.tick();
  await h.restart();
  assert.equal(h.kernel.groupPosts(conv).filter((p) => /continues/.test(p.text)).length, 0);
});

test('when the kernel does not give the conversation back, the facilitation ends as aborted with the reason on record', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-refused', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  h.kernel.endSubscription('mira', conv);
  h.kernel.subscribeRefusals.set('mira', REFUSAL);
  try {
    await h.tick();
    // A refusal may pass (the facilitator is being rebuilt): not at once.
    assert.equal((await h.facilitation(conv)).phase, 'active');
    h.clock.advance(5 * MINUTE_MS);
    await h.tick();
    const ended = await h.facilitation(conv);
    assert.equal(ended.phase, 'aborted', 'never left active');
    const events = await h.db.pool.query<{ payload: { reason?: string; subscription?: string } }>(
      `SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = 'aborted'`,
      [f.id],
    );
    assert.match(events.rows[0]?.payload.subscription ?? '', /no longer the facilitation engine/);
    const pending = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status IN ('pending', 'sending')`, [f.id]);
    assert.equal(pending.rows.length, 0, 'nothing waits for a subscription that will not come');
  } finally {
    h.kernel.subscribeRefusals.delete('mira');
  }
});

test('tools never answer created or opened for a facilitation the engine cannot read', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-tools', FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VOTE }, { conversation: conv });
  h.kernel.endSubscription('mira', conv);
  h.kernel.subscribeRefusals.set('mira', REFUSAL);
  try {
    const before = h.kernel.groupPosts(conv).length;
    const started = await h.tool('facilitation_start', { goal: 'Pick a date', definitionOfDone: 'A date is chosen', ...VOTE }, { conversation: conv });
    assert.match(started, /^Refused \(no_subscription\)/);
    assert.doesNotMatch(started, /Facilitation created|Setup updated/);
    const opened = await h.tool('facilitation_open', {}, { conversation: conv });
    assert.match(opened, /^Refused \(no_subscription\)/);
    assert.doesNotMatch(opened, /Opened/);
    assert.equal((await h.facilitation(conv)).phase, 'configuring', 'nothing was opened');
    assert.equal((await h.facilitation(conv)).goal, 'Pick a venue', 'nothing was changed');
    assert.equal(h.kernel.groupPosts(conv).length, before);
  } finally {
    h.kernel.subscribeRefusals.delete('mira');
  }
});

test('facilitation_open does not say opened when its handshake could not be posted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-handshake', FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VOTE }, { conversation: conv });
  h.kernel.sendFaults.push({ code: 'channel_error', message: 'the channel is down' });
  const opened = await h.tool('facilitation_open', {}, { conversation: conv });
  assert.doesNotMatch(opened, /^Opened/);
  assert.match(opened, /NOT posted/);
  assert.match(opened, /channel_error/);
});

test("what an ended orphan still had to say is not delivered under a new facilitation's subscription", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-stale', FOUR);
  const orphan = await startActive(h, conv, VOTE);
  h.kernel.endSubscription('mira', conv);
  // The operator ends it before the engine noticed anything.
  await operatorTerminate(h.engine.core, orphan.id, 'op@example.com', 'cleaning up');
  await h.settle();
  assert.equal(h.kernel.groupPosts(conv).filter((p) => /ends without a result/.test(p.text)).length, 0, 'it could not be posted');
  const reportsThen = h.kernel.dms.filter((d) => /cleaning up/.test(d.text)).length;

  // A new facilitation in the same conversation subscribes.
  const next = await startActive(h, conv, { ...VOTE, goal: 'Pick a date' });
  assert.notEqual(next.id, orphan.id);
  h.clock.advance(3 * 60 * MINUTE_MS);
  await h.tick();
  await h.tick();
  assert.equal(h.kernel.groupPosts(conv).filter((p) => /ends without a result/.test(p.text)).length, 0, 'the stale abort report stays unsent');
  assert.equal(h.kernel.dms.filter((d) => /cleaning up/.test(d.text)).length, reportsThen, 'and nothing of it arrives privately later');
  const waiting = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status IN ('pending', 'sending')`, [orphan.id]);
  assert.equal(waiting.rows.length, 0);
});

test('an ended facilitation without a subscription gives its messages up after a few attempts', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-give-up', FOUR);
  const orphan = await startActive(h, conv, VOTE);
  h.kernel.endSubscription('mira', conv);
  await operatorTerminate(h.engine.core, orphan.id, 'op@example.com', 'cleaning up');
  for (let pass = 0; pass < 4; pass += 1) {
    h.clock.advance(30 * MINUTE_MS);
    await h.tick();
  }
  const rows = await h.db.pool.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'abort'`, [orphan.id]);
  assert.deepEqual(rows.rows, [{ status: 'failed', attempts: 3 }]);
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false, 'an ended facilitation does not subscribe again');
  assert.equal((await h.facilitation(conv)).settings.orphaned, true);
});

test('a provider that answers without a code or a message leaves a readable error, never "undefined"', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-malformed', FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VOTE }, { conversation: conv });
  h.kernel.sendFaults.push({} as never);
  const opened = await h.tool('facilitation_open', {}, { conversation: conv });
  const row = (await h.db.pool.query<{ last_error: string }>(`SELECT last_error FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'handshake'`, [(await h.facilitation(conv)).id])).rows[0];
  assert.doesNotMatch(row?.last_error ?? '', /undefined/);
  assert.match(row?.last_error ?? '', /^malformed_outcome: /);
  assert.doesNotMatch(opened, /undefined/);
  assert.ok(!h.logs.some((l) => l.includes('undefined: undefined')));
});
