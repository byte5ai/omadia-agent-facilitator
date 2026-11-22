// Execution scopes (spec 2043 §0, kernel #2090 and #2091): every action of a
// facilitation is drawn from a scope the kernel keeps, and what the kernel
// refuses is said, never swallowed.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/clock.js';
import { lifecycleOf } from '../src/model.js';
import * as pluginApi from '@omadia/plugin-api';

import { SCOPE_MARGIN_MS, TURN_MODEL_CALLS, purposeFor } from '../src/engine/scopes.js';
import { ANNA, BERT, CARA, FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';
import { CLOSING_PURPOSES } from './fakeKernel.js';

/** The kernel's list from plugin-api 1.85.0 (omadia#2157); against an older
 *  contract the fake kernel's mirror, which the test below holds equal to it. */
const KERNEL_CLOSING_PURPOSES: readonly string[] | undefined = (pluginApi as { readonly CLOSING_SCOPE_PURPOSES?: readonly string[] }).CLOSING_SCOPE_PURPOSES;

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const THREE = [ANNA, BERT, CARA];

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
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
const events = async (facilitationId: string, kind: string): Promise<Record<string, unknown>[]> =>
  (await h.db.pool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = $2 ORDER BY occurred_at`, [facilitationId, kind])).rows.map((r) => r.payload);
const people = (processId: string, kind: 'configuring' | 'active' | 'closing' | 'follow_up', eventId = ''): string[] =>
  (h.kernel.scopeOf(processId, kind, eventId)?.targets ?? []).flatMap((t) => (t.kind === 'person' ? [`${t.principalId}${t.restriction ? `:${t.restriction}` : ''}`] : [])).sort();
const authorized = (processId: string) => h.kernel.authorizations.filter((a) => a.processId === processId);

test('the five scopes follow the lifecycle: configuring takes the reservation, the handshake opens active, the result its closing, and the close gives the conversation back', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-life', THREE);
  const deadline = new Date(h.clock.now().getTime() + 2 * DAY_MS);
  assert.match(await tool(conv, 'facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', deadline: deadline.toISOString(), ...VOTE }), /^Facilitation created/);
  const f = await h.facilitation(conv);

  // configuring: the home conversation's reservation, every message read,
  // private messages to the initiator only (the others may ask for the status).
  assert.deepEqual(h.kernel.openScopesOf(f.id).map((s) => s.kind), ['configuring']);
  assert.equal(h.kernel.reservations.find((r) => r.processId === f.id)?.releasedAt, undefined);
  assert.equal(h.kernel.modeOf(f.id, conv), 'all');
  assert.deepEqual(people(f.id, 'configuring'), ['anna', 'bert:status_only', 'cara:status_only']);
  assert.ok(authorized(f.id).some((a) => a.action === 'check' && a.purpose === 'readiness_check' && a.phase === 'configuring'), 'readiness is a checked action under the scope');

  // The handshake: active opens, configuring ends with it.
  assert.match(await tool(conv, 'facilitation_open'), /^Opened/);
  assert.equal(h.kernel.scopeOf(f.id, 'configuring')?.state, 'ended');
  const active = h.kernel.scopeOf(f.id, 'active');
  assert.equal(active?.state, 'open');
  assert.equal(active?.deadline, new Date(deadline.getTime() + SCOPE_MARGIN_MS).toISOString(), "until the facilitation's deadline, with room for the evaluation at that time");
  assert.deepEqual(people(f.id, 'active'), ['anna', 'bert', 'cara']);
  const handshake = authorized(f.id).find((a) => a.purpose === 'handshake');
  assert.deepEqual([handshake?.kind, handshake?.action, handshake?.phase, handshake?.emission], ['active', 'post', 'active', 'template']);

  // Everybody voted: the result is posted under a closing scope of its own.
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
  const closed = await h.facilitation(conv);
  assert.equal(closed.phase, 'closed');
  assert.equal(lifecycleOf(closed), 'ended', 'without action items it goes from closed straight to ended');
  const result = authorized(f.id).find((a) => a.kind === 'closing' && a.action === 'post' && a.purpose === 'essential_message');
  assert.deepEqual([result?.purpose, result?.phase], ['essential_message', 'concluding']);
  assert.ok(h.kernel.posts.some((p) => p.processId === f.id && /Result/.test(p.text)));

  // Closed: the reservation is released, nothing is read, every scope ended.
  assert.notEqual(h.kernel.reservations.find((r) => r.processId === f.id)?.releasedAt, undefined);
  assert.equal(h.kernel.modeOf(f.id, conv), undefined);
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  assert.deepEqual(h.kernel.scopes.filter((s) => s.processId === f.id).map((s) => `${s.kind}${s.eventId ? `/${s.eventId}` : ''}`), ['configuring', 'active', 'closing/result']);
  const rows = await h.db.pool.query<{ kind: string; state: string }>(`SELECT kind, state FROM plg_omadia_agent_facilitator_scopes WHERE facilitation_id = $1 ORDER BY opened_at`, [f.id]);
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.state]), [['configuring', 'ended'], ['active', 'ended'], ['closing', 'ended']], 'on record as the kernel has them');

  // A new facilitation can start in the conversation at once.
  const next = await startActive(h, conv, { ...VOTE, goal: 'Pick a date' });
  assert.notEqual(next.id, f.id);
});

test('nothing is posted, written privately or asked of the model without an authorization from the scope of the phase', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-all', THREE);
  const f = await startActive(h, conv, { ...VOTE, deadline: new Date(h.clock.now().getTime() + 3 * HOUR_MS).toISOString(), reminderMinutesBefore: [60] });
  h.kernel.onTurn = () => 'Let us hear from everybody first.';
  try {
    await say(conv, 'anna', 'What about parking at the harbour?');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  const turn = authorized(f.id).find((a) => a.action === 'model_turn');
  assert.deepEqual([turn?.kind, turn?.phase, turn?.purpose, turn?.emission, turn?.modelCalls], ['active', 'active', 'moderation', 'prose', TURN_MODEL_CALLS]);
  const request = h.kernel.turns.at(-1);
  assert.deepEqual([request?.processId, request?.scopeId, request?.budget.modelCalls], [f.id, h.kernel.scopeOf(f.id, 'active')?.id, TURN_MODEL_CALLS]);
  assert.equal(h.kernel.scopeOf(f.id, 'active')?.used.modelCalls, h.kernel.turnModelCalls, 'what the turn did not use went back to the scope');
  const said = authorized(f.id).filter((a) => a.action === 'post' && a.purpose === 'moderation').at(-1);
  assert.equal(said?.emission, 'prose', "the model's text is sent as prose");
  assert.equal(posts(conv).at(-1), 'Let us hear from everybody first.');

  // A reminder: neutral in the group, privately to the people it concerns.
  await say(conv, 'anna', 'A');
  h.clock.advance(2 * HOUR_MS + MINUTE_MS);
  await h.tick();
  const reminders = authorized(f.id).filter((a) => a.purpose === 'reminder');
  assert.deepEqual(reminders.map((a) => a.action).sort(), ['direct_message', 'direct_message', 'post']);
  assert.deepEqual(reminders.filter((a) => a.action === 'direct_message').map((a) => (a.target?.kind === 'person' ? a.target.principalId : '')).sort(), ['bert', 'cara']);
  assert.ok(h.kernel.dms.every((d) => d.processId !== f.id || ['user:bert', 'user:cara'].includes(d.principal)));

  // Every post and private message of this facilitation has its authorization.
  const sends = h.kernel.posts.filter((p) => p.processId === f.id).length + h.kernel.dms.filter((d) => d.processId === f.id).length;
  assert.equal(authorized(f.id).filter((a) => a.action === 'post' || a.action === 'direct_message').length, sends);
});

test('a kernel without execution scopes: nothing starts, and the facilitator is told what is missing', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-old-kernel', THREE);
  for (const missing of [['execution'], ['agentTurn', 'conversationSend'], ['messages']] as const) {
    for (const name of missing) h.kernel.absent.add(name);
    try {
      const answer = await tool(conv, 'facilitation_start', { goal: 'Pick a venue', ...VOTE });
      assert.match(answer, /^Refused \(instance_too_old\)/);
      assert.match(answer, /Nothing was started/);
      for (const name of missing) assert.match(answer, new RegExp({ execution: 'executionAuthorization', agentTurn: 'agentTurn@2', conversationSend: 'conversationSend@2', messages: 'conversationMessages@2' }[name]));
    } finally {
      for (const name of missing) h.kernel.absent.delete(name);
    }
  }
  assert.equal((await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1', [conv])).rows.length, 0);
  assert.deepEqual(posts(conv), []);
  assert.equal(h.kernel.scopes.filter((s) => s.targets.some((t) => t.kind === 'conversation' && t.conversationId === conv)).length, 0);
});

test('a conversation an agent discussion holds is not taken; a start that fails later gives its scope and the reservation back', { skip: PG_SKIP }, async () => {
  const busy = h.kernel.conversation('es-busy', THREE);
  h.kernel.discussions.add(busy);
  const answer = await tool(busy, 'facilitation_start', { goal: 'Pick a venue', ...VOTE });
  assert.match(answer, /^Refused \(conversation_taken\)/);
  assert.match(answer, /agent discussion/);
  h.kernel.discussions.delete(busy);

  const unready = h.kernel.conversation('es-unready', THREE);
  h.kernel.notReady.set(`mira|${unready}`, [{ code: 'app_not_installed', message: 'the app is not installed in this chat' }]);
  assert.match(await tool(unready, 'facilitation_start', { goal: 'Pick a venue', ...VOTE }), /^Refused \(not_ready\).*app_not_installed/);
  h.kernel.notReady.delete(`mira|${unready}`);
  const left = h.kernel.scopes.filter((s) => s.targets.some((t) => t.kind === 'conversation' && t.conversationId === unready));
  assert.deepEqual(left.map((s) => s.state), ['ended']);
  assert.ok(h.kernel.reservations.filter((r) => r.conversationId === unready).every((r) => r.releasedAt !== undefined));
  assert.equal((await h.db.pool.query(`SELECT 1 FROM plg_omadia_agent_facilitator_scopes s WHERE NOT EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_facilitations f WHERE f.id = s.facilitation_id)`)).rows.length, 0, 'no scope on record without its facilitation');
  // And it can start once the channel is ready.
  assert.match(await tool(unready, 'facilitation_start', { goal: 'Pick a venue', ...VOTE }), /^Facilitation created/);
});

test("an operator's stop: no turn, no post, no scheduler action; it is on record, and what is essential goes out when the stop is lifted", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-stop', THREE);
  const deadline = new Date(h.clock.now().getTime() + 2 * HOUR_MS);
  const f = await startActive(h, conv, { ...VOTE, deadline: deadline.toISOString() });
  const before = posts(conv).length;
  const turns = h.kernel.turns.length;
  h.kernel.killSwitch.processes.add(f.id);

  // Free text: the turn is refused before any model is called.
  await say(conv, 'anna', 'What about parking?');
  assert.equal(h.kernel.turns.length, turns);
  // A command still changes what the engine knows; its answer cannot go out.
  await say(conv, 'bert', 'status');
  assert.equal(posts(conv).length, before, 'nothing reaches the group while it is stopped');
  const refused = await events(f.id, 'execution_refused');
  assert.ok(refused.some((e) => e['code'] === 'kill_switch' && e['what'] === 'a turn of the facilitator'));
  assert.ok(refused.some((e) => e['code'] === 'kill_switch' && /^posting/.test(String(e['what']))));
  assert.ok(refused.every((e) => /An operator has stopped this facilitator/.test(String(e['summary']))));
  assert.ok(h.logs.some((l) => l.includes(f.id) && l.includes('kill_switch')), 'the operator reads it in the log');
  assert.equal(refused.length, new Set(refused.map((e) => `${String(e['what'])}:${String(e['code'])}`)).size, 'each kind of refusal once, not once per attempt');

  // The deadline passes while it is stopped: the scheduler does not act.
  h.clock.set(new Date(deadline.getTime() + MINUTE_MS));
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'active', 'the deadline was not evaluated');
  assert.ok((await events(f.id, 'execution_refused')).some((e) => e['what'] === 'the scheduler'));
  const job = await h.db.pool.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND kind = 'deadline'`, [f.id]);
  assert.deepEqual(job.rows, [{ status: 'pending', attempts: 0 }], 'the job stays due; a stop is not a failed attempt');

  // Lifted: the deadline is evaluated and the group reads how it ended.
  h.kernel.killSwitch.processes.delete(f.id);
  await h.tick();
  const ended = await h.facilitation(conv);
  assert.ok(ended.phase === 'aborted' || ended.phase === 'closed');
  assert.ok(posts(conv).length > before);

  // A facilitator that is stopped cannot open a facilitation, and says why.
  const other = h.kernel.conversation('es-stop-open', THREE);
  await tool(other, 'facilitation_start', { goal: 'Pick a venue', ...VOTE });
  h.kernel.killSwitch.agents.add('mira');
  try {
    const opened = await tool(other, 'facilitation_open');
    assert.match(opened, /^Refused \(kill_switch\): An operator has stopped this facilitator\..*The facilitation was not opened\./);
    assert.equal((await h.facilitation(other)).phase, 'configuring');
  } finally {
    h.kernel.killSwitch.agents.delete('mira');
  }
});

test('a turn that needs more model calls than it reserved returns no text, and the group is told; a used-up budget is said once', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-budget', THREE);
  const f = await startActive(h, conv, VOTE);
  h.kernel.onTurn = () => 'This text must never be posted.';
  h.kernel.turnModelCalls = TURN_MODEL_CALLS + 3;
  try {
    await say(conv, 'anna', 'What about parking?');
    assert.match(posts(conv).at(-1) ?? '', /^I could not answer the last message: the limit for a single answer of mine was reached\./);
    assert.ok(!posts(conv).includes('This text must never be posted.'));
    assert.ok((await events(f.id, 'execution_refused')).some((e) => e['code'] === 'reservation_exceeded'));
  } finally {
    h.kernel.turnModelCalls = 2;
  }
  // The model calls of the phase are used up.
  const scope = h.kernel.scopeOf(f.id, 'active');
  assert.ok(scope);
  scope.budget = { ...scope.budget, modelCalls: scope.used.modelCalls };
  try {
    const turns = h.kernel.turns.length;
    await say(conv, 'bert', 'And what about the garden?');
    await say(conv, 'cara', 'I would like to know that too.');
    assert.equal(h.kernel.turns.length, turns, 'no model is called');
    assert.equal(posts(conv).filter((p) => /^The budget for answers of my own is used up/.test(p)).length, 1, 'said once');
    // Votes are counted without a model: the facilitation still reaches its result.
    for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'B');
    assert.equal((await h.facilitation(conv)).phase, 'closed');
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
});

test('a deadline the facilitation gets later moves the scope of the moderation with it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-deadline', THREE);
  const f = await startActive(h, conv, VOTE);
  const before = h.kernel.scopeOf(f.id, 'active')?.deadline;
  const deadline = new Date(h.clock.now().getTime() + 5 * DAY_MS);
  await h.engine.core.work(f.id, async (w) => {
    await w.patch({ deadline });
  });
  await h.settle();
  const after = h.kernel.scopeOf(f.id, 'active')?.deadline;
  assert.notEqual(after, before);
  assert.equal(after, new Date(deadline.getTime() + SCOPE_MARGIN_MS).toISOString());
});

test('setting up is bounded: when the configuring scope runs out the facilitation ends with a short note and gives the conversation back', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-setup', THREE);
  await tool(conv, 'facilitation_start', { goal: 'Pick a venue', ...VOTE });
  const f = await h.facilitation(conv);
  h.clock.advance(71 * HOUR_MS);
  await h.tick();
  assert.equal((await h.facilitation(conv)).phase, 'configuring');
  h.clock.advance(HOUR_MS);
  await h.tick();
  const ended = await h.facilitation(conv);
  assert.equal(ended.phase, 'aborted');
  assert.match(posts(conv).at(-1) ?? '', /it was not opened within the time a facilitation may take to be set up/);
  assert.notEqual(h.kernel.reservations.find((r) => r.processId === f.id)?.releasedAt, undefined);
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
  assert.deepEqual(h.kernel.scopes.filter((s) => s.processId === f.id).map((s) => `${s.kind}${s.eventId ? `/${s.eventId}` : ''}`), ['configuring', 'closing/abort']);
});

test('a stop ends without a result under a closing scope of its own, and the report still goes out after the conversation was given back', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('es-abort', FOUR);
  const f = await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'stop');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  const closing = h.kernel.scopeOf(f.id, 'closing', 'abort');
  assert.ok(closing, 'its own closing event');
  assert.equal(h.kernel.scopeOf(f.id, 'active')?.state, 'ended');
  const report = authorized(f.id).filter((a) => a.kind === 'closing');
  assert.ok(report.some((a) => a.action === 'post' && a.phase === 'aborted'));
  assert.match(posts(conv).at(-1) ?? '', /asked to stop/);
  assert.deepEqual(h.kernel.openScopesOf(f.id), []);
});

test('ADR 0030: under a closing scope every message the engine sends there maps to a purpose the kernel allows, and moderation stays moderation', () => {
  const allowed = new Set<string>(KERNEL_CLOSING_PURPOSES ?? CLOSING_PURPOSES);
  // Sent under a closing: essential documents, consent answers on a summary, status that was
  // written in the unit of work that concluded.
  for (const [purpose, essential] of [
    ['result', true], ['abort', true], ['session_protocol', true], ['protocol', true], ['protocol_in_group', true], ['closing_status', true],
    ['session_consent_hint', false], ['session_objection', false], ['card_update', true], ['card_answer_hint', false], ['echo', false],
    ['late_acceptance', false], ['status', false], ['step_closed', false], ['nomination_accepted', false], ['left', false], ['joined', false],
    ['nomination_declined', false], ['item_taken', false], ['echo_declined', false], ['initiator_left', false], ['direct_notice', false],
    ['session_readiness', false], ['reaction', false],
  ] as const) {
    assert.ok(allowed.has(purposeFor(purpose, essential, 'closing')), `${purpose} under a closing`);
  }
  // A moderation post is refused there: a closing never re-opens the moderation.
  assert.equal(purposeFor('moderation', false, 'closing'), 'moderation');
  assert.equal(purposeFor('speaking_order', false, 'closing'), 'moderation');
  // Outside a closing nothing changed.
  assert.equal(purposeFor('card_update', true, 'active'), 'moderation');
  assert.equal(purposeFor('step_closed', false, 'active'), 'moderation');
});

test('the fake kernel mirrors the kernel\'s closing purposes exactly (plugin-api 1.85.0)', { skip: KERNEL_CLOSING_PURPOSES === undefined ? 'contract older than plugin-api 1.85.0' : false }, () => {
  assert.deepEqual([...CLOSING_PURPOSES].sort(), [...(KERNEL_CLOSING_PURPOSES ?? [])].sort());
});
