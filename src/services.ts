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

export const AGENT_PROVISIONING_SERVICE_NAME = 'agentProvisioning';
export const CONVERSATION_BINDINGS_SERVICE_NAME = 'conversationBindings';
export const ROLE_ASSIGNMENTS_SERVICE_NAME = 'conductorRoleAssignments';
export const CONVERSATION_ROSTERS_SERVICE_NAME = 'conversationRosters';

/** Kernel `agentProvisioning` (#330 C2a). */
export interface AgentProvisioningService {
  ensureAgent(input: {
    slug: string;
    name: string;
    description?: string;
    pluginId: string;
    /** Create-only; slug MUST be namespaced under `<agent slug>-`. */
    personaSkill?: { slug: string; name: string; body: string };
  }): Promise<{ created: boolean; agentSlug: string }>;
}

export interface ObservedInviteShape {
  channelId: string;
  channelType: string;
  conversationId: string;
  addedBy?: { kind: string; id: string; displayName?: string };
  occurredAt: string;
}

/** Kernel `conversationBindings` (#330 C2a) — invite-guarded, self-disposing. */
export interface ConversationBindingsService {
  bind(input: { agentSlug: string; channelType: string; conversationId: string; pendingTtlMs?: number }): Promise<{
    bound: boolean;
    reason?: string;
    preexistingOperatorBinding?: boolean;
    invite?: ObservedInviteShape;
  }>;
  unbind(input: { agentSlug: string; channelType: string; conversationId: string }): Promise<{ unbound: boolean }>;
  attachWorkflow(input: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
    workflowId: string;
    roleKey?: string;
    expiresAt: Date;
  }): Promise<{ attached: boolean }>;
  observedInvite(channelType: string, conversationId: string): ObservedInviteShape | undefined;
}

/** Kernel `conductorRoleAssignments` (#330 C2a) — 'facilitation-'-scoped, audited. */
export interface RoleAssignmentsService {
  ensureRole(input: { roleKey: string; label: string; description?: string }): Promise<void>;
  addHolder(input: { roleKey: string; holderId: string; actor: string }): Promise<void>;
  removeHolder(input: { roleKey: string; holderId: string; actor: string }): Promise<void>;
  holders(roleKey: string): Promise<string[]>;
}

/** Kernel `conversationRosters` (#330 B1) — used to resolve the inviter's
 *  email (role holders are email-keyed; bot_added carries only the AAD id). */
export interface ConversationRostersService {
  getRoster(
    channelType: string,
    conversationId: string,
  ): Promise<
    | {
        conversationType: 'direct' | 'group';
        participants: readonly {
          userRef: { kind: string; id: string; displayName?: string; email?: string };
          isBot?: boolean;
          externalId?: string | null;
          userPrincipalName?: string | null;
        }[];
        partial: boolean;
      }
    | undefined
  >;
}
