// The facilitator's turn. The kernel runs it (identity, neutrality block,
// model policy, privacy shield, receipts); the engine supplies the state of
// THIS facilitation and decides what is posted.
//
// The context below is built from the tables of one facilitation and nothing
// else, so a facilitator never carries anything from one facilitation into
// another.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Facilitation } from '../model.js';
import { formatWhen } from '../texts/index.js';
import type { EngineCore } from './core.js';
import { isSilent } from './guard.js';
import { playbook } from './playbook.js';
import { participationOf } from './status.js';

export const SILENT = '[silent]';

export type ContextSection = (q: Queryable, f: Facilitation) => Promise<string | undefined>;
const sections: ContextSection[] = [];

/** Later modules add what they know (agenda, proposal, means of the session). */
export function registerContextSection(section: ContextSection): void {
  if (!sections.includes(section)) sections.push(section);
}

export async function buildEngineContext(q: Queryable, f: Facilitation): Promise<string> {
  const dod = await store.currentDod(q, f.id);
  const participation = await participationOf(q, f);
  const lines = [
    '# Facilitation state (computed by the engine; it is the only source of truth)',
    `Phase: ${f.phase}. Language of the group: ${f.language}.`,
    `Goal: ${f.goal}`,
    `Definition of done (version ${String(dod?.version ?? 1)}): ${dod?.text ?? ''}`,
    ...(f.deadline ? [`Deadline: ${formatWhen(f.deadline, f.timezone, 'en')}`] : []),
    `Active participants: ${participation.active.map((p) => p.displayName).join(', ') || 'none known yet'}`,
    ...(participation.step
      ? [
          `Open step: "${participation.step.title}" (${participation.step.kind})`,
          `Contributed to it: ${participation.contributed.map((p) => p.displayName).join(', ') || 'nobody yet'}`,
          `Not yet: ${participation.missing.map((p) => p.displayName).join(', ') || 'nobody'}`,
        ]
      : []),
  ];
  for (const section of sections) {
    const text = await section(q, f);
    if (text) lines.push(text);
  }
  const book = playbook();
  if (book !== '') lines.push(book);
  lines.push(
    '# Rules of this turn',
    '- You never count, never work out who is missing and never decide whether the definition of done is met. The engine does; the state above is its answer.',
    '- A ballot in the announced format is recorded by the engine before you see anything. You only see free text.',
    '- To record what a person said, call facilitation_record_contribution with the message id from the input. It records it for the AUTHOR of that message only and asks them to confirm; it does not count before they did. You cannot record anything for somebody else.',
    '- If a message is unclear, call facilitation_clarify once for that message.',
    '- Never name in the group who has not contributed.',
    `- If nothing needs to be said, answer exactly ${SILENT}. Your answer is posted to the group as it is.`,
  );
  return lines.join('\n');
}

/** Run one turn for a free-text message and post the answer. */
export async function runFacilitatorTurn(engine: EngineCore, facilitationId: string, record: ConversationMessageRecord): Promise<void> {
  const pool = engine.pool();
  const f = await store.getFacilitation(pool, facilitationId);
  if (!f || (f.phase !== 'configuring' && f.phase !== 'active')) return;
  const agentTurn = engine.deps.kernel.agentTurn();
  if (!agentTurn) {
    engine.log(`facilitation ${f.id}: kernel service 'agentTurn' is not available; free text is not moderated`);
    return;
  }
  const outcome = await agentTurn.runTurn({
    agentSlug: f.facilitatorAgent,
    sessionKey: `facilitation:${f.id}`,
    channelType: f.channelType,
    conversationId: f.conversationId,
    inboundEventId: record.eventId,
    input: `From: ${record.author.displayName ?? record.author.id} (message id: ${record.messageId})\n${record.text ?? ''}`,
    engineContext: await buildEngineContext(pool, f),
  });
  if (outcome.outcome !== 'completed') {
    const detail = outcome.outcome === 'refused' ? `${outcome.code}: ${outcome.message}` : outcome.message;
    engine.log(`facilitation ${f.id}: facilitator turn ${outcome.outcome} (${detail})`);
    await engine.work(f.id, (w) => w.event('turn_failed', 'engine', { outcome: outcome.outcome, detail, eventId: record.eventId }));
    return;
  }
  // The marker anywhere in the answer means: say nothing.
  if (isSilent(outcome.text)) return;
  await engine.work(f.id, async (w) => {
    w.post({
      purpose: 'moderation',
      key: `turn:${record.eventId}`,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['configuring', 'active'],
      text: outcome.text.trim(),
    });
  });
}
