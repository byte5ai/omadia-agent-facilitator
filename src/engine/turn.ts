// The facilitator's turn. The kernel runs it (identity, neutrality block,
// model policy, privacy shield, receipts); the engine supplies the state of
// THIS facilitation and decides what is posted.
//
// The context below is built from the tables of one facilitation and nothing
// else, so a facilitator never carries anything from one facilitation into
// another.

import type { ConversationMessageRecord, ScopedAgentTurnOutcome } from '@omadia/plugin-api';

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Facilitation, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { isSilent } from './guard.js';
import { rulesOf } from './lifecycle.js';
import { playbook } from './playbook.js';
import { recordRefusal } from './refusals.js';
import { TURN_MODEL_CALLS, scopeForAction } from './scopes.js';
import { participationOf } from './status.js';
import { checkTurnText } from './turnGuard.js';

export const SILENT = '[silent]';

export type ContextSection = (q: Queryable, f: Facilitation) => Promise<string | undefined>;
const sections: ContextSection[] = [];

/** Later modules add what they know (agenda, proposal, means of the session). */
export function registerContextSection(section: ContextSection): void {
  if (!sections.includes(section)) sections.push(section);
}

/** What is asked in a step: the question, how it is decided, every option
 *  with its key, until when, and how the group was told to answer. Without
 *  it the facilitator cannot say what the vote is about. */
function questionLines(f: Facilitation, step: Step, heading: string): string[] {
  if (!step.method) return [];
  const options = step.roundOptions ?? step.options;
  const until = step.roundDeadline ?? step.timeboxEndsAt;
  const statement = step.methodConfig['statement'];
  return [
    `${heading}: "${step.method === 'consent' && typeof statement === 'string' && statement !== '' ? statement : step.title}" (decided by: ${step.method}${step.round > 1 ? `, round ${String(step.round)}` : ''})`,
    ...(options.length > 0 ? [`Options, each with its key: ${options.map((o) => `${o.key} = ${o.label}`).join(', ')}`] : []),
    ...(until ? [`This step is open until: ${formatWhen(until, f.timezone, 'en')}`] : []),
    ...rulesOf(f, step).map((rule, i) => (i === 0 ? `How the group was told to answer: ${rule}` : rule)),
  ];
}

/** Before the opening no step is open; what will be asked is set up already. */
async function plannedQuestion(q: Queryable, f: Facilitation): Promise<string[]> {
  if (f.phase !== 'configuring') return [];
  const planned = (await store.listSteps(q, f.id)).find((s) => s.status !== 'closed' && s.method !== null);
  return planned ? questionLines(f, planned, 'Set up to be asked once opened') : [];
}

export async function buildEngineContext(q: Queryable, f: Facilitation): Promise<string> {
  const dod = await store.currentDod(q, f.id);
  const participation = await participationOf(q, f);
  const lines = [
    '# Facilitation state (computed by the engine; it is the only source of truth)',
    `Phase: ${f.phase}. Language of the group: ${f.language}.`,
    `Goal: ${f.goal}`,
    `Definition of done (version ${String(dod?.version ?? 1)}): ${dod?.text ?? ''}`,
    ...(f.deadline ? [`Deadline: ${formatWhen(f.deadline, f.timezone, 'en')}`] : []),
    `Active participants: ${participation.active.map((p) => p.displayName).join(', ') || 'none known yet'}`,
    ...(participation.step
      ? [
          `Open step: "${participation.step.title}" (${participation.step.kind})`,
          ...questionLines(f, participation.step, 'Asked in the open step'),
          `Contributed to it: ${participation.contributed.map((p) => p.displayName).join(', ') || 'nobody yet'}`,
          `Not yet: ${participation.missing.map((p) => p.displayName).join(', ') || 'nobody'}`,
        ]
      : await plannedQuestion(q, f)),
  ];
  for (const section of sections) {
    const text = await section(q, f);
    if (text) lines.push(text);
  }
  const book = playbook();
  if (book !== '') lines.push(book);
  lines.push(
    '# Rules of this turn',
    '- You never count, never work out who is missing and never decide whether the definition of done is met. The engine does; the state above is its answer.',
    '- A ballot in the announced format is recorded by the engine before you see anything. You only see free text.',
    '- To record what a person said, call facilitation_record_contribution with the message id from the input. It records it for the AUTHOR of that message only and asks them to confirm; it does not count before they did. You cannot record anything for somebody else.',
    '- If a message is unclear, call facilitation_clarify once for that message.',
    '- Never name in the group who has not contributed.',
    '- When somebody asks to evaluate, finish or close the facilitation: what was answered and contributed is in the state above, so do not read it with tools first. On a free-text definition of done call facilitation_close, once; it needs no step closed before. Then answer with at most one short line: the engine posts the result.',
    '- When somebody asks what is being decided, which options there are or how to answer, say it from the state above: the question and every option with its key, as listed there. Never answer that you do not know them while they are listed.',
    `- If nothing needs to be said, answer exactly ${SILENT}. Your answer is posted to the group as it is, unless a tool you called in this turn already posted there: then your answer is not posted.`,
  );
  return lines.join('\n');
}

/** Run one turn for a free-text message and post the answer. */
export async function runFacilitatorTurn(engine: EngineCore, facilitationId: string, record: ConversationMessageRecord): Promise<void> {
  const db = engine.db();
  const f = await store.getFacilitation(db, facilitationId);
  if (!f || (f.phase !== 'configuring' && f.phase !== 'active')) return;
  const agentTurn = engine.deps.kernel.agentTurn();
  if (!agentTurn) {
    engine.log(`facilitation ${f.id}: kernel service 'agentTurn@2' is not available; free text is not moderated`);
    return;
  }
  // The turn is an authorized action: it is drawn from the scope of the
  // phase, with a reservation of model calls the kernel holds it to.
  const found = await scopeForAction(engine, f, 'moderation');
  if (!found.ok) {
    await recordRefusal(engine, f.id, { code: found.code, message: found.message, what: 'a turn of the facilitator' });
    return;
  }
  const outcome = await agentTurn.runTurn({
    agentSlug: f.facilitatorAgent,
    sessionKey: `facilitation:${f.id}`,
    channelType: f.channelType,
    conversationId: f.conversationId,
    inboundEventId: record.eventId,
    input: `From: ${record.author.displayName ?? record.author.id} (message id: ${record.messageId})\n${record.text ?? ''}`,
    engineContext: await buildEngineContext(db, f),
    ...found.value.authorization,
    purpose: 'moderation',
    emission: 'prose',
    budget: { modelCalls: TURN_MODEL_CALLS },
    target: { kind: 'conversation', channelType: f.channelType, conversationId: f.conversationId },
  });
  // What the tools of this turn did. If one already made the facilitator post
  // (the handshake, a step, a question to somebody), that was the answer:
  // whatever the model wrote on top is not posted.
  const { posted, refusals } = engine.takeTurnNotes(record.eventId);
  if (outcome.outcome !== 'completed') {
    const detail = outcome.outcome === 'refused' ? `${outcome.code}: ${outcome.message}` : outcome.message;
    engine.log(`facilitation ${f.id}: facilitator turn ${outcome.outcome} (${detail})`);
    await engine.work(f.id, (w) => w.event('turn_failed', 'engine', { outcome: outcome.outcome, detail, eventId: record.eventId }));
    if (outcome.outcome === 'refused') await turnRefused(engine, f.id, record.eventId, outcome);
    return;
  }
  const say = (w: Work, text: string, prose = false): void =>
    w.post({ purpose: 'moderation', key: `turn:${record.eventId}`, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['configuring', 'active'], text, ...(prose ? { emission: 'prose' as const } : {}) });

  // The marker anywhere in the answer means: say nothing.
  if (isSilent(outcome.text)) {
    // Unless a tool refused what somebody asked for and nothing was posted:
    // the group is not left without an answer.
    const refused = refusals.find((code) => !UNSPEAKABLE_REFUSALS.has(code));
    if (posted || refused === undefined) return;
    await engine.work(f.id, async (w) => {
      const t = texts(w.f.language);
      await w.event('refusal_said', 'engine', { eventId: record.eventId, code: refused });
      say(w, t.refusals[refused] ?? t.refusals['generic'] ?? '');
    });
    return;
  }
  if (posted) {
    await engine.work(f.id, (w) => w.event('turn_text_dropped', 'engine', { eventId: record.eventId }));
    return;
  }
  await engine.work(f.id, async (w) => {
    // Checked against the state as it is now, not as the model saw it.
    const participation = await participationOf(w.tx, w.f);
    const verdict = checkTurnText(outcome.text, {
      missing: w.f.phase === 'active' ? participation.missing.map((p) => p.displayName) : [],
      voteOpen: participation.step?.method !== undefined && participation.step?.method !== null,
      live: w.f.phase === 'configuring' || w.f.phase === 'active',
    });
    if (verdict.ok) {
      say(w, outcome.text.trim(), true);
      return;
    }
    const t = texts(w.f.language);
    await w.event('text_refused', 'engine', { purpose: 'moderation', reason: verdict.reason, eventId: record.eventId });
    engine.log(`facilitation ${w.f.id}: the text of a turn was replaced (${verdict.reason})`);
    if (verdict.reason === 'names_missing') say(w, t.notEverybodyYet());
    else say(w, t.stillOpen(participation.step?.title ?? w.f.goal, w.f.deadline ? formatWhen(w.f.deadline, w.f.timezone, w.f.language) : undefined));
  });
}

/** Refusals that are not an answer to the group (nothing could be posted, or
 *  the call itself was malformed). */
const UNSPEAKABLE_REFUSALS = new Set(['no_subscription', 'no_context', 'bad_input', 'unknown_message', 'no_facilitation']);

/**
 * The kernel did not run the turn, or cut it off. Nobody is left waiting for
 * an answer that does not come: the reason is on record, and the group is
 * told where it can still be told and the reason concerns it.
 *
 *   reservation_exceeded   this one answer needed more model calls than a
 *                          turn may make: said in the group for that message
 *   budget_exhausted       the model calls of the phase are used up: said in
 *                          the group once
 *   kill_switch, ...       an operator's matter: on record and in the log
 */
async function turnRefused(engine: EngineCore, facilitationId: string, eventId: string, outcome: Extract<ScopedAgentTurnOutcome, { outcome: 'refused' }>): Promise<void> {
  const code = outcome.code === 'not_authorized' ? (outcome.executionCode ?? outcome.code) : outcome.code;
  await recordRefusal(engine, facilitationId, { code, message: outcome.message, what: 'a turn of the facilitator' });
  if (code !== 'reservation_exceeded' && code !== 'budget_exhausted') return;
  await engine.work(facilitationId, async (w) => {
    if (w.f.phase !== 'configuring' && w.f.phase !== 'active') return;
    const t = texts(w.f.language).execution;
    w.post({
      purpose: 'system_notice',
      key: code === 'budget_exhausted' ? `turn_budget:${w.f.phase}` : `turn_limit:${eventId}`,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: code === 'budget_exhausted' ? t.turnBudget() : t.turnLimit(),
    });
  });
}
