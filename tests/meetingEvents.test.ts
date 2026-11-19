// D26 (live, 1.0.5): the engine did nothing with a meeting that started in a
// moderated chat unless a session had been scheduled through it. And the
// session rows of ended facilitations stayed "running".

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { currentSession } from '../src/engine/sessions.js';
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
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const sessionsOf = async (conv: string) => store.listSessions(h.db.pool, (await h.facilitation(conv)).id);
const TALK = { goal: 'Plan the quarter', agenda: [{ kind: 'discuss', title: 'Talk' }, { kind: 'decide', title: 'Pick', method: 'single', options: ['Alpha', 'Bravo'] }], open: true };

test('a meeting that starts in a moderated chat opens a session with a fresh snapshot, without having been scheduled', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('me-start', [ANNA, BERT]);
  h.kernel.capabilities(conv, ['text'], ['text']);
  await tool(conv, 'facilitation_start', TALK);
  assert.deepEqual((await sessionsOf(conv)).map((s) => [s.kind, s.status]), [['async', 'running']]);

  // The meeting offers more than the chat did.
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls'], { sessionRef: 'meeting-7', modality: 'online' });
  await h.kernel.sessionEvent('mira', conv, 'meeting-7', 'session_started');
  await h.settle();
  const live = (await sessionsOf(conv)).find((s) => s.kind === 'live');
  assert.equal(live?.status, 'running');
  assert.equal(live?.meetingRef, 'meeting-7');
  assert.equal(live?.modality, 'online');
  assert.deepEqual((live?.capabilitySnapshot as { inputs: string[] }).inputs, ['text', 'card_answers']);
  assert.match(posts(conv).at(-1) ?? '', /^A meeting is running in this conversation now\.\nWhat I perceive here: I read the chat, the polls\./);
  assert.ok(!posts(conv).some((p) => p.startsWith('Agenda for')), 'no agenda mail-out for a meeting nobody scheduled here');
  assert.equal((await currentSession(h.db.pool, (await h.facilitation(conv)).id))?.id, live?.id);

  // Redelivered: nothing more. Nobody joins (the channel sends no such events): nothing waits.
  const count = posts(conv).length;
  await h.kernel.sessionEvent('mira', conv, 'meeting-7', 'session_started');
  await h.settle();
  assert.equal(posts(conv).length, count);
  assert.equal((await sessionsOf(conv)).filter((s) => s.kind === 'live').length, 1);

  // A vote opened while the meeting runs uses what the meeting offers.
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.equal(h.kernel.groupPosts(conv).filter((p) => p.poll !== undefined).length, 1, 'a poll, not text only');

  // The meeting ends: the session closes and the chat's capabilities are read again.
  h.kernel.capabilities(conv, ['text', 'message_edits'], ['text']);
  await h.kernel.sessionEvent('mira', conv, 'meeting-7', 'session_ended');
  await h.settle();
  const after = await sessionsOf(conv);
  assert.deepEqual(after.map((s) => [s.kind, s.status]).sort(), [['async', 'running'], ['live', 'ended']]);
  assert.ok(after.find((s) => s.kind === 'live')?.endedAt);
  assert.deepEqual((after.find((s) => s.kind === 'async')?.capabilitySnapshot as { inputs: string[] }).inputs, ['text', 'message_edits']);
});

test('with question cards a vote in a running meeting is a card', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('me-card', [ANNA, BERT]);
  h.kernel.cardSupport = { kinds: ['single_choice', 'ranking', 'text'], maxQuestions: 5, update: true };
  try {
    await tool(conv, 'facilitation_start', TALK);
    await h.kernel.sessionEvent('mira', conv, 'meeting-8', 'session_started');
    await h.settle();
    await tool(conv, 'facilitation_step', { action: 'close' });
    await tool(conv, 'facilitation_step', { action: 'close' });
    assert.equal(h.kernel.cards(conv).length, 1);
    assert.equal(h.kernel.cards(conv)[0]?.card.questions[0]?.kind, 'single_choice');
  } finally {
    h.kernel.cardSupport = undefined;
  }
});

test('no session stays open when its facilitation has ended', { skip: PG_SKIP }, async () => {
  const closed = h.kernel.conversation('me-closed', [ANNA, BERT]);
  await tool(closed, 'facilitation_start', { goal: 'Pick', method: 'single', options: ['Alpha', 'Bravo'], open: true });
  await h.kernel.sessionEvent('mira', closed, 'meeting-9', 'session_started');
  await h.settle();
  await tool(closed, 'facilitation_session', { action: 'schedule', title: 'Later call', start: new Date(h.clock.now().getTime() + 3 * 3600_000).toISOString(), modality: 'online' });
  for (const who of ['anna', 'bert']) await say(closed, who, 'A');
  assert.equal((await h.facilitation(closed)).phase, 'closed');
  const rows = await sessionsOf(closed);
  assert.deepEqual(rows.map((s) => [s.kind, s.status]).sort(), [['async', 'ended'], ['live', 'cancelled'], ['live', 'ended']]);
  assert.ok(rows.filter((s) => s.status === 'ended').every((s) => s.endedAt !== null));

  const aborted = h.kernel.conversation('me-aborted', [ANNA, BERT]);
  await tool(aborted, 'facilitation_start', { goal: 'Pick', method: 'single', options: ['Alpha', 'Bravo'], open: true });
  await say(aborted, 'anna', 'stop');
  assert.deepEqual((await sessionsOf(aborted)).map((s) => [s.kind, s.status]), [['async', 'ended']]);

  // A meeting event for a conversation whose facilitation is over changes nothing.
  await h.kernel.sessionEvent('mira', aborted, 'meeting-10', 'session_started');
  await h.settle();
  assert.equal((await sessionsOf(aborted)).length, 1);
});
