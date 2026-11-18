// The inbound consumer (spec 5.3): every human message of a moderated
// conversation, once.
//
// Deterministic first. A message is a command, a confirmation, a ballot in the
// announced format, or free text. Only free text reaches the model, and what
// the model reads from it counts only after its author confirmed.
//
// Idempotent by event id (the inbound ledger); the cursor on the facilitation
// lets a restart replay what it missed.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import { principalKey } from '../kernel.js';
import type { Ack, Contribution, Participant } from '../model.js';
import { texts } from '../texts/index.js';
import { confirmContribution, declineContribution, mention, supersedeByMessage, withdrawByMessage } from './contributions.js';
import type { EngineCore, Work } from './core.js';
import { abortInWork } from './lifecycle.js';
import { statusText } from './status.js';

export interface InboundResult {
  /** What happened, for the inbound ledger. */
  outcome: string;
  /** Free text: the facilitator's turn should see it. */
  modelTurn?: boolean;
  /** The facilitation ended in this unit of work. */
  ended?: boolean;
}

export interface InboundContext {
  w: Work;
  record: ConversationMessageRecord;
  /** The author's participant row; undefined for somebody who is not one. */
  author: Participant | undefined;
  /** Lower-cased text without a leading mention or "/facilitator". */
  command: string;
  /** What this message carried in an older revision, retired by the edit. */
  retired?: Contribution;
}

/** A deterministic reading of one message. Undefined: not mine, try the next. */
export type InboundHandler = (ctx: InboundContext) => Promise<InboundResult | undefined>;

export function normaliseCommand(text: string | undefined): string {
  return (text ?? '')
    .trim()
    .replace(/^(@\S+\s+)+/u, '')
    .replace(/^\/facilitator\s+/i, '')
    .replace(/[.!?\s]+$/u, '')
    .toLowerCase();
}

const YES = /^(yes|yep|yeah|ja|jep|jo|ok|okay|confirm|confirmed|bestätigt|bestätige|stimmt|genau|passt|correct|korrekt|richtig|👍|✅)$/u;
const NO = /^(no|nope|nein|wrong|falsch|stimmt nicht|not correct|nicht korrekt|👎)$/u;
const POSITIVE_REACTIONS = new Set(['like', '+1', 'thumbsup', 'thumbs_up', 'yes', 'heart', 'check', 'white_check_mark', '👍', '✅', '❤️']);
const STATUS = /^(status|stand|zwischenstand)$/u;
const STOP = /^(stop|stopp)$/u;

export const isYes = (command: string): boolean => YES.test(command);
export const isNo = (command: string): boolean => NO.test(command);
export const isPositiveReaction = (name: string): boolean => POSITIVE_REACTIONS.has(name.toLowerCase());

/** "status" and "stop", as announced in the handshake. */
const commands: InboundHandler = async ({ w, record, author, command }) => {
  if (record.kind !== 'created' || !author) return undefined;
  if (STATUS.test(command)) {
    w.post({ purpose: 'status', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: await statusText(w.tx, w.f) });
    return { outcome: 'status' };
  }
  if (STOP.test(command) && (w.f.phase === 'active' || w.f.phase === 'configuring')) {
    await abortInWork(w, {
      reason: `stopped by ${author.displayName}`,
      actor: author.principalId,
      groupText: texts(w.f.language).stopped(author.displayName),
      detail: { messageId: record.messageId },
    });
    return { outcome: 'stopped', ended: true };
  }
  return undefined;
};

/** Pick the acknowledgement a "yes" refers to. */
function pickAck(pending: Ack[], replyTo: string | undefined): Ack | 'ambiguous' | undefined {
  if (pending.length === 0) return undefined;
  const direct = replyTo ? pending.find((a) => a.promptMessageId === replyTo) : undefined;
  if (direct) return direct;
  return pending.length === 1 ? pending[0] : 'ambiguous';
}

export type AckResolver = (w: Work, ack: Ack, author: Participant, record: ConversationMessageRecord, confirmed: boolean) => Promise<void>;

/** How each kind of acknowledgement is resolved. Later modules add theirs. */
export const ackResolvers: Record<string, AckResolver> = {
  contribution: async (w, ack, author, record, confirmed) => {
    if (confirmed) await confirmContribution(w, ack, author, record.messageId);
    else await declineContribution(w, ack, author, record.messageId);
  },
};

/** A person confirms or declines something that waits for them. */
const acknowledgements: InboundHandler = async ({ w, record, author, command }) => {
  if (!author) return undefined;
  let confirmed: boolean;
  let pending: Ack[];
  if (record.kind === 'reaction') {
    if (!record.reaction || record.reaction.removed || !isPositiveReaction(record.reaction.name)) return undefined;
    pending = (await store.pendingAcks(w.tx, w.f.id, author.principalId)).filter((a) => a.promptMessageId === record.messageId);
    confirmed = true;
  } else if (record.kind === 'created') {
    if (isYes(command)) confirmed = true;
    else if (isNo(command)) confirmed = false;
    else return undefined;
    pending = await store.pendingAcks(w.tx, w.f.id, author.principalId);
  } else {
    return undefined;
  }
  const ack = pickAck(pending, record.kind === 'reaction' ? record.messageId : record.replyToMessageId);
  if (!ack) return undefined;
  if (ack === 'ambiguous') {
    w.post({
      purpose: 'which_confirmation',
      key: record.eventId,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: texts(w.f.language).whichConfirmation(author.displayName, pending.map((a) => String(a.detail['summary'] ?? a.kind))),
      mentions: [mention(author)],
    });
    return { outcome: 'confirmation_ambiguous' };
  }
  const resolve = ackResolvers[ack.kind];
  if (!resolve) return undefined;
  await resolve(w, ack, author, record, confirmed);
  return { outcome: confirmed ? `confirmed_${ack.kind}` : `declined_${ack.kind}` };
};

/** Edits and deletions of a message that carried a contribution. */
const revisions: InboundHandler = async (ctx) => {
  const { w, record, author } = ctx;
  if (record.kind === 'deleted') {
    const withdrawn = await withdrawByMessage(w, record.messageId, author);
    return { outcome: withdrawn ? 'withdrawn' : 'deleted_without_contribution' };
  }
  if (record.kind !== 'edited') return undefined;
  // The latest revision counts: whatever the older one carried is retired
  // first, then the new text is read like any other message.
  const previous = await supersedeByMessage(w, record.messageId);
  if (previous) {
    ctx.retired = previous;
    w.bump();
    await w.event('contribution_superseded', previous.participantPrincipal, { contributionId: previous.id, messageId: record.messageId, revision: record.revision });
  }
  return undefined;
};

/** Reading order. Lower runs first; the fixed readings come before the
 *  method- and process-specific ones other modules register. */
export const PRIORITY = { revisions: 0, commands: 10, acknowledgements: 20, proposals: 30, followup: 35, ballots: 40, process: 50 } as const;

const handlers: Array<{ priority: number; handler: InboundHandler }> = [
  { priority: PRIORITY.revisions, handler: revisions },
  { priority: PRIORITY.commands, handler: commands },
  { priority: PRIORITY.acknowledgements, handler: acknowledgements },
];

export function registerInboundHandler(handler: InboundHandler, priority: number): void {
  if (handlers.some((h) => h.handler === handler)) return;
  handlers.push({ priority, handler });
  handlers.sort((a, b) => a.priority - b.priority);
}

export type AfterInbound = (w: Work) => Promise<void>;
const afterInbound: AfterInbound[] = [];

/** Runs after every message that was read, in the same unit of work: the
 *  place where the engine checks whether something is now decided. */
export function registerAfterInbound(hook: AfterInbound): void {
  if (!afterInbound.includes(hook)) afterInbound.push(hook);
}

async function resolveAuthor(w: Work, record: ConversationMessageRecord): Promise<Participant | undefined> {
  const key = principalKey(record.author);
  let author = await store.getParticipant(w.tx, w.f.id, key);
  if (!author && w.f.settings.openRoster === true && (w.f.phase === 'configuring' || w.f.phase === 'active')) {
    author = await store.addParticipant(w.tx, {
      facilitationId: w.f.id,
      principalId: key,
      displayName: record.author.displayName ?? record.author.id,
      canonicalPrincipal: key,
      source: 'joined',
      joinedAt: w.now,
      changedAt: w.now,
      changedByEvent: record.eventId,
    });
    if (author) {
      w.bump();
      await w.event('participant_joined', key, { by: 'first_message' });
    }
  }
  if (!author) return undefined;
  if (!w.f.initiatorParticipant && key === w.f.initiatorPrincipal) await w.patch({ initiatorParticipant: key });
  return author.status === 'active' ? author : undefined;
}

/** One stored event, inside the facilitation's unit of work. */
export async function handleInbound(w: Work, record: ConversationMessageRecord): Promise<InboundResult> {
  const claimed = await store.claimInbound(w.tx, {
    facilitationId: w.f.id,
    eventId: record.eventId,
    messageId: record.messageId,
    revision: record.revision,
    kind: record.kind,
    authorPrincipal: principalKey(record.author),
    outcome: 'processing',
    processedAt: w.now,
  });
  if (!claimed) return { outcome: 'duplicate' };

  const author = await resolveAuthor(w, record);
  const ctx: InboundContext = { w, record, author, command: normaliseCommand(record.text) };
  let result: InboundResult | undefined;
  for (const { handler } of handlers) {
    result = await handler(ctx);
    if (result) break;
  }
  if (!result) {
    const live = w.f.phase === 'configuring' || w.f.phase === 'active';
    const readable = (record.kind === 'created' || record.kind === 'edited') && (record.text ?? '').trim() !== '';
    if (!author) result = { outcome: 'not_a_participant' };
    else if (live && readable) result = { outcome: 'free_text', modelTurn: true };
    else result = { outcome: 'ignored' };
  }
  for (const hook of afterInbound) await hook(w);
  if (w.f.phase === 'aborted' || w.f.phase === 'closed') result = { ...result, ended: true };
  await store.setInboundOutcome(w.tx, w.f.id, record.eventId, result.outcome);
  // Not a state change: the cursor moves without bumping the version.
  await w.tx.query('UPDATE facilitations SET inbound_cursor = $2 WHERE id = $1', [w.f.id, record.eventId]);
  return result;
}

/** Route one kernel record to its facilitation. */
export async function processRecord(engine: EngineCore, agentSlug: string, record: ConversationMessageRecord): Promise<{ facilitationId: string; result: InboundResult } | undefined> {
  const f = await store.findRoutableByConversation(engine.pool(), record.channelType, record.conversationId);
  if (!f || f.facilitatorAgent !== agentSlug) return undefined;
  const result = await engine.work(f.id, (w) => handleInbound(w, record));
  return { facilitationId: f.id, result };
}
