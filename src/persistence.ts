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
import type {
  FacilitationContribution,
  FacilitationPhase,
  FacilitationProgress,
  FacilitationRecord,
  FacilitationStateStore,
} from './stateStore.js';

export const RUN_STATE_VERSION = 1;

export interface RunStateSnapshot {
  v: typeof RUN_STATE_VERSION;
  phase: FacilitationPhase;
  progress?: FacilitationProgress;
  nudgesSent?: number;
  roleKey?: string;
  channelType?: string;
  /** 0.7.3 — per-participant ledger (capped). */
  contributions?: FacilitationContribution[];
  /** 0.7.1 — when the run was started (minimum nudge spacing from the start). */
  startedAt?: string;
  /** 0.7.0 — last delivered nudge (time + capped text). */
  lastNudge?: { at: string; text: string };
  /** 0.7.0 — goal/DoD/deadline as changed by facilitation_update. The run
   *  payload is immutable, so the CURRENT wording has to live here. */
  amended?: { at: string; goal?: string; definitionOfDone?: string; deadline?: string };
}

/** Size guard: the kernel refuses state blobs over 16 KiB. The summary is the
 *  only free-text field — capped here even if a caller bypassed the tool cap
 *  (1000 chars ≤ 4 KB UTF-8 worst case). */
export const SNAPSHOT_SUMMARY_MAX_CHARS = 1000;
/** 0.7.0 caps for the other free-text fields — together with the summary
 *  they keep a realistic snapshot far below the kernel's 16 KiB limit. */
export const SNAPSHOT_GOAL_MAX_CHARS = 500;
export const SNAPSHOT_DOD_MAX_CHARS = 1500;
export const SNAPSHOT_NUDGE_MAX_CHARS = 300;
export const SNAPSHOT_MAX_CONTRIBUTORS = 30;
export const SNAPSHOT_CONTRIBUTOR_MAX_CHARS = 80;
export const SNAPSHOT_MAX_CONTRIBUTIONS = 20;
export const SNAPSHOT_CONTRIBUTION_MAX_CHARS = 200;

function capContributors(list: readonly string[]): string[] {
  return list.slice(0, SNAPSHOT_MAX_CONTRIBUTORS).map((name) => name.slice(0, SNAPSHOT_CONTRIBUTOR_MAX_CHARS));
}

export function snapshotOf(record: FacilitationRecord): RunStateSnapshot {
  return {
    v: RUN_STATE_VERSION,
    phase: record.phase,
    ...(record.progress
      ? {
          progress: {
            dodMet: record.progress.dodMet,
            summary: record.progress.summary.slice(0, SNAPSHOT_SUMMARY_MAX_CHARS),
            updatedAt: record.progress.updatedAt,
            ...(record.progress.contributors ? { contributors: capContributors(record.progress.contributors) } : {}),
          },
        }
      : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.contributions && record.contributions.length > 0
      ? {
          contributions: record.contributions.slice(0, SNAPSHOT_MAX_CONTRIBUTIONS).map((c) => ({
            participant: c.participant.slice(0, SNAPSHOT_CONTRIBUTOR_MAX_CHARS),
            text: c.text.slice(0, SNAPSHOT_CONTRIBUTION_MAX_CHARS),
            at: c.at,
          })),
        }
      : {}),
    ...(record.lastNudge
      ? { lastNudge: { at: record.lastNudge.at, text: record.lastNudge.text.slice(0, SNAPSHOT_NUDGE_MAX_CHARS) } }
      : {}),
    ...(record.amendedAt
      ? {
          amended: {
            at: record.amendedAt,
            ...(record.goal ? { goal: record.goal.slice(0, SNAPSHOT_GOAL_MAX_CHARS) } : {}),
            ...(record.definitionOfDone ? { definitionOfDone: record.definitionOfDone.slice(0, SNAPSHOT_DOD_MAX_CHARS) } : {}),
            ...(record.deadline ? { deadline: record.deadline } : {}),
          },
        }
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
    const contributors = Array.isArray(progress.contributors)
      ? capContributors(progress.contributors.filter((c): c is string => typeof c === 'string' && c.trim().length > 0))
      : undefined;
    out.progress = {
      dodMet: progress.dodMet,
      summary: progress.summary,
      updatedAt: progress.updatedAt,
      ...(contributors ? { contributors } : {}),
    };
  }
  if (typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt))) out.startedAt = raw.startedAt;
  if (Array.isArray(raw.contributions)) {
    const contributions = raw.contributions
      .filter(
        (c): c is FacilitationContribution =>
          c !== null &&
          typeof c === 'object' &&
          typeof (c as FacilitationContribution).participant === 'string' &&
          typeof (c as FacilitationContribution).text === 'string' &&
          typeof (c as FacilitationContribution).at === 'string',
      )
      .slice(0, SNAPSHOT_MAX_CONTRIBUTIONS)
      .map((c) => ({ participant: c.participant, text: c.text, at: c.at }));
    if (contributions.length > 0) out.contributions = contributions;
  }
  const lastNudge = raw.lastNudge as Record<string, unknown> | undefined;
  if (lastNudge && typeof lastNudge === 'object' && typeof lastNudge.at === 'string' && typeof lastNudge.text === 'string') {
    out.lastNudge = { at: lastNudge.at, text: lastNudge.text.slice(0, SNAPSHOT_NUDGE_MAX_CHARS) };
  }
  const amended = raw.amended as Record<string, unknown> | undefined;
  if (amended && typeof amended === 'object' && typeof amended.at === 'string') {
    out.amended = {
      at: amended.at,
      ...(typeof amended.goal === 'string' && amended.goal.length > 0 ? { goal: amended.goal } : {}),
      ...(typeof amended.definitionOfDone === 'string' && amended.definitionOfDone.length > 0
        ? { definitionOfDone: amended.definitionOfDone }
        : {}),
      ...(typeof amended.deadline === 'string' && amended.deadline.length > 0 ? { deadline: amended.deadline } : {}),
    };
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
