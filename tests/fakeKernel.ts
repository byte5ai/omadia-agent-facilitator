// In-memory stand-in for the kernel's conductorEphemeralRuns service with the
// 0.6.0 durable-state methods (listOwnRuns / saveRunState / cancelOwnRun),
// mirroring the contract semantics: owner-guarded, running runs only, state
// stored as a JSON copy. Shared by the durability tests so a "restart" is
// just a fresh store + toolkit against the same fake kernel.

import { CONFIG_DEFAULTS } from '../src/config.js';
import type { FacilitatorConfig } from '../src/config.js';
import { FacilitationStateStore } from '../src/stateStore.js';
import { buildFacilitationToolkit } from '../src/toolkit.js';
import type { ConversationBindingsService, EphemeralRunsService, TargetedSendService } from '../src/services.js';

export const AGENT = '@omadia/agent-facilitator';

export interface FakeRun {
  runId: string;
  workflowId: string;
  workflowSlug: string;
  patternId: string | null;
  agentId: string;
  expiresAt: string;
  payload: Record<string, unknown>;
  state: Record<string, unknown> | null;
  status: 'running' | 'cancelled';
  ttlMs?: number;
}

export function fakeKernel(opts?: { maxTtlMs?: number; now?: () => Date; events?: string[] }) {
  const runs = new Map<string, FakeRun>();
  const saves: Array<{ runId: string; state: Record<string, unknown> }> = [];
  const events = opts?.events ?? [];
  const now = opts?.now ?? (() => new Date());
  let seq = 0;
  const service: Required<EphemeralRunsService> = {
    createEphemeralRun: async (input) => {
      seq += 1;
      const ttl = Math.min(input.ttlMs ?? 24 * 3600_000, opts?.maxTtlMs ?? Number.POSITIVE_INFINITY);
      const run: FakeRun = {
        runId: `run-${String(seq)}`,
        workflowId: `wf-${String(seq)}`,
        workflowSlug: `eph-facilitation-${String(seq)}`,
        patternId: input.patternId,
        agentId: input.agentId,
        expiresAt: new Date(now().getTime() + ttl).toISOString(),
        payload: { ...(input.payload ?? {}) },
        state: null,
        status: 'running',
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      };
      runs.set(run.runId, run);
      return { runId: run.runId, workflowId: run.workflowId, workflowSlug: run.workflowSlug, expiresAt: run.expiresAt };
    },
    poke: async () => ({ poked: true }),
    listOwnRuns: async ({ agentId }) =>
      [...runs.values()]
        .filter((r) => r.agentId === agentId && r.status === 'running')
        .map((r) => ({
          runId: r.runId,
          workflowId: r.workflowId,
          workflowSlug: r.workflowSlug,
          patternId: r.patternId,
          expiresAt: r.expiresAt,
          payload: { ...r.payload },
          state: r.state ? (JSON.parse(JSON.stringify(r.state)) as Record<string, unknown>) : null,
        })),
    saveRunState: async ({ agentId, runId, state }) => {
      const run = runs.get(runId);
      if (!run || run.agentId !== agentId || run.status !== 'running') return { saved: false };
      run.state = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      saves.push({ runId, state: run.state });
      events.push('save');
      return { saved: true };
    },
    cancelOwnRun: async ({ agentId, runId }) => {
      events.push('cancel');
      const run = runs.get(runId);
      if (!run || run.agentId !== agentId) return { cancelled: false, reason: 'not_found' };
      if (run.status !== 'running') return { cancelled: false, reason: 'already_ended' };
      run.status = 'cancelled';
      return { cancelled: true };
    },
  };
  return { service, runs, saves, events };
}

/** Old kernel: only createEphemeralRun (+ poke) — none of the 0.6.0 methods. */
export function oldKernel(service: EphemeralRunsService): EphemeralRunsService {
  return { createEphemeralRun: service.createEphemeralRun, ...(service.poke ? { poke: service.poke } : {}) };
}

export function buildTools(opts: {
  ephemeralRuns: EphemeralRunsService | undefined;
  store?: FacilitationStateStore;
  bindings?: ConversationBindingsService;
  events?: string[];
  config?: Partial<FacilitatorConfig>;
  now?: () => Date;
}) {
  const store = opts.store ?? new FacilitationStateStore();
  const reports: Array<{ principal: string; text: string }> = [];
  const nudges: string[] = [];
  const logs: string[] = [];
  const events = opts.events ?? [];
  const targetedSend: TargetedSendService = {
    sendToPrincipal: async (request) => {
      events.push('report');
      reports.push({ principal: request.principal, text: request.message.text });
      return {
        resolution: { kind: 'role', holders: ['a@co.com'], partial: false },
        deliveries: [{ principalId: 'a@co.com', outcome: { outcome: 'delivered' } }],
        diagnostics: [],
      };
    },
  };
  const toolkit = buildFacilitationToolkit({
    agentId: AGENT,
    config: { ...CONFIG_DEFAULTS, ...(opts.config ?? {}) },
    store,
    getEphemeralRuns: () => opts.ephemeralRuns,
    getTargetedSend: () => targetedSend,
    getRoleAssignments: () => undefined,
    getConversationBindings: () => opts.bindings,
    getConversationRosters: () => undefined,
    getConversationSend: () => ({
      sendToConversation: async (request: { conversationId: string; message: { text: string } }) => {
        nudges.push(`${request.conversationId}:${request.message.text}`);
        return { outcome: 'delivered' as const };
      },
    }),
    log: (msg) => logs.push(msg),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const tools = new Map(toolkit.map((t) => [t.spec.name, (input: unknown) => t.handle(input) as Promise<string>]));
  const call = (name: string, input: unknown = {}): Promise<string> => tools.get(name)!(input);
  return { call, store, reports, nudges, logs, events };
}
