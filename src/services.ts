// Structural shims for the kernel services this plugin consumes (#330 A/B1).
// plugin-api ships typed shapes only for targetedSend; the others are
// kernel-published and mirrored here structurally — the service registry
// hands back `unknown`, these interfaces are the plugin's contract with it.

export type { TargetedSendService } from '@omadia/plugin-api';
export { TARGETED_SEND_SERVICE_NAME } from '@omadia/plugin-api';

export const EPHEMERAL_RUNS_SERVICE_NAME = 'conductorEphemeralRuns';
export const CONVERSATION_EVENTS_SERVICE_NAME = 'conversationEvents';

/** Kernel `conductorEphemeralRuns` (#330 Workstream A). */
export interface EphemeralRunsService {
  createEphemeralRun(input: {
    agentId: string;
    patternId: string;
    slots: Record<string, Record<string, string>>;
    payload?: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<{ runId: string; workflowId: string; workflowSlug: string; expiresAt: string }>;
}

/** Kernel `conversationEvents` (#330 B1) — subscribe-only by design:
 *  emitting stays a channel-adapter privilege (bot_added spoof protection). */
export interface ConversationEventsService {
  subscribe(fn: (event: ConversationMembershipEventShape) => void): () => void;
}

export interface ConversationMembershipEventShape {
  kind: 'bot_added' | 'members_added' | 'members_removed';
  channelId: string;
  channelType?: string;
  conversationId: string;
  conversationType?: 'direct' | 'group';
  members: readonly { kind: string; id: string; displayName?: string }[];
  addedBy?: { kind: string; id: string; displayName?: string };
  occurredAt: string;
}

// NB: conversationRosters is deliberately NOT consumed in C1 — declaring an
// unused service would be an unused grant (deny-by-default = least
// privilege). The roster-driven participant addressing lands with C2.
