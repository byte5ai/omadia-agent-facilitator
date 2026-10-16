// Durable facilitation state — write side (0.6.0). The kernel keeps one
// owner-guarded JSON blob per ephemeral run (`saveRunState`, purged with the
// workflow); this module serializes the mutable part of a facilitation
// record into it so a restart (rehydrate.ts) restores phase, progress and
// nudge accounting instead of starting from zero.
//
// Rules:
// - Writes are chained PER RUN: two quick mutations never race each other
//   into the kernel out of order.
// - Each write serializes the CURRENT record at execution time, not the one
//   at enqueue time — a burst of mutations collapses to "last state wins".
// - Best-effort: an old kernel (no saveRunState), a missing run id or a
//   failing call is logged and swallowed — it never throws into a tool.
// - No PII: invitedBy/invitedByRef stay in memory; goal/DoD already live in
//   the run payload and are not duplicated here.

import type { EphemeralRunsService } from './services.js';
import type { FacilitationPhase, FacilitationRecord, FacilitationStateStore } from './stateStore.js';

export const RUN_STATE_VERSION = 1;

export interface RunStateSnapshot {
  v: typeof RUN_STATE_VERSION;
  phase: FacilitationPhase;
  progress?: { dodMet: boolean; summary: string; updatedAt: string };
  nudgesSent?: number;
  roleKey?: string;
  channelType?: string;
}

/** Size guard: the kernel refuses state blobs over 16 KiB. The summary is the
 *  only free-text field — capped here even if a caller bypassed the tool cap
 *  (1000 chars ≤ 4 KB UTF-8 worst case). */
export const SNAPSHOT_SUMMARY_MAX_CHARS = 1000;

export function snapshotOf(record: FacilitationRecord): RunStateSnapshot {
  return {
    v: RUN_STATE_VERSION,
    phase: record.phase,
    ...(record.progress
      ? { progress: { ...record.progress, summary: record.progress.summary.slice(0, SNAPSHOT_SUMMARY_MAX_CHARS) } }
      : {}),
    ...(record.nudgesSent !== undefined ? { nudgesSent: record.nudgesSent } : {}),
    ...(record.roleKey ? { roleKey: record.roleKey } : {}),
    ...(record.channelType ? { channelType: record.channelType } : {}),
  };
}

const PHASES: readonly FacilitationPhase[] = ['pending', 'active', 'stopped'];

/** Parse a kernel-returned state blob. It is data the plugin wrote itself,
 *  but it crossed a process boundary — validate field by field and drop
 *  anything malformed instead of trusting it. Unknown versions → undefined. */
export function parseSnapshot(raw: Record<string, unknown> | null | undefined): Partial<RunStateSnapshot> | undefined {
  if (!raw || typeof raw !== 'object' || raw.v !== RUN_STATE_VERSION) return undefined;
  const out: Partial<RunStateSnapshot> = { v: RUN_STATE_VERSION };
  if (typeof raw.phase === 'string' && (PHASES as readonly string[]).includes(raw.phase)) {
    out.phase = raw.phase as FacilitationPhase;
  }
  const progress = raw.progress as Record<string, unknown> | undefined;
  if (
    progress &&
    typeof progress === 'object' &&
    typeof progress.dodMet === 'boolean' &&
    typeof progress.summary === 'string' &&
    typeof progress.updatedAt === 'string'
  ) {
    out.progress = { dodMet: progress.dodMet, summary: progress.summary, updatedAt: progress.updatedAt };
  }
  if (typeof raw.nudgesSent === 'number' && Number.isInteger(raw.nudgesSent) && raw.nudgesSent >= 0) {
    out.nudgesSent = raw.nudgesSent;
  }
  if (typeof raw.roleKey === 'string' && raw.roleKey.length > 0) out.roleKey = raw.roleKey;
  if (typeof raw.channelType === 'string' && raw.channelType.length > 0) out.channelType = raw.channelType;
  return out;
}

export class RunStatePersister {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      agentId: string;
      store: FacilitationStateStore;
      getEphemeralRuns: () => EphemeralRunsService | undefined;
      log: (msg: string) => void;
    },
  ) {}

  /** Persist the conversation's record. Resolves once THIS write (and every
   *  earlier one for the same run) has settled; never rejects. */
  persist(conversationId: string): Promise<void> {
    const runId = this.deps.store.get(conversationId)?.runId;
    if (!runId) return Promise.resolve();
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.write(conversationId, runId));
    this.chains.set(runId, next);
    void next.finally(() => {
      if (this.chains.get(runId) === next) this.chains.delete(runId);
    });
    return next;
  }

  private async write(conversationId: string, runId: string): Promise<void> {
    try {
      const service = this.deps.getEphemeralRuns();
      if (!service || typeof service.saveRunState !== 'function') return; // kernel < durable state
      const record = this.deps.store.get(conversationId);
      // The record may have moved on to another run (restart) in between.
      if (!record || record.runId !== runId) return;
      const result = await service.saveRunState({
        agentId: this.deps.agentId,
        runId,
        state: snapshotOf(record) as unknown as Record<string, unknown>,
      });
      if (!result.saved) {
        this.deps.log(`run state for ${runId} not saved (run not owned or no longer active)`);
      }
    } catch (err) {
      this.deps.log(`run state persist for ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
