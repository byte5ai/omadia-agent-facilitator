/**
 * omadia Facilitator / Convener — agent plugin (#330 Workstream C, Slice C2b).
 *
 * ONE Convener identity with modes, never a bot per function. Zero-touch
 * setup: at activate the plugin provisions its top-level Agent through the
 * kernel's agentProvisioning service (persona = the bundled playbook,
 * create-only), a group invite auto-binds the conversation through the
 * invite-guarded conversationBindings service, and facilitation_start
 * assigns the inviter to an auto-provisioned per-conversation initiator
 * role — all of it disposed of again with the ephemeral workflow.
 *
 * Every kernel service is optional (optional_requires) and resolved LAZILY
 * at first use: on a kernel that predates #330 A/B1/C2a the plugin activates
 * and each path degrades with an honest message (C1 behavior).
 */

import type { PluginContext } from '@omadia/plugin-api';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { parseConfig } from './config.js';
import { createMembershipHandler } from './membership.js';
import {
  AGENT_PROVISIONING_SERVICE_NAME,
  CONVERSATION_BINDINGS_SERVICE_NAME,
  CONVERSATION_EVENTS_SERVICE_NAME,
  CONVERSATION_ROSTERS_SERVICE_NAME,
  EPHEMERAL_RUNS_SERVICE_NAME,
  ROLE_ASSIGNMENTS_SERVICE_NAME,
  TARGETED_SEND_SERVICE_NAME,
} from './services.js';
import type {
  AgentProvisioningService,
  ConversationBindingsService,
  ConversationEventsService,
  ConversationRostersService,
  EphemeralRunsService,
  RoleAssignmentsService,
  TargetedSendService,
} from './services.js';
import { loadPlaybookBody, runAutoSetup } from './setup.js';
import { FacilitationStateStore } from './stateStore.js';
import { buildFacilitationToolkit } from './toolkit.js';

export const AGENT_ID = '@omadia/agent-facilitator' as const;

export interface FacilitatorHandle {
  readonly toolkit: { tools: LocalSubAgentTool[] };
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<FacilitatorHandle> {
  ctx.log('activating facilitator agent');

  const config = parseConfig(
    <T,>(key: string) => ctx.config.get<T>(key),
    (msg) => ctx.log(msg),
  );

  // Lazy resolver for optional_requires services: looked up per call, never
  // cached — a service published after this plugin activated is picked up
  // without a reinstall. Prefers getOptional where the kernel offers it.
  const resolve = <T,>(name: string): T | undefined => {
    const services = ctx.services as { get<S>(n: string): S | undefined; getOptional?<S>(n: string): S | undefined };
    return typeof services.getOptional === 'function' ? services.getOptional<T>(name) : services.get<T>(name);
  };

  for (const name of [
    EPHEMERAL_RUNS_SERVICE_NAME,
    TARGETED_SEND_SERVICE_NAME,
    CONVERSATION_EVENTS_SERVICE_NAME,
    AGENT_PROVISIONING_SERVICE_NAME,
    CONVERSATION_BINDINGS_SERVICE_NAME,
    ROLE_ASSIGNMENTS_SERVICE_NAME,
    CONVERSATION_ROSTERS_SERVICE_NAME,
  ]) {
    if (!resolve(name)) {
      ctx.log(`kernel service '${name}' not published (yet) — the matching feature degrades until it appears (kernel < #330?)`);
    }
  }

  // Zero-touch step 1: make sure the top-level agent exists (idempotent,
  // never mutates an existing one). Activation survives any failure here.
  await runAutoSetup({
    agentProvisioning: resolve<AgentProvisioningService>(AGENT_PROVISIONING_SERVICE_NAME),
    config,
    pluginId: AGENT_ID,
    ...(loadPlaybookBody() !== undefined ? { playbookBody: loadPlaybookBody()! } : {}),
    log: (msg) => ctx.log(msg),
  });

  const store = new FacilitationStateStore();

  // Subscription is the one inherently eager consumer: without the service at
  // activate time there is nothing to subscribe to. Logged above; a later
  // re-activate (plugin upgrade/toggle) picks it up.
  let unsubscribe: (() => void) | undefined;
  const conversationEvents = resolve<ConversationEventsService>(CONVERSATION_EVENTS_SERVICE_NAME);
  if (conversationEvents && typeof conversationEvents.subscribe === 'function') {
    unsubscribe = conversationEvents.subscribe(
      createMembershipHandler({
        store,
        config,
        getConversationBindings: () => resolve<ConversationBindingsService>(CONVERSATION_BINDINGS_SERVICE_NAME),
        log: (msg) => ctx.log(msg),
      }),
    );
    ctx.log('subscribed to conversation membership events (bot_added → pending facilitation + auto-bind)');
  }

  const tools = buildFacilitationToolkit({
    agentId: AGENT_ID,
    config,
    store,
    getEphemeralRuns: () => resolve<EphemeralRunsService>(EPHEMERAL_RUNS_SERVICE_NAME),
    getTargetedSend: () => resolve<TargetedSendService>(TARGETED_SEND_SERVICE_NAME),
    getRoleAssignments: () => resolve<RoleAssignmentsService>(ROLE_ASSIGNMENTS_SERVICE_NAME),
    getConversationBindings: () => resolve<ConversationBindingsService>(CONVERSATION_BINDINGS_SERVICE_NAME),
    getConversationRosters: () => resolve<ConversationRostersService>(CONVERSATION_ROSTERS_SERVICE_NAME),
    log: (msg) => ctx.log(msg),
  });

  return {
    toolkit: { tools },
    async close() {
      ctx.log('deactivating facilitator agent');
      unsubscribe?.();
    },
  };
}

export default { AGENT_ID, activate };
