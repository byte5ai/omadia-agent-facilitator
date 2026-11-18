// Tools for the lifecycle and for authenticated contributions.

import * as store from '../db/store.js';
import type { ContributionKind } from '../model.js';
import { askClarification, authorOf, recordContribution } from '../engine/contributions.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { abortFacilitation, configureFacilitation, openFacilitation } from '../engine/lifecycle.js';
import { statusText } from '../engine/status.js';
import { defineTool, liveFacilitation, oneOf, optionalString, requiredString } from './toolkit.js';
import type { ResolvedContext, ToolDefinition } from './toolkit.js';

const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  'idea',
  'position',
  'concern',
  'question',
  'proposal',
  'vote',
  'confirmation',
  'objection',
  'abstention',
  'commitment',
];

/** The kernel's stored event for a message of this conversation, or a refusal. */
export async function storedMessage(engine: FacilitationEngine, ctx: ResolvedContext, messageId: string) {
  const messages = engine.core.deps.kernel.messages();
  if (!messages) throw new Refusal('no_message_service', 'The kernel does not provide stored messages; nothing can be recorded.');
  const record = await messages.getEvent({ agentSlug: ctx.agentSlug, channelType: ctx.channelType, conversationId: ctx.conversationId }, messageId);
  if (!record) {
    throw new Refusal(
      'unknown_message',
      'The kernel has no such message for this conversation. It may belong to another conversation, be older than this facilitation, or not exist. Use the message id from the turn input.',
    );
  }
  return record;
}

export function lifecycleTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_start',
        description:
          'Set up a facilitation in THIS group conversation when a person here asks for it. That person becomes the initiator (say so in the group). Creates it in the phase "configuring"; calling it again adjusts the setup. Agree goal, definition of done, format and deadline with the group, then call facilitation_open. Refuses when the facilitator has no identity of its own here or cannot read every message.',
        properties: {
          goal: { type: 'string', description: 'What the group wants to reach.' },
          definitionOfDone: { type: 'string', description: 'When the facilitation is done, in the words agreed with the group.' },
          deadline: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-11-21T17:00:00+01:00.' },
          timezone: { type: 'string', description: 'IANA timezone of the group.' },
          language: { type: 'string', enum: ['de', 'en'] },
          facilitatorName: { type: 'string', description: 'Your own display name, for the handshake.' },
        },
        required: ['goal', 'definitionOfDone'],
      },
      async (args, ctx) => {
        if (!ctx.callerPrincipalId) throw new Refusal('no_caller', 'The kernel did not state who asked. A facilitation needs an initiator.');
        const deadline = optionalString(args, 'deadline');
        const timezone = optionalString(args, 'timezone');
        const language = oneOf(args, 'language', ['de', 'en'] as const);
        const name = optionalString(args, 'facilitatorName');
        const result = await configureFacilitation(engine.core, {
          ...ctx,
          callerPrincipalId: ctx.callerPrincipalId,
          goal: requiredString(args, 'goal'),
          definitionOfDone: requiredString(args, 'definitionOfDone'),
          ...(deadline ? { deadline } : {}),
          ...(timezone ? { timezone } : {}),
          ...(language ? { language } : {}),
          ...(name ? { facilitatorName: name } : {}),
        });
        engine.ensureAttached(ctx.agentSlug);
        const people = result.participants.map((p) => p.displayName).join(', ') || 'not known yet';
        return [
          result.created ? 'Facilitation created, phase: configuring.' : 'Setup updated, phase: configuring.',
          `Participants: ${people}.`,
          ...result.notes.map((n) => `Tell the group: ${n}`),
          'Agree the setup with the group. Then call facilitation_open: the engine posts the handshake itself.',
        ].join('\n');
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_open',
        description:
          'Open the facilitation once the group agreed on the setup. The engine posts the opening handshake in the group (you do not write it) and starts recording contributions.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        await openFacilitation(engine.core, f.id);
        return `Opened. The handshake was posted in the group. Answer ${'[silent]'} now unless something else needs saying.`;
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_status',
        description: 'The current state of this facilitation as the engine computed it: phase, who has contributed, who has not, deadline. Use it instead of counting yourself.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        return statusText(engine.core.pool(), f);
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_contribution',
        description:
          'Record what ONE person said in free text, for the author of that message. Pass the message id from the turn input. The engine takes author, time and revision from the stored message, asks the author to confirm, and counts it only after they did. Refused for a message from another conversation, from before the start, from a non-participant, or one that quotes or forwards somebody else.',
        properties: {
          messageId: { type: 'string', description: 'The message id from the turn input.' },
          kind: { type: 'string', enum: [...CONTRIBUTION_KINDS] },
          summary: { type: 'string', description: 'What the person said, in one sentence, in the language of the group. Shown to them for confirmation.' },
        },
        required: ['messageId', 'kind', 'summary'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const record = await storedMessage(engine, ctx, requiredString(args, 'messageId'));
        const kind = oneOf(args, 'kind', CONTRIBUTION_KINDS);
        if (!kind) throw new Refusal('bad_input', "'kind' is required.");
        const summary = requiredString(args, 'summary');
        return engine.core.work(f.id, async (w) => {
          const author = await authorOf(w, record);
          const step = await store.openStepOf(w.tx, w.f.id);
          if (!step) throw new Refusal('no_open_step', 'No step is open; there is nothing to contribute to right now.');
          const existing = await store.findLiveBySourceMessage(w.tx, w.f.id, record.messageId);
          if (existing && existing.sourceRevision === record.revision && existing.status !== 'ambiguous') {
            return `Already recorded for ${author.displayName} (${existing.status}).`;
          }
          await recordContribution(w, { record, author, step, kind, payload: { text: summary }, summary, interpreted: true });
          return `Recorded for ${author.displayName} as unconfirmed. The engine asked ${author.displayName} to confirm; it counts once they did. Do not repeat the question.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_clarify',
        description: 'Ask the author of an unclear message ONE clarifying question. The engine posts it and keeps the message out of the count until it is resolved. A second call for the same message does nothing.',
        properties: {
          messageId: { type: 'string' },
          question: { type: 'string', description: 'The question, in the language of the group, without the name (the engine adds it).' },
        },
        required: ['messageId', 'question'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const record = await storedMessage(engine, ctx, requiredString(args, 'messageId'));
        const question = requiredString(args, 'question');
        return engine.core.work(f.id, async (w) => {
          const author = await authorOf(w, record);
          const step = await store.openStepOf(w.tx, w.f.id);
          if (!step) throw new Refusal('no_open_step', 'No step is open.');
          const outcome = await askClarification(w, { record, author, step, question });
          return outcome === 'asked'
            ? `Asked ${author.displayName}. Do not ask again; answer [silent].`
            : `${author.displayName} was already asked about this message. Nothing was posted.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_stop',
        description: 'End the facilitation without a result when the group asks for it or it cannot go on. The engine posts an honest report in the group.',
        properties: { reason: { type: 'string', description: 'Why it ends, in the language of the group.' } },
        required: ['reason'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        await abortFacilitation(engine.core, f.id, { reason: requiredString(args, 'reason'), actor: 'facilitator' });
        return 'Ended without a result. The report was posted in the group.';
      },
    ),
  ];
}
