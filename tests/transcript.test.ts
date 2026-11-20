// Spoken contributions from transcript segments (spec 5.3; #2077, #2089;
// criterion 62): the platform principal of a personal media channel is the
// author and confirms exactly one revision; a shared stream claims no
// author, and a participant may adopt exactly one revision.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { ANNA, BERT, CARA, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-20T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string) => h.kernel.groupPosts(conv);
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
async function segment(conv: string, input: Parameters<Harness['kernel']['transcript']>[1]) {
  await h.kernel.transcript(conv, input);
  await h.settle();
}

/** A running facilitation that hears the call, with the group's consent. */
async function listening(name: string, extra: Record<string, unknown>) {
  const conv = h.kernel.conversation(name, [ANNA, BERT, CARA]);
  h.kernel.capabilities(conv, ['text'], ['text', 'private_messages']);
  const f = await startActive(h, conv, extra);
  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text', 'private_messages']));
  await h.settle();
  const request = posts(conv).at(-1)?.messageId ?? '';
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed', { replyTo: request });
  await passWindow(h, conv);
  assert.match(posts(conv).at(-1)?.text ?? '', /^I now follow the transcript of the call\./);
  return { conv, f };
}

test('criterion 62, personal microphone: the segment counts after its author confirms exactly that revision; nobody else, and no older revision', { skip: PG_SKIP }, async () => {
  const { conv, f } = await listening('tr-personal', { method: 'single', options: ['Thai', 'Pizza'] });
  await segment(conv, { segmentId: 'p-1', text: 'A', source: 'participant', userId: 'anna', speakerHint: 'Cara' });
  const firstAsk = posts(conv).at(-1);
  assert.match(firstAsk?.text ?? '', /^Anna, the transcript has you saying: "A"/);
  // The text is corrected: the earlier revision is retired.
  await segment(conv, { segmentId: 'p-1', text: 'B', source: 'participant', userId: 'anna' });
  const speech = async () => (await store.listContributions(h.db.pool, f.id)).filter((c) => c.source === 'speech');
  assert.deepEqual((await speech()).map((c) => [c.sourceRevision, c.status]), [[0, 'superseded'], [1, 'unconfirmed']]);
  // Somebody else confirms: nothing. Anna confirms the old question: nothing.
  await say(conv, 'bert', 'yes');
  await say(conv, 'anna', 'yes', { replyTo: firstAsk?.messageId ?? '' });
  assert.deepEqual((await speech()).map((c) => c.status), ['superseded', 'unconfirmed']);
  await say(conv, 'anna', 'yes');
  assert.deepEqual((await speech()).map((c) => [c.sourceRevision, c.status, c.participantPrincipal]), [[0, 'superseded', 'user:anna'], [1, 'valid', 'user:anna']]);
  // Replay and restart create nothing new.
  await h.restart();
  await h.tick();
  assert.equal((await speech()).length, 2);
  assert.equal((await h.facilitation(conv)).id, f.id);
});

test('criterion 62, shared room microphone: no author is claimed; an adoption of exactly that revision is one contribution "adopted from the transcript"', { skip: PG_SKIP }, async () => {
  const { conv, f } = await listening('tr-shared', { goal: 'Team offsite', definitionOfDone: 'Ideas collected', agenda: [{ kind: 'collect', title: 'Ideas' }, { kind: 'close', title: 'Close' }] });
  // The speaker recognition says "Bert": nothing is attributed to him.
  await segment(conv, { segmentId: 's-1', text: 'Hiking in the Alps', source: 'shared', speakerHint: 'Bert' });
  const shown = posts(conv).at(-1);
  assert.equal(shown?.text, 'From the room transcript: "Hiking in the Alps". Whoever said this can reply "mine" to this message to adopt it as their own contribution.');
  assert.equal((await store.listContributions(h.db.pool, f.id)).length, 0);

  await say(conv, 'cara', 'mine', { replyTo: shown?.messageId ?? '' });
  await say(conv, 'cara', 'mine', { replyTo: shown?.messageId ?? '' });
  const adopted = () => store.listContributions(h.db.pool, f.id).then((all) => all.filter((c) => c.payload['adoptedFromTranscript'] === true));
  assert.deepEqual((await adopted()).map((c) => [c.participantPrincipal, c.status, c.payload['segmentRevision']]), [['user:cara', 'valid', 0]], 'a second adoption creates nothing');
  assert.equal(posts(conv).at(-1)?.text, 'Cara adopted this from the transcript.');

  // A corrected text: adopting the older revision counts nothing.
  await segment(conv, { segmentId: 's-1', text: 'Hiking in the Dolomites', source: 'shared' });
  const corrected = posts(conv).at(-1);
  await say(conv, 'bert', 'mine', { replyTo: shown?.messageId ?? '' });
  assert.match(posts(conv).at(-1)?.text ?? '', /^Bert, that transcript text was corrected since/);
  await say(conv, 'bert', 'mine', { replyTo: corrected?.messageId ?? '' });
  assert.deepEqual((await adopted()).map((c) => [c.participantPrincipal, c.payload['segmentRevision']]).sort(), [['user:bert', 1], ['user:cara', 0]]);

  // The protocol says adopted, never "said by".
  const protocol = await buildProtocol(h.db.pool, await h.facilitation(conv));
  assert.match(protocol, /Bert: Hiking in the Dolomites \(adopted from the transcript\)/);
  assert.doesNotMatch(protocol, /said by/i);

  await h.restart();
  await h.tick();
  assert.equal((await adopted()).length, 2, 'replay after a restart adopts nothing again');
});

test('#2089: a segment revision that a later one replaced, read on replay, counts nothing', { skip: PG_SKIP }, async () => {
  const { conv, f } = await listening('tr-superseded', { goal: 'Retro', definitionOfDone: 'Ideas collected', agenda: [{ kind: 'collect', title: 'Ideas' }, { kind: 'close', title: 'Close' }] });
  const old = await h.kernel.transcript(conv, { segmentId: 'x-1', text: 'first', source: 'participant', userId: 'bert' });
  await h.kernel.transcript(conv, { segmentId: 'x-1', text: 'second', source: 'participant', userId: 'bert' });
  await h.settle();
  // The kernel marks the older revision on every read; handed over again it is refused.
  await h.engine.receive('mira', { ...old, eventId: `${old.eventId}-again`, superseded: true, latestRevision: 1 });
  await h.settle();
  const outcome = await h.db.pool.query<{ outcome: string }>(`SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 AND event_id = $2`, [f.id, `${old.eventId}-again`]);
  assert.equal(outcome.rows[0]?.outcome, 'superseded_revision');
  assert.equal((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'unconfirmed').length, 1);
  // The same for a message: an edited ballot's first revision, handed over again, is refused.
  const first = await h.kernel.say(conv, 'cara', 'Retro idea one');
  await h.kernel.edit(conv, 'cara', first.messageId, 'Retro idea two');
  await h.settle();
  await h.engine.receive('mira', { ...first, eventId: `${first.eventId}-again`, superseded: true, latestRevision: 1 });
  await h.settle();
  const refused = await h.db.pool.query<{ outcome: string }>(`SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 AND event_id = $2`, [f.id, `${first.eventId}-again`]);
  assert.equal(refused.rows[0]?.outcome, 'superseded_revision');
});
