// bot_added handling (#330 C1): the Facilitator's explicit entry into a
// conversation. No posting from here — an agent plugin cannot proactively
// post into a group; the visible opening handshake is the reply to the
// initiator's start turn (facilitation_start). This handler only records the
// pending invitation so start/status can reference WHO invited and WHERE.

import type { FacilitationStateStore } from './stateStore.js';
import type { ConversationMembershipEventShape } from './services.js';

export function createMembershipHandler(deps: {
  store: FacilitationStateStore;
  log: (msg: string) => void;
}): (event: ConversationMembershipEventShape) => void {
  return (event) => {
    try {
      if (event.kind !== 'bot_added') return;
      const invitedBy = event.addedBy?.displayName ?? event.addedBy?.id;
      deps.store.markPending({
        conversationId: event.conversationId,
        ...(event.channelType ? { channelType: event.channelType } : {}),
        ...(invitedBy ? { invitedBy } : {}),
      });
      deps.log(
        `facilitator invited into ${event.channelType ?? '?'}/${event.conversationId}` +
          (invitedBy ? ` by ${invitedBy}` : '') +
          ' — pending until facilitation_start',
      );
    } catch (err) {
      // A membership event must never break the emitting turn's fan-out.
      deps.log(`membership event handling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
