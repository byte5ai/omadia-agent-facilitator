// D15 (live runs on 1.0.1): the participant list was empty at the start. The
// engine never treats an empty or partial list as "everybody contributed".

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, DAVE, FOUR, createHarness } from './harness.js';
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
const start = (conv: string, extra: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool('facilitation_start', { ...VOTE, ...extra }, { conversation: conv, caller });
async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const names = async (conv: string): Promise<string[]> => (await store.listParticipants(h.db.pool, (await h.facilitation(conv)).id)).map((p) => p.principalId).sort();
/** A conversation whose members the channel cannot list. */
const unlisted = (id: string): string => h.kernel.conversation(id, FOUR, { noRoster: true });

test('without a member list a vote needs the participants or a deadline; nothing is created otherwise', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-refuse');
  const answer = await start(conv);
  assert.match(answer, /^Refused \(participants_unknown\)/);
  assert.match(answer, /participants/);
  assert.match(answer, /deadline/);
  assert.equal(posts(conv).length, 0);
  assert.match(await start(conv, { deadline: inHours(3), closeRule: 'all_contributed' }), /^Refused \(participants_unknown\)/);
  await assert.rejects(h.facilitation(conv));
  assert.equal(h.kernel.subscriptions.size, 0, 'the conversation is not read for a facilitation that was refused');
});

test('without a member list a vote with a deadline is evaluated at the deadline, and the handshake says why', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-deadline');
  await start(conv, { deadline: inHours(3) });
  const f = await h.facilitation(conv);
  assert.equal(f.closeRule, 'at_deadline');
  assert.match(posts(conv)[0] ?? '', /I cannot see who belongs to this conversation, so I cannot tell when everybody has voted\. I evaluate at the deadline\./);
  assert.doesNotMatch(posts(conv)[0] ?? '', /until everybody has contributed/);
  // The first ballot of anybody is not "everybody".
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  // The reminder has nobody to write to privately; the group is reminded.
  h.clock.advance(HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.match(posts(conv).at(-1) ?? '', /^Reminder: this vote is open until /);
  assert.equal((await store.listEvents(h.db.pool, f.id, ['reminder'])).length, 1);
  h.clock.advance(2 * HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('the initiator always takes part and gets the report, with or without a member list', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-initiator');
  await start(conv, { deadline: inHours(1) });
  const f = await h.facilitation(conv);
  assert.deepEqual(await names(conv), ['user:anna']);
  assert.equal(f.initiatorParticipant, 'user:anna');
  const before = h.kernel.dms.length;
  h.clock.advance(HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal((await store.listEvents(h.db.pool, f.id, ['initiator_report_skipped'])).length, 0);
  assert.deepEqual(h.kernel.dms.slice(before).map((d) => d.principal), ['user:anna']);
});

test('participants named in the request are taken: resolved against the member list, the initiator included, nobody else', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pa-named', FOUR);
  const answer = await start(conv, { participants: ['bert', 'Cara'] });
  assert.match(answer, /Participants: Anna, Bert, Cara\./);
  assert.deepEqual(await names(conv), ['user:anna', 'user:bert', 'user:cara']);
  assert.match(posts(conv)[0] ?? '', /Participants: Anna, Bert, Cara\n/);
  await say(conv, 'dave', 'A');
  assert.deepEqual(await names(conv), ['user:anna', 'user:bert', 'user:cara'], 'somebody who was not named is not counted');
  for (const who of ['anna', 'bert']) await say(conv, who, 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await say(conv, 'cara', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('a named participant nobody can be matched to is kept as named, asked to write, and waited for', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-expected');
  const answer = await start(conv, { participants: ['Anna', 'Bert', 'Cara'] });
  assert.match(answer, /Not matched to a person yet: Anna, Bert, Cara/);
  const handshake = posts(conv)[0] ?? '';
  assert.match(handshake, /Participants: Anna, Bert, Cara\nI do not know yet who of you Anna, Bert, Cara are: please write here once\./);
  assert.equal((await h.facilitation(conv)).closeRule, 'all_contributed');
  await say(conv, 'anna', 'A');
  await say(conv, 'dave', 'B');
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'Cara is still waited for');
  assert.deepEqual(await names(conv), ['user:anna', 'user:bert']);
  assert.match(await h.tool('facilitation_status', {}, { conversation: conv }), /Still open: 1 contribution/);
  await say(conv, 'cara', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.deepEqual((await h.facilitation(conv)).settings.expected ?? [], []);
});

test('a facilitation that runs without a member list never closes on "everybody contributed", whatever its close rule says', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-legacy');
  await start(conv, { deadline: inHours(2) });
  const f = await h.facilitation(conv);
  // As 1.0.3 and older stored it.
  await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET close_rule = 'all_contributed' WHERE id = $1`, [f.id]);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  assert.match(await h.tool('facilitation_propose_change', { change: 'close_rule', closeRule: 'all_contributed' }, { conversation: conv }), /^Refused \(participants_unknown\)/);
});

test('a proposal is not accepted early by "everybody agreed" while the list is unknown', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-proposal');
  await start(conv, { deadline: inHours(48) });
  await h.tool('facilitation_propose_change', { change: 'deadline', deadline: inHours(72) }, { conversation: conv });
  await say(conv, 'anna', 'agreed');
  const f = await h.facilitation(conv);
  assert.ok(await store.openProposal(h.db.pool, f.id), 'one voice is not everybody: the window stays open');

  const known = h.kernel.conversation('pa-proposal-known', [ANNA, BERT]);
  await start(known, { deadline: inHours(48) });
  await h.tool('facilitation_propose_change', { change: 'deadline', deadline: inHours(72) }, { conversation: known });
  for (const who of ['anna', 'bert']) await say(known, who, 'agreed');
  assert.equal(await store.openProposal(h.db.pool, (await h.facilitation(known)).id), undefined);
});

test('a reminder with nobody left to remind says so on record', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pa-nobody', [CARA, DAVE]);
  await start(conv, { deadline: inHours(3), closeRule: 'at_deadline' }, 'cara');
  for (const who of ['cara', 'dave']) await say(conv, who, 'A');
  const f = await h.facilitation(conv);
  const before = posts(conv).length;
  h.clock.advance(HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal(posts(conv).length, before);
  assert.deepEqual((await store.listEvents(h.db.pool, f.id, ['reminder_skipped'])).map((e) => e.payload['reason']), ['nobody_waiting']);
});

test('the participants can be named with a second call while the facilitation is set up', { skip: PG_SKIP }, async () => {
  const conv = unlisted('pa-second-call');
  assert.match(await start(conv, { deadline: inHours(5), open: false }), /phase: configuring/);
  assert.equal((await h.facilitation(conv)).closeRule, 'at_deadline');
  await start(conv, { deadline: inHours(5), participants: ['Anna', 'Bert'] });
  const f = await h.facilitation(conv);
  assert.equal(f.closeRule, 'all_contributed');
  assert.equal(f.settings.openRoster, undefined);
  assert.deepEqual(f.settings.expected, ['Anna', 'Bert']);
  assert.doesNotMatch(posts(conv)[0] ?? '', /I evaluate at the deadline/);
  await say(conv, 'anna', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});
