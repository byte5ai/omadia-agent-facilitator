// Sessions and media-adaptive moderation (spec 6.1, 6.3; issues #2076, #2077).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { SessionCapabilitySnapshot } from '@omadia/plugin-api';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { diffSnapshots, perceptionStatement, planMeans } from '../src/engine/media.js';
import { texts } from '../src/texts/index.js';
import { ANNA, BERT, CARA, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-18T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const last = (conv: string): string => posts(conv).at(-1) ?? '';
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();

const snap = (inputs: SessionCapabilitySnapshot['inputs'], outputs: SessionCapabilitySnapshot['outputs'], modality: SessionCapabilitySnapshot['modality'] = 'chat') => ({ inputs, outputs, modality });

const MEANS_CASES: Array<[string, ReturnType<typeof snap>, Partial<ReturnType<typeof planMeans>>]> = [
  ['text only', snap(['text'], ['text']), { vote: 'chat_ballots', timekeeping: 'post', speakingOrder: 'round_robin', invitation: 'group_neutral', agenda: 'post', contributions: 'text', addressing: 'name' }],
  ['Teams group chat', snap(['text', 'message_edits', 'card_answers'], ['text', 'mentions', 'cards', 'polls', 'private_messages']), { vote: 'poll', invitation: 'private_message', addressing: 'mention', speakingOrder: 'round_robin' }],
  ['cards without answers coming back', snap(['text'], ['text', 'cards']), { vote: 'chat_ballots' }],
  ['a pinned surface', snap(['text'], ['text', 'pinned_surface']), { timekeeping: 'pinned_timer', agenda: 'pinned' }],
  ['voice and raised hands', snap(['text', 'hand_raise', 'transcribed_speech'], ['text', 'voice']), { timekeeping: 'voice', speakingOrder: 'hand_raise', contributions: 'text_and_speech' }],
];
for (const [name, snapshot, expected] of MEANS_CASES) {
  test(`means: ${name}`, () => {
    const means = planMeans(snapshot);
    for (const [key, value] of Object.entries(expected)) assert.equal(means[key as keyof typeof means], value, key);
  });
}

test('the perception statement names what is perceived and what a group would wrongly assume', () => {
  const t = texts('en');
  assert.equal(
    perceptionStatement(snap(['text', 'card_answers'], ['text', 'polls', 'private_messages'], 'online'), t),
    'What I perceive here: I read the chat, the polls. I do not hear the call. I do not see raised hands. I do not see who is present. Nobody should assume more.',
  );
  assert.match(perceptionStatement(snap(['text'], ['text']), t), /I cannot run polls here, so votes are written in the chat\. I cannot write to anyone privately here/);
  assert.doesNotMatch(perceptionStatement(snap(['text'], ['text']), t), /hear the call/, 'a chat has no call to hear');
  assert.match(perceptionStatement(snap(['text', 'transcribed_speech'], ['text'], 'online'), texts('de')), /das im Call Gesagte als Transkript/);
});

test('a snapshot diff reports what was gained and lost', () => {
  const diff = diffSnapshots(snap(['text', 'card_answers'], ['text']), snap(['text', 'transcribed_speech'], ['text']));
  assert.deepEqual([diff.gained, diff.lost, diff.changed], [['transcribed_speech'], ['card_answers'], true]);
  assert.equal(diffSnapshots(snap(['text'], ['text']), snap(['text'], ['text'])).changed, false);
});

test('the handshake says what the facilitator perceives; readiness that could not be verified is said too', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-handshake', FOUR);
  h.kernel.capabilities(conv, ['text', 'message_edits'], ['text', 'mentions']);
  h.kernel.absent.add('readiness');
  const started = await tool(conv, 'facilitation_start', { goal: 'g', definitionOfDone: 'd' });
  h.kernel.absent.delete('readiness');
  assert.match(started, /Tell the group: The channel could not confirm that I can read every message here/);
  await tool(conv, 'facilitation_open');
  // Private messages work here (the way to send them exists), so nothing is said against them.
  assert.match(posts(conv)[0] ?? '', /What I perceive here: I read the chat, edited messages\. I cannot run polls here, so votes are written in the chat\. Nobody should assume more\./);
  const f = await h.facilitation(conv);
  const [session] = await store.listSessions(h.db.pool, f.id);
  assert.deepEqual([session?.kind, session?.modality, session?.status], ['async', 'chat', 'running']);
});

test('missing consent is repaired once; when the repair fails nothing starts', { skip: PG_SKIP }, async () => {
  const fixable = h.kernel.conversation('se-repair', [ANNA, BERT]);
  h.kernel.notReady.set(`mira|${fixable}`, [{ code: 'consent_missing', message: 'RSC consent is outdated' }]);
  h.kernel.repairable.add(`mira|${fixable}`);
  assert.match(await tool(fixable, 'facilitation_start', { goal: 'g', definitionOfDone: 'd' }), /^Facilitation created/);
  const broken = h.kernel.conversation('se-repair-fails', [ANNA, BERT]);
  h.kernel.notReady.set(`mira|${broken}`, [{ code: 'package_outdated', message: 'the app package is older than the manifest' }]);
  assert.match(await tool(broken, 'facilitation_start', { goal: 'g', definitionOfDone: 'd' }), /^Refused \(not_ready\).*package_outdated: the app package is older than the manifest/);
  assert.deepEqual(h.kernel.repairs, [`mira|${fixable}`, `mira|${broken}`]);
});

test('a vote goes out as a poll card where the session has polls; poll answers are ballots, an unverified one waits for its owner', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-poll', [ANNA, BERT, CARA]);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages']);
  const f = await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
  const poll = h.kernel.groupPosts(conv).find((p) => p.poll !== undefined);
  const step = (await store.listSteps(h.db.pool, f.id))[0];
  assert.deepEqual(poll?.poll, {
    pollId: `${step?.id ?? ''}:1`,
    question: 'Pick a venue',
    options: [{ id: 'A', label: 'Thai' }, { id: 'B', label: 'Pizza' }],
    hint: 'Answer in the poll, or write your choice in the chat (e.g. "A").',
  });
  const pollId = `${step?.id ?? ''}:1`;
  const card = `${poll?.messageId ?? ''}-card`;

  await h.kernel.answerCard(conv, 'anna', pollId, { optionId: 'A' }, card);
  await h.settle();
  assert.equal(last(conv), 'Recorded for you, Anna: A (Thai)');
  await h.kernel.answerCard(conv, 'anna', pollId, { optionId: 'B' }, card);
  await h.settle();
  assert.equal(last(conv), 'Changed for you, Anna: B (Pizza)');
  await say(conv, 'bert', 'B');

  await h.kernel.answerCard(conv, 'cara', 'some-other-poll', { optionId: 'A' }, card);
  await h.kernel.answerCard(conv, 'cara', pollId, { optionId: 'Z' }, card);
  await h.settle();
  assert.equal((await h.facilitation(conv)).phase, 'active', 'a stale or invalid answer records nothing');

  const unverified = await h.kernel.answerCard(conv, 'cara', pollId, { optionId: 'B' }, card);
  // The platform could not state who answered (an anonymous guest).
  await h.engine.receive('mira', { ...unverified, eventId: `${unverified.eventId}-u`, cardAnswer: { cardId: pollId, value: { optionId: 'A' }, answererVerified: false } });
  await h.settle();
  const valid = (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');
  assert.deepEqual(valid.map((c) => [c.participantPrincipal, c.source]).sort(), [['user:anna', 'card'], ['user:bert', 'message'], ['user:cara', 'card']]);
  assert.equal((await h.facilitation(conv)).phase, 'closed', 'the verified answer counted and concluded');
});

test('without polls the same vote runs as chat ballots, with no card', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-nopoll', [ANNA, BERT]);
  h.kernel.capabilities(conv, ['text'], ['text']);
  await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
  assert.equal(h.kernel.groupPosts(conv).filter((p) => p.poll !== undefined).length, 0);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('a meeting: agenda before it, start on time with what is perceived, time check, end; replayed session events change nothing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-meeting', FOUR);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages']);
  h.kernel.capabilities(conv, ['text', 'card_answers', 'presence'], ['text', 'polls', 'private_messages'], { sessionRef: 'meeting-1', modality: 'online' });
  await tool(conv, 'facilitation_start', { goal: 'Quarterly planning', definitionOfDone: 'Priorities are agreed', agenda: [{ kind: 'collect', title: 'Topics' }, { kind: 'discuss', title: 'Discuss priorities', timeboxMinutes: 20 }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  const scheduled = await tool(conv, 'facilitation_session', { action: 'schedule', title: 'Planning call', start: inMinutes(180), end: inMinutes(240), modality: 'online', meetingRef: 'meeting-1' });
  assert.match(scheduled, /^Scheduled "Planning call"\. The agenda is posted 60 minutes before/);
  await say(conv, 'anna', 'Hiring plan');
  await say(conv, 'bert', 'Budget for tooling');

  h.clock.advance(119 * MINUTE_MS);
  await h.tick();
  assert.ok(!posts(conv).some((t) => t.startsWith('Agenda for')), 'not before its time');
  h.clock.advance(2 * MINUTE_MS);
  await h.tick();
  assert.match(last(conv), /^Agenda for "Planning call" on .*:\n1\. Topics\n2\. Discuss priorities \(20 min\)\n3\. Close\nTopics and pre-reads you want to bring/s);

  h.clock.advance(60 * MINUTE_MS);
  await h.kernel.sessionEvent('mira', conv, 'meeting-1', 'session_started');
  await h.settle();
  assert.match(last(conv), /^"Planning call" starts now\. We have until .*\nWhat I perceive here: I read the chat, the polls, who joins and leaves\. I do not hear the call\. I do not see raised hands\./s);
  const count = posts(conv).length;
  await h.kernel.sessionEvent('mira', conv, 'meeting-1', 'session_started');
  await h.tick();
  assert.equal(posts(conv).length, count, 'a redelivered start and the scheduled start job do nothing');

  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(last(conv), /^Step 2 of 3: Discuss priorities\..*Timebox until /);
  h.clock.advance(15 * MINUTE_MS + 1000);
  await h.tick();
  assert.equal(last(conv), 'Time check: 5 minutes left for "Discuss priorities".');

  await h.kernel.sessionEvent('mira', conv, 'meeting-1', 'session_ended');
  await h.settle();
  assert.ok(posts(conv).includes('"Planning call" has ended. What is still open continues here in the chat.'));
  const sessions = await store.listSessions(h.db.pool, (await h.facilitation(conv)).id);
  assert.deepEqual(sessions.map((s) => [s.kind, s.status]), [['async', 'running'], ['live', 'ended']]);
});

test('hybrid: the speaking order puts remote voices first when the room has spoken more, and rotates who starts', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-hybrid', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Team rules', definitionOfDone: 'Rules agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  assert.match(await tool(conv, 'facilitation_speaking_order'), /^Posted: Anna, Bert, Cara, Dave\.$/);
  assert.match(await tool(conv, 'facilitation_speaking_order'), /^Posted: Bert, Cara, Dave, Anna\.$/);

  await tool(conv, 'facilitation_session', { action: 'schedule', title: 'Workshop', start: inMinutes(1), modality: 'hybrid', room: ['Anna', 'Bert'] });
  await tool(conv, 'facilitation_session', { action: 'start' });
  await say(conv, 'anna', 'No meetings on Friday');
  await say(conv, 'bert', 'Cameras optional');
  const order = await tool(conv, 'facilitation_speaking_order');
  assert.match(order, /\(remote first\)\.$/);
  assert.match(last(conv), /^Speaking order for this round \(remote first\): (Cara, Dave|Dave, Cara), /);
  await say(conv, 'cara', 'so, my turn?');
  const context = h.kernel.turns.at(-1)?.engineContext ?? '';
  assert.match(context, /In the room: Anna, Bert\. Remote: Cara, Dave\./);
  assert.match(context, /ask the remote voices first/);
  assert.match(context, /# Moderation playbook/);
});

test('adaptation mid-session: transcribed speech appears, the facilitator announces it and waits for consent, then records speech as unconfirmed; no restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-adapt', [ANNA, BERT, CARA]);
  h.kernel.capabilities(conv, ['text'], ['text', 'private_messages']);
  const f = await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Anna', kind: 'vote', summary: 'Thai', ballot: 'A' }), /^Refused \(no_speech\)/);

  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text', 'private_messages']));
  await h.settle();
  const [gained, proposal] = posts(conv).slice(-2);
  assert.equal(gained, 'Something changed in this session. I can now also perceive: what is said in the call, as a transcript with the speaker.');
  assert.match(proposal ?? '', /^Proposal: process the transcribed speech of this call.*Raw audio and video are not stored.*"stop listening"/s);
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Anna', kind: 'vote', summary: 'Thai', ballot: 'A' }), /^Refused \(no_consent\)/, 'nothing spoken is processed before consent');

  // Consent to being listened to is given as a reply to the request, nothing else.
  const request = h.kernel.groupPosts(conv).at(-1)?.messageId ?? '';
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed', { replyTo: request });
  assert.match(last(conv), /^I now follow the transcript of the call\./);
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Anna', kind: 'vote', summary: 'Thai', ballot: 'A' }), /^Recorded for Anna as unconfirmed/);
  assert.equal(last(conv), 'Anna, I heard you say: Thai. Reply "yes" in the chat to confirm, or correct me. It counts once you confirmed.');
  let spoken = (await store.listContributions(h.db.pool, f.id)).find((c) => c.source === 'speech');
  assert.deepEqual([spoken?.status, spoken?.sourceMessageId], ['unconfirmed', null]);
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: nobody yet/);
  await say(conv, 'anna', 'yes');
  spoken = (await store.listContributions(h.db.pool, f.id)).find((c) => c.source === 'speech');
  assert.equal(spoken?.status, 'valid');
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: Anna\n/);

  await say(conv, 'bert', 'stop listening');
  assert.equal(last(conv), 'Bert asked me to stop. I no longer process the speech of this call.');
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Cara', kind: 'vote', summary: 'Pizza', ballot: 'B' }), /^Refused \(no_consent\)/);
  assert.equal((await h.facilitation(conv)).id, f.id, 'the same facilitation throughout');
});

test('explicit consent per participant: silence is not enough', { skip: PG_SKIP }, async () => {
  const strict = await createHarness({ start: '2026-11-18T09:00:00Z', config: { mediaConsentExplicit: true } });
  try {
    const conv = strict.kernel.conversation('se-explicit', [ANNA, BERT]);
    strict.kernel.capabilities(conv, ['text'], ['text']);
    await startActive(strict, conv, { method: 'single', options: ['Thai', 'Pizza'] });
    await strict.kernel.changeCapabilities('mira', strict.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text']));
    await strict.settle();
    await strict.kernel.say(conv, 'anna', 'agreed', { replyTo: strict.kernel.groupPosts(conv).at(-1)?.messageId ?? '' });
    await strict.settle();
    strict.clock.advance(HOUR_MS);
    await strict.tick();
    assert.equal(strict.kernel.groupPosts(conv).at(-1)?.text, 'Understood. I do not process the speech of this call and continue with chat and polls only.');
  } finally {
    await strict.close();
  }
});

test('review 7: consent to processing speech is never given by a message that is not a reply to the request', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('se-consent-bound', [ANNA, BERT]);
  h.kernel.capabilities(conv, ['text'], ['text']);
  await startActive(h, conv, { method: 'consent', statement: 'We record our meetings' });
  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text']));
  await h.settle();
  const request = h.kernel.groupPosts(conv).at(-1);
  // Both agree to the DECISION. That is not consent to being listened to.
  await say(conv, 'anna', 'einverstanden');
  await say(conv, 'bert', 'agreed');
  const f = await h.facilitation(conv);
  const session = (await store.listSessions(h.db.pool, f.id)).find((s) => s.kind === 'async');
  assert.equal(session?.mediaConsent, 'pending');
  assert.ok(!posts(conv).some((t) => t.startsWith('I now follow the transcript')));
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Anna', kind: 'position', summary: 'x' }), /^Refused \((no_consent|no_facilitation)\)/);
  assert.ok(request?.text.includes('Reply to this message'));
});
