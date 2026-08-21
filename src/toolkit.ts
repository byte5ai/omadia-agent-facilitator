// The four facilitation_* tools (#330 C1). The LLM loop (top-level agent via
// query_facilitation, or the pattern's step-mode turns) drives them; every
// degradation (missing kernel service, quota, unknown conversation) comes
// back as an honest tool output — never a throw that kills the turn.

import { createHash } from 'node:crypto';

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import type { FacilitatorConfig } from './config.js';
import { sendReport } from './reporting.js';
import type {
  ConversationBindingsService,
  ConversationRostersService,
  EphemeralRunsService,
  RoleAssignmentsService,
  TargetedSendService,
} from './services.js';
import type { FacilitationRecord, FacilitationStateStore } from './stateStore.js';

const HOUR_MS = 60 * 60 * 1000;

/** Stable, readable per-conversation role key - Teams conversation ids are
 *  long and symbol-heavy, the hash keeps the key clean and collision-safe. */
export function facilitationRoleKey(conversationId: string): string {
  return `facilitation-${createHash('sha256').update(conversationId).digest('hex').slice(0, 12)}`;
}

export function buildFacilitationToolkit(deps: {
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
  log: (msg: string) => void;
}): LocalSubAgentTool[] {
  const { config, store } = deps;
  const de = config.language === 'de';

  function resolveRecord(conversationId?: string): FacilitationRecord | undefined {
    if (conversationId && conversationId.trim().length > 0) {
      return store.get(conversationId.trim());
    }
    return store.latest();
  }

  /** Resolve the inviter to the email-keyed holder id the role machinery
   *  expects. bot_added only carries the AAD id, so we match it against the
   *  roster; the AAD id itself is the honest fallback (targetedSend will then
   *  report the holder unreachable rather than silently dropping). */
  async function resolveInitiatorHolder(record: FacilitationRecord): Promise<{ holderId: string; via: string } | undefined> {
    const inviter = record.invitedByRef;
    if (!inviter) return undefined;
    const rosters = deps.getConversationRosters();
    if (rosters && record.channelType) {
      try {
        const roster = await rosters.getRoster(record.channelType, record.conversationId);
        const match = roster?.participants.find(
          (p) => p.userRef.id === inviter.id || p.externalId === inviter.id,
        );
        const email = match?.userRef.email ?? match?.userPrincipalName ?? undefined;
        if (email) return { holderId: email.toLowerCase(), via: 'roster' };
      } catch (err) {
        deps.log(`initiator roster lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { holderId: inviter.id, via: 'aad-fallback' };
  }

  function describe(record: FacilitationRecord): string {
    const lines = [
      de ? `Facilitation-Status: ${record.phase}` : `Facilitation status: ${record.phase}`,
      `Conversation: ${record.channelType ? `${record.channelType}/` : ''}${record.conversationId}`,
    ];
    if (record.goal) lines.push(de ? `Ziel: ${record.goal}` : `Goal: ${record.goal}`);
    if (record.definitionOfDone) lines.push(`Definition of Done: ${record.definitionOfDone}`);
    if (record.invitedBy) lines.push(de ? `Eingeladen von: ${record.invitedBy}` : `Invited by: ${record.invitedBy}`);
    if (record.expiresAt) lines.push(de ? `Deadline/TTL: ${record.expiresAt}` : `Deadline/TTL: ${record.expiresAt}`);
    const reportRole = record.roleKey ?? config.initiatorRoleKey;
    lines.push(
      de
        ? `Berichtet wird an: role:${reportRole} (${config.reportChannelType}).`
        : `Reports go to: role:${reportRole} (${config.reportChannelType}).`,
    );
    return lines.join('\n');
  }

  const start: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_start',
      description:
        'Start a facilitation for the current group conversation: creates ONE ephemeral Conductor run from the curated facilitation pattern (goal + machine-checkable definition of done) and returns the opening handshake to post verbatim into the chat. Call exactly once per facilitation, after the initiator stated goal and definition of done.',
      input_schema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The outcome the group must reach, in one sentence.' },
          definitionOfDone: {
            type: 'string',
            description: 'Machine-checkable completion criterion (e.g. "every role carries exactly one confirmed name and the group agreed").',
          },
          conversationId: {
            type: 'string',
            description: 'Channel-native conversation id, when known. Omit to use the most recent invitation.',
          },
          ttlHours: { type: 'number', description: 'Optional lifetime override in hours (kernel-clamped).' },
        },
        required: ['goal', 'definitionOfDone'],
      },
    },
    async handle(input: unknown): Promise<string> {
      const args = (input ?? {}) as { goal?: string; definitionOfDone?: string; conversationId?: string; ttlHours?: number };
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      const definitionOfDone = typeof args.definitionOfDone === 'string' ? args.definitionOfDone.trim() : '';
      if (!goal || !definitionOfDone) {
        return de
          ? 'Start abgelehnt: goal und definitionOfDone sind Pflicht. Frage den Initiator nach Ziel und einer maschinell prüfbaren Definition-of-Done.'
          : 'Start refused: goal and definitionOfDone are required. Ask the initiator for the goal and a machine-checkable definition of done.';
      }
      const ephemeralRuns = deps.getEphemeralRuns();
      if (!ephemeralRuns) {
        return de
          ? 'Start nicht möglich: der Kernel stellt keinen conductorEphemeralRuns-Service bereit (Kernel < #330 Workstream A, oder keine Datenbank). Bitte den Operator informieren.'
          : 'Cannot start: the kernel does not publish the conductorEphemeralRuns service (kernel < #330 Workstream A, or no database). Please inform the operator.';
      }

      const pending = resolveRecord(args.conversationId);
      const conversationId = args.conversationId?.trim() || pending?.conversationId;
      if (!conversationId) {
        // Refusing beats a colliding synthetic key (review L4): after a
        // restart there is no pending record to fall back on.
        return de
          ? 'Start abgelehnt: Ich kenne keine Ziel-Konversation (keine ausstehende Einladung, keine conversationId). Bitte die conversationId mitgeben.'
          : 'Start refused: no target conversation known (no pending invitation, no conversationId). Please pass the conversationId.';
      }
      if (pending?.phase === 'active') {
        return de
          ? `Es läuft bereits eine Facilitation in dieser Konversation (Run ${pending.runId ?? '?'}). Genau EINE pro Konversation — nutze facilitation_status.`
          : `A facilitation is already active in this conversation (run ${pending.runId ?? '?'}). Exactly ONE per conversation — use facilitation_status.`;
      }

      const ttlHours =
        typeof args.ttlHours === 'number' && Number.isFinite(args.ttlHours) && args.ttlHours > 0
          ? args.ttlHours
          : config.defaultTtlHours;

      // #330 C2b - per-conversation initiator role, auto-assigned to the
      // inviter. Degrades to the configured default role when the kernel
      // predates C2a or no invite context exists.
      let initiatorRoleKey = config.initiatorRoleKey;
      const roleAssignments = deps.getRoleAssignments();
      if (roleAssignments && pending) {
        const candidateKey = facilitationRoleKey(conversationId);
        const holder = await resolveInitiatorHolder(pending);
        if (holder) {
          try {
            await roleAssignments.ensureRole({
              roleKey: candidateKey,
              label: `Facilitation initiator (${conversationId.slice(0, 24)})`,
              description: 'Auto-provisioned per-conversation initiator role (#330 C2b) - disposed with the facilitation.',
            });
            await roleAssignments.addHolder({
              roleKey: candidateKey,
              holderId: holder.holderId,
              actor: `plugin:${deps.agentId}`,
            });
            initiatorRoleKey = candidateKey;
            deps.log(`initiator role ${candidateKey} -> ${holder.holderId} (${holder.via})`);
          } catch (err) {
            deps.log(`initiator role provisioning failed - falling back to '${config.initiatorRoleKey}': ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      let handle;
      try {
        handle = await ephemeralRuns.createEphemeralRun({
          agentId: deps.agentId,
          patternId: 'facilitation',
          slots: {
            agents: { facilitator: config.facilitatorAgentSlug },
            roles: { initiator: initiatorRoleKey },
            channels: { report: config.reportChannelType },
          },
          payload: { goal, definitionOfDone },
          ttlMs: ttlHours * HOUR_MS,
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`facilitation_start failed: ${name}: ${message}`);
        if (name === 'EphemeralQuotaExceededError') {
          return de
            ? `Start abgelehnt (Kernel-Guardrail): ${message}. Später erneut versuchen oder laufende Facilitations beenden lassen.`
            : `Start refused (kernel guardrail): ${message}. Retry later or let running facilitations finish.`;
        }
        return de
          ? `Start fehlgeschlagen: ${message}`
          : `Start failed: ${message}`;
      }

      store.markActive({
        conversationId,
        goal,
        definitionOfDone,
        runId: handle.runId,
        workflowSlug: handle.workflowSlug,
        expiresAt: handle.expiresAt,
        roleKey: initiatorRoleKey,
      });

      // Tie the auto-bind + role to the run so the kernel reaper disposes of
      // them with the workflow. Best-effort: a miss only means the binding
      // falls back to its pending expiry.
      const conversationBindings = deps.getConversationBindings();
      if (conversationBindings && pending?.channelType) {
        await conversationBindings
          .attachWorkflow({
            agentSlug: config.facilitatorAgentSlug,
            channelType: pending.channelType,
            conversationId,
            workflowId: handle.workflowId,
            roleKey: initiatorRoleKey,
            expiresAt: new Date(handle.expiresAt),
          })
          .then((r) => {
            if (!r.attached) deps.log('attachWorkflow did not take (no owned pending row) - binding stays on its invite expiry');
          })
          .catch((err: unknown) => deps.log(`attachWorkflow failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      const disclosure = config.discloseReportTarget
        ? de
          ? `Das Ergebnis (und ggf. Zwischenstände) berichte ich an role:${initiatorRoleKey}.`
          : `I will report the result (and interim status, if configured) to role:${initiatorRoleKey}.`
        : '';
      const handshake = de
        ? [
            'Ich bin der omadia Facilitator und moderiere diese Konversation ab jetzt zu einem definierten Ergebnis.',
            `Ziel: ${goal}`,
            `Definition of Done: ${definitionOfDone}`,
            `Deadline/TTL: ${handle.expiresAt}`,
            disclosure,
            'Mit "/facilitator status" bekommt ihr jederzeit den Stand; "/facilitator stop" beendet die Moderation.',
          ]
        : [
            'I am the omadia Facilitator and will moderate this conversation toward a defined outcome from now on.',
            `Goal: ${goal}`,
            `Definition of Done: ${definitionOfDone}`,
            `Deadline/TTL: ${handle.expiresAt}`,
            disclosure,
            'Use "/facilitator status" any time for the current state; "/facilitator stop" ends the moderation.',
          ];
      return handshake.filter((l) => l.length > 0).join('\n');
    },
  };

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
      const args = (input ?? {}) as { conversationId?: string };
      const record = resolveRecord(args.conversationId);
      if (!record) {
        return de
          ? 'Keine Facilitation bekannt (auch keine ausstehende Einladung). Hinweis: Nach einem Middleware-Neustart geht der lokale Status verloren — der Conductor-Run selbst läuft davon unabhängig weiter.'
          : 'No facilitation known (and no pending invitation). Note: local state is lost on a middleware restart — the Conductor run itself keeps running independently.';
      }
      return describe(record);
    },
  };

  const stop: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_stop',
      description:
        'End the moderation for this conversation ("/facilitator stop"): marks the facilitation stopped and returns the closing announcement to post. Honest limitation: the underlying Conductor run continues until its deadline/TTL fallback — this stops the moderation, not the workflow.',
      input_schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: [],
      },
    },
    async handle(input: unknown): Promise<string> {
      const args = (input ?? {}) as { conversationId?: string };
      const record = resolveRecord(args.conversationId);
      if (!record) {
        return de ? 'Keine Facilitation zum Beenden bekannt.' : 'No facilitation known to stop.';
      }
      store.markStopped(record.conversationId);
      const stopRole = record.roleKey ?? config.initiatorRoleKey;
      return de
        ? `Die Moderation ist beendet (announced stop). Der zugrundeliegende Workflow-Run ${record.runId ?? ''} läuft bis zu seiner Deadline/TTL weiter und meldet dann Ergebnis oder Abbruch an role:${stopRole}.`
        : `Moderation ended (announced stop). The underlying workflow run ${record.runId ?? ''} continues until its deadline/TTL and will then report result or abort to role:${stopRole}.`;
    },
  };

  const report: LocalSubAgentTool = {
    spec: {
      name: 'facilitation_report',
      description:
        "Deliver a report to the facilitation's initiator (role fan-out to all current holders via the kernel targetedSend service). kind 'final' for the confirmed result or the failure report; 'interim' for status updates (only sent when reporting_mode=interim).",
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['final', 'interim'], description: "Report kind: 'final' or 'interim'." },
          text: { type: 'string', description: 'The report text to deliver.' },
        },
        required: ['kind', 'text'],
      },
    },
    async handle(input: unknown): Promise<string> {
      const args = (input ?? {}) as { kind?: string; text?: string };
      const kind = args.kind === 'interim' ? 'interim' : 'final';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return de ? 'Report abgelehnt: text ist leer.' : 'Report refused: text is empty.';
      const activeRoleKey = store.latest()?.roleKey;
      const result = await sendReport(
        { targetedSend: deps.getTargetedSend(), config, log: deps.log, ...(activeRoleKey ? { roleKey: activeRoleKey } : {}) },
        kind,
        text,
      );
      return result.summary;
    },
  };

  return [start, status, stop, report];
}
