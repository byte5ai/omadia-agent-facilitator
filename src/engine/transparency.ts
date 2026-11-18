// Transparency (spec 5.7): the opening handshake, the report, and rule changes
// by consent of the group.
//
// The handshake and the reports are written by the engine so that they are
// complete every time. Everything the initiator receives was said in the group
// first.

import * as store from '../db/store.js';
import type { CloseRule, DodVersion, MethodId, Proposal, Step, StepOption } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { cancelOpenRequests } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { conclude, onClosed } from './decide.js';
import { displayNameOf, facilitatorName, onAborted, rulesOf, setHandshake } from './lifecycle.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { buildProtocol, closingSummary } from './protocol.js';
import { scheduleDeadlineJobs } from './scheduler.js';

export type HandshakeNote = (w: Work) => Promise<{ perception?: string; notes?: string[] }>;
const handshakeNotes: HandshakeNote[] = [];
/** More that the handshake must say (what the facilitator perceives here). */
export function registerHandshakeNote(note: HandshakeNote): void {
  if (!handshakeNotes.includes(note)) handshakeNotes.push(note);
}

async function handshakeText(w: Work, onlyStep: Step | undefined): Promise<string> {
  const f = w.f;
  const t = texts(f.language);
  const participants = (await store.listParticipants(w.tx, f.id)).filter((p) => p.status === 'active');
  const dod = await store.currentDod(w.tx, f.id);
  const steps = await store.listSteps(w.tx, f.id);
  let perception: string | undefined;
  const notes: string[] = [];
  for (const note of handshakeNotes) {
    const extra = await note(w);
    perception = extra.perception ?? perception;
    notes.push(...(extra.notes ?? []));
  }
  // Every decision method that is already fixed is announced with its rules.
  const deciding = onlyStep ? [onlyStep] : steps.filter((s) => s.method !== null && (s.method === 'consent' || s.options.length > 0));
  return t.handshakeFull({
    facilitator: facilitatorName(f),
    initiator: displayNameOf(participants, f.initiatorParticipant, f.initiatorPrincipal),
    goal: f.goal,
    definitionOfDone: dod?.text ?? '',
    format: t.formats[f.format],
    agenda: steps.length > 1 ? steps.map((s) => t.agendaLine(s.position, s.title, s.timeboxMinutes)) : [],
    rules: deciding.flatMap((s) => rulesOf(f, s)),
    participants: participants.map((p) => p.displayName),
    ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
    ...(f.deadline && f.reminderPolicy.offsetsHours.length > 0 ? { reminders: t.reminderTimes(f.reminderPolicy.offsetsHours) } : {}),
    followUp: f.followupPolicy.actionItems,
    changeWindowHours: f.settings.changeWindowHours,
    ...(perception ? { perception } : {}),
    notes,
  });
}

/** The report to the initiator: the result and the protocol, and only if the
 *  initiator is still an active participant when it is sent. */
async function reportToInitiator(w: Work, outcome: string): Promise<void> {
  const participants = await store.listParticipants(w.tx, w.f.id);
  const initiator = participants.find((p) => p.principalId === w.f.initiatorParticipant || p.principalId === w.f.initiatorPrincipal);
  if (!initiator || initiator.status !== 'active') {
    await w.event('initiator_report_skipped', 'engine', { reason: initiator ? 'left the conversation' : 'not a participant' });
    return;
  }
  const t = texts(w.f.language);
  w.post({
    purpose: 'initiator_report',
    key: 'report',
    to: { principalId: initiator.principalId },
    deliveryClass: 'essential',
    text: t.initiatorReport(initiator.displayName, outcome, await buildProtocol(w.tx, w.f)),
  });
  await w.event('initiator_report', 'engine', { to: initiator.principalId });
}

// ── rule changes ────────────────────────────────────────────────────────────

export type ChangeRequest =
  | { type: 'definition_of_done'; text: string }
  | { type: 'deadline'; deadline: Date }
  | { type: 'close_rule'; closeRule: CloseRule }
  | { type: 'method'; stepId: string; method: MethodId; options: StepOption[]; points?: number[]; statement?: string };

const ballotsFit = (before: Step, after: Pick<Step, 'method' | 'options'>): boolean =>
  before.method === after.method && JSON.stringify(before.options) === JSON.stringify(after.options);

/** Put a change of the rules to the group. Anyone may propose; it takes
 *  effect when no active participant objects within the window set at start. */
export async function proposeChange(w: Work, change: ChangeRequest, proposer: { principalId: string; messageId?: string }): Promise<Proposal> {
  if (w.f.phase !== 'active' && w.f.phase !== 'configuring') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const t = texts(w.f.language);
  const windowMinutes = w.f.settings.changeWindowHours * 60;
  const base = { proposedBy: proposer.principalId, ...(proposer.messageId ? { proposalMessageId: proposer.messageId } : {}), windowMinutes };
  switch (change.type) {
    case 'definition_of_done': {
      const version = await store.addDodVersion(w.tx, {
        facilitationId: w.f.id,
        text: change.text,
        // A reworded definition is free text until the engine is told otherwise.
        criteria: (await store.currentDod(w.tx, w.f.id))?.criteria ?? null,
        proposedBy: proposer.principalId,
        proposalMessageId: proposer.messageId ?? null,
        consentState: 'proposed',
        createdAt: w.now,
      });
      return openProposal(w, { ...base, kind: 'change', summary: t.change.definition_of_done(change.text, version.version), payload: { type: change.type, dodVersionId: version.id } });
    }
    case 'deadline': {
      if (change.deadline.getTime() <= w.now.getTime()) throw new Refusal('bad_deadline', 'The proposed deadline is in the past.');
      return openProposal(w, { ...base, kind: 'change', summary: t.change.deadline(formatWhen(change.deadline, w.f.timezone, w.f.language)), payload: { type: change.type, deadline: change.deadline.toISOString() } });
    }
    case 'close_rule': {
      if (change.closeRule === 'at_deadline' && !w.f.deadline) throw new Refusal('bad_input', 'Evaluating at the deadline needs a deadline.');
      return openProposal(w, { ...base, kind: 'change', summary: t.change.close_rule(change.closeRule), payload: { type: change.type, closeRule: change.closeRule } });
    }
    case 'method': {
      const step = await store.getStep(w.tx, change.stepId);
      if (!step || step.status === 'closed') throw new Refusal('bad_input', 'That step is not open or still to come.');
      const methodConfig = {
        ...step.methodConfig,
        ...(change.method === 'ranked' ? { points: change.points ?? step.methodConfig['points'] ?? [...w.config.rankedPoints] } : {}),
        ...(change.method === 'consent' ? { statement: change.statement ?? step.title } : {}),
      };
      const rules = rulesOf(w.f, { ...step, method: change.method, options: change.options, roundOptions: null, methodConfig }).join(' ');
      return openProposal(w, {
        ...base,
        kind: 'change',
        summary: t.change.method(step.title, rules),
        payload: { type: change.type, stepId: step.id, method: change.method, options: change.options, methodConfig, rules },
      });
    }
  }
}

async function applyChange(w: Work, proposal: Proposal): Promise<void> {
  const t = texts(w.f.language);
  const payload = proposal.payload;
  const announce = (text: string): void => w.post({ purpose: 'change_announced', key: proposal.id, to: 'group', deliveryClass: 'essential', text });
  switch (payload['type']) {
    case 'definition_of_done': {
      const version = (await store.patchDodVersion(w.tx, String(payload['dodVersionId']), { consentState: 'accepted', effectiveAt: w.now })) as DodVersion;
      announce(t.changed.definition_of_done(version.version, version.text));
      return;
    }
    case 'deadline': {
      const deadline = new Date(String(payload['deadline']));
      await w.patch({ deadline });
      await scheduleDeadlineJobs(w);
      announce(t.changed.deadline(formatWhen(deadline, w.f.timezone, w.f.language)));
      return;
    }
    case 'close_rule': {
      const closeRule = payload['closeRule'] as CloseRule;
      await w.patch({ closeRule });
      announce(t.changed.close_rule(closeRule));
      return;
    }
    case 'method': {
      const step = await store.getStep(w.tx, String(payload['stepId']));
      if (!step || step.status === 'closed') return;
      const next = { method: payload['method'] as MethodId, options: payload['options'] as StepOption[] };
      // Contributions stay valid unless the change affects them.
      const affected = ballotsFit(step, next)
        ? []
        : (await store.listContributions(w.tx, w.f.id, step.id)).filter((c) => (c.status === 'valid' || c.status === 'unconfirmed') && c.payload['ballot'] !== undefined);
      for (const c of affected) await store.patchContribution(w.tx, c.id, { status: 'superseded' });
      if (affected.length > 0) await cancelOpenRequests(w, step.id);
      await store.patchStep(w.tx, step.id, { ...next, methodConfig: payload['methodConfig'] as Record<string, unknown>, round: affected.length > 0 ? step.round + 1 : step.round, roundOptions: null, roundDeadline: null });
      announce(t.changed.method(step.title, String(payload['rules'] ?? '')));
      if (affected.length > 0) {
        const participants = await store.listParticipants(w.tx, w.f.id);
        const names = [...new Set(affected.map((c) => c.participantPrincipal))].map((id) => displayNameOf(participants, id, id));
        // The facilitator names who needs to act again.
        w.post({ purpose: 'act_again', key: proposal.id, to: 'group', deliveryClass: 'essential', text: t.actAgain(t.list(names)) });
      }
      return;
    }
    default:
      throw new Error(`unknown change type '${String(payload['type'])}'`);
  }
}

/** A free-text definition of done is met when the group says so. */
export async function proposeDodMet(w: Work): Promise<Proposal> {
  if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const dod = await store.currentDod(w.tx, w.f.id);
  if (dod?.criteria) throw new Refusal('machine_checkable', 'This definition of done is checked automatically. The facilitation concludes by itself when it is met; there is nothing to confirm.');
  const t = texts(w.f.language);
  const summary = t.closeSummary(await closingSummary(w));
  return openProposal(w, { kind: 'dod_met', summary, proposedBy: 'facilitator', windowMinutes: Math.min(w.f.settings.confirmWindowMinutes, w.f.settings.changeWindowHours * 60) });
}

export function installTransparency(): void {
  setHandshake(handshakeText);

  registerProposalKind('change', {
    describe: (_w, p) => p.summary,
    accept: applyChange,
    reject: async (w, p) => {
      if (p.payload['type'] === 'definition_of_done') await store.patchDodVersion(w.tx, String(p.payload['dodVersionId']), { consentState: 'rejected' });
    },
  });

  registerProposalKind('dod_met', {
    describe: (w, p) => texts(w.f.language).change.dod_met(p.summary),
    accept: async (w) => {
      await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET status = 'closed', closed_at = $2 WHERE facilitation_id = $1 AND status <> 'closed'`, [w.f.id, w.now]);
      await conclude(w, { atDeadline: false });
    },
  });

  // Group first, then the initiator.
  onClosed(async (w) => reportToInitiator(w, String(w.f.result?.['text'] ?? '')));
  onAborted(async (w, report) => reportToInitiator(w, report));
}
