// bot_added handling (#330 C2b): the Facilitator's explicit entry into a
// conversation — now with zero-touch auto-bind. The kernel's
// conversationBindings service only ever binds conversations IT observed the
// group invite for, refuses foreign-bound conversations, and disposes of the
// binding with the facilitation (or the pending expiry). No posting from
// here — the visible opening handshake stays the reply to the initiator's
// start turn (facilitation_start).

import type { FacilitatorConfig } from './config.js';
import type { ConversationBindingsService, ConversationMembershipEventShape } from './services.js';
import type { FacilitationStateStore } from './stateStore.js';

export function createMembershipHandler(deps: {
  store: FacilitationStateStore;
  config: FacilitatorConfig;
  getConversationBindings: () => ConversationBindingsService | undefined;
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
        ...(event.addedBy
          ? { invitedByRef: { id: event.addedBy.id, ...(event.addedBy.displayName ? { displayName: event.addedBy.displayName } : {}) } }
          : {}),
      });
      deps.log(
        `facilitator invited into ${event.channelType ?? '?'}/${event.conversationId}` +
          (invitedBy ? ` by ${invitedBy}` : '') +
          ' — pending until facilitation_start',
      );

      // Zero-touch auto-bind (async, isolated): group invites only — the
      // kernel guard re-checks that anyway, this just avoids noise.
      if (event.conversationType !== 'group' || !event.channelType) return;
      const bindings = deps.getConversationBindings();
      if (!bindings) {
        deps.log("kernel service 'conversationBindings' not published — bind the conversation manually (kernel < #330 C2a?)");
        return;
      }
      const channelType = event.channelType;
      void bindings
        .bind({ agentSlug: deps.config.facilitatorAgentSlug, channelType, conversationId: event.conversationId })
        .then((result) => {
          if (result.bound) {
            deps.log(
              `auto-bound ${channelType}/${event.conversationId} → '${deps.config.facilitatorAgentSlug}'` +
                (result.preexistingOperatorBinding ? ' (pre-existing operator binding, left outside the ephemeral lifecycle)' : ''),
            );
          } else {
            deps.log(`auto-bind of ${channelType}/${event.conversationId} refused: ${result.reason ?? 'unknown'}`);
          }
        })
        .catch((err: unknown) => {
          deps.log(`auto-bind failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    } catch (err) {
      // A membership event must never break the emitting turn's fan-out.
      deps.log(`membership event handling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
