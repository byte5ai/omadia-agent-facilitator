// Acceptance suite: spec 9, criteria 1 to 20 (byte5ai/omadia#2043).
//
// End to end on the fake kernel with its simulated channel, a fake clock and
// a real Postgres. One test per criterion, named by its number.
//
// Not covered here, and reported as skipped rather than passed:
//   10 (first half)  refusing grants, consultation and memory for a
//                    facilitator, and the 1:1 refusal, are enforced by the
//                    kernel, not by this engine.
//   13               needs a real Teams test tenant.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { rows } from '../src/db/sql.js';
import * as store from '../src/db/store.js';
import { withFacilitationLock } from '../src/db/tx.js';
import { scoped } from '../src/engine/capabilities.js';
import { Refusal } from '../src/engine/core.js';
import { listAudit, protocolFor } from '../src/engine/governance.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { handle } from '../src/http/operatorApi.js';
import { evaluate } from '../src/methods/evaluate.js';
import { toOptions } from '../src/methods/ballot.js';
import type { OutboxRow } from '../src/model.js';
import { buildTools } from '../src/tools/index.js';
import { ANNA, BERT, CARA, DAVE, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-16T08:00:00Z', config: { protocolMailEnabled: true, maxActivePerFacilitator: 40, startsPerHourPerFacilitator: 100 } });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
  h.kernel.names.set('mira', 'Mira');
  h.kernel.names.set('jonas', 'Jonas');
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VENUES = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'], points: [3, 2, 1] };
const posts = (conv: string, as?: string): string[] => h.kernel.groupPosts(conv, as).map((p) => p.text);
const last = (conv: string): string => posts(conv).at(-1) ?? '';
const result = (conv: string): string => posts(conv).find((t) => t.startsWith('Result for')) ?? '';
const count = (conv: string, prefix: string): number => posts(conv).filter((t) => t.startsWith(prefix)).length;
const tool = (conv: string, name: string, args: Record<string, unknown> = {}, agent = 'mira', caller = 'anna'): Promise<string> => h.tool(name, args, { conversation: conv, agent, caller });
const status = (conv: string): Promise<string> => tool(conv, 'facilitation_status');
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const everybody = async (conv: string, text: string, who = ['anna', 'bert', 'cara', 'dave']): Promise<void> => {
  for (const person of who) await say(conv, person, text);
};
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const reminderDms = (): number => h.kernel.dms.filter((d) => d.text.includes('is still open')).length;
const outbox = async (conv: string) => rows<OutboxRow>(h.db.pool, 'SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id]);

test('1. field scenario: four people, ranked vote 3/2/1, deadline in three days, two votes without a mention, restart in between', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-01', FOUR);
  const f = await startActive(h, conv, { ...VENUES, deadline: inHours(72) });
  assert.match(posts(conv)[0] ?? '', /^Hello, I am Mira/);
  const turns = h.kernel.turns.length;

  await say(conv, 'anna', '@Mira A > C > B');
  assert.equal(last(conv), 'Recorded for you, Anna: A (Harbour) > C (Castle Hill) > B (Old Town)');
  assert.match(await status(conv), /Contributed: 1 of 4\nStill open: 3 contributions/);

  await say(conv, 'bert', 'B > A'); // no mention
  assert.equal(last(conv), 'Recorded for you, Bert: B (Old Town) > A (Harbour)');
  assert.match(await status(conv), /Contributed: 2 of 4\nStill open: 2 contributions/);

  await h.restart(); // a middleware restart between the second and the third vote
  assert.match(await status(conv), /Contributed: 2 of 4\nStill open: 2 contributions/);

  await say(conv, 'cara', 'A > B > C'); // no mention
  assert.equal(last(conv), 'Recorded for you, Cara: A (Harbour) > B (Old Town) > C (Castle Hill)');
  assert.match(await status(conv), /Contributed: 3 of 4\nStill open: 1 contribution/);
  assert.equal((await h.facilitation(conv)).phase, 'active');

  const dms = h.kernel.dms.length;
  await say(conv, 'dave', '@Mira C > A');
  const closed = await h.facilitation(conv);
  assert.equal(closed.id, f.id);
  assert.equal(closed.phase, 'closed', 'the fourth vote concludes the facilitation');
  assert.match(posts(conv).find((t) => t.startsWith('Result for')) ?? '', /- Pick a venue: Harbour \(Harbour 10, Old Town 6, Castle Hill 6\)/);
  const report = h.kernel.dms.slice(dms).find((d) => d.principal === 'user:anna');
  assert.match(report?.text ?? '', /you started this facilitation.*Result for "Pick a venue"/s, 'and it is sent to the initiator');
  assert.equal(h.kernel.turns.length, turns, 'no model recorded or counted anything');
  assert.ok(posts(conv).every((_t, i) => h.kernel.groupPosts(conv)[i]?.as === 'mira'));

  // No reminder is sent afterwards.
  await h.tick(); // what follows the close (the protocol mail) is done
  const before = posts(conv).length;
  const reminders = reminderDms();
  h.clock.set(new Date((f.deadline as Date).getTime() - 24 * HOUR_MS + 1000));
  await h.tick();
  h.clock.set(new Date((f.deadline as Date).getTime() + 1000));
  await h.tick();
  assert.equal(posts(conv).length, before);
  assert.equal(count(conv, 'Reminder:'), 0);
  assert.equal(reminderDms(), reminders);
});

test('2. deadline: one reminder at -24 h and one at -2 h (private to the missing person, neutral in the group), honest close at the deadline, no abort before', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-02', FOUR);
  const f = await startActive(h, conv, { ...VENUES, deadline: inHours(72) });
  const deadline = f.deadline as Date;
  for (const [who, vote] of [['anna', 'A > B'], ['bert', 'A'], ['cara', 'B > A']] as const) await say(conv, who, vote);
  const dms = h.kernel.dms.length;

  h.clock.set(new Date(deadline.getTime() - 24 * HOUR_MS + 1000));
  await h.tick();
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 1);
  assert.match(posts(conv).find((t) => t.startsWith('Reminder:')) ?? '', /^Reminder: one contribution is still open\./);
  assert.ok(!posts(conv).some((t) => t.startsWith('Reminder:') && t.includes('Dave')));
  assert.deepEqual(h.kernel.dms.slice(dms).map((d) => d.principal), ['user:dave']);

  h.clock.set(new Date(deadline.getTime() - 2 * HOUR_MS + 1000));
  await h.tick();
  assert.equal(count(conv, 'Reminder:'), 2);
  assert.equal((await h.facilitation(conv)).phase, 'active');

  h.clock.set(new Date(deadline.getTime() + 1000));
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(posts(conv).find((t) => t.startsWith('Result for')) ?? '', /The deadline has passed; 3 of 4 contributed, and this is the result of what was contributed\./);
  assert.equal(count(conv, 'This facilitation ends without'), 0);
});

test('3. races and delivery: vote and reminder in the same second, crash between commit and send, lost confirmation, vote and deadline at once', { skip: PG_SKIP }, async () => {
  // (a) The last vote and a due reminder in the same second: no reminder is delivered.
  const a = h.kernel.conversation('ac-03a', FOUR);
  const fa = await startActive(h, a, { ...VENUES, deadline: inHours(72) });
  await everybody(a, 'A', ['anna', 'bert', 'cara']);
  h.clock.set(new Date((fa.deadline as Date).getTime() - 24 * HOUR_MS));
  h.kernel.tickMs = 0;
  const remindersBefore = reminderDms();
  h.hooks.beforeJob = async (job) => {
    if (job.facilitationId !== fa.id || job.kind !== 'reminder') return;
    delete h.hooks.beforeJob;
    await h.kernel.say(a, 'dave', 'B');
  };
  await h.tick();
  h.kernel.tickMs = 1000;
  assert.equal(count(a, 'Reminder:'), 0);
  assert.equal(reminderDms(), remindersBefore);

  // (b) A crash after commit and before send: an essential message is sent after the restart, a reminder is not.
  const b = h.kernel.conversation('ac-03b', FOUR);
  const fb = await startActive(h, b, VENUES);
  await withFacilitationLock(h.db.pool, fb.id, (client) =>
    h.engine.core.workOn(client, fb.id, async (w) => {
      w.post({ purpose: 'reminder', key: 'crash', to: 'group', deliveryClass: 'droppable', versionBound: false, text: 'Reminder: never sent' });
      w.post({ purpose: 'abort', key: 'crash', to: 'group', deliveryClass: 'essential', text: 'Essential: sent after the restart' });
    }),
  );
  await h.restart();
  assert.equal(count(b, 'Essential: sent after the restart'), 1);
  assert.equal(count(b, 'Reminder: never sent'), 0);

  // (c) A lost send confirmation: the result is retried, a reminder is not.
  const c = h.kernel.conversation('ac-03c', FOUR);
  const fc = await startActive(h, c, { ...VENUES, deadline: inHours(72) });
  await everybody(c, 'A', ['anna', 'bert', 'cara']);
  h.kernel.sendFaults.push('lost');
  h.clock.set(new Date((fc.deadline as Date).getTime() - 24 * HOUR_MS + 1000));
  await h.tick();
  h.clock.advance(10 * MINUTE_MS);
  await h.tick();
  assert.equal(count(c, 'Reminder:'), 1, 'the reminder reached the channel once and is not repeated');
  h.kernel.sendFaults.push({ code: 'throttled', message: 'echo' }, 'lost');
  await say(c, 'dave', 'A');
  h.clock.advance(2 * MINUTE_MS);
  await h.tick();
  assert.equal(count(c, 'Result for'), 2, 'the result is retried, accepting a duplicate');
  assert.deepEqual((await outbox(c)).filter((r) => r.purpose === 'result').map((r) => [r.status, r.attempts]), [['sent', 2]]);

  // (d) Last vote and deadline at the same time: one evaluation, one report.
  const d = h.kernel.conversation('ac-03d', FOUR);
  const fd = await startActive(h, d, { ...VENUES, deadline: inHours(72) });
  await everybody(d, 'A', ['anna', 'bert', 'cara']);
  h.clock.set(fd.deadline as Date);
  h.kernel.tickMs = 0;
  await Promise.all([h.kernel.say(d, 'dave', 'B'), h.engine.tick()]);
  await h.settle();
  h.kernel.tickMs = 1000;
  assert.equal(count(d, 'Result for') + count(d, 'This facilitation ends without'), 1);
  assert.equal((await store.listDecisions(h.db.pool, fd.id)).length, 1);
});

test('4. authorship and currency', { skip: PG_SKIP }, async () => {
  const foreign = h.kernel.conversation('ac-04-other', FOUR);
  await startActive(h, foreign, VENUES);
  const elsewhere = await h.kernel.say(foreign, 'anna', 'A > B');

  const conv = h.kernel.conversation('ac-04', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VENUES });
  const early = await h.kernel.say(conv, 'cara', 'A > B > C');
  h.clock.advance(MINUTE_MS);
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  const record = (messageId: string, ballot = 'A'): Promise<string> => tool(conv, 'facilitation_record_contribution', { messageId, kind: 'vote', summary: 'x', ballot });
  const valid = async () => (await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'valid');

  // "Anna agrees too" from Bert records nothing for Anna.
  const proxy = await say(conv, 'bert', 'Anna agrees too');
  await record(proxy.messageId);
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).map((c) => c.participantPrincipal), ['user:bert']);
  await say(conv, 'anna', 'yes');
  assert.deepEqual(await valid(), [], "Anna cannot confirm what was read from Bert's message");
  await say(conv, 'bert', 'no');

  // A quoted or forwarded ballot records nothing.
  const quoted = await say(conv, 'bert', 'A > B > C', { quoted: true });
  const forwarded = await say(conv, 'bert', 'B > A', { forwarded: true });
  assert.match(await record(quoted.messageId), /^Refused \(not_own_words\)/);
  assert.match(await record(forwarded.messageId), /^Refused \(not_own_words\)/);

  // A foreign message id, a non-participant's message, a message from before the start.
  assert.match(await record(elsewhere.messageId), /^Refused \(unknown_message\)/);
  h.kernel.conversation(conv, [...FOUR, { id: 'guest', displayName: 'Guest' }]);
  const guest = await say(conv, 'guest', 'A');
  assert.match(await record(guest.messageId), /^Refused \(not_participant\)/);
  assert.match(await record(early.messageId), /^Refused \(before_start\)/);
  assert.deepEqual(await valid(), []);

  // An edited ballot counts in its latest revision.
  const ballot = await say(conv, 'cara', 'A > B');
  await h.kernel.edit(conv, 'cara', ballot.messageId, 'C > B');
  await h.settle();
  assert.deepEqual((await valid()).map((c) => [c.participantPrincipal, c.sourceRevision, (c.payload['ballot'] as { ranking: string[] }).ranking]), [['user:cara', 1, ['C', 'B']]]);

  // A ballot read from free text counts only after its author confirmed the echo.
  const free = await say(conv, 'dave', 'the old town for me, then the castle');
  assert.match(await record(free.messageId, 'B > C'), /^Recorded for Dave as unconfirmed/);
  assert.equal((await valid()).length, 1);
  await say(conv, 'dave', 'yes');
  assert.deepEqual((await valid()).map((c) => c.participantPrincipal).sort(), ['user:cara', 'user:dave']);
});

test('5. methods and evaluation: every row of the table (the full table-driven set is methods.test.ts)', () => {
  const options = toOptions(['X', 'Y']);
  const base = { options, activeParticipants: ['a', 'b'], closeRule: 'all_contributed' as const, deadlineReached: false, hasOpenProposal: false };
  const ranked = (ranking: string[]) => ({ type: 'ranked' as const, ranking });
  const table: Array<[string, Parameters<typeof evaluate>[0], string]> = [
    ['clear result', { ...base, method: 'ranked', ballots: [{ principal: 'a', ballot: ranked(['A', 'B']) }, { principal: 'b', ballot: ranked(['A']) }] }, 'clear'],
    ['partial ranking and abstention', { ...base, method: 'ranked', ballots: [{ principal: 'a', ballot: ranked(['B']) }, { principal: 'b', ballot: { type: 'abstention' } }] }, 'clear'],
    ['tie: runoff', { ...base, method: 'ranked', ballots: [{ principal: 'a', ballot: ranked(['A', 'B']) }, { principal: 'b', ballot: ranked(['B', 'A']) }] }, 'tie'],
    ['runoff timeout with the tie standing', { ...base, method: 'single', deadlineReached: true, ballots: [{ principal: 'a', ballot: { type: 'single', choice: 'A' } }, { principal: 'b', ballot: { type: 'single', choice: 'B' } }] }, 'tie'],
    ['consent with an objection', { ...base, method: 'consent', ballots: [{ principal: 'a', ballot: { type: 'consent', consent: true } }, { principal: 'b', ballot: { type: 'consent', consent: false, reason: 'r' } }] }, 'objection'],
    ['assignment confirmed', { ...base, method: 'assignment', ballots: [], assignmentEvents: [{ principal: 'a', nominations: [{ item: 'A', nominee: 'a' }, { item: 'B', nominee: 'b' }], declines: [], confirms: [] }, { principal: 'b', nominations: [], declines: [], confirms: ['B'] }] }, 'assignment_done'],
    ['assignment declined', { ...base, method: 'assignment', ballots: [], assignmentEvents: [{ principal: 'a', nominations: [{ item: 'A', nominee: 'a' }, { item: 'B', nominee: 'b' }], declines: [], confirms: [] }, { principal: 'b', nominations: [], declines: ['B'], confirms: [] }] }, 'assignment_open'],
    ['a pending change proposal blocks conclusion', { ...base, method: 'ranked', hasOpenProposal: true, ballots: [{ principal: 'a', ballot: ranked(['A']) }, { principal: 'b', ballot: ranked(['A']) }] }, 'blocked_by_proposal'],
    ['waiting for a contribution', { ...base, method: 'approval', ballots: [{ principal: 'a', ballot: { type: 'approval', choices: ['A', 'B'] } }] }, 'waiting'],
  ];
  for (const [name, input, state] of table) assert.equal(evaluate(input).state, state, name);
});

test('5b. methods through the engine: duplicate option refused, empty ballot is no contribution, change before conclusion', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-05', [ANNA, BERT]);
  const f = await startActive(h, conv, VENUES);
  await say(conv, 'anna', 'A > A');
  assert.match(last(conv), /^Anna, an option appears twice/);
  await say(conv, 'anna', '   ');
  await say(conv, 'anna', 'A > B');
  await say(conv, 'anna', 'B > A');
  assert.equal(last(conv), 'Changed for you, Anna: B (Old Town) > A (Harbour)');
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).map((c) => c.status).sort(), ['ambiguous', 'superseded', 'valid']);
  await say(conv, 'bert', 'abstain');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(result(conv), /Old Town \(Harbour 2, Old Town 3, Castle Hill 0\)/);
});

test('6. ambiguity: exactly one clarifying question, not counted until resolved', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-06', [ANNA, BERT]);
  const f = await startActive(h, conv, VENUES);
  const vague = await say(conv, 'anna', 'A > D');
  assert.equal(last(conv), 'Anna, I do not know this option: D. Which of the options do you mean?');
  await h.engine.receive('mira', vague);
  assert.match(await tool(conv, 'facilitation_clarify', { messageId: vague.messageId, question: 'which one?' }), /already asked/);
  assert.equal(posts(conv).filter((t) => t.startsWith('Anna, ')).length, 1);
  await say(conv, 'bert', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the ambiguous ballot does not count');
  assert.match(await status(conv), /Still open: 1 contribution/);
  await say(conv, 'anna', 'A > B');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal((await store.listContributions(h.db.pool, f.id)).filter((c) => c.status === 'ambiguous').length, 1);
});

test('7. definition of done changes without a restart: proposal, consent window, objection blocks, success announced with version, survives a restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-07', FOUR);
  const f = await startActive(h, conv, { ...VENUES, deadline: inHours(120) });
  await say(conv, 'anna', 'A');
  const ask = await say(conv, 'bert', 'should it not also be bookable?');
  await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen and can be booked', messageId: ask.messageId });
  await say(conv, 'cara', 'objection: we cannot check that now');
  h.clock.advance(12 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.match(last(conv), /^Not accepted:/);
  assert.equal((await store.currentDod(h.db.pool, f.id))?.version, 1);

  await tool(conv, 'facilitation_propose_change', { change: 'definition_of_done', definitionOfDone: 'A venue is chosen by all four', messageId: ask.messageId });
  await h.restart();
  h.clock.advance(12 * HOUR_MS + MINUTE_MS);
  await h.tick();
  assert.equal(last(conv), 'The definition of done is now version 3: A venue is chosen by all four');
  const current = await store.currentDod(h.db.pool, f.id);
  assert.deepEqual([current?.version, current?.text, current?.proposedBy], [3, 'A venue is chosen by all four', 'user:bert']);
  assert.equal((await h.facilitation(conv)).id, f.id, 'the same facilitation, no restart of the facilitation');
  assert.match(await status(conv), /Definition of done \(version 3\).*\nContributed: 1 of \d+/);
});

test('8. membership: a joiner is welcomed and counted, a leaver keeps the contribution and is no longer missing (the group status gives counts, a private one names), an initiator who leaves gets neither contributions nor the report', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-08', [ANNA, BERT, CARA]);
  await startActive(h, conv, VENUES);
  await say(conv, 'bert', 'A');
  h.kernel.join(conv, DAVE);
  await h.settle();
  assert.match(last(conv), /^Welcome, Dave\./);
  assert.match(await status(conv), /Still open: 3 contributions/);

  h.kernel.leave(conv, 'bert');
  await h.settle();
  assert.match(await status(conv), /Contributed: 1 of 4\nStill open: 3 contributions/, 'the contribution stays; Bert is not "missing"');
  // Criterion 16: in the group nobody is named as missing, also on request;
  // the same question in a private chat gets the names.
  await say(conv, 'cara', 'status');
  assert.doesNotMatch(last(conv), /Anna|Cara|Dave/, 'the group status names nobody');
  assert.match(last(conv), /Still open: 3 contributions/);
  // Cara takes part in earlier facilitations of this suite too: the newest one is this one.
  const which = (await h.kernel.privateMessage('mira', 'cara', 'status')) ?? '';
  const n = which.split('\n').filter((l) => /^\d+\. /.test(l)).length;
  const own = n === 0 ? which : ((await h.kernel.privateMessage('mira', 'cara', `status ${String(n)}`)) ?? '');
  assert.match(own, /Contributed: Bert\nStill open: Anna, Cara, Dave/);

  const dms = h.kernel.dms.length;
  h.kernel.leave(conv, 'anna');
  await h.settle();
  assert.ok(posts(conv).some((t) => t.startsWith('Anna started this facilitation and has left the conversation. From now on Anna receives neither')));
  await say(conv, 'cara', 'B');
  await say(conv, 'dave', 'B');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.match(result(conv), /Old Town \(Harbour 3, Old Town 6, Castle Hill 0\)/);
  assert.equal(h.kernel.dms.slice(dms).filter((d) => d.principal === 'user:anna').length, 0);
});

test('9. several facilitators: two facilitators in two chats and one facilitator in two chats; every post from the right bot, state never crosses', { skip: PG_SKIP }, async () => {
  const one = h.kernel.conversation('ac-09-mira-1', FOUR);
  const two = h.kernel.conversation('ac-09-mira-2', FOUR);
  const three = h.kernel.conversation('ac-09-jonas', FOUR);
  await tool(one, 'facilitation_start', { goal: 'Venue for the summer party', definitionOfDone: 'd', ...VENUES });
  await tool(two, 'facilitation_start', { goal: 'Name of the new product', definitionOfDone: 'd', method: 'single', options: ['Nova', 'Atlas'] });
  await tool(three, 'facilitation_start', { goal: 'Budget round', definitionOfDone: 'd', method: 'approval', options: ['Tools', 'Travel', 'Training'] }, 'jonas');
  await tool(one, 'facilitation_open');
  await tool(two, 'facilitation_open');
  await tool(three, 'facilitation_open', {}, 'jonas');
  assert.match(posts(one)[0] ?? '', /^Hello, I am Mira/);
  assert.match(posts(three)[0] ?? '', /^Hello, I am Jonas/);
  assert.match(await tool(three, 'facilitation_start', { goal: 'x', definitionOfDone: 'd' }, 'mira'), /^Refused \(conversation_taken\)/, 'one facilitation per conversation');

  // Interleaved contributions of the same people.
  await say(one, 'anna', 'A > B');
  await say(two, 'anna', 'A');
  await say(three, 'anna', 'A, C');
  await say(two, 'bert', 'B');
  await say(one, 'bert', 'C');
  await say(three, 'bert', 'C');
  assert.match(await status(one), /Goal: Venue for the summer party\n.*\nContributed: 2 of 4\nStill open: 2 contributions\nOptions: .*\nProvisional tally: Harbour 3, Old Town 2, Castle Hill 3/);
  assert.match(await status(two), /Goal: Name of the new product\n.*\nContributed: 2 of 4\nStill open: 2 contributions\nOptions: .*\nProvisional tally: Nova 1, Atlas 1/);
  assert.match(await tool(three, 'facilitation_status', {}, 'jonas'), /Goal: Budget round\n.*\nContributed: 2 of 4\nStill open: 2 contributions\nOptions: .*\nProvisional tally: Tools 1, Travel 0, Training 2/);

  // Every post comes from the right bot.
  assert.ok(h.kernel.groupPosts(one).every((p) => p.as === 'mira') && h.kernel.groupPosts(two).every((p) => p.as === 'mira'));
  assert.ok(h.kernel.groupPosts(three).length > 0 && h.kernel.groupPosts(three).every((p) => p.as === 'jonas'));

  // Concluding one leaves the others untouched.
  await say(two, 'cara', 'A');
  await say(two, 'dave', 'A');
  assert.equal((await h.facilitation(two)).phase, 'closed');
  assert.equal((await h.facilitation(one)).phase, 'active');
  assert.equal((await h.facilitation(three)).phase, 'active');
  for (const [conv, agent] of [[one, 'mira'], [three, 'jonas']] as const) await tool(conv, 'facilitation_stop', { reason: 'test over' }, agent);
});

test('10. omissions (engine part): the same person in two facilitations is never referred to across them; the engine offers nothing but facilitation tools', { skip: PG_SKIP }, async () => {
  const a = h.kernel.conversation('ac-10-a', [ANNA, BERT]);
  const b = h.kernel.conversation('ac-10-b', [ANNA, CARA]);
  await startActive(h, a, { goal: 'Salary bands for the sales team', definitionOfDone: 'Bands are agreed' });
  await startActive(h, b, { goal: 'Office move', definitionOfDone: 'A date is agreed' });
  const secret = await say(a, 'anna', 'I think the bands are far too low');
  await tool(a, 'facilitation_record_contribution', { messageId: secret.messageId, kind: 'position', summary: 'finds the bands far too low' });
  await say(a, 'anna', 'yes');

  await say(b, 'anna', 'when would the move be?');
  const turn = h.kernel.turns.at(-1);
  assert.equal(turn?.conversationId, b);
  assert.equal(turn?.sessionKey, `facilitation:${(await h.facilitation(b)).id}`, 'a session of its own per facilitation');
  for (const leak of ['Salary', 'bands', 'sales team', 'Bert']) assert.ok(!(turn?.engineContext ?? '').includes(leak), `the turn in the other facilitation mentions "${leak}"`);
  assert.ok(!(await buildProtocol(h.db.pool, await h.facilitation(b))).includes('bands'));
  assert.match(await tool(b, 'facilitation_record_contribution', { messageId: secret.messageId, kind: 'position', summary: 'x' }), /^Refused \(unknown_message\)/, 'a message of one facilitation cannot be used in another');

  const names = buildTools(h.engine).map((t) => t.spec.name);
  assert.ok(names.length > 0 && names.every((n) => n.startsWith('facilitation_')), 'only the engine\'s own tools');
  const manifest = readFileSync(join(process.cwd(), 'manifest.yaml'), 'utf8');
  assert.match(manifest, /memory:\n\s+reads: \[\]\n\s+writes: \[\]\n\s+graph:\n\s+reads: \[\]\n\s+writes: \[\]\n\s+network:\n\s+outbound: \[\]/, 'no memory, graph or network permission');
  for (const conv of [a, b]) await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('10 (kernel part). granting a business plugin, a consultation grant or a memory tool to a facilitator is refused; a 1:1 request for help gets the refusal', { skip: 'enforced by the kernel (agent kind facilitator), not by this engine; covered by the kernel suite' }, () => {});

test('11. visibility: a user outside the conversation cannot read a protocol; operator content access is audited', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-11', FOUR);
  const f = await startActive(h, conv, VENUES);
  await say(conv, 'anna', 'A');
  await assert.rejects(protocolFor(h.db.pool, f, 'user:outsider'), (err: unknown) => err instanceof Refusal && err.code === 'not_visible');
  assert.match(await tool(conv, 'facilitation_protocol', {}, 'mira', 'outsider'), /^Refused \(not_visible\)/);
  assert.match(await protocolFor(h.db.pool, f, 'user:bert'), /Anna: A \(Harbour\)/);

  const list = await handle(h.engine, { method: 'GET', path: '/facilitations', query: {}, body: undefined, actor: 'op@example.com' });
  assert.ok(!JSON.stringify(list.body).includes('Pick a venue') && !JSON.stringify(list.body).includes('Anna'), 'metadata only');
  const refused = await handle(h.engine, { method: 'POST', path: `/facilitations/${f.id}/content`, query: {}, body: {}, actor: 'op@example.com' });
  assert.equal(refused.status, 400);
  const content = await handle(h.engine, { method: 'POST', path: `/facilitations/${f.id}/content`, query: {}, body: { reason: 'Data subject access request 2026-114' }, actor: 'op@example.com' });
  assert.equal(content.status, 200);
  assert.deepEqual((await listAudit(h.db.pool, f.id)).map((a) => [a.action, a.actor, a.reason]), [['content_read', 'op@example.com', 'Data subject access request 2026-114']]);
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('12. no silent end: a failed step and a reached lifetime produce an abort report in the group; a reached quota produces a system notice', { skip: PG_SKIP }, async () => {
  const failed = h.kernel.conversation('ac-12-failed', [ANNA, BERT]);
  const ff = await startActive(h, failed, VENUES);
  await h.db.pool.query(`INSERT INTO plg_omadia_agent_facilitator_jobs (facilitation_id, kind, dedupe_key, due_at, created_at) VALUES ($1, 'broken_step', $2, $3, $3)`, [ff.id, `${ff.id}:broken`, h.clock.now()]);
  for (let i = 0; i < 5; i += 1) await h.tick();
  assert.equal((await h.facilitation(failed)).phase, 'aborted');
  assert.equal(last(failed), 'This facilitation ends without a result. Reason: an internal step failed repeatedly and could not be completed');

  const old = h.kernel.conversation('ac-12-ttl', [ANNA, BERT]);
  await startActive(h, old, VENUES);
  h.clock.advance(30 * DAY_MS + HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(old)).phase, 'aborted');
  assert.equal(last(old), 'This facilitation ends without a result. Reason: the maximum duration of 30 days was reached');

  const tight = await createHarness({ start: '2026-11-16T08:00:00Z', config: { maxActivePerFacilitator: 1 } });
  try {
    const first = tight.kernel.conversation('ac-12-quota-1', [ANNA, BERT]);
    const second = tight.kernel.conversation('ac-12-quota-2', [ANNA, BERT]);
    assert.match(await tight.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { conversation: first }), /^Facilitation created/);
    assert.match(await tight.tool('facilitation_start', { goal: 'g', definitionOfDone: 'd' }, { conversation: second }), /^Refused \(quota_active\): System notice: this facilitator already runs 1 facilitations, which is its limit/);
  } finally {
    await tight.close();
  }
});

test('13. Teams contract tests against the real test tenant', { skip: 'needs a real Teams test tenant; none exists. Acceptance rests on the simulated channel.' }, () => {});

test('14. retrospective: ideas without mentions, clusters confirmed by the group, two actions each with a confirmed owner and a due date, protocol, reminder before the due date', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-14', FOUR);
  const turns = h.kernel.turns.length;
  await tool(conv, 'facilitation_start', { goal: 'Retro sprint 12', definitionOfDone: 'Actions with owners agreed', format: 'retrospective', followUp: true });
  await tool(conv, 'facilitation_open');
  for (const [who, idea] of [['anna', 'Releases were calm'], ['bert', 'Too many meetings'], ['cara', 'Standups ran long'], ['dave', 'Pairing helped']] as const) await say(conv, who, idea);
  assert.equal(h.kernel.turns.length, turns, 'collected without mentions and without a model');
  const f = await h.facilitation(conv);
  const next = async (): Promise<void> => {
    await tool(conv, 'facilitation_step', { action: 'close' });
    if ((await store.openStepOf(h.db.pool, f.id))?.status === 'open' && last(conv).startsWith('Before we close')) await tool(conv, 'facilitation_step', { action: 'close' });
  };
  await next();
  await tool(conv, 'facilitation_propose_clusters', { clusters: [{ label: 'Meetings', members: [2, 3] }, { label: 'Working together', members: [1, 4] }] });
  await everybody(conv, 'agreed');
  assert.deepEqual((await store.listClusters(h.db.pool, f.id)).map((c) => [c.label, c.confirmed]), [['Meetings', true], ['Working together', true]]);
  await next(); // cluster
  await next(); // discuss
  await tool(conv, 'facilitation_record_decision', { statement: 'Standups are capped at 10 minutes', rationale: 'they ran long' });
  await everybody(conv, 'agreed');
  await tool(conv, 'facilitation_record_decision', { statement: 'One meeting-free day per week', rationale: 'too many meetings' });
  await everybody(conv, 'agreed');
  await next(); // decide
  const due = new Date(h.clock.now().getTime() + 5 * DAY_MS);
  await tool(conv, 'facilitation_record_action_item', { description: 'Set a timer in standups', owner: 'Cara', dueDate: due.toISOString() });
  await say(conv, 'cara', 'yes');
  await tool(conv, 'facilitation_record_action_item', { description: 'Block Wednesdays', owner: 'Bert', dueDate: due.toISOString() });
  await say(conv, 'bert', 'yes');
  assert.deepEqual((await store.listActionItems(h.db.pool, f.id)).map((a) => [a.ownerPrincipal, a.ownerConfirmed, a.dueDate.toISOString()]), [['user:cara', true, due.toISOString()], ['user:bert', true, due.toISOString()]]);
  await next(); // assign
  await everybody(conv, 'agreed'); // the binding close
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  const protocol = await buildProtocol(h.db.pool, closed);
  assert.match(protocol, /Decisions:\n- Standups are capped at 10 minutes \(Rationale: they ran long\)\n- One meeting-free day per week \(Rationale: too many meetings\)/);
  assert.match(protocol, /Action items:\n- #1 Set a timer in standups \(Cara, due .*\): open\n- #2 Block Wednesdays \(Bert, due .*\): open/);

  const dms = h.kernel.dms.length;
  h.clock.set(new Date(due.getTime() - 24 * HOUR_MS + MINUTE_MS));
  await h.tick();
  assert.deepEqual(h.kernel.dms.slice(dms).filter((d) => d.text.includes('action item')).map((d) => d.principal).sort(), ['user:bert', 'user:cara'], 'each owner is reminded before the due date');
});

test('15. assignment: five roles, each ends with exactly one name confirmed by that person; a declined nomination reopens the role', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-15', FOUR);
  const f = await startActive(h, conv, { goal: 'Roles for the workshop', definitionOfDone: 'Every role has one name', method: 'assignment', options: ['Chair', 'Notes', 'Timekeeper', 'Host', 'Tech'] });
  await say(conv, 'anna', 'I take A');
  await say(conv, 'anna', 'B: Bert');
  await say(conv, 'bert', 'no');
  assert.equal(last(conv), 'Bert declined Notes. It is open again.');
  assert.match(await status(conv), /Status: running/);
  await say(conv, 'cara', 'I take B');
  await say(conv, 'bert', 'C: Bert\nD: Dave');
  assert.equal((await h.facilitation(conv)).phase, 'active', 'Dave has not confirmed');
  await say(conv, 'cara', 'yes');
  assert.equal((await h.facilitation(conv)).phase, 'active', "somebody else's yes confirms nothing");
  await say(conv, 'dave', 'yes');
  await say(conv, 'anna', 'E: Dave');
  await say(conv, 'dave', '👍');
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  const decision = (await store.listDecisions(h.db.pool, f.id))[0];
  assert.deepEqual(decision?.result['assignments'], [
    { item: 'A', nominee: 'user:anna', confirmed: true },
    { item: 'B', nominee: 'user:cara', confirmed: true },
    { item: 'C', nominee: 'user:bert', confirmed: true },
    { item: 'D', nominee: 'user:dave', confirmed: true },
    { item: 'E', nominee: 'user:dave', confirmed: true },
  ]);
  assert.match(result(conv), /- Roles for the workshop: Chair: Anna; Notes: Cara; Timekeeper: Bert; Host: Dave; Tech: Dave/);
});

test('16. silent voices and balance: a participant who has not contributed is invited privately before the step closes; nobody is named in the group', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-16', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Team rules', definitionOfDone: 'Rules agreed', agenda: [{ kind: 'discuss', title: 'Discuss the rules' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  for (const who of ['anna', 'bert', 'cara']) {
    const said = await say(conv, who, 'short meetings, please');
    await tool(conv, 'facilitation_record_contribution', { messageId: said.messageId, kind: 'position', summary: 'wants short meetings' });
    await say(conv, who, 'yes');
  }
  const dms = h.kernel.dms.length;
  const groupBefore = posts(conv).length;
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Not closed yet: 1 person has not contributed/);
  assert.equal((await store.openStepOf(h.db.pool, f.id))?.title, 'Discuss the rules', 'the step did not close before the invitation');
  assert.deepEqual(h.kernel.dms.slice(dms).map((d) => d.principal), ['user:dave']);
  const said = posts(conv).slice(groupBefore);
  assert.deepEqual(said, ['Before we close "Discuss the rules": whoever has not had the chance yet is welcome to add something now. After that, write "next" to close this step.']);
  assert.ok(posts(conv).every((t) => !(t.includes('Dave') && /not contributed|not had the chance|still open/.test(t))), 'nobody is named in the group as not having contributed');
  // The facilitator's turn knows the balance, so it can moderate it.
  await say(conv, 'dave', 'what do you need from me?');
  assert.match(h.kernel.turns.at(-1)?.engineContext ?? '', /Contributions per person in the open step.*Anna 1, Bert 1, Cara 1, Dave 0/);
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Closed/);
});

test('17. timebox: when it ends the facilitator summarises and the group decides to close or extend; no step closes silently', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-17', FOUR);
  await tool(conv, 'facilitation_start', { goal: 'Ideas', definitionOfDone: 'Ideas collected', agenda: [{ kind: 'collect', title: 'Collect ideas', timeboxMinutes: 10 }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  await say(conv, 'anna', 'A boat trip');
  h.clock.advance(10 * MINUTE_MS + 1000);
  await h.tick();
  assert.equal(posts(conv).at(-2), 'The timebox for "Collect ideas" is over. So far: 1 contribution from 1 of 4 people.');
  assert.match(last(conv), /^Proposal: close "Collect ideas" and move on/);
  assert.equal((await store.openStepOf(h.db.pool, f.id))?.title, 'Collect ideas');
  await say(conv, 'bert', 'extend 10');
  assert.match(last(conv), /^"Collect ideas" is extended by 10 minutes/);
  h.clock.advance(10 * MINUTE_MS + 1000);
  await h.tick();
  await everybody(conv, 'agreed');
  const tail = posts(conv).slice(-3);
  assert.equal(tail[0], 'Accepted, nobody objected: close "Collect ideas" and move on');
  assert.equal(tail[1], '"Collect ideas" is closed.');
  assert.match(tail[2] ?? '', /^Step 2 of 2: Discuss\./);
  const steps = await store.listSteps(h.db.pool, f.id);
  const events = (await store.listEvents(h.db.pool, f.id, ['step_closed'])).map((e) => e.actor);
  assert.deepEqual([steps[0]?.status, events], ['closed', ['group']], 'closed by the group, and said');
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('18. online meeting with chat and cards only', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-18', FOUR);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages']);
  h.kernel.capabilities(conv, ['text', 'card_answers'], ['text', 'polls', 'private_messages'], { sessionRef: 'meet-18', modality: 'online' });
  for (const person of ['anna', 'bert', 'cara', 'dave']) followup.calendars.set(`${person}@example.com`, []);
  followup.calendars.set('sam@example.com', []);
  const start = new Date(h.clock.now().getTime() + 3 * HOUR_MS);

  await tool(conv, 'facilitation_start', {
    goal: 'Tooling budget',
    definitionOfDone: 'A tool is chosen and next steps have owners',
    agenda: [
      { kind: 'collect', title: 'Topics' },
      { kind: 'decide', title: 'Which tool', method: 'single', options: ['Linear', 'Jira'], timeboxMinutes: 20 },
      { kind: 'assign', title: 'Next steps' },
      { kind: 'close', title: 'Close' },
    ],
  });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  assert.match(posts(conv)[0] ?? '', /What I perceive here: I read the chat, the polls\./);
  await tool(conv, 'facilitation_session', { action: 'schedule', title: 'Budget call', start: start.toISOString(), end: new Date(start.getTime() + HOUR_MS).toISOString(), modality: 'online', meetingRef: 'meet-18' });

  // Topics are collected in the chat before the meeting; the agenda is sent before it.
  await say(conv, 'anna', 'Licences run out in March');
  await say(conv, 'bert', 'Migration effort');
  h.clock.set(new Date(start.getTime() - 60 * MINUTE_MS + 1000));
  await h.tick();
  assert.match(last(conv), /^Agenda for "Budget call" on .*\n1\. Topics\n2\. Which tool \(20 min\)\n3\. Next steps\n4\. Close/);
  assert.ok(h.clock.now() < start, 'the agenda went out before the meeting');
  await tool(conv, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam@example.com', role: 'receives_protocol' });
  await everybody(conv, 'agreed');
  await tool(conv, 'facilitation_stakeholder', { name: 'Pia Procurement', address: 'pia@example.com', role: 'receives_protocol' });
  await everybody(conv, 'agreed');

  // The meeting starts: the facilitator says that it does not hear the call.
  h.clock.set(start);
  await h.kernel.sessionEvent('mira', conv, 'meet-18', 'session_started');
  await h.settle();
  assert.match(last(conv), /^"Budget call" starts now\..*I do not hear the call\./s);

  // A live poll as a card during the session, time-keeping posts, a parking lot.
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  const poll = h.kernel.groupPosts(conv).find((p) => p.poll !== undefined);
  assert.deepEqual((poll?.poll as { question: string; options: unknown[] }).question, 'Which tool');
  assert.match(posts(conv).find((t) => t.startsWith('Step 2 of 4')) ?? '', /Timebox until /);
  await tool(conv, 'facilitation_park', { topic: 'Single sign-on for the new tool' });
  assert.equal(last(conv), 'Parked for later, so we stay on the current step: Single sign-on for the new tool');
  h.clock.advance(15 * MINUTE_MS + 1000);
  await h.tick();
  assert.equal(last(conv), 'Time check: 5 minutes left for "Which tool".');
  const pollId = (poll?.poll as { pollId: string }).pollId;
  for (const [who, option] of [['anna', 'A'], ['bert', 'A'], ['cara', 'B'], ['dave', 'A']] as const) await h.kernel.answerCard(conv, who, pollId, { optionId: option }, `${poll?.messageId ?? ''}-card`);
  await h.settle();
  assert.match(last(conv), /^Step 3 of 4: Next steps\./);

  // A binding close with next steps confirmed by the group.
  await tool(conv, 'facilitation_record_action_item', { description: 'Request a quote from Linear', owner: 'Dave', dueDate: new Date(start.getTime() + 5 * DAY_MS).toISOString() });
  await say(conv, 'dave', 'yes');
  await tool(conv, 'facilitation_plan_followup_meeting', { subject: 'Tooling follow-up', durationMinutes: 30, earliest: new Date(start.getTime() + DAY_MS).toISOString(), latest: new Date(start.getTime() + 8 * DAY_MS).toISOString() });
  await everybody(conv, 'agreed');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(last(conv), /^Proposal: close the facilitation with this summary:\nDecisions:\n- Which tool: Linear \(Linear 3, Jira 1\)\nNext steps:\n- #1 Request a quote from Linear \(Dave, due .*\): open\nOpen points:\n- Single sign-on for the new tool/);
  assert.equal((await h.facilitation(conv)).phase, 'active');
  const dms = h.kernel.dms.length;
  await everybody(conv, 'agreed');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  await h.tick(); // mail and invitation run after the close is committed

  // The protocol goes to the participants and the two stakeholders; a follow-up meeting is created from free/busy.
  assert.deepEqual(h.kernel.dms.slice(dms).filter((d) => d.text.includes('here is the protocol')).map((d) => d.principal).sort(), ['user:bert', 'user:cara', 'user:dave']);
  // Participants in one mail, the stakeholder in their own, filtered one.
  const subject = followup.mails.at(-1)?.subject;
  const mailed = followup.mails.filter((m) => m.subject === subject).flatMap((m) => [...m.recipients]);
  assert.deepEqual(mailed.sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com', 'dave@example.com', 'pia@example.com', 'sam@example.com']);
  assert.deepEqual(followup.mails.filter((m) => m.subject === subject && m.recipients.length === 1).map((m) => m.recipients[0]).sort(), ['pia@example.com', 'sam@example.com'], 'each stakeholder their own protocol');
  const invitation = followup.invitations.at(-1);
  assert.equal(invitation?.subject, 'Tooling follow-up');
  assert.deepEqual([...(invitation?.attendees ?? [])].sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com', 'dave@example.com']);
  assert.ok(followup.calls.some((c) => c.method === 'freeBusy' && c.grant.facilitationId === f.id));
  assert.match(last(conv), /^Follow-up meeting "Tooling follow-up" is in the calendars for /);
});

test('19. adaptation: transcribed audio appears mid-session; announced, consent first, spoken contributions unconfirmed until confirmed; no restart', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-19', [ANNA, BERT, CARA]);
  h.kernel.capabilities(conv, ['text'], ['text', 'private_messages']);
  const f = await startActive(h, conv, { method: 'single', options: ['Thai', 'Pizza'] });
  await say(conv, 'anna', 'A');
  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text', 'private_messages']));
  await h.settle();
  assert.ok(posts(conv).includes('Something changed in this session. I can now also perceive: what is said in the call, as a transcript with the speaker.'));
  assert.match(last(conv), /^Proposal: process the transcribed speech of this call/);
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Bert', kind: 'vote', summary: 'Pizza', ballot: 'B' }), /^Refused \(no_consent\)/);
  const request = h.kernel.groupPosts(conv).at(-1)?.messageId ?? '';
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed', { replyTo: request });
  assert.match(await tool(conv, 'facilitation_record_spoken', { speaker: 'Bert', kind: 'vote', summary: 'Pizza', ballot: 'B' }), /^Recorded for Bert as unconfirmed/);
  assert.match(await status(conv), /Contributed: 1 of 3\nStill open: 2 contributions/, 'not counted before Bert confirmed');
  await say(conv, 'bert', 'yes');
  assert.match(await status(conv), /Contributed: 2 of 3\nStill open: 1 contribution/);
  const now = await h.facilitation(conv);
  assert.deepEqual([now.id, now.phase], [f.id, 'active'], 'the same facilitation, no restart');
  assert.match(await status(conv), /Provisional tally: Thai 1, Pizza 1/, "Anna's earlier vote still counts");
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('20. scoped capabilities: no calendar contents or mailboxes, nobody the group did not confirm, and the grant is lost when the follow-up ends', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ac-20', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', { goal: 'Plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await say(conv, 'anna', 'A point');
  await tool(conv, 'facilitation_stakeholder', { name: 'Uwe Unconfirmed', address: 'uwe@example.com', role: 'invited_to_followups' });
  await say(conv, 'bert', 'objection: not his topic');
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await everybody(conv, 'agreed', ['anna', 'bert', 'cara']);
  const f = await h.facilitation(conv);
  assert.equal(f.phase, 'closed');

  await h.tick();
  const calls = followup.calls.length;
  const api = await scoped(h.engine.core, f.id);
  // The whole reach: busy intervals, one invitation, one mail. Nothing that reads a mailbox or an appointment.
  assert.deepEqual(Object.keys(api).sort(), ['createInvitation', 'freeBusy', 'grant', 'sendMail']);
  assert.ok(!api.grant.allowed.includes('uwe@example.com'), 'a stakeholder the group refused is not in the grant');
  const uninvited = await api.createInvitation({ attendees: ['anna@example.com', 'uwe@example.com'], subject: 's', start: new Date('2026-12-01T09:00:00Z'), end: new Date('2026-12-01T10:00:00Z'), body: '', online: true });
  assert.deepEqual(uninvited, { ok: false, code: 'recipient_not_allowed', detail: 'uwe@example.com' });
  const busy = await api.freeBusy(['anna@example.com'], new Date('2026-12-01T08:00:00Z'), new Date('2026-12-02T08:00:00Z'));
  assert.equal(busy.ok, true);
  if (busy.ok && busy.value.outcome === 'ok') for (const entry of busy.value.busy) assert.deepEqual(Object.keys(entry).sort(), ['attendee', 'intervals'], 'busy intervals only');
  assert.equal(followup.calls.length, calls + 1, 'only the allowed free/busy call reached the integration');

  h.clock.advance(14 * DAY_MS + HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).settings.followupGrant, 'revoked');
  const late = await (await scoped(h.engine.core, f.id)).freeBusy(['anna@example.com'], new Date('2026-12-10T08:00:00Z'), new Date('2026-12-11T08:00:00Z'));
  assert.deepEqual(late, { ok: false, code: 'grant_revoked' });
  assert.equal(followup.calls.length, calls + 1);
  assert.match(await buildProtocol(h.db.pool, await h.facilitation(conv)), /Use of scoped capabilities:[\s\S]*grant issued[\s\S]*grant revoked: the follow-up period ended/);
});
