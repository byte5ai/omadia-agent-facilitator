// Contributions on behalf of others (spec 5.3; #2061).
//
// Somebody brings in what other people said elsewhere (older votes from a
// screenshot, a list from another chat). Nothing of it counts for those
// people until each confirms it in their own message: it is recorded as
// `pending_import` for that person, keeps who imported it and from where,
// and the person is asked once. Status and protocol show the origin.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Ballot } from '../methods/ballot.js';
import type { Ack, Contribution, ContributionKind, Participant, Step } from '../model.js';
import { texts } from '../texts/index.js';
import { mention } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { sameName } from './roll.js';

/** Part indexes of imports start here; a message's own parts stay below. */
export const IMPORT_PARTS_FROM = 1000;

/** Where an imported contribution came from, kept in its payload. */
export interface ImportOrigin {
  by: string;
  origin: string;
  messageId: string;
}

export const importOf = (c: Pick<Contribution, 'payload'>): ImportOrigin | undefined => {
  const raw = c.payload['import'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const { by, origin, messageId } = raw as Record<string, unknown>;
  return typeof by === 'string' && typeof origin === 'string' && typeof messageId === 'string' ? { by, origin, messageId } : undefined;
};

/**
 * The one active participant a name stands for. Two people who share a first
 * name are never guessed between: the name must tell them apart.
 */
export function personNamed(participants: readonly Participant[], name: string): Participant {
  const active = participants.filter((p) => p.status === 'active');
  const exact = active.filter((p) => p.displayName.trim().toLowerCase() === name.trim().toLowerCase());
  const matches = exact.length === 1 ? exact : active.filter((p) => sameName(p.displayName, name));
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length === 0) throw new Refusal('unknown_person', `Nobody among the participants is called '${name}'. Nothing was recorded.`);
  throw new Refusal('ambiguous_person', `'${name}' could be ${matches.map((p) => p.displayName).join(' or ')}. Use the full name. Nothing was recorded.`);
}

export interface ImportInput {
  record: ConversationMessageRecord;
  importer: Participant;
  step: Step;
  person: string;
  kind: ContributionKind;
  summary: string;
  ballot?: Ballot;
  origin: string;
}

/** Record a contribution for somebody else; it waits for that person. */
export async function recordImport(w: Work, input: ImportInput): Promise<{ person: Participant; contribution: Contribution }> {
  const participants = await store.listParticipants(w.tx, w.f.id);
  const person = personNamed(participants, input.person);
  if (person.principalId === input.importer.principalId) {
    throw new Refusal('own_contribution', 'That is your own contribution: write it here yourself. Nothing was recorded.');
  }
  // Several people may be imported from one message: each is a part of it,
  // numbered apart from the author's own parts, which a new revision of the
  // message renumbers from 0.
  const partIndex = (await store.listLiveBySourceMessage(w.tx, w.f.id, input.record.messageId)).reduce((max, c) => Math.max(max, c.partIndex + 1), IMPORT_PARTS_FROM);
  const origin: ImportOrigin = { by: input.importer.principalId, origin: input.origin, messageId: input.record.messageId };
  const contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: input.step.id,
    round: input.step.round,
    participantPrincipal: person.principalId,
    kind: input.kind,
    payload: { ...(input.ballot ? { ballot: input.ballot } : { text: input.summary }), summary: input.summary, import: origin },
    source: 'message',
    sourceMessageId: input.record.messageId,
    sourceRevision: input.record.revision,
    sourceEventId: input.record.eventId,
    sourceOccurredAt: new Date(input.record.occurredAt),
    partIndex,
    status: 'pending_import',
    interpreted: true,
    recordedAt: w.now,
  });
  w.bump();
  await w.event('contribution_imported', input.importer.principalId, { contributionId: contribution.id, for: person.principalId, origin: input.origin, summary: input.summary });
  const ack = await insert<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', {
    facilitationId: w.f.id,
    principal: person.principalId,
    kind: 'import',
    refId: contribution.id,
    detail: { summary: input.summary, origin: input.origin },
    createdAt: w.now,
  });
  w.post({
    purpose: 'echo',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active'],
    text: texts(w.f.language).importPending(person.displayName, input.importer.displayName, input.summary, input.origin),
    mentions: [mention(person)],
    link: { kind: 'ack', id: ack.id },
  });
  return { person, contribution };
}

/**
 * The person answered. Yes: it counts from now on, as theirs, if its step and
 * round are still open (`count` applies the method's rules, for a ballot one
 * per person and round). No: it is withdrawn.
 */
export async function resolveImport(
  w: Work,
  ack: Ack,
  author: Participant,
  messageId: string,
  confirmed: boolean,
  count: (contribution: Contribution, step: Step) => Promise<void>,
): Promise<void> {
  const contribution = await store.getContribution(w.tx, ack.refId);
  const step = contribution ? await store.getStep(w.tx, contribution.stepId) : undefined;
  const still = contribution?.status === 'pending_import' && step?.status === 'open' && contribution.round === step.round;
  await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: still ? (confirmed ? 'confirmed' : 'declined') : 'cancelled', resolvedAt: w.now, resolvedByMessageId: messageId });
  if (!contribution || !step || !still) {
    if (contribution?.status === 'pending_import') await store.patchContribution(w.tx, contribution.id, { status: 'superseded' });
    return;
  }
  w.bump();
  if (!confirmed) {
    await store.patchContribution(w.tx, contribution.id, { status: 'withdrawn' });
    await w.event('import_declined', author.principalId, { contributionId: contribution.id, messageId });
    w.post({ purpose: 'echo_declined', key: ack.id, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).echoDeclined(author.displayName), mentions: [mention(author)] });
    return;
  }
  const valid = await store.patchContribution(w.tx, contribution.id, { status: 'valid' });
  await w.event('import_confirmed', author.principalId, { contributionId: contribution.id, messageId });
  if (valid) await count(valid, step);
}

/** For status: what waits for its person, with its origin. */
export async function pendingImports(w: Pick<Work, 'tx' | 'f'>): Promise<Contribution[]> {
  return (await store.listContributions(w.tx, w.f.id)).filter((c) => c.status === 'pending_import');
}
