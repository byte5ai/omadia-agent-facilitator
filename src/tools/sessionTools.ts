// Tools for meetings and for what a session's media allow.

import * as store from '../db/store.js';
import type { Modality } from '../model.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { parseInstant } from '../engine/lifecycle.js';
import { endSession, prepareSessionStart, scheduleSession, speakingOrder, startSession } from '../engine/sessions.js';
import { declareStepElectorate } from '../engine/sessionElectorate.js';
import { resolvePerson } from '../methods/ballot.js';
import { defineTool, liveFacilitation, oneOf, optionalString, requiredString, stringList } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const MODALITIES: readonly Modality[] = ['online', 'hybrid'];

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
            const started = await startSession(w, next, prefetched?.snapshot, prefetched?.live);
            // Not thrown: what was said and scheduled about it must stay.
            if (started.status !== 'live') return 'The session could not go live: its meeting chat is not ready. The group was told what is missing; I try again shortly.';
            return 'The session is running. What can be perceived in it was said in the group.';
          }
          const running = sessions.find((s) => s.status === 'live');
          if (!running) throw new Refusal('no_session', 'No session is running.');
          await endSession(w, running);
          return 'The session has ended. Its summary went out in its conversation; where it needs the group\'s confirmation it waits for it.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_step_electorate',
        description:
          'Who decides the open step: "session" = the participants of the session that runs in its linked meeting chat right now (people only in that chat count, people only at home do not), or "home" = the participants of the main conversation (the default). Only before anybody contributed to the step. Use "session" when the group wants a step decided by the people in the meeting.',
        properties: { scope: { type: 'string', enum: ['session', 'home'] } },
        required: ['scope'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const scope = oneOf(args, 'scope', ['session', 'home'] as const);
        if (!scope) throw new Refusal('bad_input', "'scope' is 'session' or 'home'.");
        return engine.core.work(f.id, async (w) => {
          const declared = await declareStepElectorate(w, scope);
          return scope === 'session'
            ? `"${declared.step.title}" is now decided by the participants of the session${declared.session?.title ? ` "${declared.session.title}"` : ''}. That was said in the meeting chat.`
            : `"${declared.step.title}" is decided by the participants of the main conversation.`;
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

  ];
}
