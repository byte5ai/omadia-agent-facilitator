// Acceptance suite, session paths (spec 9, criteria 22, 29, 46, 54, 60;
// byte5ai/omadia#2068).
//
// End to end on the fake kernel with its simulated channel, a fake clock and
// a real Postgres. "In each of Teams, Slack, Discord and Telegram" runs the
// same path once per transport: the fake kernel set to that channel type.
// What the other session tests already prove is not repeated here (see
// docs/acceptance-matrix.md).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { listClosings } from '../src/engine/resultStatus.js';
import type { Session } from '../src/model.js';
import type { FakeUser } from './fakeKernel.js';
import { ANNA, BERT, CARA, DAVE, createHarness, passWindow, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const CHANNELS = ['teams', 'slack', 'discord', 'telegram'] as const;

const at = (h: Harness, minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const textsIn = (h: Harness, conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const liveSessionOf = async (h: Harness, facilitationId: string): Promise<Session | undefined> => (await store.listSessions(h.db.pool, facilitationId)).find((s) => s.kind === 'live');
async function say(h: Harness, conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
async function link(h: Harness, meeting: string, goal: string, who = 'anna'): Promise<void> {
  await h.kernel.linkRequest(meeting, who, `@mira link this chat to ${goal}`);
  await h.settle();
}

// ── criterion 29, first half, and criterion 60: per transport ──────────────

for (const channel of CHANNELS) {
  test(`29. ${channel}: the link is confirmed in the session chat before the session starts; after the slot a consent answer without a mention counts, a late vote is refused, stop works during \`confirming\``, { skip: PG_SKIP }, async () => {
    const h = await createHarness({ start: '2026-11-20T09:00:00Z', channel });
    try {
      const home = h.kernel.conversation(`sp29-${channel}-home`, [ANNA, BERT, CARA]);
      const meeting = h.kernel.conversation(`sp29-${channel}-meeting`, [ANNA, BERT, CARA]);
      const goal = `Lunch place ${channel}`;
      // A free-text definition of done (the agenda's vote gets its options
      // only once open, so nothing is checked automatically).
      await h.tool('facilitation_start', { goal, definitionOfDone: 'Everybody can live with the place', agenda: [{ kind: 'decide', title: 'Vote' }, { kind: 'discuss', title: 'Wrap-up' }] }, { conversation: home });
      await h.tool('facilitation_open', {}, { conversation: home });
      assert.match(await h.tool('facilitation_set_decision', { method: 'single', options: ['Thai', 'Pizza'], title: 'Vote' }, { conversation: home }), /^Set\./);
      await h.tool('facilitation_session', { action: 'schedule', title: 'Lunch call', start: at(h, 60), end: at(h, 120), modality: 'online' }, { conversation: home });
      const f = await h.facilitation(home);
      assert.equal(f.channelType, channel);

      // The link is confirmed in the session conversation, before the session starts.
      await link(h, meeting, goal);
      assert.equal((await liveSessionOf(h, f.id))?.status, 'scheduled');
      assert.match(textsIn(h, meeting).at(-1) ?? '', new RegExp(`^This chat is now linked to "${goal}" as the conversation of the session "Lunch call"`));

      // The slot: Anna votes in the meeting chat, without a mention.
      h.clock.advance(61 * MINUTE_MS);
      await h.tick();
      assert.equal((await liveSessionOf(h, f.id))?.status, 'live');
      await say(h, meeting, 'anna', 'A');
      const counted = async (who: string): Promise<number> => (await store.listContributions(h.db.pool, f.id)).filter((c) => c.participantPrincipal === `user:${who}` && c.status === 'valid').length;
      assert.equal(await counted('anna'), 1, 'a vote during the session counts');

      // The slot ends: the summary asks for consent in the session chat.
      h.clock.advance(60 * MINUTE_MS);
      await h.tick();
      await h.tick();
      const session = await liveSessionOf(h, f.id);
      assert.equal(session?.status, 'confirming');
      assert.match(textsIn(h, meeting).join('\n'), /Summary of the session "Lunch call"[\s\S]*Please confirm this summary/);

      // A late vote is refused: it counts nothing.
      await say(h, meeting, 'bert', 'B');
      assert.equal(await counted('bert'), 0, 'a vote after the slot does not count');
      assert.equal((await h.facilitation(home)).phase, 'active');

      // A consent answer without a mention (and not a reply) counts.
      const closingOf = async () => (await listClosings(h.db.pool, f.id)).find((c) => c.sessionId === session?.id);
      await say(h, meeting, 'cara', 'objection: we never talked about the price');
      assert.deepEqual((await closingOf())?.objections.map((o) => o.principal), ['user:cara']);
      assert.match(textsIn(h, meeting).at(-1) ?? '', /^Objection from Cara: we never talked about the price/);
      await say(h, meeting, 'cara', 'agreed');
      assert.deepEqual((await closingOf())?.objections, [], 'agreeing lifts the own objection');

      // Stop works during `confirming`, from the session chat.
      await say(h, meeting, 'anna', 'stop');
      assert.equal((await h.facilitation(home)).phase, 'aborted');
      await h.tick();
      const closing = await closingOf();
      assert.deepEqual([closing?.resultStatus, closing?.resultReason], ['not_confirmed', 'stopped']);
      assert.equal((await liveSessionOf(h, f.id))?.status, 'closed');
    } finally {
      await h.close();
    }
  });

  test(`60. ${channel}: a meeting chat that gets mentions but not every message does not go live and the home conversation is told; once permitted, contributions without a mention count`, { skip: PG_SKIP }, async () => {
    const h = await createHarness({ start: '2026-11-20T09:00:00Z', channel });
    try {
      const home = h.kernel.conversation(`sp60-${channel}-home`, [ANNA, BERT, CARA]);
      const meeting = h.kernel.conversation(`sp60-${channel}-meeting`, [ANNA, BERT]);
      const goal = `Planning ${channel}`;
      await h.tool('facilitation_start', { goal, definitionOfDone: 'Priorities are agreed', agenda: [{ kind: 'collect', title: 'Topics' }, { kind: 'close', title: 'Close' }] }, { conversation: home });
      await h.tool('facilitation_open', {}, { conversation: home });
      await h.tool('facilitation_session', { action: 'schedule', title: 'Planning call', start: at(h, 120), end: at(h, 180), modality: 'online' }, { conversation: home });
      const f = await h.facilitation(home);
      assert.equal((await h.facilitation(home)).phase, 'active', 'the home conversation is ready');
      h.kernel.notReady.set(`mira|${meeting}`, [{ code: 'not_ready', message: `the ${channel} bot cannot read every message in this chat` }]);
      await link(h, meeting, goal);
      assert.equal(h.kernel.modeOf(f.id, meeting), 'addressed', 'mentions reach it');
      assert.match(textsIn(h, home).at(-1) ?? '', /^The session "Planning call" cannot start in its meeting chat yet: .*cannot read every message/);

      h.clock.advance(121 * MINUTE_MS);
      await h.tick();
      assert.equal((await liveSessionOf(h, f.id))?.status, 'scheduled', 'not live');
      await say(h, meeting, 'bert', 'Budget review');
      assert.equal((await store.listContributions(h.db.pool, f.id)).length, 0, 'nothing counts before it is live');

      h.kernel.notReady.delete(`mira|${meeting}`);
      h.clock.advance(6 * MINUTE_MS);
      await h.tick();
      assert.equal((await liveSessionOf(h, f.id))?.status, 'live');
      assert.equal(h.kernel.modeOf(f.id, meeting), 'all');
      await say(h, meeting, 'bert', 'Hiring plan');
      assert.deepEqual((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').map((c) => c.participantPrincipal), ['user:bert']);
    } finally {
      await h.close();
    }
  });
}

// ── criteria 22, 46 and 54: one harness ────────────────────────────────────

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-20T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('22. preparation in A, live session in B linked from A, follow-up in A: a contribution from B counts only while the session is live', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('sp22-home', [ANNA, BERT, CARA]);
  const meeting = h.kernel.conversation('sp22-meeting', [ANNA, BERT]);
  const goal = 'Roadmap sp22';
  await h.tool('facilitation_start', { goal, definitionOfDone: 'Topics are collected', agenda: [{ kind: 'collect', title: 'Topics' }, { kind: 'close', title: 'Close' }] }, { conversation: home });
  await h.tool('facilitation_open', {}, { conversation: home });
  await h.tool('facilitation_session', { action: 'schedule', title: 'Roadmap call', start: at(h, 60), end: at(h, 120), modality: 'online' }, { conversation: home });
  await link(h, meeting, goal);
  const f = await h.facilitation(home);
  const sent: string[] = [];
  const fromMeeting = async (): Promise<string[]> => (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid' && sent.includes(c.sourceMessageId ?? '')).map((c) => String(c.payload['summary'] ?? ''));
  const inMeeting = async (text: string): Promise<void> => {
    sent.push((await say(h, meeting, 'bert', text)).messageId);
  };

  // Before the session only what is addressed reaches the facilitator; even that is no contribution.
  await inMeeting('@Mira Mobile app');
  assert.deepEqual(await fromMeeting(), [], 'before the session: nothing from B counts');
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  await inMeeting('Pricing page');
  assert.equal((await fromMeeting()).length, 1, 'during the session it counts');
  h.clock.advance(60 * MINUTE_MS);
  await h.tick();
  await h.tick();
  assert.notEqual((await liveSessionOf(h, f.id))?.status, 'live');
  await inMeeting('Partner portal');
  assert.equal((await fromMeeting()).length, 1, 'after the session nothing from B counts');
  // Follow-up in A goes on as before.
  await say(h, home, 'cara', 'Search');
  assert.ok((await store.listContributions(h.db.pool, f.id)).some((c) => c.participantPrincipal === 'user:cara' && c.status === 'valid'));
});

test('46. a person with both memberships asks privately: each scope\'s part, the home status of one facilitation and only the session status of the other', { skip: PG_SKIP }, async () => {
  // Facilitation one: Fay is a home participant.
  const fay: FakeUser = { id: 'fay-sp46', displayName: 'Fay' };
  const homeOne = h.kernel.conversation('sp46-one', [ANNA, BERT, fay]);
  await startActive(h, homeOne, { goal: 'Offsite sp46', method: 'single', options: ['Lake', 'City'] });
  // Facilitation two: Fay is only in its meeting chat, a guest.
  const homeTwo = h.kernel.conversation('sp46-two', [ANNA, DAVE]);
  const meeting = h.kernel.conversation('sp46-meeting', [ANNA, DAVE, fay]);
  await h.tool('facilitation_start', { goal: 'Budget sp46', definitionOfDone: 'Budget agreed', agenda: [{ kind: 'collect', title: 'Items' }, { kind: 'close', title: 'Close' }] }, { conversation: homeTwo });
  await h.tool('facilitation_open', {}, { conversation: homeTwo });
  await say(h, homeTwo, 'dave', 'Something only the budget group knows');
  await h.tool('facilitation_session', { action: 'schedule', title: 'Budget call', start: at(h, 30), modality: 'online' }, { conversation: homeTwo });
  await link(h, meeting, 'Budget sp46');
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  await say(h, meeting, fay.id, 'Could we look at travel too?');

  const answer = (await h.kernel.privateMessage('mira', fay.id, 'status')) ?? '';
  assert.match(answer, /Offsite sp46/, 'the home part of the facilitation she takes part in');
  assert.match(answer, /Budget call: running/, 'and the session part of the other');
  assert.doesNotMatch(answer, /Budget sp46|Dave|Something only the budget group knows/, 'nothing of the other home conversation');
});

test('54. a session with an unknown roster is linked during `active` while home uses the platform roster: its declared list decides its step and its confirmation; home participants stay unchanged', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('sp54-home', [ANNA, BERT, CARA]);
  const guest: FakeUser = { id: 'gina-sp54', displayName: 'Gina Guest' };
  const meeting = h.kernel.conversation('sp54-meeting', [ANNA, guest], { partialRoster: true });
  const goal = 'Venue sp54';
  await h.tool('facilitation_start', { goal, definitionOfDone: 'Everybody can live with the venue', agenda: [{ kind: 'decide', title: 'Vote' }, { kind: 'discuss', title: 'Wrap-up' }] }, { conversation: home });
  await h.tool('facilitation_open', {}, { conversation: home });
  await h.tool('facilitation_set_decision', { method: 'single', options: ['Thai', 'Pizza'], title: 'Vote' }, { conversation: home });
  const f = await h.facilitation(home);
  assert.deepEqual([f.phase, f.electorateSource], ['active', 'platform_roster']);
  const homeBefore = (await store.listParticipants(h.db.pool, f.id)).map((p) => `${p.principalId}:${p.status}`).sort();

  await h.tool('facilitation_session', { action: 'schedule', title: 'Venue call', start: at(h, 30), end: at(h, 90), modality: 'online' }, { conversation: home });
  await link(h, meeting, goal);
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  const session = await liveSessionOf(h, f.id);
  assert.deepEqual([session?.status, session?.electorateSource], ['live', 'declared_list'], 'the session keeps a declared list');

  // The guest writes and so is on the declared list; the step is run by the session.
  await say(h, meeting, guest.id, 'Hello everybody');
  await h.tool('facilitation_step_electorate', { scope: 'session' }, { conversation: home });
  await say(h, home, 'bert', 'B');
  const valid = async (): Promise<string[]> => (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid').map((c) => c.participantPrincipal).sort();
  assert.deepEqual(await valid(), [], 'a home-only person is not on the session list');
  await say(h, meeting, guest.id, 'B');
  await say(h, meeting, 'anna', 'A');
  assert.deepEqual(await valid(), ['user:anna', `user:${guest.id}`]);

  // Its confirmation: the guest on the declared list may object, and the objection counts.
  h.clock.advance(60 * MINUTE_MS);
  await h.tick();
  await h.tick();
  assert.equal((await liveSessionOf(h, f.id))?.status, 'confirming');
  await say(h, meeting, guest.id, 'objection: the vote was too short');
  const closing = (await listClosings(h.db.pool, f.id)).find((c) => c.sessionId === session?.id);
  assert.deepEqual(closing?.objections.map((o) => o.principal), [`user:${guest.id}`]);
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  const ended = (await listClosings(h.db.pool, f.id)).find((c) => c.sessionId === session?.id);
  assert.deepEqual([ended?.resultStatus, ended?.resultReason], ['not_confirmed', 'objection']);

  // Home participants are unchanged by the session's list.
  const homeAfter = (await store.listParticipants(h.db.pool, f.id)).map((p) => `${p.principalId}:${p.status}`).sort();
  assert.deepEqual(homeAfter, homeBefore);
  assert.equal((await h.facilitation(home)).electorateSource, 'platform_roster');
  await passWindow(h, home);
});
