// A collecting step: the group can move on in plain words, and a message
// about the process is not swallowed as a collected point.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { FOUR, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
async function collectStep(conv: string, language?: 'de'): Promise<string> {
  h.kernel.conversation(conv, FOUR);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', format: 'decision', ...(language ? { language } : {}) }, { conversation: conv });
  await h.tool('facilitation_open', {}, { conversation: conv });
  return (await h.facilitation(conv)).id;
}
const collected = async (id: string): Promise<string[]> => (await store.listContributions(h.db.pool, id)).filter((c) => c.status === 'valid').map((c) => String(c.payload['text']));

test('the step announcement says how the group moves on', { skip: PG_SKIP }, async () => {
  await collectStep('mo-announce');
  assert.match(posts('mo-announce')[1] ?? '', /Write "next" when everything is collected/);
  await collectStep('mo-announce-de', 'de');
  assert.match(posts('mo-announce-de')[1] ?? '', /Schreibt "weiter", wenn alles gesammelt ist/);
});

test('"next" in a collecting step proposes to close it; it is not a collected point and needs no model', { skip: PG_SKIP }, async () => {
  const id = await collectStep('mo-next');
  await say('mo-next', 'anna', 'The harbour');
  const turns = h.kernel.turns.length;
  await say('mo-next', 'bert', 'Next');
  assert.deepEqual(await collected(id), ['The harbour']);
  assert.equal(h.kernel.turns.length, turns, 'deterministic: no model turn');
  assert.match(posts('mo-next').at(-1) ?? '', /^Proposal: close "Collect options and positions" and move on/);
  // Nobody objects: the window ends, the step closes, the next one opens.
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  assert.equal((await store.openStepOf(h.db.pool, id))?.kind, 'discuss');
});

test('"weiter" works the same in German, and a second one while the proposal is open opens nothing', { skip: PG_SKIP }, async () => {
  const id = await collectStep('mo-weiter', 'de');
  await say('mo-weiter', 'anna', 'weiter');
  await say('mo-weiter', 'bert', 'Weiter!');
  const proposals = await store.listProposals(h.db.pool, id);
  assert.equal(proposals.length, 1);
  assert.deepEqual(await collected(id), []);
});

test('a message about the process reaches the facilitator turn instead of being recorded as a point', { skip: PG_SKIP }, async () => {
  const id = await collectStep('mo-process', 'de');
  for (const text of [
    'Die drei Optionen stehen ja schon fest. Bitte direkt zur Abstimmung.',
    'Können wir den Schritt überspringen',
    'Mira, lass uns weitermachen',
  ]) {
    const turns = h.kernel.turns.length;
    await say('mo-process', 'bert', text);
    assert.equal(h.kernel.turns.length, turns + 1, `no turn for: ${text}`);
  }
  assert.deepEqual(await collected(id), []);
  // An ordinary point is still recorded at once.
  await say('mo-process', 'cara', 'Der Hafen hat genug Platz');
  assert.deepEqual(await collected(id), ['Der Hafen hat genug Platz']);
});

// ── S4: the discussing step ─────────────────────────────────────────────────

async function discussStep(conv: string, language?: 'de'): Promise<string> {
  h.kernel.conversation(conv, FOUR);
  await h.tool(
    'facilitation_start',
    { goal: 'Pick a venue', agenda: [{ kind: 'discuss', title: 'Talk it through' }, { kind: 'decide', title: 'Vote', method: 'single', options: ['Harbour', 'Garden'] }], open: true, ...(language ? { language } : {}) },
    { conversation: conv },
  );
  return (await h.facilitation(conv)).id;
}

test('S4: a discussing step says how it ends, and "next" proposes to close it without a model', { skip: PG_SKIP }, async () => {
  const id = await discussStep('mo-discuss');
  assert.match(posts('mo-discuss')[1] ?? '', /Write "next" when everything has been said/);
  const turns = h.kernel.turns.length;
  await say('mo-discuss', 'anna', 'next');
  assert.equal(h.kernel.turns.length, turns, 'no model turn');
  assert.match(posts('mo-discuss').at(-1) ?? '', /^Proposal: close "Talk it through" and move on/);
  for (const who of ['anna', 'bert', 'cara', 'dave']) await say('mo-discuss', who, 'agreed');
  await passWindow(h, 'mo-discuss');
  assert.equal((await store.openStepOf(h.db.pool, id))?.kind, 'decide');
});

test('S4: in German the word is "weiter", and the speaking order no longer uses the same word for something else', { skip: PG_SKIP }, async () => {
  await discussStep('mo-discuss-de', 'de');
  assert.match(posts('mo-discuss-de')[1] ?? '', /Schreibt "weiter", wenn alles gesagt ist/);
  await say('mo-discuss-de', 'bert', 'weiter');
  assert.match(posts('mo-discuss-de').at(-1) ?? '', /^Vorschlag: "Talk it through" abschließen und weitergehen/);
  const { de } = await import('../src/texts/de.js');
  const { en } = await import('../src/texts/en.js');
  assert.doesNotMatch(de.speakingOrder(['Anna'], false), /"weiter"/);
  assert.doesNotMatch(en.speakingOrder(['Anna'], false), /"next"/);
});

test('S4: after the silent voices were invited, the group is told how the step ends', { skip: PG_SKIP }, async () => {
  await discussStep('mo-discuss-invite');
  await say('mo-discuss-invite', 'anna', 'I prefer the harbour because of the space');
  await h.tool('facilitation_step', { action: 'close' }, { conversation: 'mo-discuss-invite' });
  assert.match(posts('mo-discuss-invite').at(-1) ?? '', /write "next" to close this step/);
});
