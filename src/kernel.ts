// The kernel services the engine consumes, behind one accessor.
//
// Every service is resolved PER CALL, never cached: an optional dependency
// contributes no activation edge, so a service may be published after this
// plugin activated. A missing service is a supported state; each caller
// carries its own degradation message.
//
// The database is not among them. It is `ctx.sql`: the plugin's own schema,
// reached as the plugin's own database role (kernel #2088). The shared pool
// (`graphPool`) is never asked for; the kernel refuses it to an archetype
// plugin.

import {
  AGENT_TURN_V2_SERVICE_NAME,
  CHANNEL_READINESS_SERVICE_NAME,
  CONVERSATION_MESSAGES_SERVICE_NAME,
  CONVERSATION_MESSAGES_V2_SERVICE_NAME,
  CONVERSATION_SEND_V2_SERVICE_NAME,
  EXECUTION_AUTHORIZATION_SERVICE_NAME,
  EXECUTION_GRANTS_SERVICE_NAME,
  FACILITATION_FOLLOWUP_SERVICE_NAME,
  SESSION_CAPABILITIES_SERVICE_NAME,
} from '@omadia/plugin-api';
import type {
  ChannelReadinessService,
  ConversationMessagesService,
  ExecutionAuthorizationService,
  ExecutionGrantsService,
  FacilitationFollowupService,
  ProcessConversationMessagesService,
  ScopedAgentTurnService,
  ScopedConversationSendService,
  SessionCapabilitiesService,
} from '@omadia/plugin-api';

import { dbOf } from './db/pool.js';
import type { Db, KernelSql } from './db/pool.js';

export const CONVERSATION_EVENTS_SERVICE_NAME = 'conversationEvents';
export const CONVERSATION_ROSTERS_SERVICE_NAME = 'conversationRosters';

export interface ChannelUserRef {
  kind: string;
  id: string;
  displayName?: string;
  email?: string;
  principalId?: string;
  /** Set by channels that can tell: this member is a bot, not a person. */
  isBot?: boolean;
}

/**
 * The key a person has in the engine: the canonical principal.
 *
 * The kernel fills `record.author.principalId` as `user:<channel user id,
 * lower-cased>` and states the caller of a tool call in the same form. Roster
 * and membership events carry the channel-native id; the same rule turns it
 * into the same key, so one person is one participant whichever way the
 * kernel named them.
 */
export function principalKey(ref: { id: string; principalId?: string | undefined }): string {
  if (ref.principalId) return ref.principalId;
  return ref.id.includes(':') ? ref.id : `user:${ref.id.toLowerCase()}`;
}

/** Kernel `conversationEvents` (#330 B1): membership changes. Subscribe-only;
 *  emitting stays a channel-adapter privilege. */
export interface ConversationMembershipEvent {
  kind: 'bot_added' | 'members_added' | 'members_removed' | 'bot_present';
  channelId: string;
  channelType?: string;
  conversationId: string;
  conversationType?: 'direct' | 'group';
  members: readonly ChannelUserRef[];
  addedBy?: ChannelUserRef;
  occurredAt: string;
}

export interface ConversationEventsService {
  subscribe(fn: (event: ConversationMembershipEvent) => void): () => void;
}

export interface RosterParticipant {
  userRef: ChannelUserRef;
  isBot?: boolean;
  externalId?: string | null;
  userPrincipalName?: string | null;
}

/** How much of a conversation's membership the channel could read (#2091). */
export type RosterStatus = 'complete' | 'partial' | 'unknown';

export interface ConversationRoster {
  conversationType: 'direct' | 'group';
  participants: readonly RosterParticipant[];
  /** The channel could only list a lower bound of the members. Kept for a
   *  kernel that predates `status`; read through {@link rosterStatusOf}. */
  partial: boolean;
  /** `complete`, `partial` or `unknown` (#2091). Absent on an older kernel. */
  status?: RosterStatus;
  /** When the platform answered (ISO 8601); a cached answer keeps its time. */
  readAt?: string;
}

/** The status of a roster: the kernel's statement, else derived from
 *  `partial`. No answer at all is `unknown`. */
export function rosterStatusOf(roster: Pick<ConversationRoster, 'status' | 'partial'> | undefined): RosterStatus {
  if (!roster) return 'unknown';
  return roster.status ?? (roster.partial ? 'partial' : 'complete');
}

/** Kernel `conversationRosters` (#330 B1): who is in a conversation. */
export interface ConversationRostersService {
  /**
   * With `agentSlug` the kernel asks the channel as that agent's own bot (an
   * agent without an identity yields `undefined`). Without it the instance's
   * default bot is asked, which is often not a member of a conversation a
   * facilitator moderates. A kernel that predates the option ignores it.
   * `fresh: true` (#2091) bypasses the channel's cache.
   */
  getRoster(channelType: string, conversationId: string, opts?: { agentSlug?: string; fresh?: boolean }): Promise<ConversationRoster | undefined>;
}

export interface Kernel {
  /** The engine's own database (`ctx.sql`), absent without the operator's grant. */
  db(): Db | undefined;
  /** Execution scopes, reservations and the kill switch (kernel #2090). */
  execution(): ExecutionAuthorizationService | undefined;
  /** Kernel-issued grants for mail and calendar (kernel #2078). */
  grants(): ExecutionGrantsService | undefined;
  /** `conversationMessages@2`: subscriptions and reads bound to a process. */
  messages(): ProcessConversationMessagesService | undefined;
  /** `agentTurn@2`: a model turn drawn from an execution scope. */
  agentTurn(): ScopedAgentTurnService | undefined;
  /** `conversationSend@2`: posts, direct messages, card updates and the
   *  readiness check of one conversation, each drawn from a scope. */
  conversationSend(): ScopedConversationSendService | undefined;
  /** The first major of the message service. Only asked to give back the
   *  subscription of a facilitation that began before execution scopes. */
  legacyMessages(): Pick<ConversationMessagesService, 'unsubscribe'> | undefined;
  /** Only its consent repair is used; the check itself is a scoped action. */
  readiness(): ChannelReadinessService | undefined;
  sessionCapabilities(): SessionCapabilitiesService | undefined;
  conversationEvents(): ConversationEventsService | undefined;
  rosters(): ConversationRostersService | undefined;
  followup(): FacilitationFollowupService | undefined;
}

/** The names behind {@link Kernel}, in the order the manifest declares them. */
export const KERNEL_SERVICE_NAMES = [
  EXECUTION_AUTHORIZATION_SERVICE_NAME,
  EXECUTION_GRANTS_SERVICE_NAME,
  CONVERSATION_MESSAGES_V2_SERVICE_NAME,
  AGENT_TURN_V2_SERVICE_NAME,
  CONVERSATION_SEND_V2_SERVICE_NAME,
  CONVERSATION_MESSAGES_SERVICE_NAME,
  CHANNEL_READINESS_SERVICE_NAME,
  SESSION_CAPABILITIES_SERVICE_NAME,
  CONVERSATION_EVENTS_SERVICE_NAME,
  CONVERSATION_ROSTERS_SERVICE_NAME,
  FACILITATION_FOLLOWUP_SERVICE_NAME,
] as const;

export interface ServiceLookup {
  get<T>(name: string): T | undefined;
  getOptional?<T>(name: string): T | undefined;
}

/** Resolve one optional service. A kernel without the grant for a name throws
 *  from `get`; to the engine that is the same as "not there". */
export function resolveService<T>(services: ServiceLookup, name: string): T | undefined {
  try {
    return typeof services.getOptional === 'function' ? services.getOptional<T>(name) : services.get<T>(name);
  } catch {
    return undefined;
  }
}

/**
 * The kernel as the engine uses it. Services are looked up on every call.
 * The database is not a service: it is the plugin's own accessor, which the
 * kernel builds before activation and which does not change afterwards.
 */
export function createKernel(services: ServiceLookup, sql?: KernelSql): Kernel {
  const db = dbOf(sql);
  const lookup = <T>(name: string) => (): T | undefined => resolveService<T>(services, name);
  return {
    db: () => db,
    execution: lookup<ExecutionAuthorizationService>(EXECUTION_AUTHORIZATION_SERVICE_NAME),
    grants: lookup<ExecutionGrantsService>(EXECUTION_GRANTS_SERVICE_NAME),
    messages: lookup<ProcessConversationMessagesService>(CONVERSATION_MESSAGES_V2_SERVICE_NAME),
    agentTurn: lookup<ScopedAgentTurnService>(AGENT_TURN_V2_SERVICE_NAME),
    conversationSend: lookup<ScopedConversationSendService>(CONVERSATION_SEND_V2_SERVICE_NAME),
    legacyMessages: lookup<Pick<ConversationMessagesService, 'unsubscribe'>>(CONVERSATION_MESSAGES_SERVICE_NAME),
    readiness: lookup<ChannelReadinessService>(CHANNEL_READINESS_SERVICE_NAME),
    sessionCapabilities: lookup<SessionCapabilitiesService>(SESSION_CAPABILITIES_SERVICE_NAME),
    conversationEvents: lookup<ConversationEventsService>(CONVERSATION_EVENTS_SERVICE_NAME),
    rosters: lookup<ConversationRostersService>(CONVERSATION_ROSTERS_SERVICE_NAME),
    followup: lookup<FacilitationFollowupService>(FACILITATION_FOLLOWUP_SERVICE_NAME),
  };
}

/** The kernel services a facilitation cannot run without, as an operator
 *  reads them. */
const REQUIRED_SERVICES: readonly (readonly [keyof Kernel, string])[] = [
  ['execution', EXECUTION_AUTHORIZATION_SERVICE_NAME],
  ['agentTurn', AGENT_TURN_V2_SERVICE_NAME],
  ['messages', CONVERSATION_MESSAGES_V2_SERVICE_NAME],
  ['conversationSend', CONVERSATION_SEND_V2_SERVICE_NAME],
];

/**
 * Which of the services a facilitation needs the kernel does not offer.
 * Empty: everything is there. A facilitation needs all of them: without
 * execution scopes nothing it does would be authorized, so nothing starts
 * rather than something that half works.
 */
export function missingServices(kernel: Kernel): string[] {
  return REQUIRED_SERVICES.filter(([accessor]) => kernel[accessor]() === undefined).map(([, name]) => name);
}
