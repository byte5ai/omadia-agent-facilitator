// Facilitation-scoped capabilities (spec 5.11, issue #2078, acceptance 20).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { scoped } from '../src/engine/capabilities.js';
import { alignToGrid, findSlot } from '../src/engine/slots.js';
import { buildProtocol } from '../src/engine/protocol.js';
import { ANNA, BERT, CARA, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';
import { proposeNamedStakeholders } from '../src/tools/startStakeholders.js';

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

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string) {
  const record = await h.kernel.say(conv, who, text);
  await h.settle();
  return record;
}
/** A reply to the facilitator's last message: what it hears in follow-up
 *  without a turn of the facilitator being started (a mention starts one). */
async function reply(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text, { replyTo: h.kernel.groupPosts(conv).at(-1)?.messageId ?? '' });
  await h.settle();
}
/** Everybody answers; an agreement holds once the window has ended (spec
 *  5.7: agreeing early does not end it). */
const all = async (conv: string, text: string, who = ['anna', 'bert', 'cara']): Promise<void> => {
  for (const person of who) await say(conv, person, text);
  if (text === 'agreed') await passWindow(h, conv);
};
const iso = (s: string): Date => new Date(s);

test('slots: the first common free time in working hours on a weekday, on the quarter-hour grid', () => {
  // Wednesday 18 Nov 2026, Berlin is UTC+1.
  const base = { timezone: 'Europe/Berlin', durationMinutes: 60 };
  assert.equal(alignToGrid(iso('2026-11-18T09:07:00Z')).toISOString(), '2026-11-18T09:15:00.000Z');
  assert.deepEqual(findSlot({ ...base, from: iso('2026-11-18T09:07:00Z'), to: iso('2026-11-20T17:00:00Z'), busy: [] })?.start.toISOString(), '2026-11-18T09:15:00.000Z');
  // Busy until 11:30 local and again 12:00 to 13:00: the hour does not fit in between.
  const busy = [{ start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:30:00Z' }, { start: '2026-11-18T11:00:00Z', end: '2026-11-18T12:00:00Z' }];
  assert.equal(findSlot({ ...base, from: iso('2026-11-18T09:00:00Z'), to: iso('2026-11-20T17:00:00Z'), busy })?.start.toISOString(), '2026-11-18T12:00:00.000Z');
  // After 16:00 local an hour no longer ends inside the working day: next morning 09:00 local.
  assert.equal(findSlot({ ...base, from: iso('2026-11-18T15:30:00Z'), to: iso('2026-11-20T17:00:00Z'), busy: [] })?.start.toISOString(), '2026-11-19T08:00:00.000Z');
  // Friday evening: Monday morning.
  assert.equal(findSlot({ ...base, from: iso('2026-11-20T17:00:00Z'), to: iso('2026-11-25T17:00:00Z'), busy: [] })?.start.toISOString(), '2026-11-23T08:00:00.000Z');
  assert.equal(findSlot({ ...base, from: iso('2026-11-18T09:00:00Z'), to: iso('2026-11-18T16:00:00Z'), busy: [{ start: '2026-11-18T00:00:00Z', end: '2026-11-19T00:00:00Z' }] }), undefined);
});

async function closedWithFollowup(conv: string, opts: { stakeholders?: boolean; meeting?: boolean; fixedDates?: boolean; tick?: boolean } = {}) {
  await tool(conv, 'facilitation_start', { goal: 'Offsite plan', definitionOfDone: 'Plan agreed', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await say(conv, 'anna', 'A boat trip');
  if (opts.stakeholders) {
    await tool(conv, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'Sam@Example.com', role: 'receives_protocol' });
    await all(conv, 'agreed');
    await tool(conv, 'facilitation_stakeholder', { name: 'Vera Venue', address: 'vera@example.com', role: 'invited_to_followups' });
    await all(conv, 'agreed');
  }
  if (opts.meeting) {
    const window = opts.fixedDates
      ? { earliest: '2026-11-19T08:00:00Z', latest: '2026-11-27T16:00:00Z' }
      : { earliest: h.clock.now().toISOString(), latest: new Date(h.clock.now().getTime() + 8 * DAY_MS).toISOString() };
    await tool(conv, 'facilitation_plan_followup_meeting', { subject: 'Offsite follow-up', durationMinutes: 60, ...window });
    await all(conv, 'agreed');
  }
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await all(conv, 'agreed');
  // Mail and invitation run as jobs after the close is committed.
  if (opts.tick !== false) await h.tick();
  return h.facilitation(conv);
}

test('a stakeholder counts only when the group confirmed; one the group refused is gone', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-stakeholder', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', { goal: 'g', definitionOfDone: 'd', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  assert.match(await tool(conv, 'facilitation_stakeholder', { name: 'Olga Outside', role: 'receives_protocol' }), /^Refused \(bad_input\): A stakeholder who is not in this conversation needs a mail address/);
  await tool(conv, 'facilitation_stakeholder', { name: 'Olga Outside', address: 'olga@example.com', role: 'receives_protocol' });
  assert.match(posts(conv).at(-1) ?? '', /^Proposal: add Olga Outside as a stakeholder who receives the protocol/);
  const f = await h.facilitation(conv);
  await say(conv, 'bert', 'objection: she is not part of this');
  h.clock.advance(31 * MINUTE_MS);
  await h.tick();
  assert.deepEqual(await store.listStakeholders(h.db.pool, f.id), []);
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('stakeholders named in the start request are recorded one by one, wait for the opening, and go to the group once (live finding 2026-11-21)', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-start-stakeholders', [ANNA, BERT, CARA]);
  const answer = await tool(conv, 'facilitation_start', {
    goal: 'g',
    definitionOfDone: 'd',
    agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }],
    stakeholders: [
      { name: 'Maria Boss', address: 'Maria@Example.com' },
      { name: 'Tom IT', role: 'invited_to_followups' },
      { name: 'Paul Typo', address: 'paul(at)example' },
      { name: 'Cara' },
    ],
  });
  // One bad address does not hold up the others; each one left out has its own note.
  assert.match(answer, /Stakeholders noted: Maria Boss, Cara\. Nothing was posted about them yet/);
  assert.match(answer, /Not noted as a stakeholder: Tom IT\. Not in this conversation and no mail address given\. Ask for the address/);
  assert.match(answer, /Not noted as a stakeholder: Paul Typo\. "paul\(at\)example" is not a mail address\. Ask for the correct address/);
  assert.match(answer, /It is NOT open: nothing was posted in the group/);
  // Nothing is posted while it is being set up (spec 5.2).
  assert.equal(h.kernel.groupPosts(conv).length, 0);
  const f = await h.facilitation(conv);
  assert.equal((await store.listStakeholders(h.db.pool, f.id)).filter((s) => !s.confirmed).length, 2);

  // Adjusting the setup does not record the same people again.
  const again = await tool(conv, 'facilitation_start', { goal: 'g2', stakeholders: [{ name: 'maria boss', address: 'maria@example.com' }] });
  assert.doesNotMatch(again, /Stakeholders noted/);
  // Read and write in one unit of work: two calls at once record a new person once.
  const [one, two] = await Promise.all([
    proposeNamedStakeholders(h.engine, f.id, [{ displayName: 'Dora Dev', address: 'dora@example.com', role: 'receives_protocol' }], 'user:anna'),
    proposeNamedStakeholders(h.engine, f.id, [{ displayName: 'Dora Dev', address: 'dora@example.com', role: 'receives_protocol' }], 'user:anna'),
  ]);
  assert.equal([...one.notes, ...two.notes].filter((n) => n.startsWith('Stakeholders noted: Dora Dev')).length, 1);
  assert.equal((await store.listStakeholders(h.db.pool, f.id)).length, 3);
  assert.equal((await store.listProposals(h.db.pool, f.id)).length, 0);

  // Once open, after the handshake, all of them go to the group as one proposal.
  await tool(conv, 'facilitation_open');
  await h.tick();
  const stakeholderProposals = (await store.listProposals(h.db.pool, f.id)).filter((p) => p.kind === 'stakeholder');
  assert.equal(stakeholderProposals.length, 1);
  const proposal = posts(conv).at(-1) ?? '';
  assert.match(proposal, /^Proposal: add /);
  for (const name of ['Maria Boss', 'Cara', 'Dora Dev']) assert.match(proposal, new RegExp(`add ${name} as a stakeholder who receives the protocol`));
  assert.equal(posts(conv).filter((t) => t.startsWith('Proposal:')).length, 1);
  await all(conv, 'agreed');
  const confirmed = (await store.listStakeholders(h.db.pool, f.id)).filter((s) => s.confirmed);
  assert.deepEqual(confirmed.map((s) => s.address).sort(), ['cara@example.com', 'dora@example.com', 'maria@example.com']);
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('a pending stakeholder proposal never holds up a step close or the binding close; it is asked again afterwards', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-stakeholder-yields', [ANNA, BERT, CARA]);
  await tool(conv, 'facilitation_start', { goal: 'g', definitionOfDone: 'd', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'collect', title: 'More' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  await tool(conv, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam@example.com', role: 'receives_protocol' });
  assert.equal((await store.openProposal(h.db.pool, f.id))?.kind, 'stakeholder');

  // "move on" opens the step close: not refused, the stakeholder proposal gives way.
  await say(conv, 'anna', 'move on');
  assert.equal((await store.openProposal(h.db.pool, f.id))?.kind, 'step_close');
  assert.ok(posts(conv).some((t) => t.startsWith('I set the proposal on stakeholders aside')));
  assert.ok(!posts(conv).some((t) => t === 'One proposal at a time: the open one is decided first.'));
  await all(conv, 'agreed');
  assert.equal((await store.listSteps(h.db.pool, f.id)).find((s) => s.title === 'More')?.status, 'open');

  // Afterwards it is put to the group again, with the same person.
  h.clock.advance(6 * MINUTE_MS);
  await h.tick();
  const again = await store.openProposal(h.db.pool, f.id);
  assert.equal(again?.kind, 'stakeholder');
  assert.equal((await store.listStakeholders(h.db.pool, f.id)).length, 1);

  // The binding close opens although the stakeholder proposal is open.
  await say(conv, 'bert', 'A point');
  await tool(conv, 'facilitation_step', { action: 'close' });
  assert.match(await tool(conv, 'facilitation_step', { action: 'close' }), /^Closed/);
  assert.equal((await store.openProposal(h.db.pool, f.id))?.kind, 'close');
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('a pending stakeholder proposal never holds up the media consent of a call', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-stakeholder-media', [ANNA, BERT]);
  h.kernel.capabilities(conv, ['text'], ['text']);
  await tool(conv, 'facilitation_start', { goal: 'g', definitionOfDone: 'd', agenda: [{ kind: 'collect', title: 'Collect' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  const f = await h.facilitation(conv);
  await tool(conv, 'facilitation_stakeholder', { name: 'Sam Sponsor', address: 'sam@example.com', role: 'receives_protocol' });
  await h.kernel.changeCapabilities('mira', h.kernel.capabilities(conv, ['text', 'transcribed_speech'], ['text']));
  await h.settle();
  assert.equal((await store.openProposal(h.db.pool, f.id))?.kind, 'media_consent');
  await tool(conv, 'facilitation_stop', { reason: 'test over' });
});

test('at the close the protocol goes to participants and confirmed stakeholders, and the agreed follow-up meeting is created from free/busy', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-close', [ANNA, BERT, CARA]);
  followup.calendars.set('anna@example.com', [{ start: '2026-11-19T08:00:00Z', end: '2026-11-19T10:00:00Z' }]);
  followup.calendars.set('bert@example.com', []);
  followup.calendars.set('cara@example.com', [{ start: '2026-11-19T10:00:00Z', end: '2026-11-19T10:30:00Z' }]);
  const dms = h.kernel.dms.length;
  const f = await closedWithFollowup(conv, { stakeholders: true, meeting: true, fixedDates: true });
  assert.equal(f.phase, 'closed');

  // Protocol dispatch: privately to the participants (the initiator has it with the report), by mail to everybody the grant covers.
  const direct = h.kernel.dms.slice(dms).filter((d) => d.text.includes('here is the protocol of the facilitation'));
  assert.deepEqual(direct.map((d) => d.principal).sort(), ['user:bert', 'user:cara']);
  // The participants get their protocol in one mail; the stakeholder gets
  // their own, filtered one (spec 5.8): no contributions, a note about it.
  const [mail, sams] = followup.mails.slice(-2);
  assert.deepEqual([...(mail?.recipients ?? [])].sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com']);
  assert.equal(mail?.subject, 'Protocol: Offsite plan');
  assert.match(mail?.body ?? '', /^Protocol: Offsite plan\nResult status: published\nDelivery: delivered\nFacilitator: Mira/);
  assert.deepEqual(sams?.recipients, ['sam@example.com']);
  assert.match(sams?.body ?? '', /^Protocol: Offsite plan\nResult status: published\nDelivery: delivered\n/);
  assert.doesNotMatch(sams?.body ?? '', /Contributions|A boat trip|Participants:/);
  assert.match(sams?.body ?? '', /Some parts of this protocol are not shared with you/);
  assert.ok(!followup.mails.slice(-2).some((m) => m.recipients.includes('vera@example.com')), 'a stakeholder for follow-ups does not get the protocol');
  assert.ok(posts(conv).includes('The protocol has been sent: privately to 2 participants and by mail to 4 addresses.'));

  // Follow-up scheduling: free/busy only, then the invitation for the first common free time.
  const freeBusy = followup.calls.find((c) => c.method === 'freeBusy' && c.grant.facilitationId === f.id);
  assert.deepEqual([...(freeBusy?.request['attendees'] as string[])].sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com', 'vera@example.com']);
  assert.equal(freeBusy?.request['from'], '2026-11-19T08:00:00.000Z');
  const invitation = followup.invitations.at(-1);
  assert.equal(invitation?.start, '2026-11-19T10:30:00.000Z', 'after Anna is free and after Cara is free');
  assert.equal(invitation?.end, '2026-11-19T11:30:00.000Z');
  assert.ok(!invitation?.attendees.includes('sam@example.com'), 'a stakeholder who only receives the protocol is not invited');
  assert.match(invitation?.body ?? '', /^Follow-up to "Offsite plan"\.\n\nDecisions:/);
  assert.match(posts(conv).at(-1) ?? '', /^Follow-up meeting "Offsite follow-up" is in the calendars for Thu, 19\/11\/2026, 11:30 \(Europe\/Berlin\)\. For 1 person I could not see availability, so please check the time\.$/);

  // Every use is in the protocol.
  const protocol = await buildProtocol(h.db.pool, f);
  assert.match(protocol, /Use of scoped capabilities:\n- .*grant issued for 5 addresses/);
  assert.match(protocol, /protocol mailed to 3 addresses/);
  assert.match(protocol, /protocol mailed to 1 address\b/);
  assert.match(protocol, /free\/busy read for 4 people/);
  assert.match(protocol, /invitation "Offsite follow-up" for Thu, 19\/11\/2026, 11:30 \(Europe\/Berlin\) sent to 4 people/);
});

test('the facilitator cannot reach anybody the group did not confirm, and the integration is not even called', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-scope', [ANNA, BERT, CARA]);
  const f = await closedWithFollowup(conv);
  const calls = followup.calls.length;
  const api = await scoped(h.engine.core, f.id);
  assert.deepEqual([...api.grant.allowed].sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com']);
  const stranger = await api.freeBusy(['anna@example.com', 'ceo@example.com'], iso('2026-11-19T08:00:00Z'), iso('2026-11-20T08:00:00Z'));
  assert.deepEqual(stranger, { ok: false, code: 'recipient_not_allowed', detail: 'ceo@example.com' });
  const invite = await api.createInvitation({ attendees: ['ceo@example.com'], subject: 'x', start: iso('2026-11-19T08:00:00Z'), end: iso('2026-11-19T09:00:00Z'), body: '', online: true });
  assert.equal(invite.ok, false);
  const mail = await api.sendMail(['press@example.com'], 'x', 'y');
  assert.equal(mail.ok, false);
  // The surface has exactly three operations: no reading of mailboxes or calendar contents.
  assert.deepEqual(Object.keys(api).sort(), ['createInvitation', 'dispatchDone', 'freeBusy', 'grant', 'sendMail']);
  assert.equal(followup.calls.length, calls, 'refused by the engine before the integration is called');
  assert.equal((await store.listEvents(h.db.pool, f.id, ['capability_refused'])).length, 3);
  assert.match(await h.tool('facilitation_plan_followup_meeting', { subject: 'x', durationMinutes: 60, earliest: '2026-11-19T08:00:00Z', latest: '2026-11-20T08:00:00Z' }, { conversation: conv }), /^Refused \(no_facilitation\)/, 'after the close the facilitator has no tools here');
});

test('the grant is revoked when the follow-up ends: scheduling is refused afterwards', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-revoke', [ANNA, BERT, CARA]);
  const f = await closedWithFollowup(conv);
  assert.equal((await h.facilitation(conv)).settings.followupGrant, 'active');
  h.clock.advance(14 * DAY_MS + HOUR_MS);
  await h.tick();
  const revoked = await h.facilitation(conv);
  assert.equal(revoked.settings.followupGrant, 'revoked');
  const calls = followup.calls.length;
  const late = await (await scoped(h.engine.core, f.id)).freeBusy(['anna@example.com'], h.clock.now(), new Date(h.clock.now().getTime() + 5 * DAY_MS));
  assert.deepEqual(late, { ok: false, code: 'grant_revoked' });
  assert.equal(followup.calls.length, calls, 'the integration is not called without a grant');
  const events = await store.listEvents(h.db.pool, f.id, ['grant_issued', 'grant_revoked', 'capability_refused']);
  assert.deepEqual(events.map((e) => e.kind), ['grant_issued', 'grant_revoked', 'capability_refused']);
});

test('with action items the grant ends with their follow-up', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-items', [ANNA, BERT]);
  await tool(conv, 'facilitation_start', { goal: 'Next steps', definitionOfDone: 'Owners agreed', followUp: true, agenda: [{ kind: 'assign', title: 'Assign' }, { kind: 'close', title: 'Close' }] });
  await tool(conv, 'facilitation_open');
  await tool(conv, 'facilitation_record_action_item', { description: 'Book the boat', owner: 'Anna', dueDate: new Date(h.clock.now().getTime() + 2 * DAY_MS).toISOString() });
  await say(conv, 'anna', 'yes');
  await tool(conv, 'facilitation_step', { action: 'close' });
  await tool(conv, 'facilitation_step', { action: 'close' });
  await all(conv, 'agreed', ['anna', 'bert']);
  assert.equal((await h.facilitation(conv)).settings.followupGrant, 'active');
  // In follow-up the facilitator hears a reply to one of its messages.
  await reply(conv, 'anna', 'done 1');
  const ended = await h.facilitation(conv);
  assert.equal(ended.followupState, 'ended');
  assert.equal(ended.settings.followupGrant, 'revoked');
});

test('no integration, or one that is not configured: the close stands and the group is told what to do itself', { skip: PG_SKIP }, async () => {
  followup.configured = false;
  const conv = h.kernel.conversation('ca-unconfigured', [ANNA, BERT, CARA]);
  const f = await closedWithFollowup(conv, { meeting: true });
  followup.configured = true;
  assert.equal(f.phase, 'closed');
  const texts = posts(conv);
  assert.ok(texts.includes('The protocol could not be mailed (no calendar integration is set up for this instance). It is in this group, and 2 participants got it privately.'));
  assert.ok(texts.includes('I could not schedule "Offsite follow-up" (no calendar integration is set up for this instance). Please send the invitation yourselves.'));

  h.kernel.absent.add('followup');
  const none = h.kernel.conversation('ca-none', [ANNA, BERT, CARA]);
  const g = await closedWithFollowup(none, { meeting: true });
  h.kernel.absent.delete('followup');
  assert.equal(g.phase, 'closed');
  assert.ok(posts(none).includes('I could not schedule "Offsite follow-up" (no calendar integration is installed). Please send the invitation yourselves.'));
});

test('an invitation without a meeting link, and no common free time, are both said to the group', { skip: PG_SKIP }, async () => {
  followup.joinLinks = false;
  const conv = h.kernel.conversation('ca-nolink', [ANNA, BERT, CARA]);
  await closedWithFollowup(conv, { meeting: true });
  followup.joinLinks = true;
  assert.match(posts(conv).at(-1) ?? '', /The invitation went out without a meeting link\./);

  followup.calendars.set('bert@example.com', [{ start: '2026-11-18T00:00:00Z', end: '2027-03-31T00:00:00Z' }]);
  const full = h.kernel.conversation('ca-noslot', [ANNA, BERT, CARA]);
  await closedWithFollowup(full, { meeting: true });
  followup.calendars.set('bert@example.com', []);
  assert.equal(posts(full).at(-1), 'I found no time between the agreed dates at which everybody is free for "Offsite follow-up". Please pick a time yourselves.');
});

test('review 4: the close is committed before any mail or calendar call, and no lock is held during them', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-commit-first', [ANNA, BERT, CARA]);
  for (const person of ['anna', 'bert', 'cara']) followup.calendars.set(`${person}@example.com`, []);
  const seen: Array<{ method: string; phase: string | undefined; lockFree: boolean }> = [];
  followup.onCall = async (method) => {
    // Looked at from another connection: what is committed, and is the facilitation's lock free?
    const f = await h.facilitation(conv);
    const lock = await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_locks WHERE facilitation_id = $1 AND lease_until > now()`, [f.id]);
    seen.push({ method, phase: f.phase, lockFree: lock.rows.length === 0 });
  };
  try {
    await closedWithFollowup(conv, { meeting: true });
    await h.tick();
  } finally {
    followup.onCall = () => undefined;
  }
  assert.deepEqual(seen.map((s) => s.method), ['sendMail', 'freeBusy', 'createInvitation']);
  for (const call of seen) assert.deepEqual([call.phase, call.lockFree], ['closed', true], call.method);
});

test('review 4: a mail or an invitation whose answer is lost is not sent a second time; the close stands and the group is told', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-lost-answer', [ANNA, BERT, CARA]);
  const mails = followup.mails.length;
  const invitations = followup.invitations.length;
  followup.afterEffects.set('sendMail', 'throw');
  followup.afterEffects.set('createInvitation', 'throw');
  try {
    const f = await closedWithFollowup(conv, { meeting: true });
    assert.equal(f.phase, 'closed');
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(5 * MINUTE_MS);
      await h.tick();
    }
  } finally {
    followup.afterEffects.clear();
  }
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(followup.mails.length, mails + 1, 'exactly one mail');
  assert.equal(followup.invitations.length, invitations + 1, 'exactly one invitation');
  const said = posts(conv);
  assert.ok(said.some((t) => t.startsWith('I do not know whether the protocol mail went out')), 'the unknown outcome is said');
  assert.ok(said.some((t) => t.startsWith('I do not know whether the invitation for "Offsite follow-up" went out')));
});

test('review 4: a close that has to be repeated does not repeat the mail or the invitation', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-close-twice', [ANNA, BERT, CARA]);
  const mails = followup.mails.length;
  const invitations = followup.invitations.length;
  let failed = false;
  h.hooks.beforeClose = () => {
    if (failed) return;
    failed = true;
    throw new Error('database error while closing');
  };
  try {
    // The group's consent is decided when its window ends, by the scheduler:
    // the first close fails there, and the scheduler repeats it.
    await closedWithFollowup(conv, { meeting: true, tick: false });
    assert.equal(failed, true, 'the first close failed');
    await h.tick();
    await h.tick();
  } finally {
    delete h.hooks.beforeClose;
  }
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  assert.equal(followup.mails.length, mails + 1);
  assert.equal(followup.invitations.length, invitations + 1);
});

test('review 4: an integration that does not answer times out; the conversation is released once the follow-up work is done', { skip: PG_SKIP }, async () => {
  const { followupLimits } = await import('../src/engine/capabilities.js');
  const before = { ...followupLimits };
  followupLimits.timeoutMs = 150;
  const conv = h.kernel.conversation('ca-hang', [ANNA, BERT, CARA]);
  followup.afterEffects.set('sendMail', 'hang');
  try {
    const f = await closedWithFollowup(conv, { tick: false });
    assert.equal(f.phase, 'closed');
    // The conversation is given back at the close; the closing scope stays
    // while the mail is still to go (the note about it is drawn from it).
    assert.equal(h.kernel.modeOf(f.id, conv), 'none', 'not read any more');
    assert.equal(h.kernel.reservations.find((r) => r.processId === f.id)?.releasedAt !== undefined, true, 'the reservation is released at the close');
    assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'open');
    await h.tick();
    await h.tick();
    assert.equal(h.kernel.scopeOf(f.id, 'closing', 'result')?.state, 'ended', 'ended once the follow-up work is done');
    assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  } finally {
    followup.afterEffects.clear();
    Object.assign(followupLimits, before);
  }
  assert.ok(posts(conv).some((t) => t.startsWith('I do not know whether the protocol mail went out')));
  assert.equal(h.kernel.subscriptions.has(`mira|teams|${conv}`), false);
});

// ── 1.4.0: kernel-issued grants (kernel #2078) ──────────────────────────────

test('mail and calendar run under grants the kernel issued: per scope, for the people the group confirmed, handed to the integration and revoked when their work is done', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('ca-grants', [ANNA, BERT, CARA]);
  followup.calendars.set('anna@example.com', []);
  followup.calendars.set('bert@example.com', []);
  followup.calendars.set('cara@example.com', []);
  const f = await closedWithFollowup(conv, { stakeholders: true, meeting: true });
  const grants = h.kernel.grants.filter((g) => g.processId === f.id);
  // One dispatch grant for all its mails (the participants' and the
  // stakeholder's): the kernel never issues a grant twice.
  assert.deepEqual(grants.map((g) => g.kind).sort(), ['followup_scheduling', 'protocol_dispatch']);

  // Protocol dispatch: under the closing scope of the result.
  const dispatch = grants.find((g) => g.kind === 'protocol_dispatch');
  assert.equal(dispatch?.scopeId, h.kernel.scopeOf(f.id, 'closing', 'result')?.id);
  assert.deepEqual([...(dispatch?.recipients ?? [])].sort(), ['anna@example.com', 'bert@example.com', 'cara@example.com', 'sam@example.com', 'vera@example.com']);
  assert.deepEqual(dispatch?.uses.map((u) => [u.operation, u.allowed]), [['send_mail', true], ['send_mail', true]], 'the integration asked the kernel before each mail');
  assert.match(dispatch?.revokeReason ?? '', /protocol mail done/, 'revoked once the sends are confirmed');

  // Follow-up scheduling: under the scheduling scope of the agreed meeting.
  const scheduling = grants.find((g) => g.kind === 'followup_scheduling');
  assert.equal(scheduling?.scopeId, h.kernel.scopeOf(f.id, 'scheduling', 'followup_meeting')?.id);
  assert.deepEqual(scheduling?.uses.map((u) => [u.operation, u.allowed]), [['free_busy', true], ['create_invitation', true]]);
  assert.match(scheduling?.revokeReason ?? '', /invitation done/, 'revoked once the invitation is out');

  // Every call of the integration carried the grant, next to the recipient list.
  const calls = followup.calls.filter((c) => c.grant.facilitationId === f.id);
  assert.deepEqual(calls.map((c) => [c.method, (c.grant as { grantId?: string }).grantId]), [
    ['sendMail', dispatch?.id],
    ['sendMail', dispatch?.id],
    ['freeBusy', scheduling?.id],
    ['createInvitation', scheduling?.id],
  ]);
  assert.ok(calls.every((c) => c.grant.allowed.length === 5), 'the recipient list stays the second line');

  // With its work done every scope has ended, and no grant is live.
  await h.tick();
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  assert.ok((await h.engine.core.deps.kernel.grants()?.listGrants(f.id))?.every((g) => !g.live));
});

test('without a grant nothing is sent: an instance that cannot grant, and a kernel that refuses, are said to the group and the integration is not asked', { skip: PG_SKIP }, async () => {
  const calls = followup.calls.length;
  h.kernel.absent.add('grants');
  try {
    const conv = h.kernel.conversation('ca-no-grants', [ANNA, BERT, CARA]);
    const f = await closedWithFollowup(conv, { meeting: true });
    assert.equal(f.phase, 'closed', 'the close stands');
    assert.ok(posts(conv).includes('The protocol could not be mailed (this instance cannot grant a facilitation mail or calendar access). It is in this group, and 2 participants got it privately.'), posts(conv).slice(-4).join('\n---\n'));
    assert.ok(posts(conv).some((t) => t.startsWith('I could not schedule "Offsite follow-up" (this instance cannot grant a facilitation mail or calendar access).')));
  } finally {
    h.kernel.absent.delete('grants');
  }
  assert.equal(followup.calls.length, calls, 'the integration was not called');

  // The integration asks the kernel with the grant; a stop refuses its use.
  const conv = h.kernel.conversation('ca-grant-refused', [ANNA, BERT, CARA]);
  followup.onCall = () => {
    h.kernel.killSwitch.instance = true;
  };
  try {
    await closedWithFollowup(conv, { tick: false });
    await h.tick();
  } finally {
    followup.onCall = () => undefined;
    h.kernel.killSwitch.instance = false;
  }
  const f = await h.facilitation(conv);
  const grant = h.kernel.grants.find((g) => g.processId === f.id && g.kind === 'protocol_dispatch');
  assert.deepEqual(grant?.uses.map((u) => [u.allowed, u.refusal]), [[false, 'kill_switch']]);
  assert.equal(followup.mails.filter((m) => m.subject === 'Protocol: Offsite plan' && m.body.includes(f.id)).length, 0);
  await h.tick();
  h.clock.advance(MINUTE_MS);
  await h.tick();
  assert.ok(posts(conv).some((t) => t.startsWith('The protocol could not be mailed (the instance did not grant this')), posts(conv).slice(-4).join('\n---\n'));
});
