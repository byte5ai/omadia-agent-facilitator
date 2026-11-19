// D36: a mention as Teams writes it. The stored text carries the mentioned
// display name without an "@", several words and parentheses included
// ("Mona (Test) erledigt 1"); that the message addresses the facilitator is
// the kernel's statement on the record, not something read from the text.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { withoutMention } from '../src/engine/addressing.js';
import { normaliseCommand } from '../src/engine/inbound.js';
import { statusText } from '../src/engine/status.js';
import { ANNA, BERT, CARA, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const NAME = 'Mona (Test)';
const NAMES = [NAME, 'mona'];

test('the mention at the start of a text is taken off as the channel wrote it', () => {
  const addressed = (text: string): string => normaliseCommand(text, { names: NAMES, addressed: true });
  assert.equal(addressed('Mona (Test) erledigt 1'), 'erledigt 1');
  assert.equal(addressed('Mona (Test) status'), 'status');
  assert.equal(addressed('Mona (Test) Stopp!'), 'stopp');
  assert.equal(addressed('Mona  (Test)   erledigt 1'), 'erledigt 1', 'white space as the client leaves it');
  assert.equal(addressed('<at>Mona (Test)</at> erledigt 1'), 'erledigt 1');
  assert.equal(addressed('<at id="0">Mona (Test)</at>, status'), 'status');
  assert.equal(addressed('@Mona (Test) erledigt 1'), 'erledigt 1');
  assert.equal(addressed('@Mona erledigt 1'), 'erledigt 1', 'a mention typed by hand');
  assert.equal(addressed('Mona erledigt 1'), 'erledigt 1', 'a mention shortened to the first name');
  assert.equal(addressed('mona (test): erledigt 1'), 'erledigt 1');
  assert.equal(addressed('Mona (Test)'), '', 'nothing but the mention');
  assert.equal(addressed('erledigt 1'), 'erledigt 1');
  assert.equal(addressed('@Bert Mona (Test) status'), 'status', 'more than one mention');
  // What follows the name is kept as it is.
  assert.equal(withoutMention('Mona (Test) halte bitte als Aufgabe fest: Raum buchen.', NAMES, true), 'halte bitte als Aufgabe fest: Raum buchen.');
  // The kernel knows the facilitator as "Mona", Teams shows "Mona (Test)".
  assert.equal(normaliseCommand('Mona (Test) erledigt 1', { names: ['Mona', 'mona'], addressed: true }), 'erledigt 1');
  assert.equal(normaliseCommand('Mona (bitte) erledigt 1', { names: ['Mona'], addressed: false }), 'mona (bitte) erledigt 1');
  // A name that only begins like the facilitator's is no mention.
  assert.equal(addressed('Monalisa status'), 'monalisa status');

  // Without the kernel's statement only the whole name is a mention: a
  // sentence that starts with a first name stays what it is.
  const plain = (text: string): string => normaliseCommand(text, { names: NAMES, addressed: false });
  assert.equal(plain('Mona (Test) status'), 'status');
  assert.equal(plain('Mona status'), 'mona status');
  assert.equal(plain('Mona kommt morgen später'), 'mona kommt morgen später');
  // And as before, without any names.
  assert.equal(normaliseCommand('@mira status'), 'status');
});

let h: Harness;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness();
  h.kernel.names.set('mona', NAME);
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const statuses = async (facilitationId: string): Promise<string[]> => (await store.listActionItems(h.db.pool, facilitationId)).map((a) => a.status);
const outcomes = async (facilitationId: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [facilitationId])).rows.map((r) => r.outcome);
/** A real mention: the display name in the text, the kernel says "addressed". */
async function teams(conv: string, who: string, text: string): Promise<'engine' | 'turn' | 'suppressed'> {
  const result = await h.kernel.mention(conv, who, text, { agent: 'mona', addressed: true });
  await h.settle();
  return result.answeredBy;
}

async function followUp(conv: string, count: number) {
  h.kernel.conversation(conv, [ANNA, BERT]);
  const at = { agent: 'mona', conversation: conv };
  await h.tool('facilitation_start', { goal: `Next steps ${conv}`, followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }], open: true }, at);
  for (let n = 1; n <= count; n += 1) {
    await h.tool('facilitation_record_action_item', { description: `Task ${String(n)}`, owner: 'Anna', dueDate: inHours(48) }, at);
    await h.kernel.say(conv, 'anna', 'yes');
    await h.settle();
  }
  await h.tool('facilitation_step', { action: 'close' }, at);
  await h.tool('facilitation_step', { action: 'close' }, at);
  for (const who of ['anna', 'bert']) {
    await h.kernel.say(conv, who, 'agreed');
    await h.settle();
  }
  const f = await h.facilitation(conv);
  assert.equal(f.settings.facilitatorName, NAME);
  assert.deepEqual([f.phase, f.followupState], ['closed', 'active']);
  return f;
}

test('scenario A, follow-up: "Mona (Test) erledigt 1" is taken by the engine, the item is closed and that is said once', { skip: PG_SKIP }, async () => {
  const conv = 'tm-followup';
  const f = await followUp(conv, 2);
  const before = posts(conv).length;
  assert.equal(await teams(conv, 'anna', 'Mona (Test) erledigt 1'), 'engine');
  assert.deepEqual(await statuses(f.id), ['done', 'confirmed']);
  assert.deepEqual(posts(conv).slice(before), ['Done, thank you Anna: #1 Task 1']);
  // "status", with the tag form and with the name shortened.
  assert.equal(await teams(conv, 'bert', '<at>Mona (Test)</at> Status'), 'engine');
  assert.match(posts(conv).at(-1) ?? '', /closed, action items are being followed up/);
  assert.equal(await teams(conv, 'anna', 'Mona fertig 2'), 'engine');
  assert.deepEqual(await statuses(f.id), ['done', 'done']);
  // Something the engine has no fixed answer for is still the turn's.
  const other = await followUp('tm-followup-other', 1);
  assert.equal(await teams('tm-followup-other', 'anna', 'Mona (Test) wie war das noch mit dem Raum'), 'turn');
  assert.deepEqual(await statuses(other.id), ['confirmed']);
});

test('scenario B, during a vote: a request with a real mention that does not end in "?" gets its turn, and a command after a mention is read', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tm-vote', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] }, 'mona');
  const turns = h.kernel.turns.length;
  h.kernel.onTurn = () => 'Noted, I put that to the group after the vote.';
  try {
    // Small talk without a mention stays quiet in a vote, as before.
    await h.kernel.say(conv, 'bert', 'nice weather today');
    await h.settle();
    assert.equal((await outcomes(f.id)).at(-1), 'not_addressed');
    assert.equal(h.kernel.turns.length, turns);
    // The kernel suppresses the ordinary turn here: the engine has to answer.
    assert.equal(await teams(conv, 'anna', 'Mona (Test) halte bitte als Aufgabe fest: Raum buchen, fällig morgen um 12 Uhr.'), 'suppressed');
    assert.equal((await outcomes(f.id)).at(-1), 'free_text');
    assert.equal(h.kernel.turns.length, turns + 1, 'a message the kernel marks as addressed always gets an answer');
    assert.equal(posts(conv).at(-1), 'Noted, I put that to the group after the vote.');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  // "status" and "stopp" after a mention.
  await teams(conv, 'bert', 'Mona (Test) Status');
  assert.equal((await outcomes(f.id)).at(-1), 'status');
  await teams(conv, 'anna', 'Mona (Test) stopp');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
});

// ── 1.5.2 ───────────────────────────────────────────────────────────────────

test('a ballot after a mention is a ballot: "Mona (Test) A" is counted for its author, without a model', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tm-ballot', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { method: 'single', options: ['Harbour', 'Garden'] }, 'mona');
  const turns = h.kernel.turns.length;
  await teams(conv, 'anna', 'Mona (Test) A');
  await teams(conv, 'bert', '<at>Mona (Test)</at> Garden');
  await teams(conv, 'cara', 'Mona a');
  assert.equal(h.kernel.turns.length, turns, 'no turn: each was read as the ballot it is');
  const valid = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
  assert.deepEqual(valid.map((c) => [c.participantPrincipal, (c.payload['ballot'] as { choice?: string } | undefined)?.choice ?? JSON.stringify(c.payload['ballot'])]).sort(), [
    ['user:anna', 'A'],
    ['user:bert', 'B'],
    ['user:cara', 'A'],
  ]);
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed', 'everybody voted: the result is in');
  // And the status afterwards names who voted.
  const status = (await statusText(h.db.pool, closed)).split('\n');
  assert.equal(status[0], 'Status: ended. Goal: Pick a venue');
  assert.ok(status.includes('Contributed: Anna, Bert, Cara'), status.join(' | '));
  assert.ok(status.includes('Action items: none'));
});

test('the status after the close says what was reached, who contributed and which action items are open, in the group and privately', { skip: PG_SKIP }, async () => {
  const conv = 'tm-status';
  const f = await followUp(conv, 2);
  // One of the two is done.
  assert.equal(await teams(conv, 'anna', 'Mona (Test) erledigt 2'), 'engine');
  assert.equal(await teams(conv, 'bert', 'Mona (Test) Status'), 'engine');
  const status = posts(conv).at(-1) ?? '';
  const lines = status.split('\n');
  assert.equal(lines[0], `Status: closed, action items are being followed up. Goal: Next steps ${conv}`);
  assert.equal(lines[1], 'Contributed: Anna', 'who took on an action item, not "nobody yet"');
  assert.equal(lines[2], 'Action items (1 open):');
  assert.match(lines[3] ?? '', /^- #1 Task 1 \(Anna, due .+\): open$/);
  assert.match(lines[4] ?? '', /^- #2 Task 2 \(Anna, due .+\): done$/);
  assert.match(lines[5] ?? '', /^Followed up until: /);
  assert.equal(lines.length, 6);
  assert.doesNotMatch(status, /Still open|nobody yet|Definition of done/, 'nothing about a step that no longer exists');
  // The private answer is the same status.
  // (Anna takes part in other follow-ups of this file: she is asked which.)
  const which = (await h.kernel.privateMessage('mona', 'anna', 'status')) ?? '';
  const number = new RegExp(`^(\\d+)\\. Next steps ${conv}$`, 'm').exec(which)?.[1];
  assert.ok(number, which);
  assert.equal(await h.kernel.privateMessage('mona', 'anna', `status ${String(number)}`), status);
  assert.equal((await h.facilitation(conv)).id, f.id);
});
