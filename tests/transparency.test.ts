// Transparency (spec 5.7, acceptance 7): handshake, status, result to the
// group first and then to the initiator, rule changes by consent.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { rows } from '../src/db/sql.js';
import * as store from '../src/db/store.js';
import type { Job, OutboxRow } from '../src/model.js';
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

const VOTE = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'] };
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const last = (conv: string): string => posts(conv).at(-1) ?? '';
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, caller });
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const dod = async (conv: string) => store.listDodVersions(h.db.pool, (await h.facilitation(conv)).id);

test('the handshake says everything: who, why, done when, format, method and rules, participants, deadline, reminders, follow-up, changes, report target, status and stop', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-handshake', FOUR);
  await startActive(h, conv, { ...VOTE, deadline: inHours(72), format: 'decision', agenda: [{ kind: 'decide', title: 'Pick a venue', method: 'ranked', options: VOTE.options }, { kind: 'close', title: 'Close' }], followUp: true });
  const text = posts(conv)[0] ?? '';
  for (const part of [
    'Hello, I am Mira',
    'I am neutral',
    'I never vote',
    'Started by: Anna',
    'Goal: Pick a venue',
    'Done when (version 1): A venue is chosen',
    'Format: Decision',
    'Agenda:\n1. Pick a venue\n2. Close',
    'How to vote: rank the options, best first',
    'A = Harbour, B = Old Town, C = Castle Hill',
    'Points per rank: 3/2/1',
    'A tie goes to a runoff',
    'Participants: Anna, Bert, Cara, Dave',
    'Deadline: ',
    'Reminders: 24 h, 2 h before the deadline',
    'in the group without names',
    'Action items: I remind each owner before the due date',
    'A change holds when nobody objects within 12 hours (never past the deadline)',
    'the result goes to this group first, then to Anna with the protocol',
    'Anna receives nothing you were not told about',
    'Ask "status" at any time. "stop" ends the facilitation.',
  ]) {
    assert.ok(text.includes(part), `handshake lacks: ${part}`);
  }
});

test('status: phase, who contributed, who is missing, provisional tally, deadline, version of the definition of done', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-status', FOUR);
  await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  await say(conv, 'anna', 'A > B');
  await say(conv, 'bert', 'B');
  await say(conv, 'cara', 'status');
  const status = last(conv);
  assert.match(status, /^Status: running\. Goal: Pick a venue\nDefinition of done \(version 1\): A venue is chosen\nContributed: Anna, Bert\nStill open: Cara, Dave\nProvisional tally: Harbour 3, Old Town 5, Castle Hill 0\nDeadline: /);
});

test('the result goes to the group first, then to the initiator with the protocol; an initiator who left receives nothing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-result', FOUR);
  await startActive(h, conv, VOTE);
  const dmsBefore = h.kernel.dms.length;
  for (const who of ['anna', 'bert', 'cara', 'dave']) await say(conv, who, 'A');
  const f = await h.facilitation(conv);
  const sent = (await rows<OutboxRow>(h.db.pool, `SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status = 'sent' ORDER BY sent_at, seq`, [f.id])).map((r) => r.purpose);
  assert.ok(sent.indexOf('result') < sent.indexOf('initiator_report'), 'group first');
  const report = h.kernel.dms.slice(dmsBefore).filter((d) => d.text.includes('you started this facilitation'));
  assert.deepEqual(report.map((d) => [d.as, d.principal]), [['mira', 'user:anna']]);
  assert.match(report[0]?.text ?? '', /^Hello Anna, you started this facilitation, so here is the report\. It contains nothing the group was not told\./);
  assert.match(report[0]?.text ?? '', /Result for "Pick a venue":\n- Pick a venue: Harbour/);
  assert.match(report[0]?.text ?? '', /Protocol: Pick a venue\nFacilitator: Mira\nStarted by: Anna/);
  assert.match(report[0]?.text ?? '', /Contributions:\n- Pick a venue: Anna: A \(Harbour\)/);

  const left = h.kernel.conversation('tr-result-left', FOUR);
  await startActive(h, left, VOTE);
  await say(left, 'anna', 'A');
  h.kernel.leave(left, 'anna');
  await h.settle();
  assert.ok(posts(left).some((t) => t.includes('Anna started this facilitation and has left')), 'the group is told');
  const before = h.kernel.dms.length;
  for (const who of ['bert', 'cara', 'dave']) await say(left, who, 'B');
  assert.equal((await h.facilitation(left)).phase, 'closed');
  assert.equal(h.kernel.dms.slice(before).filter((d) => d.principal === 'user:anna').length, 0, 'no report to an initiator who left');
  assert.equal((await store.listEvents(h.db.pool, (await h.facilitation(left)).id, ['initiator_report_skipped'])).length, 1);
});

test('an abort is reported to the group and to the initiator; a report that cannot be delivered privately is said in the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-abort', FOUR);
  await startActive(h, conv, VOTE);
  const before = h.kernel.dms.length;
  await say(conv, 'bert', 'stop');
  assert.match(h.kernel.dms.slice(before)[0]?.text ?? '', /Bert asked to stop\. The facilitation ends here without a result/);

  const blocked = h.kernel.conversation('tr-abort-blocked', FOUR);
  await startActive(h, blocked, VOTE);
  h.kernel.dmBlocked.set('user:anna', 'app_not_installed');
  await say(blocked, 'cara', 'stop');
  h.kernel.dmBlocked.delete('user:anna');
  assert.equal(last(blocked), 'I could not send the report to Anna privately. It is all here in the group.');
});

test('definition of done changes without a restart: proposal, consent window, an objection blocks, success is announced with its version and survives a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-dod', FOUR);
  await startActive(h, conv, { ...VOTE, deadline: inHours(96) });
  await say(conv, 'anna', 'A');
  const ask = await say(conv, 'bert', 'can we say the venue must also be free on the 12th?');
  const put = await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen that is free on the 12th', messageId: ask.messageId });
  assert.match(put, /^Put to the group\. It holds if nobody objects until /);
  assert.match(last(conv), /^Proposal: change the definition of done to \(version 2\): A venue is chosen that is free on the 12th\nIt holds if nobody objects until /);
  const f = await h.facilitation(conv);
  let proposal = await store.openProposal(h.db.pool, f.id);
  assert.equal(proposal?.proposedBy, 'user:bert', 'the proposer comes from the stored message');
  assert.equal(proposal?.windowEndsAt.getTime(), h.clock.now().getTime() + 12 * HOUR_MS, 'default window: 12 h');
  assert.deepEqual((await dod(conv)).map((d) => [d.version, d.consentState]), [[1, 'initial'], [2, 'proposed']]);

  await say(conv, 'cara', 'Objection: we do not know the date yet');
  h.clock.advance(12 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.match(last(conv), /^Not accepted: change the definition of done.*\nStanding objection:\n- Cara: we do not know the date yet/s);
  assert.deepEqual((await dod(conv)).map((d) => [d.version, d.consentState]), [[1, 'initial'], [2, 'rejected']]);
  assert.match(await tool(conv, 'facilitation_status'), /Definition of done \(version 1\): A venue is chosen\n/);

  await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen and booked', messageId: ask.messageId });
  await say(conv, 'dave', 'agreed');
  await h.restart();
  proposal = await store.openProposal(h.db.pool, f.id);
  assert.equal(proposal?.status, 'open', 'the open proposal survives the restart');
  assert.deepEqual(proposal?.consents, ['user:dave']);
  h.clock.advance(12 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const tail = posts(conv).slice(-2);
  assert.match(tail[0] ?? '', /^Accepted, nobody objected: change the definition of done to \(version 3\): A venue is chosen and booked/);
  assert.equal(tail[1], 'The definition of done is now version 3: A venue is chosen and booked');
  assert.match(await tool(conv, 'facilitation_status'), /Definition of done \(version 3\): A venue is chosen and booked\nContributed: Anna\n/);
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the facilitation ran on; the vote Anna cast still counts');
});

test('a pending change proposal blocks the conclusion; once it is decided the evaluation runs', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-blocks', [ANNA, BERT, CARA]);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen and booked' });
  await say(conv, 'cara', 'B');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'every vote is in, but the proposal is decided first');
  await say(conv, 'anna', 'agreed');
  await say(conv, 'bert', 'agreed');
  await say(conv, 'cara', 'agreed');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  const texts = posts(conv);
  assert.ok(texts.indexOf('The definition of done is now version 2: A venue is chosen and booked') < texts.findIndex((t) => t.startsWith('Result for')));
});

test('a change window never runs past the deadline: the proposal is decided, then the deadline evaluates', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-window', [ANNA, BERT, CARA]);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(3) });
  await say(conv, 'anna', 'B');
  await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen by majority' });
  assert.equal((await store.openProposal(h.db.pool, f.id))?.windowEndsAt.toISOString(), f.deadline?.toISOString());
  h.clock.set(new Date((f.deadline as Date).getTime() + 1000));
  await h.tick();
  const texts = posts(conv);
  assert.ok(texts.some((t) => t.startsWith('The definition of done is now version 2')));
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(last(conv), /Old Town \(Harbour 0, Old Town 3, Castle Hill 0\)/);
});

test('changing the method: ballots that no longer fit are retired and the people are named; a change of points keeps them', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-method', [ANNA, BERT, CARA]);
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A > B');
  await say(conv, 'bert', 'B');
  await tool(conv, 'facilitation_propose_change', { change: 'method', points: [5, 3, 1] });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  assert.match(last(conv), /^"Pick a venue" is now decided like this\. .*Points per rank: 5\/3\/1/);
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: Anna, Bert\nStill open: Cara\nProvisional tally: Harbour 5, Old Town 8, Castle Hill 0/);

  await tool(conv, 'facilitation_propose_change', { change: 'method', method: 'single', options: ['Harbour', 'Old Town'], replaceOptions: true });
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  const tail = posts(conv).slice(-2);
  assert.match(tail[0] ?? '', /is now decided like this\. How to vote: write the one option you choose/);
  assert.equal(tail[1], 'Contributions made under the old rules no longer fit. Please contribute again: Anna and Bert.');
  assert.match(await tool(conv, 'facilitation_status'), /Contributed: nobody yet\nStill open: Anna, Bert, Cara/);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  await say(conv, 'cara', 'B');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
});

test('moving the deadline moves the reminders with it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-deadline', [ANNA, BERT]);
  const f = await startActive(h, conv, { ...VOTE, deadline: inHours(72) });
  const next = inHours(120);
  await tool(conv, 'facilitation_propose_change', { change: 'deadline', deadline: next });
  await say(conv, 'anna', 'agreed');
  await say(conv, 'bert', 'agreed');
  assert.match(last(conv), /^The deadline is now .*Reminders move with it\./);
  assert.equal((await h.facilitation(conv)).deadline?.toISOString(), next);
  const pending = (await rows<Job>(h.db.pool, `SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND status = 'pending' AND kind <> 'lifetime' ORDER BY due_at`, [f.id])).map((j) => [j.kind, j.dueAt.toISOString()]);
  const at = (hours: number): string => new Date(Date.parse(next) - hours * HOUR_MS).toISOString();
  assert.deepEqual(pending, [['reminder', at(24)], ['reminder', at(2)], ['deadline', next]]);
});

test('a free-text definition of done is met when the group says so; a machine-checkable one needs no confirmation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-freetext', [ANNA, BERT]);
  await startActive(h, conv, { goal: 'Align on the roadmap', definitionOfDone: 'Everybody can live with the roadmap' });
  assert.equal((await dod(conv))[0]?.criteria, null);
  assert.match(await tool(conv, 'facilitation_close'), /put to the group/);
  assert.match(last(conv), /^Proposal: the definition of done is met, and we close with this:\nDecisions:/);
  await say(conv, 'anna', 'agreed');
  assert.equal((await h.facilitation(conv)).phase, 'active');
  await say(conv, 'bert', 'agreed');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(last(conv), /^Result for "Align on the roadmap":/);

  const vote = h.kernel.conversation('tr-machine', [ANNA, BERT]);
  await startActive(h, vote, VOTE);
  assert.match(await tool(vote, 'facilitation_close'), /^Refused \(machine_checkable\)/);
});
