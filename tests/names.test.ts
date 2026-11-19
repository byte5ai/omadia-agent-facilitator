// People are named by their name, never by an id (first live run, item 1).
//
// The first real facilitation ran in a meeting chat whose member list the
// channel could not give: the handshake printed "Teilnehmende:" with nothing
// after it and named the initiator as `user:<guid>`.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { guardOutgoing } from '../src/engine/guard.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';
import type { FakeUser } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

const MARCEL: FakeUser = { id: '328D16DE-4575-437b-94d2-1086a4904fd7', displayName: 'Marcel Wege' };
const TESS: FakeUser = { id: '9f0c2a11-0b7e-4c1d-8a55-6d2e7b0a4c90', displayName: 'Teresita Biel' };
const PRINCIPAL = /user:[0-9a-f]{8}-|328d16de|9f0c2a11/i;
/** Without a member list a vote needs a deadline (D15). */
const vote = (): Record<string, unknown> => ({ goal: 'Den Namen wählen', language: 'de', method: 'single', options: ['Alpha', 'Bravo'], deadline: new Date(h.clock.now().getTime() + 3 * 60 * 60 * 1000).toISOString(), open: true });

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const everything = (conv: string): string[] => [...posts(conv), ...h.kernel.dms.map((d) => d.text)];
async function say(conv: string, who: FakeUser, text: string): Promise<void> {
  await h.kernel.say(conv, who.id, text);
  await h.settle();
}

test('guard: a principal id is never sent', () => {
  const verdict = guardOutgoing('Gestartet von: user:328d16de-4575-437b-94d2-1086a4904fd7');
  assert.equal(verdict.ok ? 'ok' : verdict.reason, 'principal_id');
  assert.equal(guardOutgoing('Der User: Marcel hat abgestimmt.').ok, true);
});

test('without a member list the handshake says so and names nobody by an id', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('nm-no-roster', [MARCEL, TESS], { noRoster: true });
  await h.tool('facilitation_start', vote(), { conversation: conv, caller: MARCEL.id });
  const handshake = posts(conv)[0] ?? '';
  assert.doesNotMatch(handshake, PRINCIPAL);
  assert.doesNotMatch(handshake, /Teilnehmende:\s*(\n|$)/, 'an empty list is not printed as an empty line');
  assert.match(handshake, /Teilnehmende: Die Mitgliederliste dieser Unterhaltung konnte ich nicht abrufen\. Wer hier schreibt, nimmt teil\./);
  assert.match(handshake, /Gestartet von: der Person, die mich gerade darum gebeten hat/);

  // Whoever writes is known by the name on their message from then on.
  await say(conv, MARCEL, 'A');
  await say(conv, TESS, 'A');
  // Without a member list the vote is evaluated at its deadline.
  h.clock.advance(4 * 60 * 60 * 1000);
  await h.tick();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.equal(f.initiatorParticipant, `user:${MARCEL.id.toLowerCase()}`);
  for (const text of everything(conv)) assert.doesNotMatch(text, PRINCIPAL);
  const protocol = await buildProtocol(h.db.pool, f);
  assert.match(protocol, /Gestartet von: Marcel Wege/);
  assert.doesNotMatch(protocol, PRINCIPAL);
});

test('a kernel that states the caller by name: the initiator is named and takes part from the start', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('nm-caller-name', [MARCEL, TESS], { noRoster: true });
  h.kernel.statesCallerName = true;
  try {
    await h.tool('facilitation_start', vote(), { conversation: conv, caller: MARCEL.id });
  } finally {
    h.kernel.statesCallerName = false;
  }
  const handshake = posts(conv)[0] ?? '';
  assert.match(handshake, /Gestartet von: Marcel Wege/);
  assert.match(handshake, /Teilnehmende: Marcel Wege \(die Mitgliederliste konnte ich nicht vollständig abrufen; wer hier schreibt, nimmt teil\)/);
  assert.match(handshake, /danach mit dem Protokoll an Marcel Wege\. Marcel Wege erhält nichts/);
});

test('a member the channel lists without a name is not shown as an id, and gets the name of their first message', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('nm-unnamed', [MARCEL, { id: TESS.id, displayName: undefined as unknown as string }]);
  await h.tool('facilitation_start', vote(), { conversation: conv, caller: MARCEL.id });
  assert.doesNotMatch(posts(conv)[0] ?? '', PRINCIPAL);
  h.kernel.conversation(conv, [MARCEL, TESS]);
  await say(conv, TESS, 'B');
  const f = await h.facilitation(conv);
  assert.equal((await store.getParticipant(h.db.pool, f.id, `user:${TESS.id}`))?.displayName, 'Teresita Biel');
  assert.ok(posts(conv).some((p) => p.includes('Teresita Biel')));
});

test('a text that carries the id of a participant goes out with the name instead', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('nm-turn', [MARCEL, TESS]);
  await h.tool('facilitation_start', { goal: 'Reden', language: 'de', open: true }, { conversation: conv, caller: MARCEL.id });
  h.kernel.onTurn = () => `Danke, user:${TESS.id}, das ist notiert. Und user:00000000-1111-2222-3333-444444444444 kenne ich nicht.`;
  try {
    await say(conv, TESS, 'Ich finde das gut');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  assert.equal(posts(conv).at(-1), 'Danke, Teresita Biel, das ist notiert. Und jemand aus dieser Runde kenne ich nicht.');
});
