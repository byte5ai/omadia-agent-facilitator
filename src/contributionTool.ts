// facilitation_contribution (0.7.3). Live run 2026-11-18: a participant's
// vote was relayed to the facilitator three times and never recorded — the
// model read the status, judged the vote ("not on the list", "cannot assign
// it myself") and answered without calling facilitation_progress. Recording
// a contribution is now ONE narrow tool with no judgement left to the model:
// name + what was contributed. The tool checks the name against the real
// roster, keeps a per-participant ledger and says who is still pending.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { buildParticipantOverview, loadHumanRoster } from './participants.js';
import { SNAPSHOT_CONTRIBUTION_MAX_CHARS, SNAPSHOT_CONTRIBUTOR_MAX_CHARS, SNAPSHOT_MAX_CONTRIBUTIONS } from './persistence.js';
import type { ToolContext } from './toolkit.js';

export function buildContributionTool(tc: ToolContext): LocalSubAgentTool {
  const { deps, de } = tc;

  return {
    spec: {
      name: 'facilitation_contribution',
      description:
        "Record ONE participant's contribution (a vote, an answer, a confirmation) in the running facilitation. Call it EVERY time a contribution is relayed to you — whether the participant posted it or someone (e.g. the initiator) passes it on for them. You are the minute-taker here, not a judge: never turn a contribution away, never ask for a confirmation first, never check the name yourself (names in your context can be privacy placeholders). Pass the name and the contribution exactly as you have them; the tool verifies the name against the real roster and answers with the standing and who is still pending. A second contribution by the same participant replaces the first.",
      input_schema: {
        type: 'object',
        properties: {
          participant: { type: 'string', description: 'Name of the participant, exactly as given to you.' },
          contribution: { type: 'string', description: 'What they contributed, verbatim where possible (e.g. "Parken wir das 3, Müsli 2, Windstill 1").' },
          conversationId: { type: 'string', description: 'Channel-native conversation id, when known.' },
        },
        required: ['participant', 'contribution'],
      },
    },
    async handle(input: unknown): Promise<string> {
      await tc.hydrator.ensure();
      const args = (input ?? {}) as { participant?: string; contribution?: string; conversationId?: string };
      const participant = typeof args.participant === 'string' ? args.participant.trim().slice(0, SNAPSHOT_CONTRIBUTOR_MAX_CHARS) : '';
      const text = typeof args.contribution === 'string' ? args.contribution.trim().slice(0, SNAPSHOT_CONTRIBUTION_MAX_CHARS) : '';
      if (!participant || !text) {
        return de
          ? 'Beitrag abgelehnt: participant und contribution sind Pflicht.'
          : 'Contribution refused: participant and contribution are required.';
      }
      const resolved = await tc.resolveRecordStrict(args.conversationId, true);
      if (resolved === 'ambiguous') {
        return de
          ? 'Mehrere aktive Facilitations — bitte conversationId angeben, damit der Beitrag der richtigen zugeordnet wird.'
          : 'Multiple active facilitations — pass conversationId so the contribution lands on the right one.';
      }
      const record = resolved;
      if (!record || record.phase !== 'active') {
        return de
          ? 'Keine aktive Facilitation bekannt — Beitrag nicht protokolliert.'
          : 'No active facilitation known — contribution not recorded.';
      }

      // The roster decides who the name is. Without one it is taken as given.
      let name = participant;
      let roster: { participants: string[]; partial: boolean } | undefined;
      if (!record.conversationUnknown) {
        roster = await loadHumanRoster(deps.getConversationRosters(), record.channelType, record.conversationId, deps.log);
        if (roster && roster.participants.length > 0) {
          const match = buildParticipantOverview(roster, [participant]);
          if (match.unmatched.length > 0) {
            const known = roster.participants.join(', ');
            return de
              ? `Beitrag NICHT protokolliert: „${participant}“ passt auf keine oder mehrere Personen der Teilnehmerliste. Gültige Namen: ${known}. Rufe facilitation_contribution mit dem vollen Namen aus dieser Liste erneut auf; ist unklar, wer gemeint ist, frag nach dem vollen Namen.`
              : `Contribution NOT recorded: "${participant}" matches no participant, or more than one. Valid names: ${known}. Call facilitation_contribution again with the full name from this list; if it is unclear who is meant, ask for the full name.`;
          }
          name = match.contributed[0] ?? participant;
        }
      }

      const before = record.contributions?.some((c) => c.participant === name) ?? false;
      const next = tc.store.recordContribution(record.conversationId, { participant: name, text }, tc.now(), SNAPSHOT_MAX_CONTRIBUTIONS);
      if (!next) {
        return de
          ? `Beitrag NICHT protokolliert: das Limit von ${String(SNAPSHOT_MAX_CONTRIBUTIONS)} Beitragenden ist erreicht.`
          : `Contribution NOT recorded: the limit of ${String(SNAPSHOT_MAX_CONTRIBUTIONS)} contributors is reached.`;
      }
      await tc.persister.persist(record.conversationId);

      const contributors = (next.contributions ?? []).map((c) => c.participant);
      const lines = [
        de
          ? `Beitrag von ${name} protokolliert${before ? ' (ersetzt den früheren Beitrag)' : ''}: ${text}`
          : `Contribution by ${name} recorded${before ? ' (replaces the earlier one)' : ''}: ${text}`,
      ];
      if (roster && roster.participants.length > 0) {
        const overview = buildParticipantOverview(roster, contributors);
        const total = overview.participants.length;
        lines.push(
          de
            ? `Stand: ${String(overview.contributed.length)} von ${String(total)}. Ausstehend: ${overview.pending.length > 0 ? overview.pending.join(', ') : '–'}`
            : `Standing: ${String(overview.contributed.length)} of ${String(total)}. Pending: ${overview.pending.length > 0 ? overview.pending.join(', ') : '–'}`,
        );
        if (overview.pending.length === 0 && !overview.partial) {
          lines.push(
            de
              ? 'Alle Teilnehmenden haben beigetragen. Prüfe jetzt die Definition of Done und rufe, wenn sie erfüllt ist, facilitation_progress mit dodMet=true und dem Ergebnis als summary auf.'
              : 'Every participant has contributed. Check the definition of done now and, if it is met, call facilitation_progress with dodMet=true and the outcome as summary.',
          );
        }
      } else {
        lines.push(de ? `Beiträge bisher: ${String(contributors.length)}.` : `Contributions so far: ${String(contributors.length)}.`);
      }
      return lines.join('\n');
    },
  };
}
