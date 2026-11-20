// Rollout defects D37 to D39 and O3 (facilitator 1.5.5):
//   D37  an answer on a questionnaire card was on record, but the status said
//        nobody contributed, "everybody answered" never became true, and the
//        close said there was no answer
//   D38  "evaluate and close" needed more model calls than a turn reserves
//   D39  a deadline given as a span from now was dropped
//   O3   the person never read what was taken over from "15min"

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { CardAnswerValue, CardSupport } from '../src/cards/types.js';
import { MINUTE_MS } from '../src/clock.js';
import { TURN_MODEL_CALLS } from '../src/engine/scopes.js';
import { FOUR, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

// Teams: no number field, so a number is asked as text and read by the engine.
const TEAMS: CardSupport = { kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text'], maxQuestions: 5, update: true };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-20T04:00:00Z', config: { language: 'de', maxActivePerFacilitator: 100, maxActiveInstance: 100, startsPerHourPerFacilitator: 100 } });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});
beforeEach(() => {
  if (!PG_SKIP) h.kernel.cardSupport = TEAMS;
});

const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const PAUSE = { title: 'Pause', questions: [{ id: 'minutes', label: 'Wie viele Minuten soll die Pause dauern?', kind: 'number', min: 5, max: 60 }] };
const minutes = (text: string): CardAnswerValue[] => [{ questionId: 'minutes', kind: 'text', text }];
async function answer(conv: string, who: string, text: string): Promise<void> {
  const card = h.kernel.cards(conv).at(-1);
  if (!card) throw new Error(`no card in ${conv}`);
  await h.kernel.submitCard(conv, who, card, minutes(text));
  await h.settle();
}
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}

test('D37: one participant answers the questionnaire the facilitation is for: it counts, the definition of done is met, and the result names the answer', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-repro', FOUR);
  assert.match(await tool(conv, 'facilitation_start', { goal: 'Pausendauer im Testlauf', definitionOfDone: 'Alle haben geantwortet', participants: ['Anna'], open: true }), /opened/);
  assert.match(await tool(conv, 'facilitation_questionnaire', PAUSE), /^Posted as a card/);
  const posted = h.kernel.cards(conv).at(-1);
  await answer(conv, 'anna', '15min');

  const said = posts(conv);
  // 1.5.7: the group reads that Anna answered, not what; the result names it.
  assert.ok(said.includes('Antwort von Anna erfasst (1 von 1)'), `no short acknowledgement in: ${JSON.stringify(said)}`);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed', 'it finished by itself');
  const result = String(f.result?.['text'] ?? '');
  assert.match(result, /^Ergebnis zu "Pausendauer im Testlauf":\nAntworten:\n- Wie viele Minuten soll die Pause dauern\?: Anna: 15\n/);
  assert.ok(said.includes(result), 'the group read the result');
  assert.ok(!said.some((p) => /ohne Ergebnis/.test(p)));
  const update = h.kernel.cardUpdates.find((u) => u.cardMessageId === posted?.cardMessageId);
  assert.equal(update?.update.state, 'closed', 'the card is closed in the channel');
  assert.match((update?.update as unknown as { resultLines: string[] }).resultLines.join('\n'), /Anna: 15/);
});

test('D37: an answer is that person\'s contribution: the status lists it, the turn knows the answers, and only who did not answer is invited', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-status', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna', 'Bert', 'Cara'], open: true });
  await tool(conv, 'facilitation_questionnaire', PAUSE);
  await answer(conv, 'anna', '15min');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'two have not answered');

  assert.match(await tool(conv, 'facilitation_status'), /Beigetragen: 1 von 3\nNoch offen: 2 Beiträge/);
  h.kernel.onTurn = () => '[silent]';
  await say(conv, 'bert', 'Mira, wer hat schon geantwortet?');
  const context = h.kernel.turns.at(-1)?.engineContext ?? '';
  assert.match(context, /Contributed to it: Anna\nNot yet: Bert, Cara/);
  assert.match(context, /# Questionnaire[^\n]*\n"Pause": 1 of 3 participants answered\.\nWie viele Minuten soll die Pause dauern\?: Anna: 15/);

  // A newer answer replaces the earlier one; it is still one contribution.
  await answer(conv, 'anna', '20');
  assert.match(await tool(conv, 'facilitation_questionnaire_answers'), /Anna: 20/);
  const mine = await h.db.pool.query<{ status: string }>(
    `SELECT status FROM plg_omadia_agent_facilitator_contributions WHERE facilitation_id = $1 AND participant_principal = 'user:anna' ORDER BY recorded_at`,
    [(await h.facilitation(conv)).id],
  );
  assert.deepEqual(mine.rows.map((r) => r.status), ['superseded', 'valid']);
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Not closed yet: 2 people have not contributed/);
});

test('D37: a questionnaire posted as what the facilitation is for closes it when the last participant answered', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-flag', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Die Umfrage ist ausgewertet', participants: ['Anna', 'Bert'], open: true });
  assert.match(await tool(conv, 'facilitation_questionnaire', { ...PAUSE, closesWhenAllAnswered: true }), /The facilitation closes by itself, with the answers as the result, once everybody answered/);
  await answer(conv, 'anna', '15');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await answer(conv, 'bert', '10 Minuten');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(String(f.result?.['text'] ?? ''), /Antworten:\n- Wie viele Minuten soll die Pause dauern\?: Anna: 15; Bert: 10\n/);
});

test('D37: without that, and with another definition of done, answers do not end anything; next to a vote an answer is no vote', { skip: PG_SKIP }, async () => {
  const open = h.kernel.conversation('qc-not-ending', FOUR);
  await tool(open, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna'], open: true });
  await tool(open, 'facilitation_questionnaire', PAUSE);
  await answer(open, 'anna', '15');
  assert.equal((await h.facilitation(open)).phase, 'active');

  const vote = h.kernel.conversation('qc-vote', FOUR);
  await tool(vote, 'facilitation_start', { goal: 'Samstag oder Sonntag?', method: 'single', options: ['Samstag', 'Sonntag'], participants: ['Anna', 'Bert'], open: true });
  await tool(vote, 'facilitation_questionnaire', PAUSE);
  await answer(vote, 'anna', '15');
  assert.match(await tool(vote, 'facilitation_status'), /Beigetragen: 0 von \d+/);
  assert.match(await tool(vote, 'facilitation_questionnaire_answers'), /Anna: 15/);
});

test('D38: closing on request is one tool call: the only participant concludes at once, and the result holds the answers', { skip: PG_SKIP }, async () => {
  assert.equal(TURN_MODEL_CALLS, 8, 'a turn reserves eight model calls');
  const conv = h.kernel.conversation('qc-close-one', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna'], open: true });
  await tool(conv, 'facilitation_questionnaire', PAUSE);
  await answer(conv, 'anna', '15min');
  // The turn is told that one call is enough and that it need not read first.
  h.kernel.onTurn = () => '[silent]';
  await say(conv, 'anna', 'Mira, bitte werte den Fragebogen aus und schließe die Moderation ab.');
  const turn = h.kernel.turns.at(-1);
  assert.equal(turn?.budget.modelCalls, 8);
  assert.match(turn?.engineContext ?? '', /call facilitation_close, once; it needs no step closed before/);

  assert.match(await tool(conv, 'facilitation_close'), /^Concluded: the result was posted/);
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  assert.match(String(f.result?.['text'] ?? ''), /Antworten:\n- Wie viele Minuten soll die Pause dauern\?: Anna: 15\n/);
  assert.ok(!posts(conv).some((p) => /Vorschlag|Einwand/i.test(p) && /Definition of Done ist erfüllt/.test(p)), 'nothing was put to a group of one');
});

test('D38: closing the last step does not leave the facilitation open: the close follows in the same call', { skip: PG_SKIP }, async () => {
  const one = h.kernel.conversation('qc-step-one', FOUR);
  await tool(one, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna'], open: true });
  await tool(one, 'facilitation_questionnaire', PAUSE);
  await answer(one, 'anna', '15');
  assert.match(await tool(one, 'facilitation_step', { action: 'close' }), /^Closed, and it was the last step: the facilitation is concluded/);
  await h.settle();
  assert.equal((await h.facilitation(one)).phase, 'closed');

  // With others in the group it is theirs to object: put to them, with the
  // consent of the one who asked on record.
  const three = h.kernel.conversation('qc-step-three', FOUR);
  await tool(three, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna', 'Bert', 'Cara'], open: true });
  await tool(three, 'facilitation_questionnaire', PAUSE);
  for (const who of ['anna', 'bert', 'cara']) await answer(three, who, '15');
  assert.match(await tool(three, 'facilitation_step', { action: 'close' }), /^Closed, and it was the last step: the closing summary was put to the group/);
  await h.settle();
  const f = await h.facilitation(three);
  assert.equal(f.phase, 'active');
  const proposal = (await h.db.pool.query<{ kind: string; consents: string[] }>(`SELECT kind, consents FROM plg_omadia_agent_facilitator_proposals WHERE facilitation_id = $1 AND status = 'open'`, [f.id])).rows[0];
  assert.deepEqual([proposal?.kind, proposal?.consents], ['dod_met', ['user:anna']]);
  await say(three, 'bert', 'einverstanden');
  await say(three, 'cara', 'einverstanden');
  assert.equal((await h.facilitation(three)).phase, 'closed');
});

test('D39: a deadline given as a span from now is set by the engine, and the answer of the start says which deadline holds', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-deadline', FOUR);
  const now = h.clock.now().getTime();
  const started = await tool(conv, 'facilitation_start', { goal: 'Samstag oder Sonntag?', method: 'single', options: ['Samstag', 'Sonntag'], deadlineInMinutes: 90, open: true });
  assert.match(started, /\nDeadline: /);
  const f = await h.facilitation(conv);
  const span = (f.deadline?.getTime() ?? 0) - now;
  assert.ok(span >= 90 * MINUTE_MS && span < 91 * MINUTE_MS, `ninety minutes from the start, got ${String(span / MINUTE_MS)}`);
  assert.doesNotMatch(posts(conv)[0] ?? '', /keine vereinbart/);
  assert.match(posts(conv)[0] ?? '', /Deadline: /);
  const scope = h.kernel.scopeOf(f.id, 'active');
  assert.ok(scope && new Date(scope.deadline).getTime() < now + 3 * 60 * MINUTE_MS, 'the active scope ends with the deadline, not after thirty days');

  const other = h.kernel.conversation('qc-deadline-other', FOUR);
  assert.match(await tool(other, 'facilitation_start', { goal: 'x', deadlineInMinutes: 90, deadline: '2026-11-21T17:00:00+01:00' }), /^Refused \(bad_deadline\)/);
  assert.match(await tool(other, 'facilitation_start', { goal: 'x', deadlineInMinutes: 0 }), /^Refused \(bad_deadline\)/);
  assert.match(await tool(other, 'facilitation_start', { goal: 'Samstag oder Sonntag?', method: 'single', options: ['Samstag', 'Sonntag'] }), /No deadline is set\. If the request named one, call facilitation_start again/);
});

test('1.5.7: a questionnaire answer is acknowledged in the group as "who, and how many", without the question or the answer; a chat ballot keeps its echo', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-echo', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna', 'Bert', 'Cara'], open: true });
  await tool(conv, 'facilitation_questionnaire', PAUSE);
  const before = posts(conv).length;
  await answer(conv, 'anna', '15min');
  await answer(conv, 'bert', '10');
  await answer(conv, 'anna', '20');
  const echoes = posts(conv).slice(before);
  assert.deepEqual(echoes, ['Antwort von Anna erfasst (1 von 3)', 'Antwort von Bert erfasst (2 von 3)', 'Antwort von Anna geändert (2 von 3)']);
  assert.ok(echoes.every((e) => !/Minuten|15|10|20/.test(e.replace(/\(\d von \d\)/, ''))), 'neither the question nor an answer');

  const vote = h.kernel.conversation('qc-echo-vote', FOUR);
  await tool(vote, 'facilitation_start', { goal: 'Samstag oder Sonntag?', method: 'single', options: ['Samstag', 'Sonntag'], participants: ['Anna', 'Bert'], open: true });
  await say(vote, 'anna', 'A');
  assert.equal(posts(vote).at(-1), 'Für dich erfasst, Anna: A (Samstag)');
});

test('1.5.7: a facilitation closed with a questionnaire nobody answered says so in its result; without a questionnaire the line is not there', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qc-unanswered', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna'], open: true });
  await tool(conv, 'facilitation_questionnaire', PAUSE);
  assert.match(await tool(conv, 'facilitation_close'), /^Concluded/);
  await h.settle();
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');
  const result = String(f.result?.['text'] ?? '');
  assert.equal(result, 'Ergebnis zu "Pause planen":\nAuf den Fragebogen "Pause" hat niemand geantwortet, deshalb gibt es keine Antworten zu berichten.\nDiese Moderation ist abgeschlossen. Danke euch.');
  assert.ok(posts(conv).includes(result));

  const plain = h.kernel.conversation('qc-no-questionnaire', FOUR);
  await tool(plain, 'facilitation_start', { goal: 'Pause planen', definitionOfDone: 'Wir wissen, wie lang die Pause ist', participants: ['Anna'], open: true });
  await tool(plain, 'facilitation_close');
  await h.settle();
  assert.doesNotMatch(String((await h.facilitation(plain)).result?.['text'] ?? ''), /Fragebogen/);
});
