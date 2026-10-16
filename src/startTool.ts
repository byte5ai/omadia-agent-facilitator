// facilitation_start (#330 C1, split out of toolkit.ts in 0.6.0). Creates
// exactly ONE ephemeral Conductor run per conversation and returns the
// opening handshake. Since 0.6.0 the run payload carries everything a
// restart needs to rebuild the facilitation (conversationId, channelType,
// initiator role, stated deadline) — the in-memory record is only a cache.

import { createHash } from 'node:crypto';

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { effectiveTtlHours, parseDeadline, wasClamped } from './deadline.js';
import type { FacilitationRecord } from './stateStore.js';
import type { ToolContext } from './toolkit.js';

const HOUR_MS = 60 * 60 * 1000;
// Allowlist (Teams ids: `19:…@thread.v2`, `a:…`, `29:…;messageid=…`): the id
// is rendered into pattern prompts via {{ctx.conversationId}}, so no braces,
// quotes, whitespace or control characters. `run:` is reserved for restored
// pre-0.6.0 runs whose conversation is unknown (rehydrate.ts).
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:@._;=+/,!#$%-]{1,256}$/;
const RESERVED_CONVERSATION_ID_PREFIX = 'run:';

/** Stable, readable per-conversation role key - Teams conversation ids are
 *  long and symbol-heavy, the hash keeps the key clean and collision-safe. */
export function facilitationRoleKey(conversationId: string): string {
  return `facilitation-${createHash('sha256').update(conversationId).digest('hex').slice(0, 12)}`;
}

export function isValidConversationId(conversationId: string): boolean {
  return CONVERSATION_ID_PATTERN.test(conversationId) && !conversationId.startsWith(RESERVED_CONVERSATION_ID_PREFIX);
}

export function buildStartTool(tc: ToolContext): LocalSubAgentTool {
  const { deps, de } = tc;
  const { config } = deps;

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

  return {
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
          deadline: {
            type: 'string',
            description:
              'Pass whenever the goal or the initiator states a deadline (e.g. "vote by Friday 15:00"): ISO 8601 date-time WITH timezone offset, e.g. "2026-10-16T15:00:00+02:00". The workflow then lives until the deadline plus a closing round.',
          },
          ttlHours: { type: 'number', description: 'Optional lifetime override in hours (kernel-clamped). Prefer deadline when one is stated.' },
        },
        required: ['goal', 'definitionOfDone'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await tc.hydrator.ensure();
      const args = (input ?? {}) as { goal?: string; definitionOfDone?: string; conversationId?: string; deadline?: string; ttlHours?: number };
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

      const now = tc.now();
      let deadline: { date: Date; value: string } | undefined;
      if (typeof args.deadline === 'string' && args.deadline.trim().length > 0) {
        const parsed = parseDeadline(args.deadline, now);
        const shown = args.deadline.trim().slice(0, 64);
        if (!parsed.ok) {
          return parsed.reason === 'past'
            ? de
              ? `Start abgelehnt: die Deadline ${shown} liegt in der Vergangenheit. Bitte die korrekte Deadline beim Initiator erfragen.`
              : `Start refused: the deadline ${shown} is in the past. Ask the initiator for the correct deadline.`
            : de
              ? `Start abgelehnt: deadline '${shown}' ist kein ISO-Zeitpunkt mit Zeitzone (z.B. 2026-10-16T15:00:00+02:00).`
              : `Start refused: deadline '${shown}' is not an ISO date-time with timezone offset (e.g. 2026-10-16T15:00:00+02:00).`;
        }
        deadline = { date: parsed.date, value: parsed.value };
      }

      const pending = await tc.resolveRecord(args.conversationId);
      const conversationId = args.conversationId?.trim() || pending?.conversationId;
      if (!conversationId) {
        // Refusing beats a colliding synthetic key (review L4): after a
        // restart there is no pending record to fall back on.
        return de
          ? 'Start abgelehnt: Ich kenne keine Ziel-Konversation (keine ausstehende Einladung, keine conversationId). Bitte die conversationId mitgeben.'
          : 'Start refused: no target conversation known (no pending invitation, no conversationId). Please pass the conversationId.';
      }
      if (!isValidConversationId(conversationId)) {
        return de
          ? 'Start abgelehnt: die conversationId ist ungültig (erlaubt: bis 256 Zeichen aus Buchstaben, Ziffern und :@._;=+/,!#$%-; kein "run:"-Präfix).'
          : 'Start refused: the conversationId is invalid (allowed: up to 256 letters, digits and :@._;=+/,!#$%-; no "run:" prefix).';
      }
      if (pending?.phase === 'active') {
        return de
          ? `Es läuft bereits eine Facilitation in dieser Konversation (Run ${pending.runId ?? '?'}). Genau EINE pro Konversation — nutze facilitation_status.`
          : `A facilitation is already active in this conversation (run ${pending.runId ?? '?'}). Exactly ONE per conversation — use facilitation_status.`;
      }

      const requestedTtlHours =
        typeof args.ttlHours === 'number' && Number.isFinite(args.ttlHours) && args.ttlHours > 0
          ? args.ttlHours
          : config.defaultTtlHours;
      const ttlHours = effectiveTtlHours({ ttlHours: requestedTtlHours, ...(deadline ? { deadline: deadline.date } : {}), now });
      const ttlMs = Math.round(ttlHours * HOUR_MS);

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

      // #330 round 3 — lazy bind for `bot_present` records: the eligibility
      // came from an inbound group message, the BIND waits for this explicit
      // start. Best-effort: a refusal is logged and the facilitation still
      // runs (nudges then stay kernel-refused until a binding exists).
      if (pending?.bindPending && pending.channelType) {
        const bindings = deps.getConversationBindings();
        if (bindings) {
          try {
            const bound = await bindings.bind({
              agentSlug: config.facilitatorAgentSlug,
              channelType: pending.channelType,
              conversationId,
            });
            deps.log(
              bound.bound
                ? `lazy-bound ${pending.channelType}/${conversationId} at facilitation_start`
                : `lazy bind refused at start: ${bound.reason ?? 'unknown'}`,
            );
          } catch (err) {
            deps.log(`lazy bind failed at start: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // The payload is the durable half of the facilitation: rehydrate.ts
      // rebuilds the record from it after a restart, and the pattern prompts
      // render conversationId/deadline from the run context.
      const payload: Record<string, unknown> = {
        goal,
        definitionOfDone,
        conversationId,
        ...(pending?.channelType ? { channelType: pending.channelType } : {}),
        ...(deadline ? { deadline: deadline.value } : {}),
        initiatorRoleKey,
      };

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
          payload,
          ttlMs,
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

      tc.store.markActive({
        conversationId,
        goal,
        definitionOfDone,
        runId: handle.runId,
        workflowSlug: handle.workflowSlug,
        expiresAt: handle.expiresAt,
        roleKey: initiatorRoleKey,
        ...(deadline ? { deadline: deadline.value } : {}),
      });
      await tc.persister.persist(conversationId);

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

      return handshake({ goal, definitionOfDone, initiatorRoleKey, expiresAt: handle.expiresAt, deadline: deadline?.value, clamped: wasClamped(ttlMs, handle.expiresAt, tc.now()), ttlHours });
    },
  };

  function handshake(h: {
    goal: string;
    definitionOfDone: string;
    initiatorRoleKey: string;
    expiresAt: string;
    deadline: string | undefined;
    clamped: boolean;
    ttlHours: number;
  }): string {
    const disclosure = config.discloseReportTarget
      ? de
        ? `Das Ergebnis (und ggf. Zwischenstände) berichte ich an role:${h.initiatorRoleKey}.`
        : `I will report the result (and interim status, if configured) to role:${h.initiatorRoleKey}.`
      : '';
    const timing = h.deadline
      ? [`Deadline: ${h.deadline}`, de ? `Workflow-Laufzeit (TTL) bis: ${h.expiresAt}` : `Workflow lifetime (TTL) until: ${h.expiresAt}`]
      : [`Deadline/TTL: ${h.expiresAt}`];
    let clampNote = '';
    if (h.clamped) {
      const beforeDeadline = h.deadline !== undefined && Date.parse(h.expiresAt) < Date.parse(h.deadline);
      clampNote = de
        ? `Achtung: Der Kernel hat die Laufzeit begrenzt (angefragt ${h.ttlHours.toFixed(1)} h, gewährt bis ${h.expiresAt}).` +
          (beforeDeadline ? ' Das liegt VOR der Deadline — ohne Ergebnis bis dahin endet die Facilitation vorzeitig. Bitte den Operator informieren.' : '')
        : `Note: the kernel capped the lifetime (requested ${h.ttlHours.toFixed(1)} h, granted until ${h.expiresAt}).` +
          (beforeDeadline ? ' That is BEFORE the deadline — without a result by then the facilitation ends early. Please inform the operator.' : '');
    }
    const lines = de
      ? [
          'Ich bin der omadia Facilitator und moderiere diese Konversation ab jetzt zu einem definierten Ergebnis.',
          `Ziel: ${h.goal}`,
          `Definition of Done: ${h.definitionOfDone}`,
          ...timing,
          clampNote,
          disclosure,
          'Mit "/facilitator status" bekommt ihr jederzeit den Stand; "/facilitator stop" beendet die Moderation.',
        ]
      : [
          'I am the omadia Facilitator and will moderate this conversation toward a defined outcome from now on.',
          `Goal: ${h.goal}`,
          `Definition of Done: ${h.definitionOfDone}`,
          ...timing,
          clampNote,
          disclosure,
          'Use "/facilitator status" any time for the current state; "/facilitator stop" ends the moderation.',
        ];
    return lines.filter((l) => l.length > 0).join('\n');
  }
}
