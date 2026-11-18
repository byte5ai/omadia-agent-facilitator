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

import { MINUTE_MS } from '../clock.js';
import { insert } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Participant, Proposal, ProposalObjection } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { advance } from './decide.js';
import { PRIORITY, isPositiveReaction, isYes, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { cancelJobs, scheduleJob } from './jobs.js';
import { onBeforeDeadline, registerJobHandler } from './scheduler.js';

export interface ProposalKind {
  /** What is proposed, as a phrase for the announcement. */
  describe(w: Work, proposal: Proposal): string | Promise<string>;
  /** The proposal was accepted. */
  accept(w: Work, proposal: Proposal): Promise<void>;
  /** The proposal was rejected or withdrawn. */
  reject?(w: Work, proposal: Proposal): Promise<void>;
  /** Silence is not enough: every active participant has to agree. */
  unanimous?(w: Work, proposal: Proposal): boolean;
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
  await scheduleJob(w, 'proposal_window', proposal.id, windowEndsAt, { proposalId: proposal.id });
  w.bump();
  await w.event('proposal_opened', input.proposedBy, { proposalId: proposal.id, kind: input.kind, summary: input.summary, until: windowEndsAt.toISOString() });
  w.post({
    purpose: 'proposal',
    key: proposal.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['configuring', 'active'],
    text: t.proposalAnnounce(await definition.describe(w, proposal), formatWhen(windowEndsAt, w.f.timezone, w.f.language), definition.extend !== undefined),
    link: { kind: 'proposal', id: proposal.id },
  });
  return proposal;
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

/** Accept when the window is over without a standing objection, or when
 *  every active participant agreed. */
async function settleIfDue(w: Work, proposal: Proposal, windowOver: boolean): Promise<boolean> {
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const standing = proposal.objections.filter((o) => active.some((p) => p.principalId === o.principal));
  const everybody = active.length > 0 && active.every((p) => proposal.consents.includes(p.principalId));
  if (windowOver) {
    const needsAll = kindOf(proposal).unanimous?.(w, proposal) === true;
    await decideProposal(w, { ...proposal, objections: standing }, standing.length === 0 && (!needsAll || everybody));
    return true;
  }
  if (everybody && standing.length === 0) {
    await decideProposal(w, proposal, true);
    return true;
  }
  return false;
}

const OBJECTION = /^(?:objection|i object|einwand|veto|widerspruch|ich widerspreche)(?:\s*[:,-]\s*(.*))?$/is;
const AGREED = /^(?:agreed|agree|i agree|consent|no objection|einverstanden|zustimmung|ich stimme zu|kein einwand|passt|\+1)$/;
const EXTEND = /^(?:extend|verlängern|verlaengern|more time|mehr zeit)(?:\s+(\d{1,3}))?(?:\s*(?:min|minutes|minuten|m))?$/;

async function agree(w: Work, proposal: Proposal, author: Participant): Promise<void> {
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
  if (!author || (w.f.phase !== 'active' && w.f.phase !== 'configuring')) return undefined;
  const proposal = await store.openProposal(w.tx, w.f.id);
  if (!proposal) return undefined;
  const t = texts(w.f.language);

  if (record.kind === 'reaction') {
    if (!record.reaction || record.reaction.removed || !isPositiveReaction(record.reaction.name) || record.messageId !== proposal.announceMessageId) return undefined;
    await agree(w, proposal, author);
    return { outcome: 'proposal_consent' };
  }
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  if (record.quoted === true || record.forwarded === true) return undefined;

  if (AGREED.test(command) || isYes(command)) {
    await agree(w, proposal, author);
    return { outcome: 'proposal_consent' };
  }

  const extend = EXTEND.exec(command);
  const definition = kindOf(proposal);
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
    await settleIfDue(w, proposal, true);
    // The proposal was in the way of an evaluation: look again now.
    await advance(w, 'contribution');
  });
  // No evaluation concludes while a proposal is open: it is decided first,
  // and never past the deadline.
  onBeforeDeadline(async (w) => {
    const proposal = await store.openProposal(w.tx, w.f.id);
    if (proposal) await settleIfDue(w, proposal, true);
  });
}
