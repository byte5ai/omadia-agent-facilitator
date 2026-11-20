// The electorate of a session (spec 5.5, 6.3; #2076): a step run inside a
// live session may declare the session's participants; the media consent of
// a linked session is decided by the people in the call, guests included.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { participationOf } from '../src/engine/status.js';
import type { FakeUser } from './fakeKernel.js';
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

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}

/** A running vote at home (Anna, Bert, Cara) and a live session in a linked
 *  meeting chat where Anna sits with a guest. */
async function liveSession(name: string) {
  const home = h.kernel.conversation(`${name}-home`, [ANNA, BERT, CARA]);
  const gus: FakeUser = { id: `gus-${name}`, displayName: 'Gus Guest' };
  const meeting = h.kernel.conversation(`${name}-meeting`, [ANNA, gus]);
  const goal = `Venue ${name}`;
  const f = await startActive(h, home, { goal, method: 'single', options: ['Thai', 'Pizza'] });
  await h.tool('facilitation_session', { action: 'schedule', title: 'Venue call', start: new Date(h.clock.now().getTime() + 30 * MINUTE_MS).toISOString(), modality: 'online' }, { conversation: home });
  await h.kernel.linkRequest(meeting, 'anna', `@mira link this chat to ${goal}`);
  await h.settle();
  await h.kernel.sessionEvent('mira', meeting, `m-${name}`, 'session_started');
  await h.settle();
  const session = (await store.listSessions(h.db.pool, f.id)).find((s) => s.kind === 'live');
  assert.equal(session?.status, 'live');
  assert.equal(session?.electorateSource, 'platform_roster', 'the meeting chat listed every member when it was linked');
  return { home, meeting, f, gus: gus.id };
}

test('§5.5: by default a step counts the home participants, and a session-only participant is never missing there', { skip: PG_SKIP }, async () => {
  const { home, f } = await liveSession('el-home');
  const participation = await participationOf(h.db.pool, await h.facilitation(home));
  assert.deepEqual(participation.missing.map((p) => p.principalId).sort(), ['user:anna', 'user:bert', 'user:cara']);
  assert.equal(f.id, (await h.facilitation(home)).id);
});

test('§5.5: a step run inside a live session declares its participants; they decide it, people only at home are not eligible', { skip: PG_SKIP }, async () => {
  const { home, meeting, f, gus } = await liveSession('el-session');
  const declared = await h.tool('facilitation_step_electorate', { scope: 'session' }, { conversation: home });
  assert.match(declared, /is now decided by the participants of the session "Venue call"/);
  assert.match(posts(meeting).at(-1) ?? '', /is decided by the participants of "Venue call", here in this chat\./);
  let participation = await participationOf(h.db.pool, await h.facilitation(home));
  assert.deepEqual(participation.missing.map((p) => p.principalId).sort(), ['user:anna', `user:${gus}`]);

  // Bert is only at home: his ballot takes no effect on this step.
  await say(home, 'bert', 'B');
  assert.equal((await store.listContributions(h.db.pool, f.id)).some((c) => c.participantPrincipal === 'user:bert'), false);
  // The guest votes in the meeting chat, and so does Anna: complete, decided.
  await say(meeting, gus, 'B');
  participation = await participationOf(h.db.pool, await h.facilitation(home));
  assert.deepEqual(participation.missing.map((p) => p.principalId), ['user:anna']);
  assert.ok((await store.listContributions(h.db.pool, f.id)).some((c) => c.participantPrincipal === `user:${gus}` && c.status === 'valid'));
  // Once somebody contributed, the electorate stays.
  assert.match(await h.tool('facilitation_step_electorate', { scope: 'home' }, { conversation: home }), /^Refused \(step_has_contributions\)/);
  await say(meeting, 'anna', 'B');
  await h.tick();
  const decided = await h.facilitation(home);
  assert.notEqual(decided.phase, 'active', 'both session participants voted: the step is decided');
});

test('§5.5: leaving the meeting chat ends only the session membership', { skip: PG_SKIP }, async () => {
  const { home, meeting, f } = await liveSession('el-leave');
  await h.tool('facilitation_step_electorate', { scope: 'session' }, { conversation: home });
  h.kernel.leave(meeting, 'anna');
  await h.settle();
  const participation = await participationOf(h.db.pool, await h.facilitation(home));
  assert.equal(participation.missing.some((p) => p.principalId === 'user:anna'), false, 'no longer in the session');
  assert.equal((await store.getParticipant(h.db.pool, f.id, 'user:anna'))?.status, 'active', 'still a home participant');
});

test('§6.3: in a linked session the media consent is asked in its chat, and a guest can object', { skip: PG_SKIP }, async () => {
  const { meeting, f, gus } = await liveSession('el-media');
  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(meeting, ['text', 'transcribed_speech'], ['text']));
  await h.settle();
  const request = h.kernel.groupPosts(meeting).at(-1);
  assert.match(request?.text ?? '', /^Proposal: process the transcribed speech of this call/);
  await say(meeting, gus, 'objection: I do not want to be transcribed', { replyTo: request?.messageId ?? '' });
  assert.match(posts(meeting).at(-1) ?? '', /^Gus Guest objects: I do not want to be transcribed/);
  await passWindow(h, `${'el-media'}-home`);
  const session = (await store.listSessions(h.db.pool, f.id)).find((s) => s.kind === 'live');
  assert.equal(session?.mediaConsent, 'refused');
  assert.match(posts(meeting).at(-1) ?? '', /I do not process the speech of this call/);
});
