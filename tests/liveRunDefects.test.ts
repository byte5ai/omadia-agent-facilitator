// Defects of the live run of criterion 18 in a real Teams meeting
// (omadia-channel-teams#44, 2026-11-23):
// - a proposal during a live session used the 30-minute window instead of
//   the live window (spec 5.7: shorter for a live session, default 5 minutes);
// - a proposal some people explicitly agreed to was announced as "nobody
//   objected";
// - the mail-failure text claimed private delivery when none happened;
// - a turn with one tool call and the guards needed more model calls than
//   it reserved.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { TURN_MODEL_CALLS } from '../src/engine/scopes.js';
import { texts } from '../src/texts/index.js';
import { ANNA, BERT, CARA, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const THREE = [ANNA, BERT, CARA];
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const tool = (conv: string, name: string, input: Record<string, unknown> = {}): Promise<string> => h.tool(name, input, { conversation: conv });
const windowMinutes = async (conv: string): Promise<number | undefined> => {
  const f = await h.facilitation(conv);
  const open = await store.openProposal(h.db.pool, f.id);
  return open ? Math.round((open.windowEndsAt.getTime() - h.clock.now().getTime()) / MINUTE_MS) : undefined;
};

test('spec 5.7: a proposal during a live session has the live window (default 5 minutes); in the chat it keeps the normal one', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lr-live-window', THREE);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages']);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages'], { sessionRef: 'meet-lr', modality: 'online' });
  await tool(conv, 'facilitation_start', {
    goal: 'Tooling',
    definitionOfDone: 'A tool is chosen',
    agenda: [{ kind: 'collect', title: 'Topics' }, { kind: 'discuss', title: 'Discuss' }, { kind: 'close', title: 'Close' }],
  });
  await tool(conv, 'facilitation_open');
  // In the chat, before the meeting: the normal window.
  await tool(conv, 'facilitation_propose_summary', { text: 'We collect topics until the call.' });
  assert.equal(await windowMinutes(conv), 30);
  await passWindow(h, conv);

  const start = new Date(h.clock.now().getTime() + 2 * 60 * MINUTE_MS);
  await tool(conv, 'facilitation_session', { action: 'schedule', title: 'Call', start: start.toISOString(), end: new Date(start.getTime() + 40 * MINUTE_MS).toISOString(), modality: 'online', meetingRef: 'meet-lr' });
  h.clock.set(start);
  await h.kernel.sessionEvent('mira', conv, 'meet-lr', 'session_started');
  await h.settle();
  // "next" in the meeting: the step-close proposal holds 5 minutes, not 30.
  await say(conv, 'anna', 'Licences run out');
  await say(conv, 'bert', 'next');
  assert.equal(await windowMinutes(conv), 5, 'the live window');
  await passWindow(h, conv);
  assert.match(posts(conv).find((p) => p.startsWith('Step 2 of 3')) ?? '', /Discuss/);
});

test('a proposal that people explicitly agreed to is not announced as "nobody objected"', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lr-agreed-text', THREE);
  await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] });
  await tool(conv, 'facilitation_propose_summary', { text: 'Budget is settled.' });
  await say(conv, 'anna', 'agreed');
  await say(conv, 'bert', 'agreed');
  await passWindow(h, conv);
  const accepted = posts(conv).at(-1) ?? '';
  assert.doesNotMatch(accepted, /^Accepted, nobody objected/);
  assert.match(accepted, /^Accepted \(agreed: 2, no objection\): take this summary into the record/);
});

test('the mail-failure text does not claim a private delivery that did not happen', () => {
  for (const language of ['en', 'de'] as const) {
    const t = texts(language);
    assert.doesNotMatch(t.protocolMailUnavailable('x', 0), /privately|privat/, `${language}: nobody got it privately`);
    assert.match(t.protocolMailUnavailable('x', 2), /2/, `${language}: names how many got it privately`);
    assert.doesNotMatch(t.protocolSent(0, 1), /privately to 0|privat an 0/, `${language}: no "privately to 0"`);
  }
});

test('a turn with one tool call and its guards fits the model calls it reserves', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('lr-turn-calls', THREE);
  await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] });
  h.kernel.onTurn = () => 'Noted.';
  // Seen live: main model, tool call, answer, three verifier calls and the
  // helpers needed nine calls; the reservation was eight.
  h.kernel.turnModelCalls = 9;
  try {
    await say(conv, 'anna', 'What about parking?');
    assert.equal(posts(conv).at(-1), 'Noted.');
    assert.ok(TURN_MODEL_CALLS >= 12, 'room for a tool call plus the guards');
  } finally {
    h.kernel.turnModelCalls = 2;
    h.kernel.onTurn = () => '[silent]';
  }
});
