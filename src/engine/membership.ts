// Membership changes (spec 5.5): a person who joins becomes a participant and
// is welcomed; a person who leaves keeps their contributions and is no longer
// "missing". Both are announced. An initiator who leaves loses the role.

import * as store from '../db/store.js';
import { principalKey } from '../kernel.js';
import type { ConversationMembershipEvent } from '../kernel.js';
import { texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';

export type MembershipHook = (w: Work) => Promise<void>;
const hooks: MembershipHook[] = [];

/** Called after a membership change, in the same unit of work ("every
 *  participant" may have just become true). */
export function onMembershipChange(hook: MembershipHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

/** Channels mark bots by a flag or by their user namespace ('teams-bot',
 *  Teams ids starting with '28:'). */
export const isBot = (member: { kind: string; id: string; isBot?: boolean }): boolean =>
  member.isBot === true || /bot/i.test(member.kind) || member.id.startsWith('28:');

async function applyMembership(w: Work, event: ConversationMembershipEvent): Promise<void> {
  const t = texts(w.f.language);
  const key = `${event.kind}:${event.occurredAt}`;
  let changed = false;
  for (const raw of event.members) {
    // A bot is never a participant: nobody waits for it to contribute.
    if (isBot(raw)) continue;
    const member = { ...raw, id: principalKey(raw) };
    const existing = await store.getParticipant(w.tx, w.f.id, member.id);
    if (event.kind === 'members_added') {
      if (existing?.status === 'active') continue;
      const name = member.displayName ?? existing?.displayName ?? member.id;
      if (existing) {
        await store.patchParticipant(w.tx, w.f.id, member.id, { status: 'active', leftAt: null, changedAt: w.now, changedByEvent: key });
      } else {
        await store.addParticipant(w.tx, {
          facilitationId: w.f.id,
          principalId: member.id,
          canonicalPrincipal: member.id,
          displayName: name,
          email: member.email ?? null,
          source: 'joined',
          joinedAt: w.now,
          changedAt: w.now,
          changedByEvent: key,
        });
      }
      changed = true;
      await w.event('participant_joined', member.id, { by: 'membership_event' });
      w.post({ purpose: 'joined', key: `${key}:${member.id}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.joined(name, w.f.goal), mentions: [{ user: member.id, text: name }] });
      continue;
    }
    if (!existing || existing.status === 'left') continue;
    await store.patchParticipant(w.tx, w.f.id, member.id, { status: 'left', leftAt: w.now, changedAt: w.now, changedByEvent: key });
    changed = true;
    await w.event('participant_left', member.id, {});
    w.post({ purpose: 'left', key: `${key}:${member.id}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.left(existing.displayName) });
    const isInitiator = w.f.initiatorParticipant === member.id || existing.canonicalPrincipal === w.f.initiatorPrincipal;
    if (isInitiator) {
      await w.event('initiator_left', member.id, {});
      w.post({ purpose: 'initiator_left', key, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.initiatorLeft(existing.displayName) });
    }
  }
  if (!changed) return;
  w.bump();
  for (const hook of hooks) await hook(w);
}

export async function processMembership(engine: EngineCore, event: ConversationMembershipEvent): Promise<void> {
  if (event.kind !== 'members_added' && event.kind !== 'members_removed') return;
  const pool = engine.pool();
  const candidates = (await store.listSubscribed(pool)).filter(
    (f) => f.conversationId === event.conversationId && (event.channelType === undefined || event.channelType === f.channelType),
  );
  for (const f of candidates) {
    if (f.phase !== 'configuring' && f.phase !== 'active') continue;
    await engine.work(f.id, (w) => applyMembership(w, event));
  }
}
