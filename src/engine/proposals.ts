// Consent decisions the facilitator puts to the group (spec 5.4, 5.7).
//
// A proposal holds when no active participant objects within its window, or
// at once when every active participant agreed. An objection keeps it from
// holding while it stands; the objector lifts it by agreeing. There is one
// open proposal per facilitation, so "agreed" and "objection" never have to be
// matched to anything.
//
// What a proposal does when it is accepted is registered per kind: closing a
// step, confirming clusters, a rule change.

import { HOUR_MS, MINUTE_MS } from '../clock.js';
import { insert } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Participant, Proposal, ProposalObjection } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { advance } from './decide.js';
import { PRIORITY, isPositiveReaction, isYes, registerAfterInbound, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { cancelJobs, scheduleJob } from './jobs.js';
import { onBeforeDeadline, registerJobHandler } from './scheduler.js';
import { onHeldDecisionRetry, verifyElectorate, windowMayPass } from './electorate.js';
import { everybodyKnown } from './roll.js';

export interface ProposalKind {
  /** What is proposed, as a phrase for the announcement. */
  describe(w: Work, proposal: Proposal): string | Promise<string>;
  /** The proposal was accepted. */
  accept(w: Work, proposal: Proposal): Promise<void>;
  /** The proposal was rejected or withdrawn. */
  reject?(w: Work, proposal: Proposal): Promise<void>;
  /** Answers count only as a reply to (or a reaction on) the proposal's own
   *  message, never as a free-standing one. */
  boundOnly?: boolean;
  /** Silence is not enough: every active participant has to agree. */
  unanimous?(w: Work, proposal: Proposal): boolean;
  /** Decided only at the end of its window, never earlier, and not by this
   *  module (the final confirmation of a closing, closing.ts). */
  windowOnly?: boolean;
  /** "extend N" is an answer to this kind of proposal. */
  extend?(w: Work, proposal: Proposal, minutes: number | undefined): Promise<void>;
}

const kinds = new Map<string, ProposalKind>();

export function registerProposalKind(kind: string, definition: ProposalKind): void {
  kinds.set(kind, definition);
}

const kindOf = (proposal: Proposal): ProposalKind => {
  const kind = kinds.get(proposal.kind);
  if (!kind) throw new Error(`unknown proposal kind '${proposal.kind}'`);
  return kind;
};

export interface NewProposal {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  proposedBy: string;
  proposalMessageId?: string;
  windowMinutes: number;
}

/** Put a proposal to the group. The window never runs past the deadline. */
export async function openProposal(w: Work, input: NewProposal): Promise<Proposal> {
  if (await store.openProposal(w.tx, w.f.id)) throw new Refusal('proposal_open', texts(w.f.language).proposalBusy());
  const t = texts(w.f.language);
  const wanted = new Date(w.now.getTime() + input.windowMinutes * MINUTE_MS);
  const windowEndsAt = w.f.deadline && w.f.deadline < wanted ? w.f.deadline : wanted;
  const proposal = await insert<Proposal>(w.tx, 'plg_omadia_agent_facilitator_proposals', {
    facilitationId: w.f.id,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? {},
    proposedBy: input.proposedBy,
    proposalMessageId: input.proposalMessageId ?? null,
    windowEndsAt,
    openedAt: w.now,
  });
  const definition = kindOf(proposal);
  const mustReply = definition.boundOnly === true || (await consentVoteOpen(w));
  await scheduleJob(w, 'proposal_window', proposal.id, windowEndsAt, { proposalId: proposal.id });
  w.bump();
  await w.event('proposal_opened', input.proposedBy, { proposalId: proposal.id, kind: input.kind, summary: input.summary, until: windowEndsAt.toISOString() });
  w.post({
    purpose: 'proposal',
    key: proposal.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['configuring', 'active'],
    text: t.proposalAnnounce(await definition.describe(w, proposal), formatWhen(windowEndsAt, w.f.timezone, w.f.language), definition.extend !== undefined, mustReply),
    link: { kind: 'proposal', id: proposal.id },
  });
  return proposal;
}

/** A consent decision is being voted on: "agreed" and "objection" written
 *  into the chat are ballots of that vote. */
async function consentVoteOpen(w: Pick<Work, 'tx' | 'f'>): Promise<boolean> {
  return (await store.openStepOf(w.tx, w.f.id))?.method === 'consent';
}

const patchProposal = (w: Work, id: string, patch: Partial<Proposal>): Promise<unknown> =>
  w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_proposals SET
       status = coalesce($2, status), consents = coalesce($3::jsonb, consents), objections = coalesce($4::jsonb, objections), decided_at = coalesce($5, decided_at)
     WHERE id = $1`,
    [id, patch.status ?? null, patch.consents ? JSON.stringify(patch.consents) : null, patch.objections ? JSON.stringify(patch.objections) : null, patch.decidedAt ?? null],
  );

/** Settle a proposal and run what it stands for. */
export async function decideProposal(w: Work, proposal: Proposal, accepted: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
  const t = texts(w.f.language);
  const definition = kindOf(proposal);
  const participants = await store.listParticipants(w.tx, w.f.id);
  await patchProposal(w, proposal.id, { status: accepted ? 'accepted' : 'rejected', decidedAt: w.now });
  await cancelJobs(w, ['proposal_window']);
  w.bump();
  await w.event(accepted ? 'proposal_accepted' : 'proposal_rejected', 'engine', { proposalId: proposal.id, kind: proposal.kind, summary: proposal.summary, objections: proposal.objections });
  const what = await definition.describe(w, proposal);
  if (!opts.quiet) {
    const objections = proposal.objections.map((o) => `${participants.find((p) => p.principalId === o.principal)?.displayName ?? o.principal}: ${o.reason}`);
    w.post({
      purpose: accepted ? 'proposal_accepted' : 'proposal_rejected',
      key: proposal.id,
      to: 'group',
      deliveryClass: 'essential',
      text: accepted ? t.proposalAccepted(what) : t.proposalRejected(what, objections),
    });
  }
  if (accepted) await definition.accept(w, proposal);
  else await definition.reject?.(w, proposal);
}

/** How long a proposal whose electorate could not be verified at the end of
 *  its window waits before it asks again (besides the next contribution or
 *  reminder). */
const ELECTORATE_RETRY_MS = HOUR_MS;

/**
 * The window is over and nothing stands against the proposal: it passes only
 * on a verified list of participants (spec 5.5). Otherwise it stays open and
 * is looked at again with the next contribution or reminder, and an hour
 * later; at the deadline it fails, since nothing is decided past it.
 */
async function electorateAllows(w: Work, proposal: Proposal, atDeadline: boolean): Promise<boolean> {
  const check = await verifyElectorate(w);
  if (windowMayPass(check)) return true;
  await w.event('decision_held', 'engine', { proposalId: proposal.id, reason: check.verified ? 'verified' : check.reason });
  if (atDeadline) return false;
  // One retry waits at a time: every message also looks again, and must not
  // start another hourly chain.
  const waiting = await w.tx.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_jobs
      WHERE facilitation_id = $1 AND kind = 'proposal_window' AND status = 'pending' AND payload ->> 'proposalId' = $2 AND due_at > $3 LIMIT 1`,
    [w.f.id, proposal.id, w.now],
  );
  if (waiting.rows.length > 0) return false;
  const retry = new Date(w.now.getTime() + ELECTORATE_RETRY_MS);
  const at = w.f.deadline && w.f.deadline < retry ? w.f.deadline : retry;
  await scheduleJob(w, 'proposal_window', `${proposal.id}:${at.toISOString()}`, at, { proposalId: proposal.id });
  return false;
}

const standingOf = (proposal: Proposal, active: readonly Participant[]): ProposalObjection[] =>
  proposal.objections.filter((o) => active.some((p) => p.principalId === o.principal));
const activeOf = async (w: Work): Promise<Participant[]> => (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');

/** Accept when the window is over without a standing objection (on a
 *  verified list of participants), or when every active participant agreed. */
async function settleIfDue(w: Work, proposal: Proposal, windowOver: boolean, atDeadline = false): Promise<boolean> {
  // Decided by its own closing (closing.ts), never here.
  if (kindOf(proposal).windowOnly === true) return false;
  if (windowOver) {
    // A standing objection rejects whoever else belongs to the list.
    if (standingOf(proposal, await activeOf(w)).length === 0 && !(await electorateAllows(w, proposal, atDeadline))) {
      if (!atDeadline) return false;
      await decideProposal(w, { ...proposal, objections: [] }, false);
      return true;
    }
    // Read after the check: the fresh list may have brought or taken somebody.
    const active = await activeOf(w);
    const standing = standingOf(proposal, active);
    const everybody = everybodyKnown(w.f) && active.length > 0 && active.every((p) => proposal.consents.includes(p.principalId));
    const needsAll = kindOf(proposal).unanimous?.(w, proposal) === true;
    await decideProposal(w, { ...proposal, objections: standing }, standing.length === 0 && (!needsAll || everybody));
    return true;
  }
  // "Everybody agreed" is said only about a list that is known to be
  // complete, and read after the fresh check: it may have brought somebody.
  const everybodyAgreed = async (): Promise<boolean> => {
    const active = await activeOf(w);
    return everybodyKnown(w.f) && active.length > 0 && standingOf(proposal, active).length === 0 && active.every((p) => proposal.consents.includes(p.principalId));
  };
  if (!(await everybodyAgreed()) || !(await verifyElectorate(w)).verified || !(await everybodyAgreed())) return false;
  await decideProposal(w, proposal, true);
  return true;
}

const deadlinePassed = (w: Work): boolean => w.f.deadline !== null && w.now.getTime() >= w.f.deadline.getTime();

const OBJECTION = /^(?:objection|i object|einwand|veto|widerspruch|ich widerspreche)(?:\s*[:,-]\s*(.*))?$/is;
const AGREED = /^(?:agreed|agree|i agree|consent|no objection|einverstanden|zustimmung|ich stimme zu|kein einwand|passt|\+1)$/;
const EXTEND = /^(?:extend|verlängern|verlaengern|more time|mehr zeit)(?:\s+(\d{1,3}))?(?:\s*(?:min|minutes|minuten|m))?$/;

/** Words that agree to what is open: "agreed" as well as a plain "yes". */
export const isAgreement = (command: string): boolean => AGREED.test(command) || isYes(command);

/** Record that somebody agrees to the open proposal; settles it when that was everybody. */
export async function agree(w: Work, proposal: Proposal, author: Participant): Promise<void> {
  const consents = proposal.consents.includes(author.principalId) ? proposal.consents : [...proposal.consents, author.principalId];
  // Agreeing lifts one's own objection.
  const objections = proposal.objections.filter((o) => o.principal !== author.principalId);
  await patchProposal(w, proposal.id, { consents, objections });
  w.bump();
  await w.event('proposal_consent', author.principalId, { proposalId: proposal.id });
  await settleIfDue(w, { ...proposal, consents, objections }, false);
}

/** Answers to the open proposal: agreed, objection, extend. */
const proposalAnswers: InboundHandler = async ({ w, record, author, command }) => {
  if (!author || (w.f.phase !== 'active' && w.f.phase !== 'configuring' && w.f.phase !== 'concluding')) return undefined;
  const proposal = await store.openProposal(w.tx, w.f.id);
  if (!proposal) return undefined;
  // After `concluding` only the consent answers to the final summary count.
  if (w.f.phase === 'concluding' && kindOf(proposal).windowOnly !== true) return undefined;
  const t = texts(w.f.language);

  if (record.kind === 'reaction') {
    if (!record.reaction || record.reaction.removed || !isPositiveReaction(record.reaction.name) || record.messageId !== proposal.announceMessageId) return undefined;
    await agree(w, proposal, author);
    return { outcome: 'proposal_consent' };
  }
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  if (record.quoted === true || record.forwarded === true) return undefined;

  // What does this message answer? A reply to the proposal's own message
  // answers the proposal. A free-standing one does so only when nothing else
  // could be meant: not while a consent vote is open (then it is a ballot),
  // and never for a proposal that must be answered directly.
  const definition = kindOf(proposal);
  const bound = proposal.announceMessageId !== null && record.replyToMessageId === proposal.announceMessageId;
  if (!bound && (definition.boundOnly === true || (await consentVoteOpen(w)))) return undefined;

  if (isAgreement(command)) {
    await agree(w, proposal, author);
    return { outcome: 'proposal_consent' };
  }

  const extend = EXTEND.exec(command);
  if (extend && definition.extend) {
    await patchProposal(w, proposal.id, { status: 'rejected', decidedAt: w.now });
    await cancelJobs(w, ['proposal_window']);
    w.bump();
    await w.event('proposal_extended', author.principalId, { proposalId: proposal.id });
    await definition.extend(w, proposal, extend[1] ? Number(extend[1]) : undefined);
    return { outcome: 'proposal_extend' };
  }

  const objection = OBJECTION.exec((record.text ?? '').trim().replace(/^(@\S+\s+)+/u, '').replace(/[.!]+$/u, ''));
  if (!objection) return undefined;
  const reason = (objection[1] ?? '').trim();
  if (reason === '') {
    w.post({ purpose: 'proposal_hint', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: `${author.displayName}, ${t.hint.reason_required()}` });
    return { outcome: 'proposal_objection_without_reason' };
  }
  const entry: ProposalObjection = { principal: author.principalId, reason, messageId: record.messageId };
  const objections = [...proposal.objections.filter((o) => o.principal !== author.principalId), entry];
  await patchProposal(w, proposal.id, { objections, consents: proposal.consents.filter((c) => c !== author.principalId) });
  w.bump();
  await w.event('proposal_objection', author.principalId, { proposalId: proposal.id, reason, messageId: record.messageId });
  w.post({ purpose: 'proposal_objection', key: `${proposal.id}:${record.eventId}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.proposalObjection(author.displayName, reason) });
  return { outcome: 'proposal_objection' };
};

export function installProposals(): void {
  registerInboundHandler(proposalAnswers, PRIORITY.proposals);
  registerJobHandler('proposal_window', async (w, job) => {
    const proposal = await store.openProposal(w.tx, w.f.id);
    if (!proposal || proposal.id !== job.payload['proposalId']) return;
    await settleIfDue(w, proposal, true, deadlinePassed(w));
    // The proposal was in the way of an evaluation: look again now.
    await advance(w, 'contribution');
  });
  // No evaluation concludes while a proposal is open: it is decided first,
  // and never past the deadline.
  onBeforeDeadline(async (w) => {
    const proposal = await store.openProposal(w.tx, w.f.id);
    if (proposal) await settleIfDue(w, proposal, true, true);
  });
  // A proposal held at the end of its window for want of a verified list is
  // looked at again with the next message and the next reminder.
  const retryHeld = async (w: Work): Promise<void> => {
    if (w.f.phase !== 'active' && w.f.phase !== 'configuring') return;
    const proposal = await store.openProposal(w.tx, w.f.id);
    if (!proposal || proposal.windowEndsAt.getTime() > w.now.getTime()) return;
    await settleIfDue(w, proposal, true, deadlinePassed(w));
    await advance(w, 'contribution');
  };
  registerAfterInbound(retryHeld);
  onHeldDecisionRetry(retryHeld);
}
