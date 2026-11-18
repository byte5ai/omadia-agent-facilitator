// The process (spec 5.4, acceptance 14, 16, 17): agenda, timeboxes, silent
// voices, clusters and summaries by consent, action items, protocol, follow-up.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { FORMATS } from '../src/engine/formats.js';
import { agendaFor } from '../src/engine/lifecycle.js';
import { ANNA, BERT, CARA, FOUR, createHarness } from './harness.js';
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
const everybody = async (conv: string, text: string, who = ['anna', 'bert', 'cara', 'dave']): Promise<void> => {
  for (const person of who) await say(conv, person, text);
};
const openStep = async (conv: string) => store.openStepOf(h.db.pool, (await h.facilitation(conv)).id);
const inDays = (days: number): string => new Date(h.clock.now().getTime() + days * 24 * HOUR_MS).toISOString();

const CONFIG = { rankedPoints: [3, 2, 1], language: 'en' as const };

const EXPECTED: Array<[keyof typeof FORMATS, string[]]> = [
  ['decision', ['open', 'collect', 'discuss', 'decide', 'close']],
  ['prioritisation', ['open', 'collect', 'cluster', 'prioritise', 'close']],
  ['assignment', ['open', 'collect', 'assign', 'close']],
  ['ideas', ['open', 'collect', 'cluster', 'prioritise', 'assign', 'close']],
  ['retrospective', ['open', 'collect', 'cluster', 'discuss', 'decide', 'assign', 'close']],
  ['alignment', ['open', 'collect', 'discuss', 'decide', 'close']],
];
for (const [format, kinds] of EXPECTED) {
  test(`format ${format}: the template agenda`, () => {
    assert.deepEqual(agendaFor({ goal: 'g', format }, CONFIG).map((s) => s.kind), kinds);
  });
}

test('templates are in the language of the facilitation and an agenda of the group replaces them', () => {
  assert.equal(agendaFor({ goal: 'g', format: 'retrospective', language: 'de' }, CONFIG)[1]?.title, 'Was gut lief und was nicht');
  const own = agendaFor({ goal: 'g', format: 'decision', agenda: [{ kind: 'discuss', title: 'Talk', timeboxMinutes: 15 }, { kind: 'decide', title: 'Vote', decision: { method: 'single', options: ['x', 'y'] } }] }, CONFIG);
  assert.deepEqual(own.map((s) => [s.kind, s.title, s.timeboxMinutes ?? null, s.method ?? null]), [
    ['discuss', 'Talk', 15, null],
    ['decide', 'Vote', null, 'single'],
  ]);
});

test('an agenda is announced in the handshake, the opening step is the handshake, the first working step opens with its instruction', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-agenda', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', format: 'decision', facilitatorName: 'Mira' });
  await tool(conv, 'facilitation_open');
  const [handshake, step] = posts(conv);
  assert.match(handshake ?? '', /Agenda:\n1\. Opening\n2\. Collect options and positions\n3\. Discuss\n4\. Decide\n5\. Close/);
  assert.equal(step, 'Step 2 of 5: Collect options and positions. Write what you want to bring in, one point per message.');
  assert.equal((await openStep(conv))?.kind, 'collect');
});

test('silent voices: before a discussion closes, whoever has not contributed is invited privately; the group line names nobody', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-silent', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Team rules', definitionOfDone: 'Rules agreed', agenda: [{ kind: 'discuss', title: 'Discuss the rules' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  for (const who of ['anna', 'bert', 'cara']) {
    const said = await say(conv, who, `${who} thinks we should keep meetings short`);
    await tool(conv, 'facilitation_record_contribution', { messageId: said.messageId, kind: 'position', summary: 'keep meetings short' });
    await say(conv, who, 'yes');
  }
  const dms = h.kernel.dms.length;
  const first = await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(first, /^Not closed yet: 1 person has not contributed/);
  assert.equal((await openStep(conv))?.title, 'Discuss the rules', 'still open');
  assert.deepEqual(h.kernel.dms.slice(dms).map((d) => d.principal), ['user:dave']);
  assert.match(h.kernel.dms.at(-1)?.text ?? '', /Hello Dave, we are about to close "Discuss the rules".*Please write it in the group/);
  assert.equal(last(conv), 'Before we close "Discuss the rules": whoever has not had the chance yet is welcome to add something now.');
  assert.ok(!posts(conv).some((t) => /Dave/.test(t) && /not contributed|has not/.test(t)), 'nobody is named in the group as not having contributed');

  assert.match(await tool(conv, 'facilitation_invite_silent'), /already invited/);
  assert.equal(h.kernel.dms.length, dms + 1, 'each person is invited once per step');
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Closed/);
  assert.ok(posts(conv).includes('"Discuss the rules" is closed.'));
});

test('timebox: when it ends the engine says where the step stands and the group decides to extend or close; nothing closes silently', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-timebox', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Ideas for the offsite', definitionOfDone: 'Ideas collected', agenda: [{ kind: 'collect', title: 'Collect ideas', timeboxMinutes: 10 }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(conv, 'facilitation_open');
  assert.match(last(conv), /^Step 1 of 2: Collect ideas\. .* Timebox until /);
  await say(conv, 'anna', 'A boat trip');
  await say(conv, 'bert', 'Cooking together');
  h.clock.advance(5 * MINUTE_MS);
  await h.tick();
  assert.ok(!posts(conv).some((t) => t.startsWith('The timebox')), 'not before its time');

  h.clock.advance(6 * MINUTE_MS);
  await h.tick();
  const [over, proposal] = posts(conv).slice(-2);
  assert.equal(over, 'The timebox for "Collect ideas" is over. So far: 2 contributions from 2 of 4 people.');
  assert.match(proposal ?? '', /^Proposal: close "Collect ideas" and move on\nIt holds if nobody objects until .*"extend 10" for ten more minutes/);
  assert.equal((await openStep(conv))?.title, 'Collect ideas', 'the step is still open');

  await say(conv, 'cara', 'extend 5');
  assert.match(last(conv), /^"Collect ideas" is extended by 5 minutes, until /);
  assert.equal((await openStep(conv))?.title, 'Collect ideas');
  await say(conv, 'cara', 'A hike');

  h.clock.advance(6 * MINUTE_MS);
  await h.tick();
  assert.equal(posts(conv).filter((t) => t.startsWith('The timebox for')).length, 2);
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  const tail = posts(conv).slice(-3);
  assert.equal(tail[0], 'Accepted, nobody objected: close "Collect ideas" and move on');
  assert.equal(tail[1], '"Collect ideas" is closed.');
  assert.match(tail[2] ?? '', /^Step 2 of 2: Discuss\./);
});

test('a proposal: an objection keeps it from holding, agreeing lifts it, everybody agreeing accepts at once; one at a time', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-proposal', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', { goal: 'Offsite', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'discuss', title: 'Discuss' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  assert.match(await tool(conv, 'facilitation_propose_summary', { text: 'We want an offsite in spring, within budget.' }), /put to the group/);
  assert.match(await tool(conv, 'facilitation_propose_summary', { text: 'another' }), /^Refused \(proposal_open\)/);
  await say(conv, 'anna', 'agreed');
  await say(conv, 'bert', 'Objection: spring is too early');
  assert.equal(last(conv), 'Bert objects: spring is too early. The proposal does not hold while this stands. Bert, write "agreed" if it is resolved for you.');
  await say(conv, 'cara', 'einverstanden');
  const f = await h.facilitation(conv);
  assert.equal((await store.openProposal(h.db.pool, f.id))?.status, 'open', 'not accepted while the objection stands');
  await say(conv, 'bert', 'agreed');
  assert.equal(last(conv), 'Accepted, nobody objected: take this summary into the record:\nWe want an offsite in spring, within budget.');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['summary_confirmed'])).length, 1);

  await tool(conv, 'facilitation_propose_summary', { text: 'Second summary.' });
  await say(conv, 'bert', 'objection: not what we said');
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  assert.equal(last(conv), 'Not accepted: take this summary into the record:\nSecond summary.\nStanding objection:\n- Bert: not what we said');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['summary_confirmed'])).length, 1, 'a summary the group did not confirm is not part of the record');
});

test('retrospective: ideas without mentions, clusters and decisions by consent, action items confirmed by their owners, protocol, reminder before the due date', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-retro', FOUR);
  const turns = h.kernel.turns.length;
  await tool(conv, 'facilitation_start', { goal: 'Retrospective sprint 12', definitionOfDone: 'Actions with owners are agreed', format: 'retrospective', followUp: true, facilitatorName: 'Mira' });
  await tool(conv, 'facilitation_open');
  assert.match(posts(conv)[1] ?? '', /^Step 2 of 7: What went well, what did not\./);

  // Collected without mentioning the facilitator and without a model.
  await say(conv, 'anna', 'Releases were calm');
  await say(conv, 'bert', 'Too many meetings');
  await say(conv, 'cara', 'Standups ran long');
  await say(conv, 'dave', 'Pairing helped');
  assert.equal(h.kernel.turns.length, turns);
  assert.equal(last(conv), 'Recorded for you, Dave: Pairing helped');
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Closed/);
  assert.match(last(conv), /^Step 3 of 7: Cluster\./);

  const listing = await tool(conv, 'facilitation_contributions');
  assert.match(listing, /#1 Anna \(idea\): Releases were calm\n#2 Bert \(idea\): Too many meetings\n#3 Cara \(idea\): Standups ran long\n#4 Dave \(idea\): Pairing helped/);
  assert.match(await tool(conv, 'facilitation_propose_clusters', { clusters: [{ label: 'Meetings', members: [2, 3] }, { label: 'Working together', members: [1, 4] }, { label: 'Ghost', members: [9] }] }), /^Refused \(unknown_contribution\)/);
  await tool(conv, 'facilitation_propose_clusters', { clusters: [{ label: 'Meetings', members: [2, 3] }, { label: 'Working together', members: [1, 4] }] });
  assert.match(last(conv), /^Proposal: group what was collected like this:\n- Meetings: #2, #3\n- Working together: #1, #4/);
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listClusters(h.db.pool, f.id)).map((c) => c.confirmed), [false, false], 'proposed, not yet part of the record');
  await everybody(conv, 'agreed');
  assert.deepEqual((await store.listClusters(h.db.pool, f.id)).map((c) => [c.label, c.confirmed]), [['Meetings', true], ['Working together', true]]);

  await say(conv, 'anna', 'ok, on to the discussion');
  // Everybody spoke in the cluster step (their "agreed" is not a contribution, so the engine invites first).
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(last(conv), /^Step 4 of 7: Discuss\./);
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(last(conv), /^Step 5 of 7: Decide actions\./);

  await tool(conv, 'facilitation_record_decision', { statement: 'Standups are capped at 10 minutes', rationale: 'they ran long and cost focus' });
  await everybody(conv, 'agreed');
  await tool(conv, 'facilitation_record_decision', { statement: 'One meeting-free day per week', rationale: 'too many meetings' });
  await everybody(conv, 'agreed');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(last(conv), /^Step 6 of 7: Assign owners\./);

  assert.match(await tool(conv, 'facilitation_record_action_item', { description: 'Set a 10-minute timer in standups', owner: 'Zoe', dueDate: inDays(7) }), /^Refused \(unknown_person\)/);
  await tool(conv, 'facilitation_record_action_item', { description: 'Set a 10-minute timer in standups', owner: 'Cara', dueDate: inDays(7) });
  assert.match(last(conv), /^Cara, action item #1 is proposed for you: Set a 10-minute timer in standups, due .*Reply "yes"/);
  await say(conv, 'bert', 'yes');
  assert.equal((await store.listActionItems(h.db.pool, f.id))[0]?.status, 'proposed', "somebody else's yes does not bind the owner");
  await say(conv, 'cara', 'yes');
  assert.match(last(conv), /^Action item #1: Set a 10-minute timer in standups\. Owner: Cara, due /);
  await tool(conv, 'facilitation_record_action_item', { description: 'Block Wednesdays in the team calendar', owner: 'Bert', dueDate: inDays(3) });
  await say(conv, 'bert', 'ja');
  assert.deepEqual((await store.listActionItems(h.db.pool, f.id)).map((a) => [a.number, a.status, a.ownerConfirmed]), [[1, 'confirmed', true], [2, 'confirmed', true]]);

  await tool(conv, 'facilitation_park', { topic: 'Tooling for release notes' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  const closing = last(conv);
  assert.match(closing, /^Proposal: close the facilitation with this summary:\nDecisions:\n- Standups are capped at 10 minutes\n- One meeting-free day per week\nNext steps:\n- #1 Set a 10-minute timer in standups \(Cara, due .*\): open\n- #2 Block Wednesdays.*\nOpen points:\n- Tooling for release notes/);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the group confirms before anything closes');
  await everybody(conv, 'agreed');
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.followupState, 'active');
  assert.match(last(conv), /^Result for "Retrospective sprint 12":\n- Standups are capped at 10 minutes\n- One meeting-free day per week/);

  const protocol = await (await import('../src/engine/protocol.js')).buildProtocol(h.db.pool, closed);
  assert.match(protocol, /Decisions:\n- Standups are capped at 10 minutes \(Rationale: they ran long and cost focus\)\n- One meeting-free day per week \(Rationale: too many meetings\)/);
  assert.match(protocol, /Action items:\n- #1 Set a 10-minute timer in standups \(Cara, due .*\): open\n- #2 Block Wednesdays in the team calendar \(Bert, due .*\): open/);
  assert.match(protocol, /Clusters confirmed by the group:\n- Meetings \(2\)\n- Working together \(2\)/);
  assert.match(protocol, /Open points \(parking lot\):\n- Tooling for release notes/);

  // Follow-up: the owner is reminded before the due date.
  const dms = h.kernel.dms.length;
  h.clock.advance(2 * 24 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.deepEqual(h.kernel.dms.slice(dms).map((d) => d.principal), ['user:bert']);
  assert.match(h.kernel.dms.at(-1)?.text ?? '', /Hello Bert, action item #2 is due .*write "done 2" in the group/);
  assert.match(last(conv), /^Bert, action item #2 is due /);
  await say(conv, 'cara', 'done 2');
  assert.equal(last(conv), 'Cara, action item #2 is not yours to close.');
  await say(conv, 'bert', 'done 2');
  assert.equal(last(conv), 'Done, thank you Bert: #2 Block Wednesdays in the team calendar');
  assert.equal((await h.facilitation(conv)).followupState, 'active', 'one item is still open');
  await say(conv, 'cara', 'erledigt 1');
  assert.equal(last(conv), 'The follow-up of the action items has ended. I am no longer reading this conversation.');
  assert.equal((await h.facilitation(conv)).followupState, 'ended');
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false);
});

test('follow-up ends by itself when the last due date has passed', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-followup-end', [ANNA, BERT]);
  await tool(conv, 'facilitation_start', { goal: 'Next steps', definitionOfDone: 'Owners agreed', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await tool(conv, 'facilitation_record_action_item', { description: 'Write the summary', owner: 'Anna', dueDate: inDays(2) });
  await say(conv, 'anna', 'yes');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await everybody(conv, 'agreed', ['anna', 'bert']);
  assert.equal((await h.facilitation(conv)).followupState, 'active');
  h.clock.advance(2 * 24 * HOUR_MS + 2 * MINUTE_MS);
  await h.tick();
  await h.tick();
  assert.equal((await h.facilitation(conv)).followupState, 'ended');
  assert.match(last(conv), /The follow-up of the action items has ended/);
});

test('a deciding step without options waits for them; setting them announces how to vote, and the vote concludes', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pr-setdecision', [ANNA, BERT]);
  await tool(conv, 'facilitation_start', { goal: 'Where to eat', definitionOfDone: 'A place is chosen', format: 'decision' });
  await tool(conv, 'facilitation_open');
  await say(conv, 'anna', 'Thai');
  await say(conv, 'bert', 'Pizza');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.equal(last(conv), 'Step 4 of 5: Decide. "Decide" needs its options before you can vote. I will put them to you in a moment.');
  assert.match(await tool(conv, 'facilitation_set_decision', { method: 'single', options: ['Thai', 'Pizza'], title: 'Where to eat' }), /^Set\./);
  assert.match(last(conv), /^Now deciding: Where to eat\. How to vote: write the one option you choose.*A = Thai, B = Pizza/);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed', 'nothing but the close follows the decision: the result is in');
  assert.match(last(conv), /- Where to eat: Thai \(Thai 2, Pizza 0\)/);
});
