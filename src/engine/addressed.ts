// Who answers a message that addresses the facilitator during a follow-up
// (kernel #2089, `onAddressedMessage`).
//
// In follow-up a facilitation hears only what is addressed to the
// facilitator, and a mention also starts the facilitator's ordinary turn.
// The kernel asks the engine first. The engine takes what it answers without
// a model, "done 2" of an owner and "status" of a participant, and declines
// everything else, which the ordinary turn then answers.
//
// The kernel waits a bounded time for the decision, so the decision is read
// from the state and nothing else; the work (closing the item, the line in
// the group) happens after the answer, through the same inbound path as any
// other message. The stored event of the same message is deduped there by
// its id; where the kernel knows no event yet, the record is built from the
// question and the event, should it arrive later, is left alone.

import { randomUUID } from 'node:crypto';

import type { AddressedMessageRequest, ProcessConversationMessageRecord } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { Facilitation } from '../model.js';
import { readDone } from './actionItems.js';
import type { EngineCore } from './core.js';
import { normaliseCommand, processRecord } from './inbound.js';

const STATUS = /^(status|stand|zwischenstand)$/u;

export type AddressedDecision = { handled: false } | { handled: true; facilitationId: string; work: () => Promise<void> };

/** The follow-up this message is for, decided from the state alone. */
async function meant(engine: EngineCore, request: AddressedMessageRequest): Promise<Facilitation | undefined> {
  const command = normaliseCommand(request.text);
  const status = STATUS.test(command);
  const done = status ? undefined : readDone(command);
  if (!status && !done) return undefined;
  const principal = `user:${request.principalId.toLowerCase()}`;
  const db = engine.db();
  const following: Facilitation[] = [];
  for (const processId of request.processIds) {
    const f = await store.getFacilitation(db, processId);
    if (f && f.facilitatorAgent === request.agentSlug && f.channelType === request.channelType && f.conversationId === request.conversationId && f.followupState === 'active') following.push(f);
  }
  // The most recent one first: that is the one the group has in mind.
  following.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  let named: Facilitation | undefined;
  for (const f of following) {
    if ((await store.getParticipant(db, f.id, principal))?.status !== 'active') continue;
    if (status) return f;
    const open = (await store.listActionItems(db, f.id)).filter((a) => a.status === 'confirmed');
    const candidates = done?.number !== undefined ? open.filter((a) => a.number === done.number) : open.filter((a) => a.ownerPrincipal === principal);
    // An item of their own: this follow-up. An item with that number that is
    // somebody else's is answered too ("not yours"), unless another follow-up
    // has one of theirs under the number.
    if (candidates.some((a) => a.ownerPrincipal === principal)) return f;
    if (candidates.length > 0) named ??= f;
  }
  return named;
}

/** The record the inbound path works on: the kernel's stored event when
 *  there is one, otherwise one built from the question. */
async function recordFor(engine: EngineCore, f: Facilitation, request: AddressedMessageRequest): Promise<{ record: ProcessConversationMessageRecord; stored: boolean }> {
  const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, processId: f.id };
  const messages = engine.deps.kernel.messages();
  try {
    const stored =
      (request.eventId !== undefined ? await messages?.getEventById(scope, request.eventId) : undefined) ?? (request.messageId !== undefined ? await messages?.getEvent(scope, request.messageId) : undefined);
    if (stored && stored.kind !== 'deleted') return { record: { ...stored, processId: f.id }, stored: true };
  } catch (err) {
    engine.log(`facilitation ${f.id}: the stored event of an addressed message could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const at = engine.now().toISOString();
  const id = request.messageId ?? randomUUID();
  return {
    stored: false,
    record: {
      eventId: `addressed:${id}`,
      processId: f.id,
      channelType: f.channelType,
      conversationId: f.conversationId,
      messageId: request.messageId ?? `addressed:${id}`,
      revision: 0,
      kind: 'created',
      // As the kernel states an author: the platform id, and the principal lower-cased.
      author: { kind: 'addressed', id: request.principalId, principalId: `user:${request.principalId.toLowerCase()}` },
      receivedByChannelKey: '',
      text: request.text,
      occurredAt: at,
      receivedAt: at,
      addressedToBot: true,
    },
  };
}

/**
 * Decide whether a follow-up takes the message. `handled: true` comes with
 * the work to do after the kernel got its answer. Never throws: a failure is
 * a decline, and the ordinary turn answers.
 */
export async function decideAddressed(engine: EngineCore, request: AddressedMessageRequest): Promise<AddressedDecision> {
  try {
    const f = await meant(engine, request);
    if (!f) return { handled: false };
    return {
      handled: true,
      facilitationId: f.id,
      work: async () => {
        const { record, stored } = await recordFor(engine, f, request);
        if (!stored && request.messageId !== undefined) engine.noteTakenByHook(request.messageId);
        await processRecord(engine, f.facilitatorAgent, record, { fromHook: true, keepCursor: !stored });
      },
    };
  } catch (err) {
    engine.log(`an addressed message to '${request.agentSlug}' could not be decided: ${err instanceof Error ? err.message : String(err)}`);
    return { handled: false };
  }
}
