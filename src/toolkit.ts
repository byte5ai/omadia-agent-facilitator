// The seven facilitation_* tools (#330 C1/C3, facilitation_update since 0.7.0). The LLM loop (top-level agent
// via query_facilitation, or the pattern's step-mode turns) drives them;
// every degradation (missing kernel service, quota, unknown conversation)
// comes back as an honest tool output — never a throw that kills the turn.
//
// 0.6.0 — durable state: every handler first awaits the lazy rehydration
// (rehydrate.ts — plugins activate BEFORE the kernel publishes its
// Conductor services, so activate-time hydration alone finds nothing on a
// cold boot), and every mutation is written through to the kernel's per-run
// state blob (persistence.ts). facilitation_start/stop/update/nudge live in
// their own files.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import type { FacilitatorConfig } from './config.js';
import { withLocalTime } from './localTime.js';
import { buildNudgeTool, MAX_NUDGES_PER_FACILITATION } from './nudgeTool.js';
import { buildParticipantOverview, describeParticipants, loadHumanRoster } from './participants.js';
import { RunStatePersister, SNAPSHOT_CONTRIBUTOR_MAX_CHARS, SNAPSHOT_MAX_CONTRIBUTORS } from './persistence.js';
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
import { buildUpdateTool } from './updateTool.js';
import type { FacilitationRecord, FacilitationStateStore } from './stateStore.js';

export { facilitationRoleKey } from './startTool.js';

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

  const local = (iso: string): string => withLocalTime(iso, config.timezone, de);

  async function describe(record: FacilitationRecord): Promise<string> {
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
    if (record.amendedAt) {
      lines.push(
        de
          ? `Ziel/DoD/Deadline zuletzt geändert am ${local(record.amendedAt)} (facilitation_update) — es gilt der Stand HIER, nicht der ursprüngliche Auftrag.`
          : `Goal/DoD/deadline last changed at ${local(record.amendedAt)} (facilitation_update) — the wording HERE applies, not the original brief.`,
      );
    }
    if (record.invitedBy) lines.push(de ? `Eingeladen von: ${record.invitedBy}` : `Invited by: ${record.invitedBy}`);
    if (record.deadline) lines.push(`Deadline: ${local(record.deadline)}`);
    if (record.expiresAt) {
      lines.push(
        record.deadline
          ? de
            ? `Workflow-Laufzeit (TTL) bis: ${local(record.expiresAt)}`
            : `Workflow lifetime (TTL) until: ${local(record.expiresAt)}`
          : `Deadline/TTL: ${local(record.expiresAt)}`,
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
          ? `Fortschritt (Stand ${local(record.progress.updatedAt)}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`
          : `Progress (as of ${local(record.progress.updatedAt)}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`,
      );
    }
    if (record.phase === 'active' && !record.conversationUnknown) {
      const roster = await loadHumanRoster(deps.getConversationRosters(), record.channelType, record.conversationId, deps.log);
      if (roster && roster.participants.length > 0) {
        lines.push(...describeParticipants(buildParticipantOverview(roster, record.progress?.contributors ?? []), de));
      } else if (record.progress?.contributors?.length) {
        lines.push(
          de
            ? `Beitrag erfasst: ${record.progress.contributors.join(', ')} (Teilnehmerliste nicht verfügbar)`
            : `Contribution recorded: ${record.progress.contributors.join(', ')} (participant list unavailable)`,
        );
      }
    }
    if (record.nudgesSent) {
      lines.push(`Nudges: ${String(record.nudgesSent)}/${String(MAX_NUDGES_PER_FACILITATION)}`);
    }
    if (record.lastNudge) {
      // The chat-side agent never sees the tick's posts in its own session —
      // the status is where it learns what the group was already told.
      lines.push(
        de
          ? `Letzter Nudge in den Gruppen-Chat (${local(record.lastNudge.at)}): „${record.lastNudge.text}“`
          : `Last nudge posted into the group chat (${local(record.lastNudge.at)}): "${record.lastNudge.text}"`,
      );
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
        'Truthful transparency answer for "/facilitator status" and any question about whether/how this conversation is being moderated: phase, goal, definition of done, deadline, recorded progress, participants (who contributed, who is still pending), the last nudge posted into the chat, and who receives the report.',
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
        "Record the CURRENT facilitation progress from the group conversation ({dodMet, summary, contributors}) so the hourly assess tick can read it (the tick shares no session with this chat). Call after every meaningful step toward the goal. dodMet=true additionally fires the pending assess tick immediately (poke) so the initiator's confirmation goes out without waiting for the interval.",
      input_schema: {
        type: 'object',
        properties: {
          dodMet: {
            type: 'boolean',
            description:
              'true as soon as the definition of done is met AS WORDED. A separate confirmation by the group is needed only when the definition of done itself asks for one — never invent extra conditions (confirmation round, quorum, completeness or sum checks).',
          },
          summary: { type: 'string', description: 'One-line state of the result artifact (e.g. \'5/7 roles filled, QA contested\').' },
          contributors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'COMPLETE list of the participants whose contribution (vote, answer, confirmation) is recorded so far — full names as shown in the participant list of facilitation_status. Replaces the previous list; omit to keep it. Lets the status say who is still pending. A name that matches no participant, or more than one, makes the whole call fail with the valid names.',
          },
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: ['dodMet', 'summary'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await hydrator.ensure();
      const args = (input ?? {}) as { dodMet?: boolean; summary?: string; contributors?: unknown; conversationId?: string };
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, MAX_PROGRESS_SUMMARY_CHARS) : '';
      const contributors = Array.isArray(args.contributors)
        ? [
            ...new Set(
              args.contributors
                .filter((c): c is string => typeof c === 'string')
                .map((c) => c.trim().slice(0, SNAPSHOT_CONTRIBUTOR_MAX_CHARS))
                .filter((c) => c.length > 0),
            ),
          ].slice(0, SNAPSHOT_MAX_CONTRIBUTORS)
        : undefined;
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
      // 0.7.1 — names are checked against the roster at WRITE time. A name
      // that fits nobody (a typo, or a pseudonym a masked model context
      // produced) is refused here instead of being stored and resurfacing in
      // later turns. Without a roster the list is taken as given.
      let recorded = contributors;
      if (contributors && contributors.length > 0 && !record.conversationUnknown) {
        const roster = await loadHumanRoster(deps.getConversationRosters(), record.channelType, record.conversationId, deps.log);
        if (roster && roster.participants.length > 0) {
          const overview = buildParticipantOverview(roster, contributors);
          if (overview.unmatched.length > 0) {
            const known = roster.participants.join(', ');
            return de
              ? `Progress NICHT protokolliert: ${overview.unmatched.join(', ')} passt auf keine oder mehrere Personen der Teilnehmerliste. Gültige Namen: ${known}. Bitte mit den vollen Namen aus dieser Liste erneut protokollieren.`
              : `Progress NOT recorded: ${overview.unmatched.join(', ')} matches no participant, or more than one. Valid names: ${known}. Record again with the full names from this list.`;
          }
          recorded = overview.contributed;
        }
      }
      store.recordProgress(record.conversationId, { dodMet, summary, ...(recorded ? { contributors: recorded } : {}) });
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

  const update = buildUpdateTool(tc);
  const nudge = buildNudgeTool(tc);

  return [start, status, stop, report, progress, nudge, update];
}
