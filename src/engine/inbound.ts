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
import type { Ack, Contribution, InboundRow, Participant } from '../model.js';
import { texts } from '../texts/index.js';
import { confirmContribution, declineContribution, mention, supersedeByMessage, withdrawByMessage } from './contributions.js';
import type { EngineCore, Work } from './core.js';
import { abortInWork } from './lifecycle.js';
import { isPlaceholderName, nameOrPlaceholder } from './names.js';
import { expectedNames, sameName } from './roll.js';
import { namesOf, withoutMention } from './addressing.js';
import { wantedMode } from './scopes.js';
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

/** Who a message may name at its start, and whether the kernel stated that
 *  it addresses the facilitator. */
export interface Addressing {
  names: readonly string[];
  addressed: boolean;
}

/**
 * The command a message is: lower-cased, without the mention it starts with
 * and without closing punctuation. A mention is "@token", or the
 * facilitator's name as the channel writes it into the text (addressing.ts).
 */
export function normaliseCommand(text: string | undefined, addressing?: Addressing): string {
  const body = addressing ? withoutMention(text ?? '', addressing.names, addressing.addressed) : (text ?? '');
  return body
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

/** Purposes of messages in which the facilitator asks one person something. */
const ASKS = ['echo', 'clarification', 'nomination', 'action_item', 'which_confirmation', 'proposal_hint'];

/**
 * Is this request the most recent thing the facilitator asked that person?
 * A bare "yes" answers the last question, not an older one: if the
 * facilitator has asked the person anything since (or the request never
 * reached the chat), only a reply to the request itself confirms it.
 */
async function isLatestAsk(w: Work, ack: Ack): Promise<boolean> {
  if (!ack.promptMessageId) return false;
  const later = await w.tx.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_outbox later
      WHERE later.facilitation_id = $1
        AND later.status IN ('pending', 'sending', 'sent')
        AND later.purpose = ANY($4::text[])
        AND later.payload->'mentions' @> $3::jsonb
        AND later.seq > (SELECT max(asked.seq) FROM plg_omadia_agent_facilitator_outbox asked WHERE asked.facilitation_id = $1 AND asked.payload->'link'->>'id' = $2)
      LIMIT 1`,
    [w.f.id, ack.id, JSON.stringify([{ user: ack.principal }]), `{${ASKS.join(',')}}`],
  );
  return later.rows.length === 0;
}

/** Pick the acknowledgement a "yes" refers to. A reply to (or a reaction on)
 *  the request settles it. Without one, a bare "yes" counts only when exactly
 *  one request is open and it is the last thing the person was asked. */
async function pickAck(w: Work, pending: Ack[], replyTo: string | undefined): Promise<Ack | 'ambiguous' | undefined> {
  if (pending.length === 0) return undefined;
  const direct = replyTo ? pending.find((a) => a.promptMessageId === replyTo) : undefined;
  if (direct) return direct;
  if (pending.length > 1) return 'ambiguous';
  const only = pending[0];
  return only && (await isLatestAsk(w, only)) ? only : undefined;
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
  const ack = await pickAck(w, pending, record.kind === 'reaction' ? record.messageId : record.replyToMessageId);
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
  if (record.kind !== 'edited' && record.kind !== 'deleted') return undefined;
  // Contributions are frozen once the facilitation concludes: what was
  // counted stays what was counted. A later edit or deletion is put on
  // record and changes nothing.
  if (w.f.phase !== 'active' && w.f.phase !== 'configuring') {
    const carried = await store.findLiveBySourceMessage(w.tx, w.f.id, record.messageId);
    await w.event('late_change', principalKey(record.author), { kind: record.kind, messageId: record.messageId, revision: record.revision, contributionId: carried?.id ?? null });
    return { outcome: `late_${record.kind}` };
  }
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
export const PRIORITY = { revisions: 0, commands: 10, acknowledgements: 20, proposals: 30, followup: 35, ballots: 40, process: 50, quiet: 60 } as const;

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
  const live = w.f.phase === 'configuring' || w.f.phase === 'active';
  // A participant the request named and nobody was matched to: the name on
  // this message says who it is.
  const stated = record.author.displayName && !isPlaceholderName(record.author.displayName, key) ? record.author.displayName : author?.displayName;
  const named = live && stated ? expectedNames(w.f).find((name) => sameName(name, stated)) : undefined;
  if (named !== undefined) {
    const fresh = (await store.getFacilitation(w.tx, w.f.id)) ?? w.f;
    await w.patch({ settings: { ...fresh.settings, expected: expectedNames(fresh).filter((name) => name !== named) } });
    await w.event('participant_matched', key, { named });
  }
  if (!author && (w.f.settings.openRoster === true || named !== undefined) && live) {
    author = await store.addParticipant(w.tx, {
      facilitationId: w.f.id,
      principalId: key,
      displayName: nameOrPlaceholder(record.author.displayName, key, w.f.language),
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
  // A message carries its author's name: somebody known only by an id so far
  // is called by it from now on.
  if (isPlaceholderName(author.displayName, key) && record.author.displayName && !isPlaceholderName(record.author.displayName, key)) {
    author = (await store.patchParticipant(w.tx, w.f.id, key, { displayName: record.author.displayName.trim() })) ?? author;
  }
  if (!w.f.initiatorParticipant && key === w.f.initiatorPrincipal) await w.patch({ initiatorParticipant: key });
  return author.status === 'active' ? author : undefined;
}

/** Is a facilitation of this facilitator live in the conversation? Then the
 *  kernel suppresses the facilitator's ordinary turn there. */
export async function ordinaryTurnSuppressed(w: Work): Promise<boolean> {
  const live = await store.findLiveByConversation(w.tx, w.f.channelType, w.f.conversationId);
  return live !== undefined && live.facilitatorAgent === w.f.facilitatorAgent;
}

/** How a record reached the inbound consumer. */
export interface InboundOptions {
  /** The kernel asked who answers this message and the engine took it
   *  (`onAddressedMessage`): it is the engine's, whatever the rule below says. */
  fromHook?: boolean;
  /** The record was built from the kernel's question, not read from its
   *  store: it is no position the cursor could stand on. */
  keepCursor?: boolean;
}

/**
 * One mention, one reply.
 *
 * While a facilitation runs, the engine reads every message and the kernel
 * suppresses the turn a mention would start: the engine answers. In follow-up
 * the engine only hears what is addressed to the facilitator, and a mention
 * there also starts the facilitator's ordinary turn. Exactly one of the two
 * answers:
 *
 *   a kernel with `onAddressedMessage`   the kernel asks the engine first
 *       (addressed.ts). What the engine takes it works on from there, and
 *       the turn stays silent; what it declines the turn answers. The stored
 *       event of the same message, which also shows up here (pushed, or read
 *       on a later pass), is nobody's to answer a second time:
 *       `left_to_hook`.
 *   an older kernel                      the engine cannot claim the message,
 *       so it leaves it to the turn: `left_to_turn`. The turn closes an
 *       action item through `facilitation_action_done`.
 *
 * A reply without a mention and a card button start no turn: those stay the
 * engine's. So does a mention where another facilitation of this facilitator
 * is live, because the kernel suppresses the turn there.
 */
async function notForTheEventPath(w: Work, record: ConversationMessageRecord, opts: InboundOptions): Promise<'left_to_hook' | 'left_to_turn' | undefined> {
  if (opts.fromHook === true) return undefined;
  // Taken through the kernel's question a moment ago, without a stored event
  // to dedupe on.
  if (w.engine.takenByHook(record.messageId)) return 'left_to_hook';
  if (record.addressedToBot !== true || (record.kind !== 'created' && record.kind !== 'edited')) return undefined;
  if (wantedMode(w.f) !== 'addressed') return undefined;
  if (await ordinaryTurnSuppressed(w)) return undefined;
  return w.engine.addressedHook.has(w.f.facilitatorAgent) ? 'left_to_hook' : 'left_to_turn';
}

/** One stored event, inside the facilitation's unit of work. */
export async function handleInbound(w: Work, record: ConversationMessageRecord, opts: InboundOptions = {}): Promise<InboundResult> {
  const moveCursor = (): Promise<unknown> => (opts.keepCursor === true ? Promise.resolve() : store.advanceCursor(w.tx, w.f.id, record.eventId));
  const claimed = await store.claimInbound(w.tx, ledgerRow(w.f.id, record, w.now));
  if (!claimed) {
    // The event of a message the kernel asked about may have been seen here
    // first and left for that question. Now the engine took it: it is worked
    // on once, here.
    const left =
      opts.fromHook === true
        ? await w.tx.query(`SELECT 1 FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 AND event_id = $2 AND outcome = 'left_to_hook'`, [w.f.id, record.eventId])
        : { rows: [] };
    if (left.rows.length === 0) {
      // Dealt with before. The cursor may still have to catch up to it (it
      // waited for an earlier message that has been retried since).
      await moveCursor();
      return { outcome: 'duplicate' };
    }
  }
  await w.engine.deps.hooks?.beforeInbound?.(record);

  // A message from before this facilitation existed is not its to read:
  // not as a ballot, not as a command, not as an answer to anything. (The
  // conversation may have been read for an earlier facilitation.)
  if (Date.parse(record.occurredAt) < w.f.createdAt.getTime()) {
    await store.setInboundOutcome(w.tx, w.f.id, record.eventId, 'before_facilitation');
    await moveCursor();
    return { outcome: 'before_facilitation' };
  }

  // A mention in follow-up has one owner, and it is not this path (see above).
  const left = await notForTheEventPath(w, record, opts);
  if (left !== undefined) {
    await store.setInboundOutcome(w.tx, w.f.id, record.eventId, left);
    await moveCursor();
    return { outcome: left };
  }

  const author = await resolveAuthor(w, record);
  const ctx: InboundContext = { w, record, author, command: normaliseCommand(record.text, { names: namesOf(w.f), addressed: record.addressedToBot === true || opts.fromHook === true }) };
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
  await moveCursor();
  return result;
}

const ledgerRow = (facilitationId: string, record: ConversationMessageRecord, now: Date): InboundRow => ({
  facilitationId,
  eventId: record.eventId,
  messageId: record.messageId,
  revision: record.revision,
  kind: record.kind,
  authorPrincipal: principalKey(record.author),
  occurredAt: new Date(record.occurredAt),
  outcome: 'processing',
  processedAt: now,
});

/**
 * Route one kernel record to its facilitation.
 *
 * A record that cannot be processed is not skipped: the failure is written
 * down, the cursor stays before it, and the next replay tries it again. After
 * a bound it is given up, and the group is told once that a message could not
 * be processed, so nobody waits for an echo that will not come.
 */
export async function processRecord(engine: EngineCore, agentSlug: string, record: ConversationMessageRecord, opts: InboundOptions = {}): Promise<{ facilitationId: string; result: InboundResult } | undefined> {
  // The kernel states which facilitation a record was stored for (a reply to
  // one of its messages, an answer to one of its cards, or simply the one
  // that reads the conversation). A record without it is routed by its
  // conversation.
  const processId = (record as { processId?: string }).processId;
  const f = processId !== undefined ? await store.getFacilitation(engine.db(), processId) : await store.findRoutableByConversation(engine.db(), record.channelType, record.conversationId);
  if (!f || f.facilitatorAgent !== agentSlug) return undefined;
  try {
    const result = await engine.work(f.id, (w) => handleInbound(w, record, opts));
    return { facilitationId: f.id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure = await store.recordInboundFailure(engine.db(), ledgerRow(f.id, record, engine.now()), message);
    engine.log(`facilitation ${f.id}: message ${record.messageId} could not be processed (attempt ${String(failure.attempts)}): ${message}`);
    if (failure.gaveUp) await tellUnprocessed(engine, f.id, record);
    return { facilitationId: f.id, result: { outcome: failure.gaveUp ? 'gave_up' : 'failed' } };
  }
}

async function tellUnprocessed(engine: EngineCore, facilitationId: string, record: ConversationMessageRecord): Promise<void> {
  try {
    await engine.work(facilitationId, async (w) => {
      await w.event('message_unprocessed', 'engine', { messageId: record.messageId, eventId: record.eventId });
      await store.advanceCursor(w.tx, w.f.id, record.eventId);
      if (w.f.settings.unprocessedNoticeSent === true || (w.f.phase !== 'active' && w.f.phase !== 'configuring')) return;
      await w.tx.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || '{"unprocessedNoticeSent": true}'::jsonb WHERE id = $1`, [w.f.id]);
      w.post({ purpose: 'unprocessed_notice', key: 'once', to: 'group', deliveryClass: 'essential', text: texts(w.f.language).messageUnprocessed() });
    });
  } catch (err) {
    engine.log(`facilitation ${facilitationId}: could not tell the group about an unprocessed message: ${err instanceof Error ? err.message : String(err)}`);
  }
}
