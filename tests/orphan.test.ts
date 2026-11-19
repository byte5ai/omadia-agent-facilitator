// A facilitation the kernel no longer lets read its conversation. Nothing
// tells the engine; it has to notice, and it must never leave the
// facilitation active without being able to read.
//
//   the reservation was taken away   reading went down to what is addressed
//                                    to the facilitator: taken again
//   the subscription was ended       a process subscribes a conversation
//                                    once: it does not come back, and the
//                                    facilitation ends
//   the agent's service was ended    its scopes are gone too: nothing of it
//                                    is authorized any more

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import { operatorTerminate } from '../src/engine/governance.js';
import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };

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
  h.kernel.takeReservation(conv);
  assert.equal(h.kernel.modeOf(f.id, conv), 'addressed');
  await h.kernel.say(conv, 'bert', 'B'); // nobody hears it

  await h.tick();
  assert.equal(h.kernel.modeOf(f.id, conv), 'all', 'everything is read again');
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

test('K6.4: turning the subscription back up to every message can be refused as not ready; it is on record, retried, and never taken as read', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-not-ready', FOUR);
  const f = await startActive(h, conv, VOTE);
  const told = (): number => h.kernel.groupPosts(conv).filter((p) => /continues/.test(p.text)).length;
  const refusals = async (): Promise<string[]> =>
    (await h.db.pool.query<{ payload: { reason: string } }>(`SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = 'subscription_refused'`, [f.id])).rows.map((r) => r.payload.reason);
  h.kernel.takeReservation(conv);
  h.kernel.subscribeRefusals.set('mira', { code: 'not_ready', message: 'the channel cannot deliver every message here' });
  try {
    await h.tick();
    assert.equal(h.kernel.modeOf(f.id, conv), 'addressed', 'the subscription keeps its mode');
    assert.deepEqual(await refusals(), ['not_ready: the channel cannot deliver every message here']);
    assert.equal(told(), 0, 'nothing says that it continues');
    assert.equal((await h.facilitation(conv)).settings.subscriptionLost ?? false, false);
    assert.ok((await h.facilitation(conv)).settings.refusedSince, 'the gap is on record');
    assert.ok(h.logs.some((l) => l.includes('the kernel refuses its subscription (not_ready: ')));
    await h.tick();
    assert.equal((await refusals()).length, 1, 'recorded once, asked again on every pass');
    assert.equal((await h.facilitation(conv)).phase, 'active', 'a refusal may pass');
  } finally {
    h.kernel.subscribeRefusals.delete('mira');
  }
  await h.tick();
  assert.equal(h.kernel.modeOf(f.id, conv), 'all');
  assert.equal(told(), 1, 'said once it really reads everything again');
  assert.equal((await h.facilitation(conv)).settings.refusedSince, undefined);
});

test('K6.4: a channel that stays not ready ends the facilitation with that reason, never left active on what is addressed', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-not-ready-stays', FOUR);
  const f = await startActive(h, conv, VOTE);
  h.kernel.takeReservation(conv);
  h.kernel.subscribeRefusals.set('mira', { code: 'not_ready', message: 'the channel cannot deliver every message here' });
  try {
    await h.tick();
    h.clock.advance(5 * MINUTE_MS);
    await h.tick();
  } finally {
    h.kernel.subscribeRefusals.delete('mira');
  }
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  const events = await h.db.pool.query<{ payload: { subscription?: string } }>(`SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = 'aborted'`, [f.id]);
  assert.match(events.rows[0]?.payload.subscription ?? '', /^not_ready: /);
  assert.equal(h.kernel.groupPosts(conv).filter((p) => /ends without a result/.test(p.text)).length, 1, 'the group reads that it ended');
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
  {
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
    assert.match(events.rows[0]?.payload.subscription ?? '', /^ended: /);
    // Posting is authorized by the scope, not by the subscription: the group
    // reads why it ended.
    assert.equal(h.kernel.groupPosts(conv).filter((p) => /ends without a result/.test(p.text)).length, 1);
    const pending = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status IN ('pending', 'sending')`, [f.id]);
    assert.equal(pending.rows.length, 0, 'nothing waits');
  }
});

test('tools never answer created or opened for a facilitation the engine cannot read', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-tools', FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VOTE }, { conversation: conv });
  h.kernel.endSubscription('mira', conv);
  {
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

test("what a facilitation of an agent out of service still had to say is given up at once, and does not arrive under a later facilitation", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-stale', FOUR);
  const orphan = await startActive(h, conv, VOTE);
  // The agent is disabled: the kernel ends its scopes, and with them its
  // subscriptions. The operator ends the facilitation before the engine
  // noticed anything.
  h.kernel.disabled.add('mira');
  h.kernel.endService('mira');
  await operatorTerminate(h.engine.core, orphan.id, 'op@example.com', 'cleaning up');
  await h.settle();
  assert.equal(h.kernel.groupPosts(conv).filter((p) => /ends without a result/.test(p.text)).length, 0, 'it could not be posted');
  const rows = await h.db.pool.query<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'abort'`, [orphan.id]);
  assert.deepEqual(rows.rows.map((r) => [r.status, r.attempts]), [['failed', 1]], 'not tried twenty times: the refusal does not pass on its own');
  assert.match(rows.rows[0]?.last_error ?? '', /^not_authorized:not_permitted: /);
  const refused = await h.db.pool.query<{ payload: { code: string } }>(`SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = 'execution_refused'`, [orphan.id]);
  assert.ok(refused.rows.some((r) => r.payload.code === 'not_permitted'), 'the refusal is on record');
  const reportsThen = h.kernel.dms.filter((d) => /cleaning up/.test(d.text)).length;

  // The agent is back in service; a new facilitation starts in the conversation.
  h.kernel.disabled.delete('mira');
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

test('S1: a gap that is found when the engine comes up is announced like one found on a pass, also without any message since the last gap', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('or-activate', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  const told = (): number => h.kernel.groupPosts(conv).filter((p) => /continues/.test(p.text)).length;
  // First gap, found on a pass.
  h.kernel.takeReservation(conv);
  await h.tick();
  assert.equal(told(), 1);
  // Second gap with nothing written in between, found at activation.
  h.kernel.takeReservation(conv);
  await h.restart();
  assert.equal(h.kernel.modeOf(f.id, conv), 'all');
  assert.equal(told(), 2, 'announced whichever path noticed it');
  await h.restart();
  await h.tick();
  assert.equal(told(), 2, 'and only once per gap');
});
