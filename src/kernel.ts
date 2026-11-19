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
  AGENT_TURN_SERVICE_NAME,
  CHANNEL_READINESS_SERVICE_NAME,
  CONVERSATION_MESSAGES_SERVICE_NAME,
  CONVERSATION_SEND_SERVICE_NAME,
  FACILITATION_FOLLOWUP_SERVICE_NAME,
  SESSION_CAPABILITIES_SERVICE_NAME,
  TARGETED_SEND_SERVICE_NAME,
} from '@omadia/plugin-api';
import type {
  AgentTurnService,
  ChannelReadinessService,
  ConversationMessagesService,
  ConversationSendService,
  FacilitationFollowupService,
  SessionCapabilitiesService,
  TargetedSendService,
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

export interface ConversationRoster {
  conversationType: 'direct' | 'group';
  participants: readonly RosterParticipant[];
  /** The channel could only list a lower bound of the members. */
  partial: boolean;
}

/** Kernel `conversationRosters` (#330 B1): who is in a conversation. */
export interface ConversationRostersService {
  /**
   * With `agentSlug` the kernel asks the channel as that agent's own bot (an
   * agent without an identity yields `undefined`). Without it the instance's
   * default bot is asked, which is often not a member of a conversation a
   * facilitator moderates. A kernel that predates the option ignores it.
   */
  getRoster(channelType: string, conversationId: string, opts?: { agentSlug?: string }): Promise<ConversationRoster | undefined>;
}

export interface Kernel {
  /** The engine's own database (`ctx.sql`), absent without the operator's grant. */
  db(): Db | undefined;
  messages(): ConversationMessagesService | undefined;
  agentTurn(): AgentTurnService | undefined;
  conversationSend(): ConversationSendService | undefined;
  targetedSend(): TargetedSendService | undefined;
  readiness(): ChannelReadinessService | undefined;
  sessionCapabilities(): SessionCapabilitiesService | undefined;
  conversationEvents(): ConversationEventsService | undefined;
  rosters(): ConversationRostersService | undefined;
  followup(): FacilitationFollowupService | undefined;
}

/** The names behind {@link Kernel}, in the order the manifest declares them. */
export const KERNEL_SERVICE_NAMES = [
  CONVERSATION_MESSAGES_SERVICE_NAME,
  AGENT_TURN_SERVICE_NAME,
  CONVERSATION_SEND_SERVICE_NAME,
  TARGETED_SEND_SERVICE_NAME,
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
    messages: lookup<ConversationMessagesService>(CONVERSATION_MESSAGES_SERVICE_NAME),
    agentTurn: lookup<AgentTurnService>(AGENT_TURN_SERVICE_NAME),
    conversationSend: lookup<ConversationSendService>(CONVERSATION_SEND_SERVICE_NAME),
    targetedSend: lookup<TargetedSendService>(TARGETED_SEND_SERVICE_NAME),
    readiness: lookup<ChannelReadinessService>(CHANNEL_READINESS_SERVICE_NAME),
    sessionCapabilities: lookup<SessionCapabilitiesService>(SESSION_CAPABILITIES_SERVICE_NAME),
    conversationEvents: lookup<ConversationEventsService>(CONVERSATION_EVENTS_SERVICE_NAME),
    rosters: lookup<ConversationRostersService>(CONVERSATION_ROSTERS_SERVICE_NAME),
    followup: lookup<FacilitationFollowupService>(FACILITATION_FOLLOWUP_SERVICE_NAME),
  };
}
