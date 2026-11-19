// Tools for meetings and for what a session's media allow.

import * as store from '../db/store.js';
import type { Modality } from '../model.js';
import { Refusal } from '../engine/core.js';
import { roundOptions } from '../engine/decide.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { parseInstant } from '../engine/lifecycle.js';
import { endSession, prepareSessionStart, recordSpoken, scheduleSession, speakingOrder, startSession } from '../engine/sessions.js';
import { parseBallot, resolvePerson } from '../methods/ballot.js';
import { defineTool, liveFacilitation, oneOf, optionalString, requiredString, stringList } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const MODALITIES: readonly Modality[] = ['online', 'hybrid'];
const KINDS = ['idea', 'position', 'concern', 'question', 'proposal', 'vote', 'confirmation', 'objection', 'abstention', 'commitment'] as const;

export function sessionTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_session',
        description:
          'Schedule, start or end a live session (a meeting) inside this facilitation. The engine sends the agenda before the meeting, says at the start what it perceives in that session, and keeps time. Preparation and follow-up stay in the chat.',
        properties: {
          action: { type: 'string', enum: ['schedule', 'start', 'end'] },
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO 8601 with offset.' },
          end: { type: 'string', description: 'ISO 8601 with offset.' },
          modality: { type: 'string', enum: [...MODALITIES], description: 'online, or hybrid when some people sit in a room together.' },
          meetingRef: { type: 'string', description: 'The channel meeting this session is, when the channel named one.' },
          room: { type: 'array', items: { type: 'string' }, description: 'Hybrid: names of the participants who are in the room.' },
        },
        required: ['action'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const action = oneOf(args, 'action', ['schedule', 'start', 'end'] as const);
        const prefetched = action === 'start' ? await prepareSessionStart(engine.core, f.id) : undefined;
        return engine.core.work(f.id, async (w) => {
          const sessions = (await store.listSessions(w.tx, w.f.id)).filter((s) => s.kind === 'live');
          if (action === 'schedule') {
            const start = parseInstant(requiredString(args, 'start'));
            const endRaw = optionalString(args, 'end');
            const end = endRaw ? parseInstant(endRaw) : undefined;
            if (!start || (endRaw && !end)) throw new Refusal('bad_input', 'start and end must be ISO 8601 date-times with an offset.');
            if (end && end <= start) throw new Refusal('bad_input', 'The end must be after the start.');
            const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
            const room = (stringList(args, 'room') ?? []).map((name) => {
              const person = resolvePerson(name, undefined, active.map((p) => ({ id: p.principalId, name: p.displayName })));
              if (typeof person === 'string') throw new Refusal(person, `'${name}' is not a participant I can match.`);
              return person.id;
            });
            const meetingRef = optionalString(args, 'meetingRef');
            const session = await scheduleSession(w, {
              title: optionalString(args, 'title') ?? w.f.goal,
              start,
              ...(end ? { end } : {}),
              modality: oneOf(args, 'modality', MODALITIES) ?? 'online',
              ...(meetingRef ? { meetingRef } : {}),
              room,
            });
            return `Scheduled "${session.title ?? ''}". The agenda is posted ${String(w.config.sessionAgendaLeadMinutes)} minutes before it starts and the session opens on time, without another call.`;
          }
          if (action === 'start') {
            const next = sessions.find((s) => s.status === 'scheduled');
            if (!next) throw new Refusal('no_session', 'No session is scheduled.');
            await startSession(w, next, prefetched);
            return 'The session is running. What can be perceived in it was said in the group.';
          }
          const running = sessions.find((s) => s.status === 'live');
          if (!running) throw new Refusal('no_session', 'No session is running.');
          await endSession(w, running);
          return 'The session has ended. Follow-up continues in the chat.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_speaking_order',
        description: 'Post a round-robin speaking order for the round, when the session has no raised hands. The engine rotates who starts and puts remote voices first when the room has spoken more.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        return engine.core.work(f.id, async (w) => {
          if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
          const order = await speakingOrder(w);
          return `Posted: ${order.names.join(', ')}${order.remoteFirst ? ' (remote first)' : ''}.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_spoken',
        description:
          'Record what a person SAID in the call, from the transcript. Only possible when the session gives transcribed speech and the group consented. It stays unconfirmed: the engine asks the person to confirm in the chat, and it counts only then.',
        properties: {
          speaker: { type: 'string', description: 'Name of the participant who said it, as the transcript attributes it.' },
          kind: { type: 'string', enum: [...KINDS] },
          summary: { type: 'string', description: 'What they said, in one sentence, in the language of the group.' },
          ballot: { type: 'string', description: 'While a vote is open: their ballot in the announced format.' },
        },
        required: ['speaker', 'kind', 'summary'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const kind = oneOf(args, 'kind', KINDS);
        if (!kind) throw new Refusal('bad_input', "'kind' is required.");
        const ballotText = optionalString(args, 'ballot');
        return engine.core.work(f.id, async (w) => {
          const step = await store.openStepOf(w.tx, w.f.id);
          let ballot;
          if (ballotText !== undefined && step?.method) {
            const parsed = parseBallot({ method: step.method, options: roundOptions(step), text: ballotText });
            if (parsed.kind !== 'ballot') throw new Refusal('bad_ballot', `'${ballotText}' is not a valid ballot for this step.`);
            ballot = parsed.ballot;
          }
          const recorded = await recordSpoken(w, { speaker: requiredString(args, 'speaker'), kind, summary: requiredString(args, 'summary'), ...(ballot ? { ballot } : {}) });
          return `Recorded for ${recorded.speaker.displayName} as unconfirmed. It counts once they confirmed in the chat; they were asked there.`;
        });
      },
    ),
  ];
}
