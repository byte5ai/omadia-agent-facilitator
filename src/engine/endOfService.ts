// End of service for the facilitations of one facilitator (kernel #2088,
// plugin-api 1.61.0: `archetypeProcesses:<archetype id>`).
//
// The kernel calls this BEFORE it disables or deletes a facilitator, or
// removes this plugin: every facilitation of that agent ends here, with its
// own abort report posted as the facilitator while it still can post. The
// kernel waits a bounded time and then ends the agent's subscriptions itself,
// so the answer has to be there in time: what is not finished by then is
// reported as `failed`, never left unanswered.
//
// The types mirror the kernel's contract; the plugin also runs on a kernel
// that never asks.

import { rows } from '../db/sql.js';
import type { Facilitation } from '../model.js';
import { LIVE_PHASES } from '../model.js';
import { texts } from '../texts/index.js';
import { endFollowup } from './actionItems.js';
import type { EngineCore } from './core.js';
import { abortInWork, releaseConversation } from './lifecycle.js';

export const FACILITATOR_ARCHETYPE_ID = 'facilitator';
/** `archetypeProcessesServiceName('facilitator')` of the kernel's contract. */
export const ARCHETYPE_PROCESSES_SERVICE_NAME = `archetypeProcesses:${FACILITATOR_ARCHETYPE_ID}`;

export type AgentEndOfServiceReason = 'agent_disabled' | 'agent_deleted' | 'archetype_plugin_removed';
export const END_OF_SERVICE_REASONS: readonly AgentEndOfServiceReason[] = ['agent_disabled', 'agent_deleted', 'archetype_plugin_removed'];

export interface ProcessEndRequest {
  agentSlug: string;
  reason: AgentEndOfServiceReason;
}

export interface ProcessEnded {
  processId: string;
  channelType: string;
  conversationId: string;
  outcome: 'aborted' | 'failed';
  reportPosted?: boolean;
  detail?: string;
}

export interface ProcessEndReport {
  ended: readonly ProcessEnded[];
}

export interface ArchetypeProcessesService {
  endProcessesOfAgent(request: ProcessEndRequest): Promise<ProcessEndReport>;
}

/** The kernel waits 20 s; the answer leaves before that. */
export const END_OF_SERVICE_BUDGET_MS = 17_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The reason in the words of the group's language. */
export function endOfServiceReason(language: Facilitation['language'], reason: AgentEndOfServiceReason): string {
  const t = texts(language);
  if (reason === 'agent_disabled') return t.abortAgentDisabled();
  if (reason === 'agent_deleted') return t.abortAgentDeleted();
  return t.abortArchetypeRemoved();
}

async function reportPosted(engine: EngineCore, facilitationId: string, purpose: string): Promise<boolean> {
  const sent = await engine.db().query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = $2 AND status = 'sent' LIMIT 1`,
    [facilitationId, purpose],
  );
  return sent.rows.length > 0;
}

/** End one facilitation: a running one with its abort report, a closed one
 *  that still follows up action items by ending the follow-up. */
async function endOne(engine: EngineCore, f: Facilitation, reason: AgentEndOfServiceReason): Promise<ProcessEnded> {
  const base = { processId: f.id, channelType: f.channelType, conversationId: f.conversationId };
  const running = LIVE_PHASES.includes(f.phase);
  const ended = await engine.work(f.id, async (w) => {
    if (LIVE_PHASES.includes(w.f.phase)) {
      await abortInWork(w, { reason: endOfServiceReason(w.f.language, reason), actor: 'kernel', detail: { endOfService: reason } });
    }
    if (w.f.followupState === 'active') {
      await endFollowup(w);
      await w.event('end_of_service', 'kernel', { reason });
    }
    return w.f;
  });
  await releaseConversation(engine, ended);
  const posted = await reportPosted(engine, f.id, running ? 'abort' : 'followup_ended');
  return {
    ...base,
    outcome: 'aborted',
    reportPosted: posted,
    detail: `${running ? 'ended without a result' : 'follow-up of action items ended'} (${reason})${posted ? '' : '; the closing message is not delivered yet'}`,
  };
}

/** Everything of this facilitator that would go on: live facilitations, and
 *  closed ones whose action items are still followed up. */
export function listProcessesOf(engine: EngineCore, agentSlug: string): Promise<Facilitation[]> {
  return rows<Facilitation>(
    engine.db(),
    `SELECT * FROM plg_omadia_agent_facilitator_facilitations
      WHERE facilitator_agent = $1 AND (phase = ANY($2::text[]) OR followup_state = 'active')
      ORDER BY created_at`,
    [agentSlug, `{${LIVE_PHASES.join(',')}}`],
  );
}

/**
 * End every process of the agent, for good. Idempotent: what has ended is not
 * listed again. Each facilitation ends under its own lock, all of them at the
 * same time, and the answer leaves within `budgetMs` whatever a single one
 * waits for.
 */
export async function endProcessesOfAgent(engine: EngineCore, request: ProcessEndRequest, budgetMs: number = END_OF_SERVICE_BUDGET_MS): Promise<ProcessEndReport> {
  if (typeof request?.agentSlug !== 'string' || request.agentSlug === '') throw new Error('endProcessesOfAgent needs an agentSlug');
  if (!END_OF_SERVICE_REASONS.includes(request.reason)) throw new Error(`endProcessesOfAgent: unknown reason '${String(request.reason)}'`);
  const processes = await listProcessesOf(engine, request.agentSlug);
  if (processes.length === 0) return { ended: [] };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), budgetMs);
    timer.unref?.();
  });
  try {
    const ended = await Promise.all(
      processes.map(async (f): Promise<ProcessEnded> => {
        const base = { processId: f.id, channelType: f.channelType, conversationId: f.conversationId };
        const attempt = endOne(engine, f, request.reason).catch((err: unknown): ProcessEnded => {
          engine.log(`facilitation ${f.id}: end of service (${request.reason}) failed: ${message(err)}`);
          return { ...base, outcome: 'failed', detail: message(err) };
        });
        const result = await Promise.race([attempt, late]);
        if (result !== 'late') return result;
        engine.log(`facilitation ${f.id}: end of service (${request.reason}) did not finish within ${String(budgetMs)} ms`);
        return { ...base, outcome: 'failed', detail: `not finished within ${String(Math.round(budgetMs / 1000))} s; it goes on closing in the background` };
      }),
    );
    engine.log(`end of service for '${request.agentSlug}' (${request.reason}): ${String(ended.filter((e) => e.outcome === 'aborted').length)} of ${String(ended.length)} ended`);
    return { ended };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
