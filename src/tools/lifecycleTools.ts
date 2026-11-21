// Tools for the lifecycle and for authenticated contributions.

import { MINUTE_MS } from '../clock.js';
import * as store from '../db/store.js';
import type { ContributionKind, MethodId } from '../model.js';
import { parseBallot } from '../methods/ballot.js';
import { advance, putAgain, recordBallot, roundOptions, withoutTakenItems } from '../engine/decide.js';
import { askClarification, authorOf, ownLiveParts, recordContribution, recordParts } from '../engine/contributions.js';
import { namesOf, withoutMention } from '../engine/addressing.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { FORMAT_IDS, STEP_KINDS } from '../engine/formats.js';
import { abortFacilitation, configureFacilitation, openFacilitation } from '../engine/lifecycle.js';
import { proposeNamedStakeholders, stakeholderList, STAKEHOLDER_ROLES } from './startStakeholders.js';
import type { AgendaStepInput } from '../engine/lifecycle.js';
import { nameMissingPerson } from '../engine/electorate.js';
import { personNamed, recordImport } from '../engine/imports.js';
import type { Ballot } from '../methods/ballot.js';
import { statusText } from '../engine/status.js';
import { formatWhen } from '../texts/index.js';
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
  // Read as the facilitation of this conversation: the kernel returns only
  // what that facilitation received.
  const f = await store.findRoutableByConversation(engine.core.db(), ctx.channelType, ctx.conversationId);
  const record = f ? await messages.getEvent({ agentSlug: ctx.agentSlug, channelType: ctx.channelType, conversationId: ctx.conversationId, processId: f.id }, messageId) : undefined;
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
    await engine.core.db().query<{ status: string; last_error: string | null }>(
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

/** The `parts` argument: points of one message, each with kind and summary. */
function partsOf(args: Record<string, unknown>): { kind: ContributionKind; summary: string }[] | undefined {
  const raw = args['parts'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Refusal('bad_input', "'parts' must be a non-empty list of { kind, summary }.");
  return raw.map((part, index) => {
    const entry = asObject(part);
    const kind = oneOf(entry, 'kind', CONTRIBUTION_KINDS);
    const summary = optionalString(entry, 'summary');
    if (!kind || !summary) throw new Refusal('bad_input', `Part ${String(index + 1)} needs a kind and a summary.`);
    return { kind, summary };
  });
}

const METHODS: readonly MethodId[] = ['ranked', 'single', 'approval', 'consent', 'assignment'];

/** The longest span a relative deadline may name: thirty days. */
const MAX_DEADLINE_MINUTES = 30 * 24 * 60;

export function lifecycleTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_start',
        description:
          'Call this FIRST, in the same turn in which a person here asks for a facilitation, with whatever the request already says, BEFORE you describe a setup or ask anything. You keep no memory between messages: a setup you only describe in the chat is lost with the next message, a setup stored here is not. Sets up a facilitation in THIS group conversation. That person becomes the initiator (say so in the group). Creates it in the phase "configuring": nothing is posted and nothing is recorded until it is opened. Calling it again adjusts the setup. Agree goal, definition of done, format and deadline with the group, then call facilitation_open; or pass open: true when the request already fixed everything. A request that is just a vote (it names what to choose between) is set up with method, options and open: true and NO format: it gets one deciding step that is open right after the opening message, with nothing for the group to confirm first. Refuses when the facilitator has no identity of its own here or cannot read every message.',
        properties: {
          goal: { type: 'string', description: 'What the group wants to reach.' },
          definitionOfDone: { type: 'string', description: 'When the facilitation is done, in the words agreed with the group. Leave it out if it is not agreed yet: a plain one is written from the goal, shown to the group at the opening, and you can call this tool again with the agreed wording.' },
          deadline: { type: 'string', description: 'A deadline given as a point in time: ISO 8601 with offset, e.g. 2026-11-21T17:00:00+01:00. For a deadline given as a span from now ("in 90 minutes", "in two hours") use deadlineInMinutes instead.' },
          deadlineInMinutes: { type: 'number', description: 'A deadline given as a span from now: the minutes, e.g. 90 for "in 90 minutes" or "in anderthalb Stunden", 120 for "in two hours". The engine works out the time; you need not know what time it is. Never drop a deadline the request names: pass it here or in deadline.' },
          timezone: { type: 'string', description: 'IANA timezone of the group.' },
          language: { type: 'string', enum: ['de', 'en'] },
          method: { type: 'string', enum: [...METHODS], description: 'When the facilitation is one decision: ranked (points per rank), single (one option), approval (any set), consent (no standing objection), assignment (one confirmed name per item). When the group names options but no method, leave it out: the facilitator\'s default method is used if the operator set one.' },
          options: { type: 'array', items: { type: 'string' }, description: 'The options to decide between, or the items to assign. The engine labels them A, B, C.' },
          points: { type: 'array', items: { type: 'number' }, description: 'Ranked vote: points per rank, first rank first. Default 3, 2, 1.' },
          statement: { type: 'string', description: 'Consent: the proposal put to the group.' },
          format: { type: 'string', enum: [...FORMAT_IDS], description: 'An agenda template with several steps: decision, prioritisation, assignment, ideas, retrospective, alignment. Only when the group has to collect or discuss something BEFORE it can decide. Not for a request that is just a vote: with method and options given, decision, prioritisation and assignment are reduced to one deciding step anyway. Without a format the facilitation is one single step.' },
          agenda: {
            type: 'array',
            description: 'An agenda of your own instead of the template, when the group adjusted it or explicitly asked for steps around a vote (e.g. discuss first, then vote).',
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
          reminderMinutesBefore: { type: 'array', items: { type: 'number' }, description: 'When the request asks for reminders of its own: minutes before the deadline, e.g. [5] or [1440, 120]; an empty list when it wants none. Leave it out otherwise: reminders then follow from the time to the deadline, and the opening message says which.' },
          participants: { type: 'array', items: { type: 'string' }, description: 'The names of the participants, when the request names them ("only Anna and Bert", "just me"). They are the list then: it closes when all of them have contributed, and nobody else is counted. The person who asked always takes part and need not be listed. Leave it out when the request names nobody: then the members of the conversation take part. Where the channel cannot list the members, a vote needs either this list or a deadline.' },
          stakeholders: {
            type: 'array',
            description: 'People the request names who should get the result or the protocol, or be invited to follow-up meetings, without taking part ("send the protocol to our boss Maria", "invite Tom from IT to the follow-up"). Pass every one of them here: the engine puts them to the group as one proposal right away; only a stakeholder the group confirmed is ever written to. Somebody who is not in this conversation needs a mail address; leave the address out if the request gives none and ask for it.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address: { type: 'string', description: 'Mail address, when the request gives one.' },
                role: { type: 'string', enum: [...STAKEHOLDER_ROLES], description: 'receives_protocol (default) or invited_to_followups.' },
              },
              required: ['name'],
            },
          },
          protocolByMail: { type: 'boolean', description: 'The request asks that the protocol also goes to the participants by mail after the close. It is mailed to the addresses the channel knows; nobody is asked for one. Only set it when somebody asked for it.' },
          followUp: { type: 'boolean', description: 'The group agreed that owners are reminded of their action items before the due date.' },
          followUpStatusAt: { type: 'string', description: 'ISO 8601 with offset: when the status of the action items is posted to the group.' },
          closeRule: { type: 'string', enum: ['all_contributed', 'at_deadline'], description: 'Evaluate when every participant has contributed (default) or at the deadline.' },
          open: { type: 'boolean', description: 'Open in the same call. Only when the request already fixed goal, definition of done and (for a vote) method and options, so the group has nothing left to agree on. Otherwise leave it out, agree the setup with the group and call facilitation_open.' },
        },
        required: ['goal'],
      },
      async (args, ctx) => {
        if (!ctx.callerPrincipalId) throw new Refusal('no_caller', 'It is not known who asked. A facilitation needs an initiator.');
        const inMinutes = optionalNumber(args, 'deadlineInMinutes');
        if (inMinutes !== undefined && optionalString(args, 'deadline') !== undefined) throw new Refusal('bad_deadline', "Pass either 'deadline' or 'deadlineInMinutes', not both. Nothing was created or changed.");
        if (inMinutes !== undefined && !(inMinutes >= 1 && inMinutes <= MAX_DEADLINE_MINUTES)) throw new Refusal('bad_deadline', `'deadlineInMinutes' is a number of minutes from 1 to ${String(MAX_DEADLINE_MINUTES)}. Nothing was created or changed.`);
        const deadline = inMinutes !== undefined ? new Date(engine.core.now().getTime() + Math.round(inMinutes) * MINUTE_MS).toISOString() : optionalString(args, 'deadline');
        const timezone = optionalString(args, 'timezone');
        const language = oneOf(args, 'language', ['de', 'en'] as const);
        const method = oneOf(args, 'method', METHODS);
        const closeRule = oneOf(args, 'closeRule', ['all_contributed', 'at_deadline'] as const);
        const statement = optionalString(args, 'statement');
        const points = numberList(args, 'points');
        const format = oneOf(args, 'format', FORMAT_IDS);
        const statusAt = optionalString(args, 'followUpStatusAt');
        const definitionOfDone = optionalString(args, 'definitionOfDone');
        const participants = stringList(args, 'participants');
        const stakeholders = stakeholderList(args);
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
        const existing = await store.findLiveByConversation(engine.core.db(), ctx.channelType, ctx.conversationId);
        if (existing && existing.facilitatorAgent === ctx.agentSlug) await requireReadable(engine, existing);
        const result = await configureFacilitation(engine.core, {
          ...ctx,
          callerPrincipalId: ctx.callerPrincipalId,
          goal: requiredString(args, 'goal'),
          ...(definitionOfDone ? { definitionOfDone } : {}),
          ...(deadline ? { deadline } : {}),
          ...(timezone ? { timezone } : {}),
          ...(language ? { language } : {}),
          ...(closeRule ? { closeRule } : {}),
          ...(format ? { format } : {}),
          ...(agenda ? { agenda } : {}),
          ...(participants ? { participants } : {}),
          ...(args['reminderMinutesBefore'] !== undefined && args['reminderMinutesBefore'] !== null ? { reminderMinutesBefore: args['reminderMinutesBefore'] } : {}),
          ...(typeof args['followUp'] === 'boolean' ? { followUp: args['followUp'] } : {}),
          ...(typeof args['protocolByMail'] === 'boolean' ? { protocolByMail: args['protocolByMail'] } : {}),
          ...(statusAt ? { followUpStatusAt: statusAt } : {}),
          ...(method ? { decision: { method, options: stringList(args, 'options') ?? [], ...(points ? { points } : {}), ...(statement ? { statement } : {}) } } : {}),
          ...(!method && (stringList(args, 'options') ?? []).length > 0 ? { undecidedOptions: stringList(args, 'options') ?? [] } : {}),
        });
        engine.ensureAttached(ctx.agentSlug);
        const named = await proposeNamedStakeholders(engine, result.facilitation.id, stakeholders, ctx.callerPrincipalId);
        const people = [...result.participants.map((p) => p.displayName), ...result.expected].join(', ') || 'not known yet';
        const notes = [
          ...named.notes,
          ...(result.expected.length > 0 ? [`Not matched to a person yet: ${result.expected.join(', ')}. The opening message asks them to write once; each counts from then on and is waited for until then.`] : []),
          ...result.notes.map((n) => `Tell the group: ${n}`),
          ...(result.defaultedDod !== undefined ? [`No definition of done was given, so this one is used: "${result.defaultedDod}". Say it to the group; if they want another wording, call facilitation_start again with it.`] : []),
        ];
        const set = result.facilitation.deadline;
        notes.unshift(set ? `Deadline: ${formatWhen(set, result.facilitation.timezone, 'en')}.` : 'No deadline is set. If the request named one, call facilitation_start again with deadline or deadlineInMinutes; never tell the group there is none when they asked for one.');
        const what = result.created ? 'Facilitation created' : 'Setup updated';
        if (args['open'] === true) {
          const opened = await openAndReport(engine, result.facilitation.id);
          return [opened.posted ? `${what} and opened.` : `${what}.`, `Participants: ${people}.`, ...notes, opened.text].join('\n');
        }
        return [
          named.posted
            ? `${what}, phase: configuring. It is NOT open: only the stakeholder proposal was posted in the group, and nothing is recorded yet.`
            : `${what}, phase: configuring. It is NOT open: nothing was posted in the group and nothing is recorded yet.`,
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
        description: 'The current state of this facilitation as the engine computed it: phase, how many have contributed and how many contributions are still open (never names: in the group nobody is named as missing), deadline. Use it instead of counting yourself. Also works after the close while action items are followed up.',
      },
      async (_args, ctx) => {
        // Also after the close while action items are followed up: then a
        // mention is answered by an ordinary turn, and this is its source.
        const following = await store.findRoutableByConversation(engine.core.db(), ctx.channelType, ctx.conversationId);
        const f = following && following.facilitatorAgent === ctx.agentSlug && following.followupState === 'active' && following.phase === 'closed' ? following : await liveFacilitation(engine, ctx);
        return statusText(engine.core.db(), f);
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_contribution',
        description:
          'Record what ONE person said in free text, for the author of that message. Pass the message id from the turn input. The engine takes author, time, revision and the original text from the stored message, asks the author to confirm, and counts it only after they did. A message with several points (for example three ideas) is recorded as several parts with `parts`, confirmed in one question. Refused for a message from another conversation, from before the start, from a non-participant, one that quotes or forwards somebody else, an outdated revision, and a ballot that differs from what the message says in the announced format.',
        properties: {
          messageId: { type: 'string', description: 'The message id from the turn input.' },
          revision: { type: 'number', description: 'The revision of the message you read, if the turn input states it. An older one is refused.' },
          kind: { type: 'string', enum: [...CONTRIBUTION_KINDS] },
          summary: { type: 'string', description: 'What the person said, in one sentence, in the language of the group. Shown to them for confirmation.' },
          ballot: { type: 'string', description: 'Only while a vote is open: what you read as their ballot, written in the announced format (e.g. "A > C > B", "B", "abstain", "objection: too expensive", "A: Anna"). The engine parses it; it counts after the author confirmed.' },
          parts: {
            type: 'array',
            description: 'Instead of kind and summary: several points of one message, each with its kind and its one-sentence summary.',
            items: { type: 'object', properties: { kind: { type: 'string', enum: [...CONTRIBUTION_KINDS] }, summary: { type: 'string' } }, required: ['kind', 'summary'] },
          },
        },
        required: ['messageId'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const record = await storedMessage(engine, ctx, requiredString(args, 'messageId'));
        const parts = partsOf(args);
        const kind = oneOf(args, 'kind', CONTRIBUTION_KINDS);
        const summary = optionalString(args, 'summary');
        if (!parts && (!kind || summary === undefined)) throw new Refusal('bad_input', "'kind' and 'summary' are required (or 'parts').");
        const revision = optionalNumber(args, 'revision');
        if (revision !== undefined && revision !== record.revision) {
          throw new Refusal('outdated_revision', `That message has been edited since (revision ${String(record.revision)}); what you read is no longer what it says. Read the current text first.`);
        }
        return engine.core.work(f.id, async (w) => {
          const author = await authorOf(w, record);
          const step = await store.openStepOf(w.tx, w.f.id);
          if (!step) throw new Refusal('no_open_step', 'No step is open; there is nothing to contribute to right now.');
          const [existing] = await ownLiveParts(w, record.messageId);
          const ballotText = optionalString(args, 'ballot');
          const recorded = existing && existing.sourceRevision === record.revision && existing.status !== 'ambiguous';
          if (recorded && (ballotText === undefined || !step.method)) {
            return `Already recorded for ${author.displayName} (${existing.status}).`;
          }
          if (ballotText !== undefined && step.method) {
            const people = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active').map((p) => ({ id: p.principalId, name: p.displayName }));
            const parse = (text: string) => parseBallot({ method: step.method as MethodId, options: roundOptions(step), text, author: { id: author.principalId, name: author.displayName }, people });
            const parsed = parse(ballotText);
            if (parsed.kind !== 'ballot') {
              throw new Refusal('bad_ballot', `'${ballotText}' is not a valid ballot for this step${parsed.kind === 'invalid' ? ` (${parsed.problem}: ${parsed.detail})` : ''}. If the message is unclear, use facilitation_clarify instead.`);
            }
            // Content comes from the stored original text (spec 5.3): where
            // the message itself is in the announced format, that is the
            // ballot, and a different reading is refused.
            const original = parse(withoutMention(record.text ?? '', namesOf(w.f), record.addressedToBot === true));
            if (original.kind === 'invalid') {
              throw new Refusal('content_mismatch', 'The message is written in the announced format but is not a valid ballot; its author was asked about it. Nothing was recorded.');
            }
            if (original.kind === 'ballot' && JSON.stringify(original.ballot) !== JSON.stringify(parsed.ballot)) {
              throw new Refusal('content_mismatch', `The message says '${(record.text ?? '').trim()}', which is a different ballot than '${ballotText}'. Only what the message says counts. Nothing was recorded.`);
            }
            if (recorded) return `Already recorded for ${author.displayName} (${existing.status}).`;
            const ballot = await withoutTakenItems(w, step, author, parsed.ballot, record.eventId);
            if (!ballot) return 'That item is already taken; that was said in the group. Nothing was recorded.';
            // A ballot in the announced format counts at once, read from the text.
            await recordBallot(w, { record, author, step, ballot, interpreted: original.kind !== 'ballot' });
            if (original.kind === 'ballot') return `Recorded for ${author.displayName} as written; it counts. Say nothing about it.`;
          } else if (parts && parts.length > 1) {
            await recordParts(w, { record, author, step, interpreted: true, parts: parts.map((p) => ({ kind: p.kind, payload: { text: p.summary }, summary: p.summary })) });
            return `Recorded ${String(parts.length)} points for ${author.displayName} as unconfirmed. ${author.displayName} was asked in the group to confirm all of them in one answer; they count once confirmed. Do not repeat the question.`;
          } else {
            const one = parts?.[0] ?? { kind: kind as ContributionKind, summary: summary as string };
            await recordContribution(w, { record, author, step, kind: one.kind, payload: { text: one.summary }, summary: one.summary, interpreted: true });
          }
          return `Recorded for ${author.displayName} as unconfirmed. ${author.displayName} was asked in the group to confirm; it counts once they did. Do not repeat the question.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_import',
        description:
          'Somebody brings in what ANOTHER participant said elsewhere (for example older votes in a screenshot, a list from another chat). Record it for that person, one call per person. It does not count until that person confirms it in their own message; the engine asks them. Pass the message id of the message that brought it in, the person\'s name (the full name where two share a first name) and where it comes from.',
        properties: {
          messageId: { type: 'string', description: 'The message id of the message that brought the contributions in.' },
          person: { type: 'string', description: 'Whose contribution it is, by name.' },
          origin: { type: 'string', description: 'Where it comes from, in the language of the group (e.g. "the screenshot of last week\'s poll").' },
          kind: { type: 'string', enum: [...CONTRIBUTION_KINDS] },
          summary: { type: 'string', description: 'What the person said, in one sentence.' },
          ballot: { type: 'string', description: 'While a vote is open: their ballot in the announced format.' },
        },
        required: ['messageId', 'person', 'origin', 'summary'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const record = await storedMessage(engine, ctx, requiredString(args, 'messageId'));
        const person = requiredString(args, 'person');
        const origin = requiredString(args, 'origin');
        const summary = requiredString(args, 'summary');
        const ballotText = optionalString(args, 'ballot');
        return engine.core.work(f.id, async (w) => {
          const importer = await authorOf(w, record);
          const step = await store.openStepOf(w.tx, w.f.id);
          if (!step) throw new Refusal('no_open_step', 'No step is open; there is nothing to contribute to right now.');
          let ballot: Ballot | undefined;
          if (ballotText !== undefined && step.method) {
            const people = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
            const target = personNamed(people, person);
            const parsed = parseBallot({ method: step.method, options: roundOptions(step), text: ballotText, author: { id: target.principalId, name: target.displayName }, people: people.map((p) => ({ id: p.principalId, name: p.displayName })) });
            if (parsed.kind !== 'ballot') throw new Refusal('bad_ballot', `'${ballotText}' is not a valid ballot for this step. Nothing was recorded.`);
            ballot = parsed.ballot;
          }
          const kind = oneOf(args, 'kind', CONTRIBUTION_KINDS) ?? (ballot ? 'vote' : 'position');
          const { person: target } = await recordImport(w, { record, importer, step, person, kind, summary, origin, ...(ballot ? { ballot } : {}) });
          return `Recorded for ${target.displayName} as imported; ${target.displayName} was asked in the group to confirm it in their own message. It does not count before. Do not repeat the question.`;
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
        name: 'facilitation_name_participant',
        description:
          'Only where the channel could not list every member: a participant names a person who is missing from the list of participants. The engine asks that person to write here once; they count from their own message on. Nobody is ever removed this way.',
        properties: { name: { type: 'string', description: 'The name of the missing person, as the participant wrote it.' } },
        required: ['name'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const name = requiredString(args, 'name');
        return engine.core.work(f.id, async (w) => {
          const by = ctx.callerPrincipalId ? await store.getParticipant(w.tx, w.f.id, ctx.callerPrincipalId) : undefined;
          if (!by || by.status !== 'active') throw new Refusal('not_participant', 'Only a participant can name somebody who is missing.');
          const outcome = await nameMissingPerson(w, by, name);
          if (outcome === 'already_listed') return `${name} is already on the list of participants. Nothing changed.`;
          if (outcome === 'already_named') return `${name} was already named and is waited for. Nothing changed.`;
          return `${name} was named; the group was asked that ${name} writes here once. Do not repeat it.`;
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
