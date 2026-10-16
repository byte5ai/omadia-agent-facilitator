// The six facilitation_* tools (#330 C1/C3). The LLM loop (top-level agent
// via query_facilitation, or the pattern's step-mode turns) drives them;
// every degradation (missing kernel service, quota, unknown conversation)
// comes back as an honest tool output — never a throw that kills the turn.
//
// 0.6.0 — durable state: every handler first awaits the lazy rehydration
// (rehydrate.ts — plugins activate BEFORE the kernel publishes its
// Conductor services, so activate-time hydration alone finds nothing on a
// cold boot), and every mutation is written through to the kernel's per-run
// state blob (persistence.ts). facilitation_start/stop live in their own files.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import type { FacilitatorConfig } from './config.js';
import { RunStatePersister } from './persistence.js';
import { Hydrator } from './rehydrate.js';
import { sendReport } from './reporting.js';
import type {
  ConversationBindingsService,
  ConversationRostersService,
  ConversationSendService,
  EphemeralRunsService,
  RoleAssignmentsService,
  TargetedSendService,
} from './services.js';
import { buildStartTool } from './startTool.js';
import { buildStopTool } from './stopTool.js';
import type { FacilitationRecord, FacilitationStateStore } from './stateStore.js';

export { facilitationRoleKey } from './startTool.js';

// The counter is part of the persisted run state (0.6.0), so the cap holds
// per facilitation across restarts. Writes are best-effort: on a kernel
// without saveRunState it degrades to the old per-process cap, and the TTL
// still bounds the total blast radius.
const MAX_NUDGES_PER_FACILITATION = 12;
// Field report: the assess tick nudged eleven minutes into an actively
// moderated conversation — reading as a SECOND facilitator. Fresh progress
// is deterministic proof the group is working; the tool refuses instead of
// trusting the model to hold back.
const NUDGE_COOLDOWN_AFTER_PROGRESS_MS = 45 * 60 * 1000;
// A one-line state, not a transcript — also keeps the persisted run state
// well inside the kernel's 16 KiB cap.
const MAX_PROGRESS_SUMMARY_CHARS = 1000;

export interface ToolkitDeps {
  agentId: string;
  config: FacilitatorConfig;
  store: FacilitationStateStore;
  /** Lazy resolvers (review M2): optional_requires services are looked up at
   *  FIRST USE, never cached at activation — a service published after this
   *  plugin activated is picked up without a reinstall. */
  getEphemeralRuns: () => EphemeralRunsService | undefined;
  getTargetedSend: () => TargetedSendService | undefined;
  getRoleAssignments: () => RoleAssignmentsService | undefined;
  getConversationBindings: () => ConversationBindingsService | undefined;
  getConversationRosters: () => ConversationRostersService | undefined;
  getConversationSend: () => ConversationSendService | undefined;
  log: (msg: string) => void;
  /** Shared with plugin.ts (activate-time head start); built here when absent. */
  hydrator?: Hydrator;
  persister?: RunStatePersister;
  now?: () => Date;
}

/** What the split-out tool builders (startTool.ts, stopTool.ts) share with this file. */
export interface ToolContext {
  deps: ToolkitDeps;
  de: boolean;
  store: FacilitationStateStore;
  hydrator: Hydrator;
  persister: RunStatePersister;
  now: () => Date;
  resolveRecord(conversationId?: string): Promise<FacilitationRecord | undefined>;
  resolveRecordStrict(conversationId?: string): Promise<FacilitationRecord | 'ambiguous' | undefined>;
}

export function buildFacilitationToolkit(deps: ToolkitDeps): LocalSubAgentTool[] {
  const { config, store } = deps;
  const de = config.language === 'de';
  const hydrator =
    deps.hydrator ??
    new Hydrator({
      agentId: deps.agentId,
      config,
      store,
      getEphemeralRuns: deps.getEphemeralRuns,
      getConversationBindings: deps.getConversationBindings,
      log: deps.log,
    });
  const persister =
    deps.persister ?? new RunStatePersister({ agentId: deps.agentId, store, getEphemeralRuns: deps.getEphemeralRuns, log: deps.log });
  const now = deps.now ?? (() => new Date());

  /** Explicit id → that record, with ONE throttled kernel re-read on a miss
   *  (a facilitation this process has not seen yet). */
  async function lookup(conversationId: string): Promise<FacilitationRecord | undefined> {
    const hit = store.get(conversationId);
    if (hit) return hit;
    if (await hydrator.refreshOnMiss()) return store.get(conversationId);
    return undefined;
  }

  async function resolveRecord(conversationId?: string): Promise<FacilitationRecord | undefined> {
    if (conversationId && conversationId.trim().length > 0) {
      return lookup(conversationId.trim());
    }
    return store.latest();
  }

  /** Like resolveRecord, but for the ACTING tools (progress/nudge): with more
   *  than one active facilitation the no-id `latest()` fallback is ambiguous,
   *  and a proactive message must never guess its audience. */
  async function resolveRecordStrict(conversationId?: string): Promise<FacilitationRecord | 'ambiguous' | undefined> {
    if (conversationId && conversationId.trim().length > 0) {
      return lookup(conversationId.trim());
    }
    const active = store.listActive();
    if (active.length > 1) return 'ambiguous';
    return active[0] ?? store.latest();
  }

  function describe(record: FacilitationRecord): string {
    const lines = [
      de ? `Facilitation-Status: ${record.phase}` : `Facilitation status: ${record.phase}`,
      record.conversationUnknown
        ? de
          ? `Conversation: unbekannt (Run ${record.runId ?? '?'} wurde vor 0.6.0 gestartet) — Nudges in diese Konversation sind nicht möglich.`
          : `Conversation: unknown (run ${record.runId ?? '?'} was started before 0.6.0) — nudges into it are not possible.`
        : `Conversation: ${record.channelType ? `${record.channelType}/` : ''}${record.conversationId}`,
    ];
    if (record.goal) lines.push(de ? `Ziel: ${record.goal}` : `Goal: ${record.goal}`);
    if (record.definitionOfDone) lines.push(`Definition of Done: ${record.definitionOfDone}`);
    if (record.invitedBy) lines.push(de ? `Eingeladen von: ${record.invitedBy}` : `Invited by: ${record.invitedBy}`);
    if (record.deadline) lines.push(`Deadline: ${record.deadline}`);
    if (record.expiresAt) {
      lines.push(
        record.deadline
          ? de
            ? `Workflow-Laufzeit (TTL) bis: ${record.expiresAt}`
            : `Workflow lifetime (TTL) until: ${record.expiresAt}`
          : `Deadline/TTL: ${record.expiresAt}`,
      );
    }
    if (record.restored && !record.goal) {
      lines.push(
        de
          ? 'Nach einem Neustart wiederhergestellt — Ziel/DoD stehen im Workflow-Kontext des Runs, nicht hier.'
          : 'Restored after a restart — goal/DoD live in the run workflow context, not here.',
      );
    }
    if (record.progress) {
      lines.push(
        de
          ? `Fortschritt (Stand ${record.progress.updatedAt}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`
          : `Progress (as of ${record.progress.updatedAt}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`,
      );
    }
    if (record.nudgesSent) {
      lines.push(`Nudges: ${String(record.nudgesSent)}/${String(MAX_NUDGES_PER_FACILITATION)}`);
    }
    const reportRole = record.roleKey ?? config.initiatorRoleKey;
    lines.push(
      de
        ? `Berichtet wird an: role:${reportRole} (${config.reportChannelType}).`
        : `Reports go to: role:${reportRole} (${config.reportChannelType}).`,
    );
    return lines.join('\n');
  }

  const tc: ToolContext = { deps, de, store, hydrator, persister, now, resolveRecord, resolveRecordStrict };
  const start = buildStartTool(tc);

  const status: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_status',
      description:
        'Truthful transparency answer for "/facilitator status" and any question about whether/how this conversation is being moderated: phase, goal, definition of done, deadline, and who receives the report.',
      input_schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: [],
      },
    },
    async handle(input: unknown): Promise<string> {
      await hydrator.ensure();
      const args = (input ?? {}) as { conversationId?: string };
      const record = await resolveRecord(args.conversationId);
      if (!record) {
        const base = de
          ? 'Keine Facilitation bekannt (auch keine ausstehende Einladung).'
          : 'No facilitation known (and no pending invitation).';
        if (hydrator.complete) return base;
        return (
          base +
          (de
            ? ' Hinweis: Der durable Facilitation-Status des Kernels ist (noch) nicht lesbar — ein laufender Conductor-Run ist damit nicht ausgeschlossen.'
            : ' Note: the kernel’s durable facilitation state is not readable (yet) — a running Conductor run cannot be ruled out.')
        );
      }
      return describe(record);
    },
  };

  const stop = buildStopTool(tc);

  const report: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_report',
      description:
        "Deliver a report to the facilitation's initiator (role fan-out to all current holders via the kernel targetedSend service). kind 'final' for the confirmed result or the failure report; 'interim' for status updates (only sent when reporting_mode=interim). Pass conversationId whenever it is known so the report reaches THIS facilitation's initiator.",
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['final', 'interim'], description: "Report kind: 'final' or 'interim'." },
          text: { type: 'string', description: 'The report text to deliver.' },
          conversationId: { type: 'string', description: 'Channel-native conversation id of the facilitation, when known.' },
        },
        required: ['kind', 'text'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await hydrator.ensure();
      const args = (input ?? {}) as { kind?: string; text?: string; conversationId?: string };
      const kind = args.kind === 'interim' ? 'interim' : 'final';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return de ? 'Report abgelehnt: text ist leer.' : 'Report refused: text is empty.';
      // The NAMED conversation's initiator role — an unknown id is refused,
      // never redirected to another facilitation's initiator; a record
      // without its own role reports to the configured default. latest() is
      // only for callers that cannot name the conversation.
      let activeRoleKey: string | undefined;
      if (args.conversationId && args.conversationId.trim().length > 0) {
        const target = await lookup(args.conversationId.trim());
        if (!target) {
          return de
            ? 'Report abgelehnt: zu dieser conversationId ist keine Facilitation bekannt.'
            : 'Report refused: no facilitation known for this conversationId.';
        }
        activeRoleKey = target.roleKey;
      } else {
        activeRoleKey = store.latest()?.roleKey;
      }
      const result = await sendReport(
        { targetedSend: deps.getTargetedSend(), config, log: deps.log, ...(activeRoleKey ? { roleKey: activeRoleKey } : {}) },
        kind,
        text,
      );
      return result.summary;
    },
  };

  const progress: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_progress',
      description:
        "Record the CURRENT facilitation progress from the group conversation ({dodMet, summary}) so the hourly assess tick can read it (the tick shares no session with this chat). Call after every meaningful step toward the goal. dodMet=true additionally fires the pending assess tick immediately (poke) so the initiator's confirmation goes out without waiting for the interval.",
      input_schema: {
        type: 'object',
        properties: {
          dodMet: { type: 'boolean', description: 'true ONLY when the definition of done is met AND the group explicitly confirmed.' },
          summary: { type: 'string', description: 'One-line state of the result artifact (e.g. \'5/7 roles filled, QA contested\').' },
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: ['dodMet', 'summary'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await hydrator.ensure();
      const args = (input ?? {}) as { dodMet?: boolean; summary?: string; conversationId?: string };
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, MAX_PROGRESS_SUMMARY_CHARS) : '';
      if (!summary) return de ? 'Progress abgelehnt: summary ist leer.' : 'Progress refused: summary is empty.';
      const resolved = await resolveRecordStrict(args.conversationId);
      if (resolved === 'ambiguous') {
        return de
          ? 'Mehrere aktive Facilitations — bitte conversationId angeben, damit der Progress dem richtigen Ziel zugeordnet wird.'
          : 'Multiple active facilitations — pass conversationId so the progress lands on the right one.';
      }
      const record = resolved;
      if (!record || record.phase !== 'active') {
        return de
          ? 'Keine aktive Facilitation bekannt — Progress nicht protokolliert.'
          : 'No active facilitation known — progress not recorded.';
      }
      const dodMet = args.dodMet === true;
      store.recordProgress(record.conversationId, { dodMet, summary });
      await persister.persist(record.conversationId);
      let pokeNote = '';
      if (dodMet && record.runId) {
        let poked = false;
        const ephemeralRuns = deps.getEphemeralRuns();
        if (ephemeralRuns?.poke) {
          try {
            poked = (await ephemeralRuns.poke(record.runId)).poked;
          } catch (err) {
            deps.log(`poke failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        pokeNote = poked
          ? de
            ? ' Der Assess-Tick wurde sofort ausgelöst — die Bestätigungsanfrage an den Initiator geht jetzt raus.'
            : ' The assess tick was fired immediately — the initiator confirmation is on its way.'
          : de
            ? ' Der Tick konnte NICHT sofort ausgelöst werden — er feuert beim nächsten Intervall.'
            : ' The tick could NOT be fired immediately — it will fire on the next interval.';
      }
      return (de ? `Fortschritt protokolliert (dodMet=${String(dodMet)}).` : `Progress recorded (dodMet=${String(dodMet)}).`) + pokeNote;
    },
  };

  const nudge: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_nudge',
      description:
        'Post a short, activating moderation message INTO the facilitated group conversation (proactive — used by the hourly assess tick when the group looks stalled). The kernel only delivers into conversations this facilitation owns; capped per facilitation.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The nudge to post (short, activating, neutral).' },
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: ['text'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await hydrator.ensure();
      const args = (input ?? {}) as { text?: string; conversationId?: string };
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return de ? 'Nudge abgelehnt: text ist leer.' : 'Nudge refused: text is empty.';
      if (!config.nudgesEnabled) {
        return de ? 'Nudges sind deaktiviert (nudges_enabled=false).' : 'Nudges are disabled (nudges_enabled=false).';
      }
      const resolved = await resolveRecordStrict(args.conversationId);
      if (resolved === 'ambiguous') {
        return de
          ? 'Mehrere aktive Facilitations — bitte conversationId angeben; ein Nudge darf sein Publikum nicht raten.'
          : 'Multiple active facilitations — pass conversationId; a nudge must not guess its audience.';
      }
      const record = resolved;
      if (!record || record.phase !== 'active') {
        return de ? 'Kein aktives Facilitation-Ziel für einen Nudge.' : 'No active facilitation to nudge.';
      }
      if (record.conversationUnknown) {
        return de
          ? 'Kein Nudge gesendet: Die Konversation dieser (vor 0.6.0 gestarteten) Facilitation ist nach dem Neustart unbekannt.'
          : 'No nudge sent: the conversation of this facilitation (started before 0.6.0) is unknown after the restart.';
      }
      if (record.progress?.updatedAt) {
        const age = now().getTime() - new Date(record.progress.updatedAt).getTime();
        if (Number.isFinite(age) && age >= 0 && age < NUDGE_COOLDOWN_AFTER_PROGRESS_MS) {
          return de
            ? 'Kein Nudge gesendet: Die Gruppe arbeitet aktiv (Progress vor weniger als 45 Minuten protokolliert) — ein Impuls würde als zweiter Facilitator wirken.'
            : 'No nudge sent: the group is actively working (progress recorded less than 45 minutes ago) — an impulse would read as a second facilitator.';
        }
      }
      const conversationSend = deps.getConversationSend();
      if (!conversationSend) {
        return de
          ? "Nudge nicht möglich: der Kernel stellt keinen conversationSend-Service bereit (Kernel < #330 C3)."
          : "Cannot nudge: the kernel does not publish the conversationSend service (kernel < #330 C3).";
      }
      const reserved = store.reserveNudge(record.conversationId, MAX_NUDGES_PER_FACILITATION);
      if (reserved === undefined) {
        return de
          ? `Nudge-Limit erreicht (${String(MAX_NUDGES_PER_FACILITATION)} pro Facilitation) — nicht gesendet.`
          : `Nudge cap reached (${String(MAX_NUDGES_PER_FACILITATION)} per facilitation) — not sent.`;
      }
      // Persist the reservation BEFORE delivery: a restart mid-send must
      // count the nudge, never hand out a fresh slot.
      await persister.persist(record.conversationId);
      const outcome = await conversationSend
        .sendToConversation({
          agentSlug: config.facilitatorAgentSlug,
          channelType: record.channelType ?? config.reportChannelType,
          conversationId: record.conversationId,
          message: { text },
        })
        .catch((err: unknown) => ({ outcome: 'unreachable' as const, code: 'error', message: err instanceof Error ? err.message : String(err) }));
      if (outcome.outcome === 'delivered') {
        return de
          ? `Nudge gesendet (${String(reserved)}/${String(MAX_NUDGES_PER_FACILITATION)}).`
          : `Nudge sent (${String(reserved)}/${String(MAX_NUDGES_PER_FACILITATION)}).`;
      }
      store.releaseNudge(record.conversationId);
      await persister.persist(record.conversationId);
      return de
        ? `Nudge NICHT zugestellt: ${outcome.code} — ${outcome.message}`
        : `Nudge NOT delivered: ${outcome.code} — ${outcome.message}`;
    },
  };

  return [start, status, stop, report, progress, nudge];
}
