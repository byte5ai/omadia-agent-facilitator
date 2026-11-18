// facilitation_nudge (split out of toolkit.ts in 0.7.0). The one proactive
// post into the group. Every gate is deterministic and runs BEFORE delivery:
// operator switch → audience resolution → nudge policy (nudgePolicy.ts) →
// per-facilitation cap → kernel scope check inside conversationSend.

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { checkNudgePolicy, describeNudgeRefusal } from './nudgePolicy.js';
import type { ToolContext } from './toolkit.js';

// The counter is part of the persisted run state (0.6.0), so the cap holds
// per facilitation across restarts. Writes are best-effort: on a kernel
// without saveRunState it degrades to the old per-process cap, and the TTL
// still bounds the total blast radius.
export const MAX_NUDGES_PER_FACILITATION = 12;

export function buildNudgeTool(tc: ToolContext): LocalSubAgentTool {
  const { deps, de } = tc;
  const { config } = deps;

  return {
    spec: {
      name: 'facilitation_nudge',
      description:
        'Post a short, activating moderation message INTO the facilitated group conversation (proactive — used by the hourly assess tick when the group looks stalled). The kernel only delivers into conversations this facilitation owns. The tool itself refuses when a nudge is out of place (definition of done met, deadline passed, fresh progress, last nudge too recent, quiet hours, cap reached) — relay such a refusal, never work around it.',
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
      await tc.hydrator.ensure();
      const args = (input ?? {}) as { text?: string; conversationId?: string };
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return de ? 'Nudge abgelehnt: text ist leer.' : 'Nudge refused: text is empty.';
      if (!config.nudgesEnabled) {
        return de ? 'Nudges sind deaktiviert (nudges_enabled=false).' : 'Nudges are disabled (nudges_enabled=false).';
      }
      const resolved = await tc.resolveRecordStrict(args.conversationId);
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
      const refusal = checkNudgePolicy(record, config, tc.now());
      if (refusal) return describeNudgeRefusal(refusal, de);

      const conversationSend = deps.getConversationSend();
      if (!conversationSend) {
        return de
          ? 'Nudge nicht möglich: der Kernel stellt keinen conversationSend-Service bereit (Kernel < #330 C3).'
          : 'Cannot nudge: the kernel does not publish the conversationSend service (kernel < #330 C3).';
      }
      const reserved = tc.store.reserveNudge(record.conversationId, MAX_NUDGES_PER_FACILITATION);
      if (reserved === undefined) {
        return de
          ? `Nudge-Limit erreicht (${String(MAX_NUDGES_PER_FACILITATION)} pro Facilitation) — nicht gesendet.`
          : `Nudge cap reached (${String(MAX_NUDGES_PER_FACILITATION)} per facilitation) — not sent.`;
      }
      // Persist the reservation BEFORE delivery: a restart mid-send must
      // count the nudge, never hand out a fresh slot.
      await tc.persister.persist(record.conversationId);
      const outcome = await conversationSend
        .sendToConversation({
          agentSlug: config.facilitatorAgentSlug,
          channelType: record.channelType ?? config.reportChannelType,
          conversationId: record.conversationId,
          message: { text },
        })
        .catch((err: unknown) => ({ outcome: 'unreachable' as const, code: 'error', message: err instanceof Error ? err.message : String(err) }));
      if (outcome.outcome === 'delivered') {
        tc.store.recordNudgeDelivered(record.conversationId, text, tc.now());
        await tc.persister.persist(record.conversationId);
        return de
          ? `Nudge gesendet (${String(reserved)}/${String(MAX_NUDGES_PER_FACILITATION)}).`
          : `Nudge sent (${String(reserved)}/${String(MAX_NUDGES_PER_FACILITATION)}).`;
      }
      tc.store.releaseNudge(record.conversationId);
      await tc.persister.persist(record.conversationId);
      return de
        ? `Nudge NICHT zugestellt: ${outcome.code} — ${outcome.message}`
        : `Nudge NOT delivered: ${outcome.code} — ${outcome.message}`;
    },
  };
}
