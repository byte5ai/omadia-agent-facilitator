// Tools for the lifecycle and for authenticated contributions.

import * as store from '../db/store.js';
import type { ContributionKind, MethodId } from '../model.js';
import { parseBallot } from '../methods/ballot.js';
import { advance, putAgain, recordBallot, roundOptions, withoutTakenItems } from '../engine/decide.js';
import { askClarification, authorOf, recordContribution } from '../engine/contributions.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { FORMAT_IDS, STEP_KINDS } from '../engine/formats.js';
import { abortFacilitation, configureFacilitation, openFacilitation } from '../engine/lifecycle.js';
import type { AgendaStepInput } from '../engine/lifecycle.js';
import { statusText } from '../engine/status.js';
import { asObject, defineTool, liveFacilitation, requireReadable, numberList, oneOf, optionalNumber, optionalString, requiredString, stringList } from './toolkit.js';
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
  if (!messages) throw new Refusal('no_message_service', 'The messages of this conversation cannot be read right now; nothing can be recorded.');
  const record = await messages.getEvent({ agentSlug: ctx.agentSlug, channelType: ctx.channelType, conversationId: ctx.conversationId }, messageId);
  if (!record) {
    throw new Refusal(
      'unknown_message',
      'There is no such message in this conversation. It may belong to another conversation, be older than this facilitation, or not exist. Use the message id from the turn input.',
    );
  }
  return record;
}

/** Open a facilitation and say what the group can see now. Opened means the
 *  opening message is out; what this call queued is looked at, not assumed. */
async function openAndReport(engine: FacilitationEngine, facilitationId: string): Promise<{ posted: boolean; text: string }> {
  await openFacilitation(engine.core, facilitationId);
  const handshake = (
    await engine.core.pool().query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'handshake' ORDER BY seq DESC LIMIT 1`,
      [facilitationId],
    )
  ).rows[0];
  if (!handshake) throw new Error('the opening message was not queued; nothing was posted');
  if (handshake.status !== 'sent') {
    return {
      posted: false,
      text: `The opening message was NOT posted in the group yet (${handshake.last_error ?? handshake.status}). It is tried again automatically. Do not tell the group that the facilitation is open or running; say that posting does not work right now.`,
    };
  }
  return { posted: true, text: `The opening message with goal, rules and participants was posted in the group. Do not repeat it. Answer ${'[silent]'} now unless something else needs saying.` };
}

const METHODS: readonly MethodId[] = ['ranked', 'single', 'approval', 'consent', 'assignment'];

export function lifecycleTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_start',
        description:
          'Set up a facilitation in THIS group conversation when a person here asks for it. That person becomes the initiator (say so in the group). Creates it in the phase "configuring": nothing is posted and nothing is recorded until it is opened. Calling it again adjusts the setup. Agree goal, definition of done, format and deadline with the group, then call facilitation_open; or pass open: true when the request already fixed everything. Refuses when the facilitator has no identity of its own here or cannot read every message.',
        properties: {
          goal: { type: 'string', description: 'What the group wants to reach.' },
          definitionOfDone: { type: 'string', description: 'When the facilitation is done, in the words agreed with the group.' },
          deadline: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-11-21T17:00:00+01:00.' },
          timezone: { type: 'string', description: 'IANA timezone of the group.' },
          language: { type: 'string', enum: ['de', 'en'] },
          method: { type: 'string', enum: [...METHODS], description: 'When the facilitation is one decision: ranked (points per rank), single (one option), approval (any set), consent (no standing objection), assignment (one confirmed name per item).' },
          options: { type: 'array', items: { type: 'string' }, description: 'The options to decide between, or the items to assign. The engine labels them A, B, C.' },
          points: { type: 'array', items: { type: 'number' }, description: 'Ranked vote: points per rank, first rank first. Default 3, 2, 1.' },
          statement: { type: 'string', description: 'Consent: the proposal put to the group.' },
          format: { type: 'string', enum: [...FORMAT_IDS], description: 'An agenda template: decision, prioritisation, assignment, ideas, retrospective, alignment. Each is an agenda the group can adjust. Without it the facilitation is one single step.' },
          agenda: {
            type: 'array',
            description: 'An agenda of your own instead of the template, when the group adjusted it.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...STEP_KINDS] },
                title: { type: 'string' },
                timeboxMinutes: { type: 'number' },
                method: { type: 'string', enum: [...METHODS] },
                options: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'title'],
            },
          },
          followUp: { type: 'boolean', description: 'The group agreed that owners are reminded of their action items before the due date.' },
          followUpStatusAt: { type: 'string', description: 'ISO 8601 with offset: when the status of the action items is posted to the group.' },
          closeRule: { type: 'string', enum: ['all_contributed', 'at_deadline'], description: 'Evaluate when every participant has contributed (default) or at the deadline.' },
          open: { type: 'boolean', description: 'Open in the same call. Only when the request already fixed goal, definition of done and (for a vote) method and options, so the group has nothing left to agree on. Otherwise leave it out, agree the setup with the group and call facilitation_open.' },
        },
        required: ['goal', 'definitionOfDone'],
      },
      async (args, ctx) => {
        if (!ctx.callerPrincipalId) throw new Refusal('no_caller', 'It is not known who asked. A facilitation needs an initiator.');
        const deadline = optionalString(args, 'deadline');
        const timezone = optionalString(args, 'timezone');
        const language = oneOf(args, 'language', ['de', 'en'] as const);
        const method = oneOf(args, 'method', METHODS);
        const closeRule = oneOf(args, 'closeRule', ['all_contributed', 'at_deadline'] as const);
        const statement = optionalString(args, 'statement');
        const points = numberList(args, 'points');
        const format = oneOf(args, 'format', FORMAT_IDS);
        const statusAt = optionalString(args, 'followUpStatusAt');
        const agenda = Array.isArray(args['agenda'])
          ? args['agenda'].map((raw): AgendaStepInput => {
              const o = asObject(raw);
              const kind = oneOf(o, 'kind', STEP_KINDS);
              if (!kind) throw new Refusal('bad_input', "every agenda step needs a 'kind'.");
              const stepMethod = oneOf(o, 'method', METHODS);
              const timebox = optionalNumber(o, 'timeboxMinutes');
              return {
                kind,
                title: requiredString(o, 'title'),
                ...(timebox ? { timeboxMinutes: timebox } : {}),
                ...(stepMethod ? { decision: { method: stepMethod, options: stringList(o, 'options') ?? [] } } : {}),
              };
            })
          : undefined;
        if (closeRule === 'at_deadline' && !deadline) throw new Refusal('bad_input', "closeRule 'at_deadline' needs a deadline.");
        // A setup that is adjusted must be one the engine can still read.
        const existing = await store.findLiveByConversation(engine.core.pool(), ctx.channelType, ctx.conversationId);
        if (existing && existing.facilitatorAgent === ctx.agentSlug) await requireReadable(engine, existing);
        const result = await configureFacilitation(engine.core, {
          ...ctx,
          callerPrincipalId: ctx.callerPrincipalId,
          goal: requiredString(args, 'goal'),
          definitionOfDone: requiredString(args, 'definitionOfDone'),
          ...(deadline ? { deadline } : {}),
          ...(timezone ? { timezone } : {}),
          ...(language ? { language } : {}),
          ...(closeRule ? { closeRule } : {}),
          ...(format ? { format } : {}),
          ...(agenda ? { agenda } : {}),
          ...(typeof args['followUp'] === 'boolean' ? { followUp: args['followUp'] } : {}),
          ...(statusAt ? { followUpStatusAt: statusAt } : {}),
          ...(method ? { decision: { method, options: stringList(args, 'options') ?? [], ...(points ? { points } : {}), ...(statement ? { statement } : {}) } } : {}),
        });
        engine.ensureAttached(ctx.agentSlug);
        const people = result.participants.map((p) => p.displayName).join(', ') || 'not known yet';
        const notes = result.notes.map((n) => `Tell the group: ${n}`);
        const what = result.created ? 'Facilitation created' : 'Setup updated';
        if (args['open'] === true) {
          const opened = await openAndReport(engine, result.facilitation.id);
          return [opened.posted ? `${what} and opened.` : `${what}.`, `Participants: ${people}.`, ...notes, opened.text].join('\n');
        }
        return [
          `${what}, phase: configuring. It is NOT open: nothing was posted in the group and nothing is recorded yet.`,
          `Participants: ${people}.`,
          ...notes,
          'Do not tell the group that it started or is running. Either ask the group to confirm the setup and call facilitation_open once they did, or, if the request already fixed everything, call facilitation_open now.',
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
        const opened = await openAndReport(engine, f.id);
        return opened.posted ? `Opened. ${opened.text}` : opened.text;
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
          ballot: { type: 'string', description: 'Only while a vote is open: what you read as their ballot, written in the announced format (e.g. "A > C > B", "B", "abstain", "objection: too expensive", "A: Anna"). The engine parses it; it counts after the author confirmed.' },
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
          const ballotText = optionalString(args, 'ballot');
          if (ballotText !== undefined && step.method) {
            const people = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active').map((p) => ({ id: p.principalId, name: p.displayName }));
            const parsed = parseBallot({ method: step.method, options: roundOptions(step), text: ballotText, author: { id: author.principalId, name: author.displayName }, people });
            if (parsed.kind !== 'ballot') {
              throw new Refusal('bad_ballot', `'${ballotText}' is not a valid ballot for this step${parsed.kind === 'invalid' ? ` (${parsed.problem}: ${parsed.detail})` : ''}. If the message is unclear, use facilitation_clarify instead.`);
            }
            const ballot = await withoutTakenItems(w, step, author, parsed.ballot, record.eventId);
            if (!ballot) return 'That item is already taken; that was said in the group. Nothing was recorded.';
            await recordBallot(w, { record, author, step, ballot, interpreted: true });
          } else {
            await recordContribution(w, { record, author, step, kind, payload: { text: summary }, summary, interpreted: true });
          }
          return `Recorded for ${author.displayName} as unconfirmed. ${author.displayName} was asked in the group to confirm; it counts once they did. Do not repeat the question.`;
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
        name: 'facilitation_put_again',
        description: 'Consent only: after an objection was talked through, put an amended proposal to the group. Everybody answers again; the engine posts the new wording.',
        properties: { statement: { type: 'string', description: 'The amended proposal, in the language of the group.' } },
        required: ['statement'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const statement = requiredString(args, 'statement');
        return engine.core.work(f.id, async (w) => {
          const step = await store.openStepOf(w.tx, w.f.id);
          if (w.f.phase !== 'active' || !step || step.method !== 'consent') throw new Refusal('no_consent_step', 'No consent decision is open.');
          await putAgain(w, statement);
          await advance(w, 'contribution');
          return 'The amended proposal was posted. Everybody answers again.';
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
