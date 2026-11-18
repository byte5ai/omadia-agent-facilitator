import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, DAVE, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('start creates a configuring facilitation with the roster; open posts the handshake as the facilitator', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-start', FOUR);
  const answer = await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', deadline: '2026-11-21T09:00:00Z', facilitatorName: 'Mira' }, { conversation: conv, caller: 'bert' });
  assert.match(answer, /^Facilitation created, phase: configuring/);
  assert.match(answer, /Participants: Anna, Bert, Cara, Dave/);
  let f = await h.facilitation(conv);
  assert.equal(f.phase, 'configuring');
  assert.equal(f.initiatorPrincipal, 'user:bert', 'the initiator is the kernel-stated caller');
  assert.equal(f.initiatorParticipant, 'user:bert');
  assert.equal(h.kernel.groupPosts(conv).length, 0, 'nothing is posted before the group agreed');

  assert.match(await h.tool('facilitation_open', {}, { conversation: conv }), /^Opened/);
  f = await h.facilitation(conv);
  assert.equal(f.phase, 'active');
  const posts = h.kernel.groupPosts(conv);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.as, 'mira');
  for (const part of ['I am Mira', 'Started by: Bert', 'Goal: Pick a venue', 'Done when: A venue is chosen', 'Anna, Bert, Cara, Dave', 'Deadline:', '"status"', '"stop"']) {
    assert.ok(posts[0]?.text.includes(part), `handshake lacks: ${part}`);
  }
  assert.match(await h.tool('facilitation_start', { goal: 'x', definitionOfDone: 'y' }, { conversation: conv }), /^Refused \(already_active\)/);
});

test('no own identity: the facilitator does not start and says so; nothing is created', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-noid', FOUR);
  h.kernel.noIdentity.add('ghost');
  const answer = await h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { agent: 'ghost', conversation: conv });
  assert.match(answer, /^Refused \(no_identity\)/);
  assert.match(answer, /Nothing was started/);
  await assert.rejects(h.facilitation(conv), /no facilitation/);

  // Without a readiness service the subscription is the gate, with the same answer.
  h.kernel.absent.add('readiness');
  const again = await h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { agent: 'ghost', conversation: conv });
  h.kernel.absent.delete('readiness');
  assert.match(again, /never speaks through another bot/);
  assert.equal(h.kernel.posts.filter((p) => p.as === 'ghost').length, 0, 'no default-bot fallback');
});

test('readiness: missing consent is named exactly and nothing starts', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-consent', FOUR);
  h.kernel.notReady.set(`mira|${conv}`, [{ code: 'consent_missing', message: 'RSC ChatMessage.Read.Chat is not consented in this chat' }]);
  const answer = await h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { conversation: conv });
  assert.match(answer, /^Refused \(not_ready\)/);
  assert.match(answer, /consent_missing: RSC ChatMessage\.Read\.Chat is not consented in this chat/);
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false);
});

test('a tool call without kernel context is refused; there is no "latest facilitation" fallback', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-ctx', FOUR);
  await startActive(h, conv);
  const { buildTools } = await import('../src/tools/index.js');
  const status = buildTools(h.engine).find((t) => t.spec.name === 'facilitation_status');
  assert.match((await status?.handler({})) ?? '', /never guesses a facilitation/);
  assert.match((await status?.handler({ conversationId: conv }, { agentSlug: 'mira', channelType: 'teams' })) ?? '', /never guesses/, 'a conversation id as a tool argument is ignored');
  const other = h.kernel.conversation('lc-ctx-other', FOUR);
  assert.match(await h.tool('facilitation_status', {}, { conversation: other }), /^Refused \(no_facilitation\)/);
});

test('"status" and "stop" from the group work without mentioning the facilitator and without a model', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-cmd', FOUR);
  await startActive(h, conv);
  const turnsBefore = h.kernel.turns.length;
  await h.kernel.say(conv, 'cara', 'Status?');
  await h.settle();
  const status = h.kernel.groupPosts(conv).at(-1)?.text ?? '';
  assert.match(status, /Status: running/);
  assert.match(status, /Still open: Anna, Bert, Cara, Dave/);

  await h.kernel.say(conv, 'dave', 'stop');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'aborted');
  assert.equal(f.closeReason, 'stopped by Dave');
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /Dave asked to stop/);
  assert.equal(h.kernel.turns.length, turnsBefore, 'no model turn for commands');
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false, 'the conversation is released');
  assert.ok(f.purgeAfter, 'retention is scheduled');

  await h.kernel.say(conv, 'anna', 'hello again');
  await h.settle();
  assert.equal(h.kernel.turns.length, turnsBefore, 'nothing is processed after the end');
});

test('free text goes to the facilitator turn with the state of this facilitation; its answer is posted, [silent] is not', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-turn', FOUR);
  await startActive(h, conv);
  h.kernel.onTurn = () => 'What matters most to you about the venue?';
  const said = await h.kernel.say(conv, 'anna', 'I am not sure where to begin');
  await h.settle();
  const turn = h.kernel.turns.at(-1);
  assert.equal(turn?.agentSlug, 'mira');
  assert.equal(turn?.inboundEventId, said.eventId);
  assert.equal(turn?.sessionKey, `facilitation:${(await h.facilitation(conv)).id}`);
  assert.match(turn?.input ?? '', new RegExp(`From: Anna \\(message id: ${said.messageId}\\)`));
  assert.match(turn?.engineContext ?? '', /Goal: Pick a venue/);
  assert.match(turn?.engineContext ?? '', /Not yet: Anna, Bert, Cara, Dave/);
  assert.equal(h.kernel.groupPosts(conv).at(-1)?.text, 'What matters most to you about the venue?');

  const count = h.kernel.groupPosts(conv).length;
  h.kernel.onTurn = () => '[silent]';
  await h.kernel.say(conv, 'bert', 'ok');
  await h.settle();
  assert.equal(h.kernel.groupPosts(conv).length, count);

  h.kernel.onTurn = () => ({ outcome: 'failed', message: 'model overloaded' });
  await h.kernel.say(conv, 'bert', 'and now?');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'active', 'a failed turn does not end the facilitation');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['turn_failed'])).length, 1);
  h.kernel.onTurn = () => '[silent]';
});

test('an event is processed once, and a restart replays what arrived while the engine was down', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-replay', FOUR);
  const f = await startActive(h, conv);
  const first = await h.kernel.say(conv, 'anna', 'first');
  await h.settle();
  const turns = h.kernel.turns.length;
  await h.engine.receive('mira', first);
  await h.settle();
  assert.equal(h.kernel.turns.length, turns, 'a redelivered event is not processed twice');

  await h.engine.stop();
  const missed = await h.kernel.say(conv, 'bert', 'written while the middleware was down');
  assert.equal(h.kernel.turns.length, turns);
  await h.restart();
  assert.equal(h.kernel.turns.length, turns + 1, 'replayed from the cursor');
  assert.equal(h.kernel.turns.at(-1)?.inboundEventId, missed.eventId);
  assert.equal((await h.facilitation(conv)).inboundCursor, missed.eventId);
  assert.equal((await h.facilitation(conv)).id, f.id);

  await h.restart();
  assert.equal(h.kernel.turns.length, turns + 1, 'a second restart replays nothing');
});

test('membership: joining is welcomed and counted, leaving keeps contributions, an initiator who leaves loses the role', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-members', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv);
  h.kernel.join(conv, DAVE);
  await h.settle();
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /Welcome, Dave/);
  let people = await store.listParticipants(h.db.pool, f.id);
  assert.deepEqual(people.find((p) => p.principalId === 'user:dave')?.source, 'joined');
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Still open: Anna, Bert, Cara, Dave/);

  h.kernel.leave(conv, 'cara');
  await h.settle();
  people = await store.listParticipants(h.db.pool, f.id);
  assert.equal(people.find((p) => p.principalId === 'user:cara')?.status, 'left');
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Still open: Anna, Bert, Dave$/m);

  h.kernel.leave(conv, 'anna');
  await h.settle();
  const texts = h.kernel.groupPosts(conv).map((p) => p.text);
  assert.ok(texts.some((t) => /Anna started this facilitation and has left/.test(t)));
  assert.equal((await store.listEvents(h.db.pool, f.id, ['initiator_left'])).length, 1);
});

test('an unlisted roster is said out loud and whoever writes joins', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lc-partial', [ANNA], { partialRoster: true });
  const answer = await h.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { conversation: conv });
  assert.match(answer, /Tell the group: The channel could not list every member/);
  await h.tool('facilitation_open', {}, { conversation: conv });
  h.kernel.conversation(conv, [ANNA, BERT], { partialRoster: true });
  await h.kernel.say(conv, 'bert', 'hi, I am here too');
  await h.settle();
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listParticipants(h.db.pool, f.id)).map((p) => p.principalId).sort(), ['user:anna', 'user:bert']);
});
