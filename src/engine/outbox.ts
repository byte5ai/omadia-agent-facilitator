// Delivery of the outbox (spec 5.6, delivery classes).
//
// Called with the facilitation's lock held, on the locked connection. A row is
// marked `sending` and committed BEFORE the channel call, so a crash leaves
// evidence of the attempt; the lock stays held until the call returned.
//
//   droppable (reminders, echoes, moderation posts): at-most-once. A failed
//     or unknown outcome is never retried.
//   essential (handshake, result, abort report): at-least-once. Retried until
//     the channel confirmed, accepting a rare duplicate.

import type { CardSendMembers } from '../cards/types.js';
import type { PoolClientLike, Queryable } from '../db/pool.js';
import { rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Facilitation, OutboxPayload, OutboxRow } from '../model.js';
import { texts } from '../texts/index.js';
import type { EngineCore, GroupFallback } from './core.js';
import { messageQuotaReached } from './quota.js';

type SendResult = { ok: true; messageId?: string; cardMessageId?: string } | { ok: false; code: string; message: string };

type StoredPayload = OutboxPayload & {
  link?: { kind: 'ack' | 'proposal' | 'card'; id: string };
  /** What goes to the group when this private message cannot arrive. */
  fallback?: GroupFallback;
};

/** How long one channel call may take. The facilitation's lock is held for
 *  that long at most; a call that does not answer in time has an unknown
 *  outcome and is treated like one. */
export const sendLimits = { timeoutMs: 15_000 };

export class CallTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`timeout: ${what} did not answer within ${String(ms)} ms`);
    this.name = 'CallTimeoutError';
  }
}

/** Bound a call into the kernel or an integration. */
export function withTimeout<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(what, ms)), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/** A failed send as the outbox records it. A provider may answer without a
 *  code or a message; what is written down is readable either way. */
function failed(code: unknown, message: unknown): SendResult {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  return { ok: false, code: text(code) ?? 'malformed_outcome', message: text(message) ?? 'the channel reported a failure without saying why' };
}

/** Bring a posted card up to date (its closed state). Not a post. */
async function updateCard(engine: EngineCore, q: Queryable, f: Facilitation, request: NonNullable<StoredPayload['cardUpdate']>): Promise<SendResult> {
  const service = engine.deps.kernel.conversationSend() as (CardSendMembers & object) | undefined;
  if (typeof service?.updateCard !== 'function') return { ok: false, code: 'no_card_update', message: 'the kernel cannot update cards' };
  const card = await store.getCard(q, request.cardId);
  // A card that never reached the channel has nothing to bring up to date.
  if (!card?.messageId) return { ok: false, code: 'card_not_posted', message: 'the card was not posted, so there is nothing to update' };
  const outcome = await service.updateCard({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, cardMessageId: card.messageId, update: request.update });
  return outcome.outcome === 'updated' ? { ok: true } : failed(outcome.code, outcome.message);
}

/** The code a channel answers with when it does not render a card. */
const CARD_REFUSED = 'channel_error';

async function send(engine: EngineCore, q: Queryable, f: Facilitation, row: OutboxRow): Promise<SendResult> {
  const payload = row.payload as StoredPayload;
  if (payload.cardUpdate) return updateCard(engine, q, f, payload.cardUpdate);
  if (row.targetKind === 'group') {
    const service = engine.deps.kernel.conversationSend();
    if (!service) return { ok: false, code: 'no_service', message: "kernel service 'conversationSend' is not available" };
    if (payload.card) {
      const withCard = await service.sendToConversation({
        agentSlug: f.facilitatorAgent,
        channelType: f.channelType,
        conversationId: f.conversationId,
        message: { text: payload.text, card: payload.card } as never,
        asOwnIdentity: true,
      });
      if (withCard.outcome === 'delivered') {
        const cardMessageId = (withCard as { cardMessageId?: string }).cardMessageId ?? withCard.messageId;
        return { ok: true, ...(withCard.messageId !== undefined ? { messageId: withCard.messageId } : {}), ...(cardMessageId !== undefined ? { cardMessageId } : {}) };
      }
      if (withCard.code !== CARD_REFUSED) return failed(withCard.code, withCard.message);
      // The channel does not render this card: the question goes out as
      // text, and the chat ballot is the way to answer.
      await store.patchCard(q, payload.card.cardId, { state: 'closed', closedAt: engine.now() });
      engine.log(`facilitation ${f.id}: the channel refused the card (${withCard.message}); the question is posted as text`);
      const asText = await service.sendToConversation({
        agentSlug: f.facilitatorAgent,
        channelType: f.channelType,
        conversationId: f.conversationId,
        message: { text: payload.cardFallbackText ?? payload.text },
        asOwnIdentity: true,
      });
      if (asText.outcome !== 'delivered') return failed(asText.code, asText.message);
      return { ok: true, ...(asText.messageId !== undefined ? { messageId: asText.messageId } : {}) };
    }
    const outcome = await service.sendToConversation({
      agentSlug: f.facilitatorAgent,
      channelType: f.channelType,
      conversationId: f.conversationId,
      // The text always carries the whole question, so a channel without
      // polls loses nothing.
      message: {
        text: payload.text,
        ...(payload.mentions ? { mentions: payload.mentions } : {}),
        ...(payload.poll ? { poll: payload.poll } : {}),
      },
      asOwnIdentity: true,
    });
    if (outcome.outcome !== 'delivered') return failed(outcome.code, outcome.message);
    return { ok: true, ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}) };
  }

  const service = engine.deps.kernel.targetedSend();
  if (!service) return { ok: false, code: 'no_service', message: "kernel service 'targetedSend' is not available" };
  const result = await service.sendToPrincipal({
    channelType: f.channelType,
    // Participants are keyed by canonical principal, which is the wire form.
    principal: row.targetPrincipal ?? '',
    message: { text: payload.text },
    asAgentSlug: f.facilitatorAgent,
  });
  const delivery = result.deliveries[0];
  if (!delivery) {
    const diagnostic = result.diagnostics[0];
    return failed(diagnostic?.code ?? 'no_delivery', diagnostic?.message ?? 'no delivery was reported');
  }
  return delivery.outcome.outcome === 'delivered'
    ? { ok: true, ...(delivery.outcome.messageId !== undefined ? { messageId: delivery.outcome.messageId } : {}) }
    : failed(delivery.outcome.code, delivery.outcome.message);
}

async function stampLink(q: Queryable, payload: StoredPayload, messageId: string | undefined, cardMessageId?: string): Promise<void> {
  if (!payload.link) return;
  if (payload.link.kind === 'card') {
    // Answers and updates refer to the card's own message.
    if (cardMessageId !== undefined) await store.patchCard(q, payload.link.id, { messageId: cardMessageId });
    return;
  }
  if (messageId === undefined) return;
  if (payload.link.kind === 'ack') await update(q, 'plg_omadia_agent_facilitator_acks', { id: payload.link.id }, { promptMessageId: messageId });
  else await update(q, 'plg_omadia_agent_facilitator_proposals', { id: payload.link.id }, { announceMessageId: messageId });
}

/** An essential message is retried with a growing pause, at most this often. */
export const MAX_ESSENTIAL_ATTEMPTS = 20;
/** The kernel's answer to a post without a subscription. */
const NO_SUBSCRIPTION_CODE = 'not_permitted';
/** How often an ended facilitation tries to post without a subscription. */
export const ORPHAN_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
/** A private message that can never arrive: retrying changes nothing. */
const PERMANENT_DIRECT_FAILURES = new Set(['app_not_installed', 'blocked', 'no_identity', 'not_found']);

export const retryDelayMs = (attempts: number): number => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/**
 * Settle what an earlier attempt left behind. Sends only happen under the
 * facilitation's lock, and we hold it: a row still marked `sending` belongs to
 * an attempt that died (crash, lost connection) with its outcome unknown.
 *
 *   droppable: never retried. An unknown outcome may have been a delivery.
 *   essential: retried, accepting a rare duplicate.
 *
 * A droppable message that another engine process queued and never attempted
 * is dropped as well: that process is gone, and what it wanted to say was
 * computed before the restart.
 */
async function recover(engine: EngineCore, client: PoolClientLike, facilitationId: string): Promise<void> {
  await client.query(
    `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'outcome of an earlier attempt is unknown; droppable messages are not retried'
      WHERE facilitation_id = $1 AND status = 'sending' AND delivery_class = 'droppable'`,
    [facilitationId],
  );
  await client.query(
    `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'pending', last_error = 'outcome of an earlier attempt is unknown; retrying'
      WHERE facilitation_id = $1 AND status = 'sending' AND delivery_class = 'essential'`,
    [facilitationId],
  );
  await client.query(
    `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'queued by an engine process that ended before sending it'
      WHERE facilitation_id = $1 AND status = 'pending' AND delivery_class = 'droppable' AND owner <> $2`,
    [facilitationId, engine.instanceId],
  );
}

/** Deliver every pending row of one facilitation, oldest first. */
export async function dispatchOutbox(engine: EngineCore, client: PoolClientLike, facilitationId: string): Promise<void> {
  await recover(engine, client, facilitationId);
  const pending = await rows<OutboxRow>(
    client,
    `SELECT * FROM plg_omadia_agent_facilitator_outbox
      WHERE facilitation_id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
      ORDER BY seq`,
    [facilitationId, engine.now()],
  );
  for (const row of pending) {
    const f = await store.getFacilitation(client, facilitationId);
    if (!f) return;
    await deliver(engine, client, f, row);
  }
}

const drop = (q: Queryable, row: OutboxRow, reason: string): Promise<unknown> =>
  update(q, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'dropped', dropReason: reason });

async function deliver(engine: EngineCore, client: PoolClientLike, f: Facilitation, row: OutboxRow): Promise<void> {
  // Re-check under the lock: the state the message was computed from must
  // still hold.
  if (row.requiredPhases && !row.requiredPhases.includes(f.phase)) {
    await drop(client, row, `phase is ${f.phase}`);
    return;
  }
  if (row.requiredStateVersion !== null && row.requiredStateVersion !== f.stateVersion) {
    await drop(client, row, `state moved from version ${String(row.requiredStateVersion)} to ${String(f.stateVersion)}`);
    return;
  }

  // The subscription this facilitation posted under is gone for good. A later
  // subscription to the same conversation belongs to another facilitation and
  // does not carry this one's messages.
  if (f.settings.orphaned === true) {
    await drop(client, row, 'the facilitation lost its subscription; nothing is posted for it any more');
    return;
  }

  // A private message is tried once per person: who could not be reached is
  // not tried again in this facilitation.
  if (row.targetKind === 'direct' && row.deliveryClass === 'droppable' && (f.settings.unreachable ?? []).includes(row.targetPrincipal ?? '')) {
    await drop(client, row, 'this person could not be reached privately before');
    await fallbackToGroup(engine, client, f, row);
    return;
  }

  // Quota: beyond the limit only essential messages go out, and the group is
  // told once.
  if (row.deliveryClass === 'droppable' && messageQuotaReached(f, engine.config.maxMessagesPerFacilitation)) {
    await drop(client, row, 'message quota of the facilitation reached');
    if (!f.quotaNoticeSent) {
      await client.query('UPDATE plg_omadia_agent_facilitator_facilitations SET quota_notice_sent = true WHERE id = $1', [f.id]);
      await store.appendEvent(client, { facilitationId: f.id, kind: 'quota_reached', actor: 'engine', occurredAt: engine.now(), payload: { quota: 'messages', max: engine.config.maxMessagesPerFacilitation } });
      await engine.workOn(client, f.id, async (w) => {
        w.post({ purpose: 'system_notice', key: 'message_quota', to: 'group', deliveryClass: 'essential', text: texts(f.language).system.messageQuota(engine.config.maxMessagesPerFacilitation) });
      });
    }
    return;
  }

  // Recorded before the call, in its own committed statement.
  await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'sending', attempts: row.attempts + 1, owner: engine.instanceId });
  await engine.deps.hooks?.beforeChannelCall?.(row);

  let result: SendResult;
  try {
    result = await withTimeout(send(engine, client, f, row), sendLimits.timeoutMs, `the channel send of ${row.purpose}`);
  } catch (err) {
    result = { ok: false, code: err instanceof CallTimeoutError ? 'timeout' : 'exception', message: err instanceof Error ? err.message : String(err) };
  }
  await engine.deps.hooks?.afterChannelCall?.(row);

  if (result.ok) {
    await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'sent', sentAt: engine.now(), channelMessageId: result.messageId ?? null });
    // An update of a card is no new message in the conversation.
    if (!(row.payload as StoredPayload).cardUpdate) await client.query('UPDATE plg_omadia_agent_facilitator_facilitations SET messages_sent = messages_sent + 1 WHERE id = $1', [f.id]);
    await stampLink(client, row.payload as StoredPayload, result.messageId, result.cardMessageId);
    await store.appendEvent(client, {
      facilitationId: f.id,
      kind: 'message_sent',
      actor: 'engine',
      occurredAt: engine.now(),
      payload: { purpose: row.purpose, to: row.targetKind === 'group' ? 'group' : row.targetPrincipal, text: row.payload.text },
    });
    return;
  }

  const error = `${result.code}: ${result.message}`;
  const attempts = row.attempts + 1;
  // The kernel holds no subscription for this conversation: remembered, so
  // that the next pass takes it again or ends the facilitation.
  const unsubscribed = row.targetKind === 'group' && result.code === NO_SUBSCRIPTION_CODE;
  if (unsubscribed) {
    const ended = (f.phase === 'closed' || f.phase === 'aborted') && f.followupState !== 'active';
    // An ended facilitation is not subscribed again. After a few attempts
    // its messages are given up, not kept until somebody else subscribes.
    const orphaned = ended && attempts >= ORPHAN_ATTEMPTS;
    await client.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || $2::jsonb WHERE id = $1`, [
      f.id,
      JSON.stringify(orphaned ? { subscriptionLost: true, orphaned: true } : { subscriptionLost: true }),
    ]);
    if (orphaned && row.deliveryClass === 'essential') {
      await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'failed', lastError: error });
      await store.appendEvent(client, { facilitationId: f.id, kind: 'delivery_failed', actor: 'engine', occurredAt: engine.now(), payload: { purpose: row.purpose, to: 'group', error, attempts } });
      engine.log(`facilitation ${f.id}: ${row.purpose} is given up, the facilitation has no subscription any more (${error})`);
      return;
    }
  }
  if (row.deliveryClass === 'droppable') {
    await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'dropped', lastError: error, dropReason: 'send failed; droppable messages are not retried' });
    engine.log(`facilitation ${f.id}: ${row.purpose} not delivered (${error}); not retried`);
    if (row.targetKind === 'direct') {
      await noteUnreachable(engine, client, f, row, result.code);
      await fallbackToGroup(engine, client, f, row);
    }
    return;
  }
  const permanent = row.targetKind === 'direct' && PERMANENT_DIRECT_FAILURES.has(result.code);
  if (permanent || attempts >= MAX_ESSENTIAL_ATTEMPTS) {
    await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'failed', lastError: error });
    await store.appendEvent(client, {
      facilitationId: f.id,
      kind: 'delivery_failed',
      actor: 'engine',
      occurredAt: engine.now(),
      payload: { purpose: row.purpose, to: row.targetKind === 'group' ? 'group' : row.targetPrincipal, error, attempts },
    });
    engine.log(`facilitation ${f.id}: essential ${row.purpose} could not be delivered (${error}); giving up after ${String(attempts)} attempt(s)`);
    if (row.targetKind === 'direct') {
      await noteUnreachable(engine, client, f, row, result.code);
      // What the person is owed is said in the group instead.
      await fallbackToGroup(engine, client, f, row);
    }
    return;
  }
  await update(client, 'plg_omadia_agent_facilitator_outbox', { id: row.id }, { status: 'pending', lastError: error, nextAttemptAt: new Date(engine.now().getTime() + retryDelayMs(attempts)) });
  engine.log(`facilitation ${f.id}: essential ${row.purpose} not delivered (${error}); will retry`);
}

/** A private message that names its group form: said there instead. */
async function fallbackToGroup(engine: EngineCore, client: PoolClientLike, f: Facilitation, row: OutboxRow): Promise<void> {
  const fallback = (row.payload as StoredPayload).fallback;
  if (!fallback) return;
  await engine.workOn(client, f.id, async (w) => {
    w.post({ purpose: fallback.purpose, key: fallback.key ?? row.id, to: 'group', deliveryClass: fallback.deliveryClass ?? 'droppable', versionBound: false, text: fallback.text, ...(fallback.mentions ? { mentions: fallback.mentions } : {}) });
  });
}

/** A private message did not arrive. The group is told once, neutrally and
 *  without a name; from then on reminders simply stay in the group. */
async function noteUnreachable(engine: EngineCore, client: PoolClientLike, f: Facilitation, row: OutboxRow, code: string): Promise<void> {
  await store.appendEvent(client, {
    facilitationId: f.id,
    kind: 'direct_unreachable',
    actor: 'engine',
    occurredAt: engine.now(),
    payload: { principal: row.targetPrincipal, purpose: row.purpose, code },
  });
  if (row.targetPrincipal && !(f.settings.unreachable ?? []).includes(row.targetPrincipal)) {
    await client.query(
      `UPDATE plg_omadia_agent_facilitator_facilitations SET settings = jsonb_set(settings, '{unreachable}', coalesce(settings->'unreachable', '[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1`,
      [f.id, row.targetPrincipal],
    );
  }
  if (f.settings.directNoticeSent === true || (f.phase !== 'active' && f.phase !== 'configuring')) return;
  await engine.workOn(client, f.id, async (w) => {
    // Not a state change: nothing that was computed becomes stale by it.
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || '{"directNoticeSent": true}'::jsonb WHERE id = $1`, [f.id]);
    w.post({ purpose: 'direct_notice', key: 'once', to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(f.language).directUnreachable() });
  });
}
