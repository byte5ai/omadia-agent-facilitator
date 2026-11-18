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

import type { PoolClientLike, Queryable } from '../db/pool.js';
import { rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Facilitation, OutboxPayload, OutboxRow, Participant } from '../model.js';
import type { EngineCore } from './core.js';

type SendResult = { ok: true; messageId?: string } | { ok: false; code: string; message: string };

type StoredPayload = OutboxPayload & { link?: { kind: 'ack' | 'proposal'; id: string } };

/** Where a private message goes: the canonical principal when the kernel
 *  told us one, otherwise the channel user id in wire form. */
export function directPrincipal(participant: Pick<Participant, 'principalId' | 'canonicalPrincipal'> | undefined, principalId: string): string {
  if (participant?.canonicalPrincipal) return participant.canonicalPrincipal;
  return principalId.includes(':') ? principalId : `user:${principalId}`;
}

async function send(engine: EngineCore, q: Queryable, f: Facilitation, row: OutboxRow): Promise<SendResult> {
  const payload = row.payload as StoredPayload;
  if (row.targetKind === 'group') {
    const service = engine.deps.kernel.conversationSend();
    if (!service) return { ok: false, code: 'no_service', message: "kernel service 'conversationSend' is not available" };
    const outcome = await service.sendToConversation({
      agentSlug: f.facilitatorAgent,
      channelType: f.channelType,
      conversationId: f.conversationId,
      // `card` is not part of plugin-api 1.55.0; a kernel that does not know
      // it posts the text, which always carries the same question.
      message: {
        text: payload.text,
        ...(payload.mentions ? { mentions: payload.mentions } : {}),
        ...(payload.card ? { card: payload.card } : {}),
      } as { text: string },
      asOwnIdentity: true,
    });
    return outcome.outcome === 'delivered'
      ? { ok: true, ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}) }
      : { ok: false, code: outcome.code, message: outcome.message };
  }

  const service = engine.deps.kernel.targetedSend();
  if (!service) return { ok: false, code: 'no_service', message: "kernel service 'targetedSend' is not available" };
  const principalId = row.targetPrincipal ?? '';
  const participant = await store.getParticipant(q, f.id, principalId);
  const result = await service.sendToPrincipal({
    channelType: f.channelType,
    principal: directPrincipal(participant, principalId),
    message: { text: payload.text },
    asAgentSlug: f.facilitatorAgent,
  });
  const delivery = result.deliveries[0];
  if (!delivery) {
    const diagnostic = result.diagnostics[0];
    return { ok: false, code: diagnostic?.code ?? 'no_delivery', message: diagnostic?.message ?? 'the kernel reported no delivery' };
  }
  return delivery.outcome.outcome === 'delivered'
    ? { ok: true, ...(delivery.outcome.messageId !== undefined ? { messageId: delivery.outcome.messageId } : {}) }
    : { ok: false, code: delivery.outcome.code, message: delivery.outcome.message };
}

async function stampLink(q: Queryable, payload: StoredPayload, messageId: string | undefined): Promise<void> {
  if (!payload.link || messageId === undefined) return;
  if (payload.link.kind === 'ack') await update(q, 'facilitation_acks', { id: payload.link.id }, { promptMessageId: messageId });
  else await update(q, 'facilitation_proposals', { id: payload.link.id }, { announceMessageId: messageId });
}

/** Deliver every pending row of one facilitation, oldest first. */
export async function dispatchOutbox(engine: EngineCore, client: PoolClientLike, facilitationId: string): Promise<void> {
  const pending = await rows<OutboxRow>(
    client,
    `SELECT * FROM facilitation_outbox
      WHERE facilitation_id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
      ORDER BY created_at, id`,
    [facilitationId, engine.now()],
  );
  for (const row of pending) {
    const f = await store.getFacilitation(client, facilitationId);
    if (!f) return;
    await deliver(engine, client, f, row);
  }
}

const drop = (q: Queryable, row: OutboxRow, reason: string): Promise<unknown> =>
  update(q, 'facilitation_outbox', { id: row.id }, { status: 'dropped', dropReason: reason });

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

  // Recorded before the call, in its own committed statement.
  await update(client, 'facilitation_outbox', { id: row.id }, { status: 'sending', attempts: row.attempts + 1, owner: engine.instanceId });
  await engine.deps.hooks?.beforeChannelCall?.(row);

  let result: SendResult;
  try {
    result = await send(engine, client, f, row);
  } catch (err) {
    result = { ok: false, code: 'exception', message: err instanceof Error ? err.message : String(err) };
  }
  await engine.deps.hooks?.afterChannelCall?.(row);

  if (result.ok) {
    await update(client, 'facilitation_outbox', { id: row.id }, { status: 'sent', sentAt: engine.now(), channelMessageId: result.messageId ?? null });
    await client.query('UPDATE facilitations SET messages_sent = messages_sent + 1 WHERE id = $1', [f.id]);
    await stampLink(client, row.payload as StoredPayload, result.messageId);
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
  if (row.deliveryClass === 'droppable') {
    await update(client, 'facilitation_outbox', { id: row.id }, { status: 'dropped', lastError: error, dropReason: 'send failed; droppable messages are not retried' });
    engine.log(`facilitation ${f.id}: ${row.purpose} not delivered (${error}); not retried`);
    return;
  }
  await update(client, 'facilitation_outbox', { id: row.id }, { status: 'pending', lastError: error });
  engine.log(`facilitation ${f.id}: essential ${row.purpose} not delivered (${error}); will retry`);
}
