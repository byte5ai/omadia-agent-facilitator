// The known electorate (spec 5.5; #2061, criteria 35 and 44): the source of
// the list is fixed at start; with the platform roster the channel is asked
// fresh before every automatic decision, and anything but `complete` holds
// the decision; a declared list grows by naming and posting, never shrinks
// by others.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { FINAL_ELECTORATE_MAX_MS, finalConsentElectorate } from '../src/engine/electorate.js';
import { ANNA, BERT, CARA, DAVE, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const phase = async (conv: string): Promise<string> => (await h.facilitation(conv)).phase;
const sources = async (conv: string): Promise<Record<string, string>> =>
  Object.fromEntries((await store.listParticipants(h.db.pool, (await h.facilitation(conv)).id)).map((p) => [p.principalId, p.source]));
const notices = (conv: string): number => posts(conv).filter((p) => /^I cannot verify right now who belongs/.test(p)).length;

test('a complete member list at start fixes the platform roster; the start asks it fresh', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-source', [ANNA, BERT]);
  h.kernel.rosterStatus.set(conv, 'complete');
  await h.tool('facilitation_start', VOTE, { conversation: conv });
  const f = await h.facilitation(conv);
  assert.equal(f.electorateSource, 'platform_roster');
  assert.ok(h.kernel.rosterAsks.some((a) => a.conversationId === conv && a.fresh === true), 'the source is fixed on a fresh answer');
  assert.deepEqual(await sources(conv), { 'user:anna': 'roster', 'user:bert': 'roster' });
});

test('criterion 35: a join the channel did not report within the cache lifetime is found by the fresh query before the decision', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-missed-join', [ANNA, BERT]);
  h.kernel.rosterCacheMs = 5 * MINUTE_MS;
  await h.tool('facilitation_start', VOTE, { conversation: conv });
  // A plain roster read caches the list for five minutes; Cara joins within
  // them, and her membership event is lost.
  await h.kernel.kernel().rosters()?.getRoster('teams', conv);
  h.kernel.join(conv, CARA, { missed: true });
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  assert.equal(await phase(conv), 'active', 'Cara, found by the fresh query, has not voted yet');
  assert.equal((await sources(conv))['user:cara'], 'roster');
  assert.ok(posts(conv).some((p) => /^Welcome, Cara\./.test(p)));
  await say(conv, 'cara', 'B');
  assert.equal(await phase(conv), 'closed');
  h.kernel.rosterCacheMs = 0;
});

test('criterion 35: a fresh answer `partial` holds the automatic decision, says so once, and a later `complete` lets it through', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-partial', [ANNA, BERT]);
  await h.tool('facilitation_start', VOTE, { conversation: conv });
  h.kernel.rosterStatus.set(conv, 'partial');
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  assert.equal(await phase(conv), 'active', 'no decision on a list that is not complete');
  assert.equal(notices(conv), 1);
  const f = await h.facilitation(conv);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['electorate_unverified'])).length, 1);
  // The next contribution asks again: still partial, nothing new is said.
  await say(conv, 'bert', 'B');
  assert.equal(await phase(conv), 'active');
  assert.equal(notices(conv), 1, 'the group is told once');
  h.kernel.rosterStatus.set(conv, 'complete');
  await say(conv, 'bert', 'A');
  assert.equal(await phase(conv), 'closed');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['electorate_verified'])).length, 1);
});

test('criterion 35: an unknown roster at the decision is retried at the next reminder', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-reminder', [ANNA, BERT]);
  await h.tool('facilitation_start', { ...VOTE, deadline: inHours(3) }, { conversation: conv });
  h.kernel.rosterStatus.set(conv, 'unknown');
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'B');
  await say(conv, 'bert', 'A');
  assert.equal(await phase(conv), 'active');
  h.kernel.rosterStatus.set(conv, 'complete');
  // The reminder two hours before the deadline.
  h.clock.advance(HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal(await phase(conv), 'closed', 'the held decision is taken at the reminder');
});

test('criterion 35: a declared list counts the initiator\'s names, a person named by somebody else who confirmed, and a person who posted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-declared', [ANNA, BERT, CARA, DAVE], { partialRoster: true });
  const answer = await h.tool('facilitation_start', { ...VOTE, participants: ['Anna', 'Bert'] }, { conversation: conv });
  assert.match(answer, /Participants:/);
  assert.equal((await h.facilitation(conv)).electorateSource, 'declared_list');
  // Bert names Dave, who is missing; Dave counts once he writes himself.
  assert.match(await h.tool('facilitation_name_participant', { name: 'Dave' }, { conversation: conv, caller: 'bert' }), /was named/);
  assert.match(posts(conv).at(-1) ?? '', /^Bert named Dave as a participant\. Dave, please write here once/);
  assert.match(await h.tool('facilitation_name_participant', { name: 'Dave' }, { conversation: conv, caller: 'anna' }), /already named/);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  assert.equal(await phase(conv), 'active', 'Dave is waited for');
  // Cara is on nobody's list and posts: she is added and welcomed.
  await say(conv, 'cara', 'B');
  assert.ok(posts(conv).some((p) => /^Welcome, Cara\./.test(p)));
  await say(conv, 'dave', 'A');
  assert.deepEqual(await sources(conv), { 'user:anna': 'roster', 'user:bert': 'declared', 'user:cara': 'posted', 'user:dave': 'named' });
  assert.equal(await phase(conv), 'closed', 'all four voted: the completeness decision counts the posted and the named person');
});

test('naming somebody on a complete platform roster is refused; nobody is removed by others', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-name-refused', [ANNA, BERT]);
  await h.tool('facilitation_start', VOTE, { conversation: conv });
  assert.match(await h.tool('facilitation_name_participant', { name: 'Cara' }, { conversation: conv, caller: 'bert' }), /^Refused \(roster_complete\)/);
});

test('a proposal whose window ends on a partial roster is held, and passes once the list is complete', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-proposal', [ANNA, BERT]);
  await h.tool('facilitation_start', { ...VOTE, deadline: inHours(48) }, { conversation: conv });
  await h.tool('facilitation_propose_change', { change: 'deadline', deadline: inHours(72) }, { conversation: conv, caller: 'anna' });
  const f = await h.facilitation(conv);
  const proposal = await store.openProposal(h.db.pool, f.id);
  assert.ok(proposal);
  h.kernel.rosterStatus.set(conv, 'partial');
  h.clock.set(new Date(proposal.windowEndsAt.getTime() + MINUTE_MS));
  await h.tick();
  assert.equal((await store.openProposal(h.db.pool, f.id))?.id, proposal.id, 'held: nobody objected, but the list is not verified');
  assert.equal(notices(conv), 1);
  h.kernel.rosterStatus.set(conv, 'complete');
  h.clock.advance(HOUR_MS);
  await h.tick();
  assert.equal(await store.openProposal(h.db.pool, f.id), undefined);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['proposal_accepted'])).length, 1);
});

test('criterion 44: the final consent asks the roster fresh, then hourly for at most 24 hours, then gives up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('el-final', [ANNA, BERT]);
  await h.tool('facilitation_start', VOTE, { conversation: conv });
  const f = await h.facilitation(conv);
  const windowEnd = h.clock.now();
  const ask = () => h.engine.core.work(f.id, (w) => finalConsentElectorate(w, windowEnd));
  assert.deepEqual(await ask(), { state: 'verified' });
  h.kernel.rosterStatus.set(conv, 'partial');
  const retry = await ask();
  assert.equal(retry.state, 'retry');
  assert.equal(retry.state === 'retry' ? retry.at.getTime() - h.clock.now().getTime() : 0, HOUR_MS);
  h.clock.set(new Date(windowEnd.getTime() + FINAL_ELECTORATE_MAX_MS - 10 * MINUTE_MS));
  const last = await ask();
  assert.equal(last.state === 'retry' ? last.at.getTime() : 0, windowEnd.getTime() + FINAL_ELECTORATE_MAX_MS, 'never past the 24 hours');
  h.clock.set(new Date(windowEnd.getTime() + FINAL_ELECTORATE_MAX_MS));
  assert.deepEqual(await ask(), { state: 'unverifiable' });
  assert.equal(notices(conv), 0, 'the final consent says nothing to the group itself');
});
