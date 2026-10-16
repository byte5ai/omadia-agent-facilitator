// Restart rehydration (0.6.0) — read side of the durable facilitation state.
//
// BOOT ORDER is why this is LAZY: the kernel activates agent plugins before
// it publishes the Conductor-backed services (conductorEphemeralRuns,
// conversationBindings) on a cold boot, so an activate-time pass finds no
// source and restores nothing. `ensure()` is therefore awaited by EVERY tool
// handler; the activate-time call is only a best-effort head start.
//
// Sources, in order:
// 1. conductorEphemeralRuns.listOwnRuns — the agent's own running/waiting
//    runs. Pattern 'facilitation' only. payload carries goal/DoD/
//    conversationId (0.6.0+ starts), state the persisted snapshot.
// 2. conversationBindings.listOwnAttachments — merged by conversationId
//    (adds channelType/roleKey); attachment-only rows restore as before.
// A legacy run (started < 0.6.0: no payload.conversationId) is matched to
// its attachment via activeRunId; without one it is keyed `run:<runId>` and
// flagged conversationUnknown — status works, posting into it does not.

import type { FacilitatorConfig } from './config.js';
import { parseSnapshot } from './persistence.js';
import type { ConversationBindingsService, EphemeralRunsService } from './services.js';
import type { FacilitationPhase, FacilitationStateStore } from './stateStore.js';

export const FACILITATION_PATTERN_ID = 'facilitation';
/** Minimum spacing between passes after a failed pass / for refreshOnMiss. */
export const REHYDRATE_RETRY_MS = 60 * 1000;

type OwnRun = Awaited<ReturnType<NonNullable<EphemeralRunsService['listOwnRuns']>>>[number];

function iso(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export class Hydrator {
  private done = false;
  private inFlight: Promise<void> | undefined;
  private lastFailureAt: number | undefined;
  private lastRefreshAt: number | undefined;

  constructor(
    private readonly deps: {
      agentId: string;
      config: Pick<FacilitatorConfig, 'facilitatorAgentSlug'>;
      store: FacilitationStateStore;
      getEphemeralRuns: () => EphemeralRunsService | undefined;
      getConversationBindings: () => ConversationBindingsService | undefined;
      log: (msg: string) => void;
      now?: () => number;
    },
  ) {}

  /** True once a pass with at least one durable source succeeded. */
  get complete(): boolean {
    return this.done;
  }

  /** Idempotent, never throws. Concurrent callers share one in-flight pass.
   *  No source published yet (cold boot) → nothing cached, the next call
   *  probes again (a free service lookup). A source that THREW, or a pass
   *  that ran with only one of the two services published, is retried at
   *  most every REHYDRATE_RETRY_MS. */
  async ensure(): Promise<void> {
    // A pass already in flight may have started before a service was
    // published (e.g. kicked by a membership event) — wait for it, then
    // decide again instead of returning its stale outcome.
    if (this.inFlight) await this.inFlight;
    if (this.done) return;
    if (this.inFlight) return this.inFlight;
    if (this.lastFailureAt !== undefined && this.now() - this.lastFailureAt < REHYDRATE_RETRY_MS) return;
    return this.run();
  }

  /** One extra, throttled pass after an explicit conversationId missed the
   *  store — picks up a facilitation this process has not seen yet.
   *  Returns true when a pass actually ran. */
  async refreshOnMiss(): Promise<boolean> {
    if (this.inFlight) {
      await this.inFlight;
      return true;
    }
    if (this.lastRefreshAt !== undefined && this.now() - this.lastRefreshAt < REHYDRATE_RETRY_MS) return false;
    this.lastRefreshAt = this.now();
    await this.run();
    return true;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private run(): Promise<void> {
    const pass = this.pass()
      .then((outcome) => {
        if (outcome === 'ok') {
          this.done = true;
          this.lastFailureAt = undefined;
        } else if (outcome === 'failed' || outcome === 'partial') {
          this.lastFailureAt = this.now();
        }
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = pass;
    return pass;
  }

  private async pass(): Promise<'ok' | 'no-source' | 'partial' | 'failed'> {
    const runsService = this.deps.getEphemeralRuns();
    const bindings = this.deps.getConversationBindings();
    const listRuns = runsService && typeof runsService.listOwnRuns === 'function' ? runsService : undefined;
    const listAttachments = bindings && typeof bindings.listOwnAttachments === 'function' ? bindings : undefined;
    if (!listRuns && !listAttachments) return 'no-source';

    let failed = false;
    let fromRuns = 0;
    let fromAttachments = 0;
    const legacyRuns = new Map<string, OwnRun>();

    if (listRuns) {
      try {
        const runs = await listRuns.listOwnRuns!({ agentId: this.deps.agentId });
        for (const run of runs) {
          if (run.patternId !== FACILITATION_PATTERN_ID) continue;
          const conversationId = str(run.payload?.conversationId);
          if (!conversationId) {
            legacyRuns.set(run.runId, run);
            continue;
          }
          if (this.restoreRun(run, conversationId)) fromRuns += 1;
        }
      } catch (err) {
        failed = true;
        this.deps.log(`facilitation rehydration: listOwnRuns failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (listAttachments) {
      try {
        const rows = await listAttachments.listOwnAttachments!({ agentSlug: this.deps.config.facilitatorAgentSlug });
        for (const row of rows) {
          const legacy = row.activeRunId ? legacyRuns.get(row.activeRunId) : undefined;
          if (legacy) {
            legacyRuns.delete(legacy.runId);
            if (this.restoreRun(legacy, row.conversationId, row)) fromRuns += 1;
            continue;
          }
          if (this.deps.store.get(row.conversationId)?.restored) {
            this.deps.store.mergeRestored(row.conversationId, {
              channelType: row.channelType,
              ...(row.roleKey ? { roleKey: row.roleKey } : {}),
            });
            continue;
          }
          // Same rule as for runs: create-only, except that an attached row
          // upgrades a live pending-without-runId marker (bot_present).
          const record = this.deps.store.restore({
            conversationId: row.conversationId,
            channelType: row.channelType,
            phase: row.state === 'attached' ? 'active' : 'pending',
            ...(row.activeRunId ? { runId: row.activeRunId } : {}),
            ...(row.roleKey ? { roleKey: row.roleKey } : {}),
            ...(iso(row.expiresAt) ? { expiresAt: iso(row.expiresAt)! } : {}),
          });
          if (record) fromAttachments += 1;
        }
      } catch (err) {
        failed = true;
        this.deps.log(`facilitation rehydration: listOwnAttachments failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Legacy runs nobody could place: keep goal/DoD visible, never post.
    for (const run of legacyRuns.values()) {
      if (this.deps.store.getByRunId(run.runId)) continue;
      if (this.restoreRun(run, `run:${run.runId}`, undefined, true)) fromRuns += 1;
    }

    const total = fromRuns + fromAttachments;
    if (total > 0) {
      this.deps.log(
        `facilitation state rehydrated: ${String(total)} record(s) restored (runs: ${String(fromRuns)}, attachment-only: ${String(fromAttachments)})`,
      );
    }
    if (failed) return 'failed';
    // One of the two kernel services is not published (yet): what was found
    // is restored, but the pass is not final — the other source may appear.
    return runsService && bindings ? 'ok' : 'partial';
  }

  private restoreRun(
    run: OwnRun,
    conversationId: string,
    attachment?: { channelType: string; roleKey: string | null },
    conversationUnknown = false,
  ): boolean {
    const payload = run.payload ?? {};
    const state = parseSnapshot(run.state);
    // A run listed by the kernel is running/waiting; only an explicit
    // persisted stop keeps it from being moderated again.
    const phase: FacilitationPhase = state?.phase === 'stopped' ? 'stopped' : 'active';
    const channelType = state?.channelType ?? str(payload.channelType) ?? attachment?.channelType;
    const roleKey = state?.roleKey ?? str(payload.initiatorRoleKey) ?? attachment?.roleKey ?? undefined;
    const goal = str(payload.goal);
    const definitionOfDone = str(payload.definitionOfDone);
    const deadline = str(payload.deadline);
    const expiresAt = iso(run.expiresAt);
    const record = this.deps.store.restore({
      conversationId,
      phase,
      runId: run.runId,
      workflowSlug: run.workflowSlug,
      ...(channelType ? { channelType } : {}),
      ...(roleKey ? { roleKey } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(goal ? { goal } : {}),
      ...(definitionOfDone ? { definitionOfDone } : {}),
      ...(deadline ? { deadline } : {}),
      ...(state?.progress ? { progress: state.progress } : {}),
      ...(state?.nudgesSent !== undefined ? { nudgesSent: state.nudgesSent } : {}),
      ...(conversationUnknown ? { conversationUnknown: true } : {}),
    });
    return record !== undefined;
  }
}
