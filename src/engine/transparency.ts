// Transparency (spec 5.7): the opening handshake, the report, and rule changes
// by consent of the group.
//
// The handshake and the reports are written by the engine so that they are
// complete every time. Everything the initiator receives was said in the group
// first.

import { MINUTE_MS } from '../clock.js';
import * as store from '../db/store.js';
import type { CloseRule, DodVersion, MethodId, Proposal, Step, StepOption } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { cancelOpenRequests } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { conclude, onClosed } from './decide.js';
import { displayNameOf, facilitatorName, onAborted, rulesOf, setHandshake, announceVote } from './lifecycle.js';
import { initiatorName, isPlaceholderName } from './names.js';
import { reminderOffsetsFor, upcomingOffsets } from './reminders.js';
import { verifyElectorate } from './electorate.js';
import { everybodyKnown, expectedNames, listKnown } from './roll.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { voteCardFits } from './cards.js';
import { buildProtocol, closingSummary, sendWithProtocol } from './protocol.js';
import { scheduleDeadlineJobs } from './scheduler.js';
import { listClosings } from './resultStatus.js';

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
  const named = initiatorName(f, participants);
  const upcoming = upcomingOffsets(f, w.now);
  // Every decision method that is already fixed is announced with its rules.
  const deciding = onlyStep ? [onlyStep] : steps.filter((s) => s.method !== null && (s.method === 'consent' || s.options.length > 0));
  // A vote that is a card is explained by the card: the handshake points to
  // it and keeps the line on when it closes. The chat syntax is for channels
  // without cards.
  const rules: string[] = [];
  for (const s of deciding) {
    const lines = rulesOf(f, s);
    if (await voteCardFits(w, s)) {
      if (!rules.includes(t.card.voteOnCard)) rules.push(t.card.voteOnCard);
      rules.push(...lines.slice(1));
    } else rules.push(...lines);
  }
  return t.handshakeFull({
    facilitator: facilitatorName(f),
    ...(named ? { initiator: named } : {}),
    goal: f.goal,
    definitionOfDone: dod?.text ?? '',
    format: t.formats[f.format],
    agenda: steps.length > 1 ? steps.map((s) => t.agendaLine(s.position, s.title, s.timeboxMinutes)) : [],
    rules,
    // Somebody without a name yet is not listed as a placeholder.
    participants: [...participants.filter((p) => !isPlaceholderName(p.displayName, p.principalId)).map((p) => p.displayName), ...expectedNames(f)],
    rosterOpen: f.settings.openRoster === true,
    unmatched: [...expectedNames(f)],
    atDeadlineOnly: !listKnown(f) && deciding.length > 0,
    ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
    // Only reminders that will be sent are announced.
    ...(upcoming.length > 0 ? { reminders: t.reminderTimes(upcoming) } : {}),
    ...(f.deadline && upcoming.length === 0
      ? { noReminders: f.reminderPolicy.asked === true && f.reminderPolicy.offsetsHours.length === 0 ? null : Math.max(1, Math.round((f.deadline.getTime() - w.now.getTime()) / MINUTE_MS)) }
      : {}),
    followUp: f.followupPolicy.actionItems,
    protocolMail: f.followupPolicy.protocolMail === true || w.config.protocolMailEnabled,
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
  const protocol = await buildProtocol(w.tx, w.f);
  // Part of the closing: never after its dispatch limit.
  const closing = (await listClosings(w.tx, w.f.id)).find((c) => c.kind === (w.f.phase === 'aborted' ? 'abort' : 'result'));
  sendWithProtocol(w, { principalId: initiator.principalId }, { purpose: 'initiator_report', key: 'report', text: t.initiatorReport(initiator.displayName, outcome, protocol) }, protocol, closing);
  await w.event('initiator_report', 'engine', { to: initiator.principalId });
}

// ── rule changes ────────────────────────────────────────────────────────────

export type ChangeRequest =
  | { type: 'definition_of_done'; text: string }
  | { type: 'deadline'; deadline: Date }
  | { type: 'close_rule'; closeRule: CloseRule }
  /** Hours before the deadline; empty for no reminders. */
  | { type: 'reminders'; offsetsHours: number[] }
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
      if (change.closeRule === 'all_contributed' && !listKnown(w.f)) {
        throw new Refusal('participants_unknown', 'The channel cannot list who is in this conversation, so I cannot tell when everybody has voted. This facilitation is evaluated at its deadline. Nothing was put to the group.');
      }
      return openProposal(w, { ...base, kind: 'change', summary: t.change.close_rule(change.closeRule), payload: { type: change.type, closeRule: change.closeRule } });
    }
    case 'reminders':
      return openProposal(w, { ...base, kind: 'change', summary: t.change.reminders(t.reminderTimes(change.offsetsHours)), payload: { type: change.type, offsetsHours: change.offsetsHours } });
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
      // Reminders nobody asked for follow the new deadline.
      await w.patch({ deadline, ...(w.f.reminderPolicy.asked === true ? {} : { reminderPolicy: { offsetsHours: reminderOffsetsFor(deadline.getTime() - w.now.getTime(), w.config.reminderOffsetsHours) } }) });
      await scheduleDeadlineJobs(w);
      announce(t.changed.deadline(formatWhen(deadline, w.f.timezone, w.f.language)));
      return;
    }
    case 'reminders': {
      const offsetsHours = (payload['offsetsHours'] as number[]).filter((h) => typeof h === 'number');
      await w.patch({ reminderPolicy: { offsetsHours, asked: true } });
      await scheduleDeadlineJobs(w);
      announce(t.changed.reminders(t.reminderTimes(offsetsHours)));
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
      // A changed question is put to the group again: a card of the old one
      // is replaced by a new version.
      const changed = await store.getStep(w.tx, step.id);
      if (changed?.status === 'open') await announceVote(w, changed);
      if (affected.length > 0) {
        const participants = await store.listParticipants(w.tx, w.f.id);
        const names = [...new Set(affected.map((c) => c.participantPrincipal))].map((id) => displayNameOf(participants, id, t.unnamedPerson));
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

const activeCount = async (w: Work): Promise<number> => (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active').length;

/**
 * Somebody asked to close on a free-text definition of done. Where that
 * person is the only participant there is nobody left to object: the result
 * is published at once. Otherwise the facilitation concludes and its final
 * summary is put to the group for confirmation inside the closing (spec
 * 5.2): confirmed when no objection stands at the window's end.
 */
export async function closeOnRequest(w: Work, askedBy: string | undefined): Promise<'concluded' | 'confirming'> {
  if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const dod = await store.currentDod(w.tx, w.f.id);
  if (dod?.criteria) throw new Refusal('machine_checkable', 'This definition of done is checked automatically. The facilitation concludes by itself when it is met; there is nothing to confirm.');
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const asker = askedBy === undefined ? undefined : active.find((p) => p.principalId === askedBy);
  if (asker && active.length === 1 && everybodyKnown(w.f) && !(await store.openProposal(w.tx, w.f.id)) && (await verifyElectorate(w)).verified && (await activeCount(w)) === 1) {
    await w.event('dod_met', asker.principalId, { by: 'the only participant' });
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET status = 'closed', closed_at = $2 WHERE facilitation_id = $1 AND status <> 'closed'`, [w.f.id, w.now]);
    w.bump();
    await conclude(w, { atDeadline: false });
    return 'concluded';
  }
  // The final summary is put to the group for confirmation inside the
  // closing (spec 5.2): its window starts once it is delivered; only a
  // standing objection at its end keeps it from being confirmed.
  if (await store.openProposal(w.tx, w.f.id)) throw new Refusal('proposal_open', texts(w.f.language).proposalBusy());
  await w.event('close_requested', asker?.principalId ?? 'facilitator', {});
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET status = 'closed', closed_at = $2 WHERE facilitation_id = $1 AND status <> 'closed'`, [w.f.id, w.now]);
  w.bump();
  await conclude(w, { atDeadline: false, confirm: true });
  return 'confirming';
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
