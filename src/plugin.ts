/**
 * omadia Facilitator / Convener — agent plugin (#330 Workstream C, Slice C1).
 *
 * ONE Convener identity with modes, never a bot per function. This plugin
 * contributes the facilitation_* toolkit (start/status/stop/report) and the
 * bot_added subscription; the live moderation itself runs through the
 * top-level Agent the operator binds to the group conversation (see README —
 * the playbook skill drives the sub-agent, the Agent's own instructions carry
 * the moderation persona).
 *
 * Every kernel service is optional (optional_requires) and resolved LAZILY at
 * first use (plugin-api guidance for optional deps — no activation edge, no
 * cached miss): on a kernel that predates #330 A/B1 the plugin activates and
 * each tool answers with an honest degradation message instead of failing.
 */

import type { PluginContext } from '@omadia/plugin-api';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { parseConfig } from './config.js';
import { createMembershipHandler } from './membership.js';
import {
  CONVERSATION_EVENTS_SERVICE_NAME,
  EPHEMERAL_RUNS_SERVICE_NAME,
  TARGETED_SEND_SERVICE_NAME,
} from './services.js';
import type { ConversationEventsService, EphemeralRunsService, TargetedSendService } from './services.js';
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

  for (const name of [EPHEMERAL_RUNS_SERVICE_NAME, TARGETED_SEND_SERVICE_NAME, CONVERSATION_EVENTS_SERVICE_NAME]) {
    if (!resolve(name)) {
      ctx.log(`kernel service '${name}' not published (yet) — the matching feature degrades until it appears (kernel < #330?)`);
    }
  }

  const store = new FacilitationStateStore();

  // Subscription is the one inherently eager consumer: without the service at
  // activate time there is nothing to subscribe to. Logged above; a later
  // re-activate (plugin upgrade/toggle) picks it up.
  let unsubscribe: (() => void) | undefined;
  const conversationEvents = resolve<ConversationEventsService>(CONVERSATION_EVENTS_SERVICE_NAME);
  if (conversationEvents && typeof conversationEvents.subscribe === 'function') {
    unsubscribe = conversationEvents.subscribe(
      createMembershipHandler({ store, log: (msg) => ctx.log(msg) }),
    );
    ctx.log('subscribed to conversation membership events (bot_added → pending facilitation)');
  }

  const tools = buildFacilitationToolkit({
    agentId: AGENT_ID,
    config,
    store,
    getEphemeralRuns: () => resolve<EphemeralRunsService>(EPHEMERAL_RUNS_SERVICE_NAME),
    getTargetedSend: () => resolve<TargetedSendService>(TARGETED_SEND_SERVICE_NAME),
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
