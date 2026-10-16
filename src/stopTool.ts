// facilitation_stop (split out of toolkit.ts in 0.6.0). Order: final stop
// report to the initiator (a cancelled run sends no abort report of its
// own) → cancel the run through the kernel → local stopped marker → durable
// 'stopped' only when the run keeps going (kernel without cancelOwnRun or a
// failed cancel), so a restart does not resume the moderation.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { sendReport } from './reporting.js';
import type { FacilitationRecord } from './stateStore.js';
import type { ToolContext } from './toolkit.js';

export function buildStopTool(tc: ToolContext): LocalSubAgentTool {
  const { deps, de } = tc;
  const { config } = deps;

  /** Stop note for the initiator: why it ended and the last recorded state. */
  function stopReportText(record: FacilitationRecord): string {
    const lines = [
      de
        ? `Die Facilitation wurde per "/facilitator stop" beendet (Konversation ${record.conversationId}).`
        : `The facilitation was ended via "/facilitator stop" (conversation ${record.conversationId}).`,
    ];
    if (record.goal) lines.push(de ? `Ziel: ${record.goal}` : `Goal: ${record.goal}`);
    lines.push(
      record.progress
        ? de
          ? `Letzter protokollierter Stand (${record.progress.updatedAt}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`
          : `Last recorded state (${record.progress.updatedAt}): dodMet=${String(record.progress.dodMet)} — ${record.progress.summary}`
        : de
          ? 'Es wurde kein Fortschritt protokolliert.'
          : 'No progress was recorded.',
    );
    return lines.join('\n');
  }

  /** Cancel the run through the kernel. 'unavailable' = kernel without
   *  cancelOwnRun or the call threw — the run then keeps going to its TTL. */
  async function cancelRun(runId: string): Promise<'cancelled' | 'already_ended' | 'not_found' | 'unavailable'> {
    const ephemeralRuns = deps.getEphemeralRuns();
    if (!ephemeralRuns || typeof ephemeralRuns.cancelOwnRun !== 'function') return 'unavailable';
    try {
      const result = await ephemeralRuns.cancelOwnRun({ agentId: deps.agentId, runId, reason: 'facilitation_stop' });
      if (result.cancelled) return 'cancelled';
      return result.reason === 'already_ended' ? 'already_ended' : 'not_found';
    } catch (err) {
      deps.log(`cancelOwnRun(${runId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'unavailable';
    }
  }

  return {
    spec: {
      name: 'facilitation_stop',
      description:
        'End the moderation for this conversation ("/facilitator stop"): sends the stop report (last recorded state) to the initiator, cancels the underlying Conductor run, marks the facilitation stopped and returns the closing announcement to post. On an older kernel without run cancel the run continues until its deadline/TTL — the returned text says which case applies.',
      input_schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: [],
      },
    },
    async handle(input: unknown): Promise<string> {
      await tc.hydrator.ensure();
      const args = (input ?? {}) as { conversationId?: string };
      // Strict: stopping cancels a durable run — never guess which one.
      const resolved = await tc.resolveRecordStrict(args.conversationId);
      if (resolved === 'ambiguous') {
        return de
          ? 'Mehrere aktive Facilitations — bitte conversationId angeben; ein Stop darf nicht raten, welche Facilitation er beendet.'
          : 'Multiple active facilitations — pass conversationId; a stop must not guess which facilitation it ends.';
      }
      const record = resolved;
      if (!record) {
        return de ? 'Keine Facilitation zum Beenden bekannt.' : 'No facilitation known to stop.';
      }
      if (record.phase === 'stopped') {
        return de ? 'Diese Facilitation ist bereits beendet.' : 'This facilitation has already been stopped.';
      }
      const stopRole = record.roleKey ?? config.initiatorRoleKey;
      if (record.phase !== 'active' || !record.runId) {
        // Never started: nothing to report or cancel.
        tc.store.markStopped(record.conversationId);
        return de
          ? 'Die Moderation ist beendet (announced stop). Es lief noch kein Workflow-Run.'
          : 'Moderation ended (announced stop). No workflow run had been started yet.';
      }

      // Order matters: report FIRST (the cancelled run sends no abort
      // report of its own), then cancel, then the local marker.
      const reportResult = await sendReport(
        { targetedSend: deps.getTargetedSend(), config, log: deps.log, roleKey: stopRole },
        'final',
        stopReportText(record),
      );
      const cancel = await cancelRun(record.runId);
      tc.store.markStopped(record.conversationId);
      // Only a run that keeps going needs the durable 'stopped' marker — a
      // cancelled/ended run is purged with its workflow anyway.
      if (cancel === 'unavailable') await tc.persister.persist(record.conversationId);
      deps.log(`facilitation_stop ${record.conversationId}: run ${record.runId} → ${cancel}`);

      const reportNote = ` ${reportResult.summary}`;
      if (cancel === 'cancelled') {
        return (
          (de
            ? `Die Moderation ist beendet (announced stop). Der Workflow-Run ${record.runId} wurde abgebrochen.`
            : `Moderation ended (announced stop). Workflow run ${record.runId} was cancelled.`) + reportNote
        );
      }
      if (cancel === 'already_ended' || cancel === 'not_found') {
        return (
          (de
            ? `Die Moderation ist beendet (announced stop). Der Workflow-Run ${record.runId} lief bereits nicht mehr.`
            : `Moderation ended (announced stop). Workflow run ${record.runId} was no longer running.`) + reportNote
        );
      }
      return (
        (de
          ? `Die Moderation ist beendet (announced stop). Der zugrundeliegende Workflow-Run ${record.runId} konnte nicht abgebrochen werden und läuft bis zu seiner Deadline/TTL weiter; danach meldet er Ergebnis oder Abbruch an role:${stopRole}.`
          : `Moderation ended (announced stop). The underlying workflow run ${record.runId} could not be cancelled and continues until its deadline/TTL; it will then report result or abort to role:${stopRole}.`) +
        reportNote
      );
    },
  };
}
