// D21 (live run): the follow-up stopped with no_addresses because the member
// list had not been readable and the participants were known from their
// messages only. Addresses come from the channel's member list, never from
// the chat.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import type { FakeUser } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-18T09:00:00Z', config: { protocolMailEnabled: true } });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const NAMELESS: FakeUser[] = [
  { id: 'nora', displayName: 'Nora' },
  { id: 'omar', displayName: 'Omar' },
];
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const VOTE = { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true };
const MEETING = { subject: 'Venue follow-up', durationMinutes: 30, earliest: '2026-11-19T08:00:00+00:00', latest: '2026-11-20T16:00:00+00:00' };

test('participants known from their messages get their address from the member list once the channel gives it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ad-late', [ANNA, BERT], { noRoster: true });
  await tool(conv, 'facilitation_start', { ...VOTE, participants: ['Anna', 'Bert'] });
  await say(conv, 'anna', 'A');
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listParticipants(h.db.pool, f.id)).map((p) => p.email), [null]);
  // The channel can list the members now (the facilitator's own bot is asked).
  h.kernel.conversation(conv, [ANNA, BERT]);
  const mailsBefore = followup.mails.length;
  await say(conv, 'bert', 'A');
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.deepEqual((await store.listParticipants(h.db.pool, f.id)).map((p) => p.email).sort(), ['anna@example.com', 'bert@example.com']);
  assert.deepEqual([...(followup.mails.slice(mailsBefore)[0]?.recipients ?? [])].sort(), ['anna@example.com', 'bert@example.com']);
  assert.ok(h.kernel.rosterAsks.filter((a) => a.conversationId === conv).every((a) => a.agentSlug === 'mira'));
});

test('without addresses a follow-up meeting is refused with the reason, and nobody is asked for an address', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ad-none', NAMELESS);
  await tool(conv, 'facilitation_start', VOTE, 'nora');
  const answer = await tool(conv, 'facilitation_plan_followup_meeting', MEETING, 'nora');
  assert.match(answer, /^Refused \(no_addresses\)/);
  assert.match(answer, /does not provide the mail addresses/);
  assert.match(answer, /Do not ask anybody for an address/);
  assert.equal(await store.openProposal(h.db.pool, (await h.facilitation(conv)).id), undefined);
});

test('a protocol mail that has nobody to go to says why and puts the protocol in the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ad-mail', NAMELESS);
  await tool(conv, 'facilitation_start', VOTE, 'nora');
  const mailsBefore = followup.mails.length;
  for (const who of ['nora', 'omar']) await say(conv, who, 'A');
  await h.tick();
  assert.equal(followup.mails.length, mailsBefore);
  const said = posts(conv).filter((p) => /^I cannot mail the protocol/.test(p));
  assert.equal(said.length, 1);
  assert.match(said[0] ?? '', /^I cannot mail the protocol: this channel does not give me the mail addresses of the participants, and I do not collect addresses in the chat\. Here it is instead:\n\nProtocol: Pick a venue\n/);
  void HOUR_MS;
});

test('some participants without an address: the meeting is planned and the tool says who will not be invited by mail', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ad-some', [ANNA, NAMELESS[1] as FakeUser]);
  await tool(conv, 'facilitation_start', VOTE);
  const answer = await tool(conv, 'facilitation_plan_followup_meeting', MEETING);
  assert.match(answer, /^Put to the group\./);
  assert.match(answer, /1 of 2 participants has no mail address here and will not get the invitation/);
});
