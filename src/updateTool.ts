// facilitation_update (0.7.0). Field report 2026-11-17: the definition of
// done could not be corrected after the start, so every correction meant
// stop + start — and each restart left another hourly run behind. This tool
// changes goal / definition of done / deadline of the RUNNING facilitation
// in place; the run, its progress and its nudge accounting stay.
//
// The run payload is immutable, so the current wording lives in the record
// and in the persisted snapshot (persistence.ts → `amended`); the assess
// tick reads it through facilitation_status.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { parseDeadline } from './deadline.js';
import { SNAPSHOT_DOD_MAX_CHARS, SNAPSHOT_GOAL_MAX_CHARS } from './persistence.js';
import type { ToolContext } from './toolkit.js';

export function buildUpdateTool(tc: ToolContext): LocalSubAgentTool {
  const { de } = tc;

  return {
    spec: {
      name: 'facilitation_update',
      description:
        "Change the goal, the definition of done and/or the deadline of the RUNNING facilitation in place — no stop/start, progress and nudge accounting are kept. Call ONLY when the initiator explicitly asked for the change, and pass the initiator's wording verbatim: never add a condition (confirmation round, quorum, validation rule) nobody asked for.",
      input_schema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'New goal, in one sentence. Omit to keep the current one.' },
          definitionOfDone: { type: 'string', description: 'New definition of done, in the initiator’s wording. Omit to keep the current one.' },
          deadline: {
            type: 'string',
            description: 'New deadline: ISO 8601 date-time WITH timezone offset, e.g. "2026-10-16T15:00:00+02:00". Omit to keep the current one.',
          },
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: [],
      },
    },
    async handle(input: unknown): Promise<string> {
      await tc.hydrator.ensure();
      const args = (input ?? {}) as { goal?: string; definitionOfDone?: string; deadline?: string; conversationId?: string };
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      const definitionOfDone = typeof args.definitionOfDone === 'string' ? args.definitionOfDone.trim() : '';
      const rawDeadline = typeof args.deadline === 'string' ? args.deadline.trim() : '';
      if (!goal && !definitionOfDone && !rawDeadline) {
        return de
          ? 'Update abgelehnt: mindestens eines von goal, definitionOfDone oder deadline ist nötig.'
          : 'Update refused: pass at least one of goal, definitionOfDone or deadline.';
      }
      if (goal.length > SNAPSHOT_GOAL_MAX_CHARS || definitionOfDone.length > SNAPSHOT_DOD_MAX_CHARS) {
        return de
          ? `Update abgelehnt: goal darf höchstens ${String(SNAPSHOT_GOAL_MAX_CHARS)}, definitionOfDone höchstens ${String(SNAPSHOT_DOD_MAX_CHARS)} Zeichen haben.`
          : `Update refused: goal is limited to ${String(SNAPSHOT_GOAL_MAX_CHARS)} characters, definitionOfDone to ${String(SNAPSHOT_DOD_MAX_CHARS)}.`;
      }

      let deadline: string | undefined;
      if (rawDeadline) {
        const parsed = parseDeadline(rawDeadline, tc.now());
        const shown = rawDeadline.slice(0, 64);
        if (!parsed.ok) {
          return parsed.reason === 'past'
            ? de
              ? `Update abgelehnt: die Deadline ${shown} liegt in der Vergangenheit.`
              : `Update refused: the deadline ${shown} is in the past.`
            : de
              ? `Update abgelehnt: deadline '${shown}' ist kein ISO-Zeitpunkt mit Zeitzone (z.B. 2026-10-16T15:00:00+02:00).`
              : `Update refused: deadline '${shown}' is not an ISO date-time with timezone offset (e.g. 2026-10-16T15:00:00+02:00).`;
        }
        deadline = parsed.value;
      }

      // Strict: an update rewrites what a group is measured against — never guess which one.
      const resolved = await tc.resolveRecordStrict(args.conversationId);
      if (resolved === 'ambiguous') {
        return de
          ? 'Mehrere aktive Facilitations — bitte conversationId angeben; ein Update darf nicht raten, welche Facilitation es ändert.'
          : 'Multiple active facilitations — pass conversationId; an update must not guess which facilitation it changes.';
      }
      const record = resolved;
      if (!record || record.phase !== 'active') {
        return de
          ? 'Keine aktive Facilitation bekannt — nichts geändert. Eine neue Facilitation startet facilitation_start.'
          : 'No active facilitation known — nothing changed. Use facilitation_start for a new one.';
      }

      const next = tc.store.amend(record.conversationId, {
        ...(goal ? { goal } : {}),
        ...(definitionOfDone ? { definitionOfDone } : {}),
        ...(deadline ? { deadline } : {}),
      });
      await tc.persister.persist(record.conversationId);

      const lines = [de ? 'Facilitation aktualisiert (kein Neustart, Fortschritt bleibt erhalten).' : 'Facilitation updated (no restart, progress is kept).'];
      if (goal) lines.push(de ? `Ziel: ${goal}` : `Goal: ${goal}`);
      if (definitionOfDone) lines.push(`Definition of Done: ${definitionOfDone}`);
      if (deadline) lines.push(`Deadline: ${deadline}`);
      // The workflow lifetime was fixed at the start and cannot be stretched here.
      const expiresAt = next?.expiresAt;
      if (deadline && expiresAt && Date.parse(expiresAt) < Date.parse(deadline)) {
        lines.push(
          de
            ? `Achtung: Der Workflow läuft nur bis ${expiresAt} — das liegt VOR der neuen Deadline. Für die volle Laufzeit ist ein Neustart nötig (facilitation_stop, dann facilitation_start mit deadline).`
            : `Note: the workflow only lives until ${expiresAt} — BEFORE the new deadline. A restart is needed for the full lifetime (facilitation_stop, then facilitation_start with deadline).`,
        );
      }
      return lines.join('\n');
    },
  };
}
