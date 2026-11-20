// The roster is read as the facilitator, and the initiator is named from the
// tool call (kernel with plugin-api 1.57.0). Both are optional: an older
// kernel ignores the agent and states no name, and the 1.0.2 fallbacks hold.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createHarness } from './harness.js';
import type { Harness } from './harness.js';
import type { FakeUser } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

const MARCEL: FakeUser = { id: '328d16de-4575-437b-94d2-1086a4904fd7', displayName: 'Marcel Wege' };
const TESS: FakeUser = { id: '9f0c2a11-0b7e-4c1d-8a55-6d2e7b0a4c90', displayName: 'Teresita Biel' };
const VOTE = { goal: 'Den Namen wählen', language: 'de', method: 'single', options: ['Alpha', 'Bravo'], deadline: '2026-11-18T12:00:00+00:00', open: true };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

/** A meeting chat only the facilitator's own bot is in. */
function meetingChat(id: string): string {
  const conv = h.kernel.conversation(id, [MARCEL, TESS]);
  h.kernel.ownBotOnly.add(conv);
  return conv;
}
async function handshakeOf(conv: string, kernel: { rosterAsAgent: boolean; statesCallerName: boolean }, agent = 'mira'): Promise<string> {
  Object.assign(h.kernel, kernel);
  try {
    await h.tool('facilitation_start', VOTE, { conversation: conv, caller: MARCEL.id, agent });
  } finally {
    Object.assign(h.kernel, { rosterAsAgent: false, statesCallerName: false });
  }
  return h.kernel.groupPosts(conv)[0]?.text ?? '';
}

test('the roster is asked for as the facilitator of the facilitation', { skip: PG_SKIP }, async () => {
  const conv = meetingChat('rf-asks');
  await handshakeOf(conv, { rosterAsAgent: true, statesCallerName: false });
  assert.deepEqual(h.kernel.rosterAsks.filter((a) => a.conversationId === conv), [{ conversationId: conv, agentSlug: 'mira', fresh: true }]);
});

test('new kernel: the members are listed through the own bot and the initiator is named', { skip: PG_SKIP }, async () => {
  const conv = meetingChat('rf-new');
  const handshake = await handshakeOf(conv, { rosterAsAgent: true, statesCallerName: true });
  assert.match(handshake, /Gestartet von: Marcel Wege\n/);
  assert.match(handshake, /Teilnehmende: Marcel Wege, Teresita Biel\n/);
  assert.equal((await h.facilitation(conv)).settings.openRoster, undefined);
});

test('roster as the facilitator, no caller name: the initiator is named from the roster', { skip: PG_SKIP }, async () => {
  const handshake = await handshakeOf(meetingChat('rf-roster-only'), { rosterAsAgent: true, statesCallerName: false });
  assert.match(handshake, /Gestartet von: Marcel Wege\n/);
  assert.match(handshake, /Teilnehmende: Marcel Wege, Teresita Biel\n/);
});

test('caller name, no roster as the facilitator: the initiator is named and the member list is said to be unavailable', { skip: PG_SKIP }, async () => {
  const handshake = await handshakeOf(meetingChat('rf-name-only'), { rosterAsAgent: false, statesCallerName: true });
  assert.match(handshake, /Gestartet von: Marcel Wege\n/);
  assert.match(handshake, /Teilnehmende: Marcel Wege \(die Mitgliederliste konnte ich nicht vollständig abrufen; wer hier schreibt, nimmt teil\)/);
});

test('older kernel: neither is there and the 1.0.2 wording holds', { skip: PG_SKIP }, async () => {
  const conv = meetingChat('rf-old');
  const handshake = await handshakeOf(conv, { rosterAsAgent: false, statesCallerName: false });
  assert.match(handshake, /Gestartet von: der Person, die mich gerade darum gebeten hat/);
  assert.match(handshake, /Teilnehmende: Die Mitgliederliste dieser Unterhaltung konnte ich nicht abrufen\. Wer hier schreibt, nimmt teil\./);
  assert.doesNotMatch(handshake, /user:|328d16de/);
  assert.equal((await h.facilitation(conv)).settings.openRoster, true);
});
