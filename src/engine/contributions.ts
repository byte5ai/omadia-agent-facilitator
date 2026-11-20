// Authenticated contributions (spec 5.3).
//
// Authorship comes only from the kernel's stored inbound event. Author,
// message id, revision and time are copied from that record; no tool argument
// can name who said something. A contribution read from free text counts only
// after its author confirmed the echo.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import { principalKey } from '../kernel.js';
import type { Ack, Contribution, ContributionKind, Participant, Step } from '../model.js';
import { texts } from '../texts/index.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';

export const mention = (p: Pick<Participant, 'principalId' | 'displayName'>): { user: string; text: string } => ({
  user: p.principalId,
  text: p.displayName,
});

/**
 * Was the message written after the facilitation became active? What counts
 * is when the message was CREATED: an old message does not become current by
 * being edited. For anything but a 'created' record the engine looks up when
 * it saw the message being created; a message it never saw created predates
 * its reading of the conversation.
 */
export async function writtenAfterStart(w: Pick<Work, 'tx' | 'f'>, record: ConversationMessageRecord): Promise<boolean> {
  if (!w.f.activatedAt) return false;
  // A card answer is its own event, not a revision of an older message.
  const created = record.kind === 'created' || record.kind === 'card_answer' ? new Date(record.occurredAt) : await store.writtenAt(w.tx, w.f.id, record.messageId);
  return created !== undefined && created.getTime() >= w.f.activatedAt.getTime();
}

/** Who may contribute with this message, or why not. */
export async function authorOf(w: Work, record: ConversationMessageRecord): Promise<Participant> {
  if (record.channelType !== w.f.channelType || record.conversationId !== w.f.conversationId) {
    throw new Refusal('foreign_message', 'That message belongs to another conversation.');
  }
  if (record.kind === 'deleted') throw new Refusal('deleted_message', 'That message was deleted.');
  if (w.f.phase !== 'active') {
    throw new Refusal('not_active', `The facilitation is ${w.f.phase}; contributions are recorded only while it is active.`);
  }
  if (!(await writtenAfterStart(w, record))) {
    throw new Refusal('before_start', 'That message was written before this facilitation started. It does not count here.');
  }
  if (record.quoted === true || record.forwarded === true) {
    throw new Refusal('not_own_words', 'That message quotes or forwards somebody else. A person contributes only in their own message.');
  }
  const participant = await store.getParticipant(w.tx, w.f.id, principalKey(record.author));
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
  /** Human-readable form of the payload, for the confirmation question. */
  summary: string;
  /** Read from free text by the model: waits for its author. */
  interpreted: boolean;
  source?: 'message' | 'card';
  /** It replaces an earlier contribution of the same person. */
  replaces?: boolean;
  /** No confirmation question: the caller asks something better. */
  quiet?: boolean;
  /** The part of the message this contribution is (several per message). */
  partIndex?: number;
}

/** Cancel the confirmation requests that wait on these contributions. */
async function cancelAcksFor(w: Work, contributionIds: readonly string[]): Promise<void> {
  if (contributionIds.length === 0) return;
  await w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_acks SET status = 'cancelled', resolved_at = $3
      WHERE facilitation_id = $1 AND kind IN ('contribution', 'import') AND ref_id = ANY($2::uuid[]) AND status = 'pending'`,
    [w.f.id, contributionIds, w.now],
  );
}

/** Imported for somebody else (spec 5.3): such a part belongs to that person
 *  and ends only through their answer or its step, never through the
 *  importer's message. */
const isImport = (c: Contribution): boolean => c.payload['import'] !== undefined;

/** The live parts of a message that are its author's own (not imports). */
export async function ownLiveParts(w: Pick<Work, 'tx' | 'f'>, messageId: string): Promise<Contribution[]> {
  return (await store.listLiveBySourceMessage(w.tx, w.f.id, messageId)).filter((c) => !isImport(c));
}

/** Retire whatever this message carried before (an older revision): every
 *  part of its author's own. Returns the first part that was retired. */
export async function supersedeByMessage(w: Work, messageId: string): Promise<Contribution | undefined> {
  const previous = await ownLiveParts(w, messageId);
  for (const part of previous) await store.patchContribution(w.tx, part.id, { status: 'superseded' });
  await cancelAcksFor(w, previous.map((p) => p.id));
  return previous[0];
}

/** Write one contribution (one part of a message) from a kernel record. */
async function writePart(w: Work, input: RecordInput): Promise<Contribution> {
  const { record, author, step } = input;
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
    partIndex: input.partIndex ?? 0,
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
    part: contribution.partIndex,
  });
  return contribution;
}

/** Ask the author once to confirm what was read from their message. */
async function askToConfirm(w: Work, input: Pick<RecordInput, 'author' | 'source'>, parts: readonly Contribution[], summaries: readonly string[]): Promise<void> {
  const t = texts(w.f.language);
  const [first] = parts;
  if (!first) return;
  const summary = summaries.join('; ');
  const ack = await insert<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', {
    facilitationId: w.f.id,
    principal: input.author.principalId,
    kind: 'contribution',
    refId: first.id,
    detail: { summary, ...(parts.length > 1 ? { contributionIds: parts.map((p) => p.id) } : {}) },
    createdAt: w.now,
  });
  w.post({
    purpose: 'echo',
    key: first.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active'],
    text: input.source === 'card' ? t.echoUnverifiedCard(input.author.displayName, summary) : t.echoInterpreted(input.author.displayName, summary),
    mentions: [mention(input.author)],
    link: { kind: 'ack', id: ack.id },
  });
}

/**
 * Write one contribution from a kernel record.
 *
 * Recording is quiet (spec 5.3, 5.14): a contribution in the announced
 * format is not echoed in the group. (A reaction on the message would be the
 * acknowledgement where the channel supports one; the kernel offers no
 * contract for the facilitator to react, so there is nothing.) Only a
 * reading from free text gets a short question to its author.
 */
export async function recordContribution(w: Work, input: RecordInput): Promise<Contribution> {
  if ((input.partIndex ?? 0) === 0) await supersedeByMessage(w, input.record.messageId);
  const contribution = await writePart(w, input);
  if (input.interpreted && !input.quiet) await askToConfirm(w, input, [contribution], [input.summary]);
  return contribution;
}

/** One part of a message with several contributions. */
export interface PartInput {
  kind: ContributionKind;
  payload: Record<string, unknown>;
  summary: string;
}

/**
 * Several contributions from one message (spec 5.3, criterion 50): each is a
 * part with its own index; what the message carried before is retired as a
 * whole; a reading from free text is confirmed in one question listing all
 * parts.
 */
export async function recordParts(
  w: Work,
  input: Omit<RecordInput, 'kind' | 'payload' | 'summary' | 'partIndex'> & { parts: readonly PartInput[] },
): Promise<Contribution[]> {
  await supersedeByMessage(w, input.record.messageId);
  const written: Contribution[] = [];
  for (const [index, part] of input.parts.entries()) {
    written.push(await writePart(w, { ...input, ...part, partIndex: index }));
  }
  if (input.interpreted && !input.quiet) await askToConfirm(w, input, written, input.parts.map((p) => p.summary));
  return written;
}

/**
 * Retire the confirmation requests a person has open for a step: they voted
 * directly, or the step moved on to another round. The reading that waited
 * for a "yes" is superseded with it, so no later "yes" can bring it back.
 */
export async function cancelOpenRequests(w: Work, stepId: string, principal?: string): Promise<number> {
  const stale = await w.tx.query<{ ack_id: string; ref_id: string; detail: Record<string, unknown> }>(
    `SELECT a.id AS ack_id, a.ref_id, a.detail
       FROM plg_omadia_agent_facilitator_acks a
       JOIN plg_omadia_agent_facilitator_contributions c ON c.id = a.ref_id
      WHERE a.facilitation_id = $1 AND a.kind IN ('contribution', 'import') AND a.status = 'pending'
        AND c.step_id = $2 AND ($3::text IS NULL OR a.principal = $3)`,
    [w.f.id, stepId, principal ?? null],
  );
  for (const row of stale.rows) {
    await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: row.ack_id }, { status: 'cancelled', resolvedAt: w.now });
    // Every part the request stood for, and an import that waited for it.
    const ids = partsOf({ refId: row.ref_id, detail: row.detail });
    await w.tx.query(
      `UPDATE plg_omadia_agent_facilitator_contributions SET status = 'superseded' WHERE id = ANY($1::uuid[]) AND status IN ('unconfirmed', 'pending_import')`,
      [ids],
    );
  }
  return stale.rows.length;
}

/** The contributions a confirmation request stands for: one, or every part
 *  of a message that was read as several. */
const partsOf = (ack: Pick<Ack, 'refId' | 'detail'>): string[] => {
  const ids = ack.detail['contributionIds'];
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? (ids as string[]) : [ack.refId];
};

/** The author confirmed the reading: it counts from now on. Quiet: the
 *  author's "yes" needs no answer. */
export async function confirmContribution(w: Work, ack: Ack, author: Participant, messageId: string): Promise<Contribution | undefined> {
  await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: 'confirmed', resolvedAt: w.now, resolvedByMessageId: messageId });
  let first: Contribution | undefined;
  for (const id of partsOf(ack)) {
    const contribution = await store.getContribution(w.tx, id);
    if (!contribution || contribution.status !== 'unconfirmed') continue;
    const confirmed = await store.patchContribution(w.tx, contribution.id, { status: 'valid' });
    first ??= confirmed;
    w.bump();
    await w.event('contribution_confirmed', author.principalId, { contributionId: contribution.id, messageId });
  }
  return first;
}

/** The author said the reading was wrong: nothing is recorded. */
export async function declineContribution(w: Work, ack: Ack, author: Participant, messageId: string): Promise<void> {
  await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: 'declined', resolvedAt: w.now, resolvedByMessageId: messageId });
  for (const id of partsOf(ack)) {
    const contribution = await store.getContribution(w.tx, id);
    if (!contribution || contribution.status !== 'unconfirmed') continue;
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

/** The source message was deleted: what it carried no longer counts. Quiet:
 *  the author deleted it themselves. */
export async function withdrawByMessage(w: Work, messageId: string): Promise<boolean> {
  const live = await ownLiveParts(w, messageId);
  if (live.length === 0) return false;
  for (const part of live) {
    await store.patchContribution(w.tx, part.id, { status: 'withdrawn' });
    await w.event('contribution_withdrawn', part.participantPrincipal, { contributionId: part.id, messageId });
  }
  await cancelAcksFor(w, live.map((p) => p.id));
  w.bump();
  return true;
}

/** One clarifying question per message; the contribution stays out until resolved. */
export async function askClarification(
  w: Work,
  input: { record: ConversationMessageRecord; author: Participant; step: Step; question: string },
): Promise<'asked' | 'already_asked'> {
  const [existing] = await ownLiveParts(w, input.record.messageId);
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
