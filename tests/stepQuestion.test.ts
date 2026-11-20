// O1 of the rollout: during a vote a participant asked which options there
// are, and the facilitator answered that its state holds only the goal.
// What is asked in a step (the question, every option with its key, until
// when, how to answer) is part of the state the turn gets, and the status
// lists the options.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-19T09:00:00Z', config: { language: 'de' } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const WEEKEND = { goal: 'Samstag oder Sonntag?', definitionOfDone: 'Ein Tag ist gewählt', method: 'single', options: ['Samstag', 'Sonntag'] };
const context = (): string => h.kernel.turns.at(-1)?.engineContext ?? '';
async function ask(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}

test('during a vote the turn knows the question, every option with its key, and how to answer', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sq-vote', FOUR);
  await startActive(h, conv, WEEKEND);
  h.kernel.onTurn = () => 'Zur Wahl stehen A = Samstag und B = Sonntag.';
  await ask(conv, 'anna', 'welche Optionen stehen zur Wahl');
  assert.match(context(), /Asked in the open step: "Samstag oder Sonntag\?" \(decided by: single\)/);
  assert.match(context(), /Options, each with its key: A = Samstag, B = Sonntag/);
  assert.match(context(), /How the group was told to answer: .*A = Samstag, B = Sonntag/);
  assert.match(context(), /say it from the state above: the question and every option with its key/);
  assert.equal(h.kernel.groupPosts(conv).at(-1)?.text, 'Zur Wahl stehen A = Samstag und B = Sonntag.', 'naming the options is not held back');
});

test('the status lists the options with their keys', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sq-status', FOUR);
  await startActive(h, conv, WEEKEND);
  await ask(conv, 'anna', 'A');
  await ask(conv, 'bert', 'status');
  assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /Noch offen: 3 Beiträge\nOptionen: A = Samstag, B = Sonntag\nVorläufiger Stand: Samstag 1, Sonntag 0\n/);
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Optionen: A = Samstag, B = Sonntag/);
});

test('the deadline stands next to the question and its options', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sq-deadline', FOUR);
  await startActive(h, conv, { ...WEEKEND, deadline: new Date(h.clock.now().getTime() + 48 * HOUR_MS).toISOString() });
  await ask(conv, 'anna', 'bis wann kann ich abstimmen?');
  assert.match(context(), /\nDeadline: /);
  assert.match(context(), /Options, each with its key: A = Samstag, B = Sonntag/);
});

test('before the opening the turn knows what is set up to be asked', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sq-configuring', FOUR);
  const started = await h.tool('facilitation_start', WEEKEND, { conversation: conv });
  assert.match(started, /^Facilitation created/);
  await ask(conv, 'anna', 'worüber stimmen wir gleich ab?');
  assert.match(context(), /Set up to be asked once opened: "Samstag oder Sonntag\?" \(decided by: single\)/);
  assert.match(context(), /Options, each with its key: A = Samstag, B = Sonntag/);
});

test('a consent step states the proposal and has no options line', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('sq-consent', FOUR);
  await startActive(h, conv, { goal: 'Wir treffen uns am Samstag', definitionOfDone: 'Niemand widerspricht', method: 'consent' });
  await ask(conv, 'anna', 'worum geht es gerade?');
  assert.match(context(), /Asked in the open step: "Wir treffen uns am Samstag" \(decided by: consent\)/);
  assert.doesNotMatch(context(), /Options, each with its key/);
  await ask(conv, 'bert', 'status');
  assert.doesNotMatch(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /Optionen:/);
});
