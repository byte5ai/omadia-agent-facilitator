// Regression with real names (#2061): umlauts, two people with the same first
// name, ids the channel gives as GUIDs. Every post names the right people, no
// privacy placeholder, principal id or internal artifact reaches the chat.
// Imported votes (spec 5.3) count only after their person confirmed them;
// status and protocol show where they came from.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';
import type { FakeUser } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

const JUERGEN: FakeUser = { id: '1f0c2a9e-7b3d-4c51-9a8e-2d6f4b1c7e01', displayName: 'Jürgen Weiß', email: 'juergen@example.com' };
const ANNA_M: FakeUser = { id: '2a1d3b8f-6c4e-4d62-8b9f-3e7a5c2d8f02', displayName: 'Anna Müller', email: 'anna.mueller@example.com' };
const ANNA_S: FakeUser = { id: '3b2e4c7a-5d5f-4e73-9caf-4f8b6d3e9a03', displayName: 'Anna Schmidt', email: 'anna.schmidt@example.com' };
const BERT: FakeUser = { id: '4c3f5d6b-4e6a-4f84-8dba-5a9c7e4fab04', displayName: 'Bert Öztürk', email: 'bert@example.com' };
const PEOPLE = [JUERGEN, ANNA_M, ANNA_S, BERT];

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const tool = (conv: string, name: string, args: Record<string, unknown>, caller: FakeUser = JUERGEN): Promise<string> => h.tool(name, args, { conversation: conv, caller: caller.id });
async function say(conv: string, who: FakeUser, text: string) {
  const record = await h.kernel.say(conv, who.id, text);
  await h.settle();
  return record;
}
const valid = async (conv: string, who: FakeUser) => {
  const f = await h.facilitation(conv);
  return (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid' && c.participantPrincipal === `user:${who.id}`);
};

/** What must never reach a chat. */
const FORBIDDEN = [/\b(?:PLATZHALTER|PLACEHOLDER)-[A-Z0-9_]+-\d+\b/, /\buser:[0-9a-f]{8}-/i, /[{}]/, /\bfacilitation_[a-z_]+\b/, /\[\s*silent\s*\]/i];

test('real names: umlauts and a shared first name; an imported vote counts after its own person confirmed it, with its origin', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('rn-names', PEOPLE);
  await tool(conv, 'facilitation_start', { goal: 'Ort für das Teamessen', method: 'single', options: ['Hafen', 'Garten'], language: 'de', open: true });
  const handshake = h.kernel.groupPosts(conv)[0]?.text ?? '';
  for (const person of PEOPLE) assert.ok(handshake.includes(person.displayName), `the handshake names ${person.displayName}`);

  // Jürgen brings in older votes from a screenshot.
  const brought = await say(conv, JUERGEN, 'Hier die Stimmen aus dem Screenshot von letzter Woche');
  const ambiguous = await tool(conv, 'facilitation_record_import', { messageId: brought.messageId, person: 'Anna', origin: 'dem Screenshot', summary: 'Garten', ballot: 'B' });
  assert.match(ambiguous, /^Refused \(ambiguous_person\)/);
  assert.match(ambiguous, /Anna Müller or Anna Schmidt/);
  // Written without the umlaut, it still finds the one Anna Müller.
  assert.match(await tool(conv, 'facilitation_record_import', { messageId: brought.messageId, person: 'Anna Muller', origin: 'dem Screenshot', summary: 'Garten', ballot: 'B' }), /^Recorded for Anna Müller as imported/);
  assert.match(await tool(conv, 'facilitation_record_import', { messageId: brought.messageId, person: 'Bert', origin: 'dem Screenshot', summary: 'Hafen', ballot: 'A' }), /^Recorded for Bert Öztürk as imported/);
  const asked = h.kernel.groupPosts(conv).filter((p) => p.text.includes('aus dem Screenshot erfasst'));
  assert.deepEqual(asked.map((p) => p.mentions), [[{ user: `user:${ANNA_M.id}`, text: 'Anna Müller' }], [{ user: `user:${BERT.id}`, text: 'Bert Öztürk' }]]);
  assert.match(asked[0]?.text ?? '', /^Anna Müller, Jürgen Weiß hat das für dich aus dem Screenshot erfasst: Garten\./);

  // Nothing counts yet; the group status shows the imports with their origin, no names.
  assert.deepEqual(await valid(conv, ANNA_M), []);
  const status = await tool(conv, 'facilitation_status', {});
  assert.match(status, /Übernommen, wartet auf die eigene Bestätigung: Garten \(dem Screenshot\); Hafen \(dem Screenshot\)/);

  // The other Anna's "ja" confirms nothing of Anna Müller's.
  await say(conv, ANNA_S, 'ja');
  assert.deepEqual(await valid(conv, ANNA_M), []);
  // Anna Müller confirms in her own message; Bert says no.
  await h.kernel.say(conv, ANNA_M.id, 'ja', { replyTo: h.kernel.groupPosts(conv).find((p) => p.text.startsWith('Anna Müller, Jürgen'))?.messageId });
  await h.settle();
  assert.deepEqual((await valid(conv, ANNA_M)).map((c) => c.payload['summary']), ['Garten']);
  await h.kernel.say(conv, BERT.id, 'nein', { replyTo: h.kernel.groupPosts(conv).find((p) => p.text.startsWith('Bert Öztürk, Jürgen'))?.messageId });
  await h.settle();
  assert.deepEqual(await valid(conv, BERT), [], 'a declined import never counts');

  const protocol = await tool(conv, 'facilitation_protocol', {});
  assert.match(protocol, /Anna Müller: Garten \(von Jürgen Weiß aus dem Screenshot übernommen, bestätigt\)/);

  await say(conv, JUERGEN, 'A');
  await say(conv, ANNA_S, 'A');
  await say(conv, BERT, 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(h.kernel.groupPosts(conv).map((p) => p.text).join('\n'), /Hafen/);

  for (const post of [...h.kernel.groupPosts(conv), ...h.kernel.dms]) {
    for (const forbidden of FORBIDDEN) assert.doesNotMatch(post.text, forbidden, `nothing internal in: ${post.text}`);
    for (const m of (post as { mentions?: { user: string; text: string }[] }).mentions ?? []) {
      const person = PEOPLE.find((p) => `user:${p.id}` === m.user);
      assert.equal(m.text, person?.displayName, 'a mention carries the name of exactly that person');
    }
  }
});
