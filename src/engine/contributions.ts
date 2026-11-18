// Authenticated contributions (spec 5.3).
//
// Authorship comes only from the kernel's stored inbound event. Author,
// message id, revision and time are copied from that record; no tool argument
// can name who said something. A contribution read from free text counts only
// after its author confirmed the echo.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Ack, Contribution, ContributionKind, Participant, Step } from '../model.js';
import { texts } from '../texts/index.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';

export const mention = (p: Pick<Participant, 'principalId' | 'displayName'>): { user: string; text: string } => ({
  user: p.principalId,
  text: p.displayName,
});

/** Who may contribute with this message, or why not. */
export async function authorOf(w: Work, record: ConversationMessageRecord): Promise<Participant> {
  if (record.channelType !== w.f.channelType || record.conversationId !== w.f.conversationId) {
    throw new Refusal('foreign_message', 'That message belongs to another conversation.');
  }
  if (record.kind === 'deleted') throw new Refusal('deleted_message', 'That message was deleted.');
  if (w.f.phase !== 'active') {
    throw new Refusal('not_active', `The facilitation is ${w.f.phase}; contributions are recorded only while it is active.`);
  }
  if (!w.f.activatedAt || Date.parse(record.occurredAt) < w.f.activatedAt.getTime()) {
    throw new Refusal('before_start', 'That message was written before this facilitation started. It does not count here.');
  }
  if (record.quoted === true || record.forwarded === true) {
    throw new Refusal('not_own_words', 'That message quotes or forwards somebody else. A person contributes only in their own message.');
  }
  const participant = await store.getParticipant(w.tx, w.f.id, record.author.id);
  if (!participant || participant.status !== 'active') {
    throw new Refusal('not_participant', 'The author of that message is not a participant of this facilitation.');
  }
  return participant;
}

export interface RecordInput {
  record: ConversationMessageRecord;
  author: Participant;
  step: Step;
  kind: ContributionKind;
  payload: Record<string, unknown>;
  /** Human-readable form of the payload, for the echo. */
  summary: string;
  /** Read from free text by the model: waits for its author. */
  interpreted: boolean;
  source?: 'message' | 'card';
}

/** Retire whatever this message carried before (an older revision). */
export async function supersedeByMessage(w: Work, messageId: string): Promise<Contribution | undefined> {
  const previous = await store.findLiveBySourceMessage(w.tx, w.f.id, messageId);
  if (!previous) return undefined;
  await store.patchContribution(w.tx, previous.id, { status: 'superseded' });
  await w.tx.query(
    `UPDATE facilitation_acks SET status = 'cancelled', resolved_at = $3
      WHERE facilitation_id = $1 AND kind = 'contribution' AND ref_id = $2 AND status = 'pending'`,
    [w.f.id, previous.id, w.now],
  );
  return previous;
}

/** Write one contribution from a kernel record and echo it to its author. */
export async function recordContribution(w: Work, input: RecordInput): Promise<Contribution> {
  const { record, author, step } = input;
  const t = texts(w.f.language);
  const previous = await supersedeByMessage(w, record.messageId);
  const contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: step.id,
    round: step.round,
    participantPrincipal: author.principalId,
    kind: input.kind,
    payload: { ...input.payload, summary: input.summary },
    source: input.source ?? 'message',
    sourceMessageId: record.messageId,
    sourceRevision: record.revision,
    sourceEventId: record.eventId,
    sourceOccurredAt: new Date(record.occurredAt),
    status: input.interpreted ? 'unconfirmed' : 'valid',
    interpreted: input.interpreted,
    recordedAt: w.now,
  });
  w.bump();
  await w.event('contribution_recorded', author.principalId, {
    contributionId: contribution.id,
    kind: input.kind,
    summary: input.summary,
    status: contribution.status,
    messageId: record.messageId,
    revision: record.revision,
  });

  if (input.interpreted) {
    const ack = await insert<Ack>(w.tx, 'facilitation_acks', {
      facilitationId: w.f.id,
      principal: author.principalId,
      kind: 'contribution',
      refId: contribution.id,
      detail: { summary: input.summary },
      createdAt: w.now,
    });
    w.post({
      purpose: 'echo',
      key: contribution.id,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['active'],
      text: t.echoInterpreted(author.displayName, input.summary),
      mentions: [mention(author)],
      link: { kind: 'ack', id: ack.id },
    });
    return contribution;
  }

  w.post({
    purpose: 'echo',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active', 'concluding'],
    text: previous ? t.echoChanged(author.displayName, input.summary) : t.echoRecorded(author.displayName, input.summary),
    mentions: [mention(author)],
  });
  return contribution;
}

const summaryOf = (c: Contribution): string => String(c.payload['summary'] ?? '');

/** The author confirmed the echo: the contribution counts from now on. */
export async function confirmContribution(w: Work, ack: Ack, author: Participant, messageId: string): Promise<Contribution | undefined> {
  const contribution = await store.getContribution(w.tx, ack.refId);
  await update(w.tx, 'facilitation_acks', { id: ack.id }, { status: 'confirmed', resolvedAt: w.now, resolvedByMessageId: messageId });
  if (!contribution || contribution.status !== 'unconfirmed') return undefined;
  const confirmed = await store.patchContribution(w.tx, contribution.id, { status: 'valid' });
  w.bump();
  await w.event('contribution_confirmed', author.principalId, { contributionId: contribution.id, messageId });
  w.post({
    purpose: 'echo_confirmed',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active', 'concluding'],
    text: texts(w.f.language).echoConfirmed(author.displayName, summaryOf(contribution)),
    mentions: [mention(author)],
  });
  return confirmed;
}

/** The author said the reading was wrong: nothing is recorded. */
export async function declineContribution(w: Work, ack: Ack, author: Participant, messageId: string): Promise<void> {
  await update(w.tx, 'facilitation_acks', { id: ack.id }, { status: 'declined', resolvedAt: w.now, resolvedByMessageId: messageId });
  const contribution = await store.getContribution(w.tx, ack.refId);
  if (contribution && contribution.status === 'unconfirmed') {
    await store.patchContribution(w.tx, contribution.id, { status: 'withdrawn' });
    w.bump();
    await w.event('contribution_declined', author.principalId, { contributionId: contribution.id, messageId });
  }
  w.post({
    purpose: 'echo_declined',
    key: ack.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    text: texts(w.f.language).echoDeclined(author.displayName),
    mentions: [mention(author)],
  });
}

/** The source message was deleted: what it carried no longer counts. */
export async function withdrawByMessage(w: Work, messageId: string, author: Participant | undefined): Promise<boolean> {
  const live = await store.findLiveBySourceMessage(w.tx, w.f.id, messageId);
  if (!live) return false;
  await store.patchContribution(w.tx, live.id, { status: 'withdrawn' });
  await w.tx.query(
    `UPDATE facilitation_acks SET status = 'cancelled', resolved_at = $3
      WHERE facilitation_id = $1 AND kind = 'contribution' AND ref_id = $2 AND status = 'pending'`,
    [w.f.id, live.id, w.now],
  );
  w.bump();
  await w.event('contribution_withdrawn', live.participantPrincipal, { contributionId: live.id, messageId });
  if (author) {
    w.post({
      purpose: 'echo_withdrawn',
      key: live.id,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['active'],
      text: texts(w.f.language).echoWithdrawn(author.displayName),
      mentions: [mention(author)],
    });
  }
  return true;
}

/** One clarifying question per message; the contribution stays out until resolved. */
export async function askClarification(
  w: Work,
  input: { record: ConversationMessageRecord; author: Participant; step: Step; question: string },
): Promise<'asked' | 'already_asked'> {
  const existing = await store.findLiveBySourceMessage(w.tx, w.f.id, input.record.messageId);
  if (existing && existing.sourceRevision === input.record.revision) {
    if (existing.status === 'ambiguous') return 'already_asked';
    throw new Refusal('already_recorded', 'That message already carries a recorded contribution.');
  }
  if (existing) await supersedeByMessage(w, input.record.messageId);
  const contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: input.step.id,
    round: input.step.round,
    participantPrincipal: input.author.principalId,
    kind: 'question',
    payload: { clarification: input.question },
    source: 'message',
    sourceMessageId: input.record.messageId,
    sourceRevision: input.record.revision,
    sourceEventId: input.record.eventId,
    sourceOccurredAt: new Date(input.record.occurredAt),
    status: 'ambiguous',
    interpreted: false,
    recordedAt: w.now,
  });
  w.bump();
  await w.event('clarification_asked', 'engine', { contributionId: contribution.id, messageId: input.record.messageId, question: input.question });
  w.post({
    purpose: 'clarification',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active'],
    text: `${input.author.displayName}, ${input.question}`,
    mentions: [mention(input.author)],
  });
  return 'asked';
}
