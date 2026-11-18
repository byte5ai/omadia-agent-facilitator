// Tools for the process: steps, clusters and summaries for confirmation,
// decisions, action items, the parking lot, silent voices, the protocol.

import * as store from '../db/store.js';
import type { MethodId, Step } from '../model.js';
import { parseInstant } from '../engine/lifecycle.js';
import { resolvePerson, toOptions } from '../methods/ballot.js';
import { proposeActionItem } from '../engine/actionItems.js';
import { Refusal } from '../engine/core.js';
import type { Work } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { balanceOf, closeStep, extendStep, inviteSilentVoices, numberedContributions, proposeClusters, setDecision } from '../engine/process.js';
import { openProposal } from '../engine/proposals.js';
import { protocolFor } from '../engine/governance.js';
import { buildProtocol } from '../engine/protocol.js';
import { texts } from '../texts/index.js';
import { asObject, defineTool, liveFacilitation, numberList, oneOf, optionalNumber, optionalString, requiredString, stringList } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const METHODS: readonly MethodId[] = ['ranked', 'single', 'approval', 'consent', 'assignment'];

async function openStepOrRefuse(w: Work): Promise<Step> {
  if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) throw new Refusal('no_open_step', 'No step is open.');
  return step;
}

/** The step whose contributions are meant: a named one, the open one, or the
 *  latest one that has any. */
async function sourceStep(w: Work, position: number | undefined): Promise<Step> {
  const steps = await store.listSteps(w.tx, w.f.id);
  if (position !== undefined) {
    const named = steps.find((s) => s.position === position);
    if (!named) throw new Refusal('bad_input', `The agenda has no step ${String(position)}.`);
    return named;
  }
  const all = await store.listContributions(w.tx, w.f.id);
  const withValid = steps.filter((s) => all.some((c) => c.stepId === s.id && c.status === 'valid'));
  const open = steps.find((s) => s.status === 'open');
  const chosen = (open && withValid.includes(open) ? open : withValid.at(-1)) ?? open;
  if (!chosen) throw new Refusal('no_contributions', 'Nothing has been contributed yet.');
  return chosen;
}

export function processTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_step',
        description:
          'Close or extend the open step. "close" on a collecting or discussing step first makes the engine invite whoever has not contributed (privately, and with a neutral line in the group); call it again after they had their chance. A step that is decided by a vote closes by itself.',
        properties: {
          action: { type: 'string', enum: ['close', 'extend'] },
          minutes: { type: 'number', description: 'For "extend": how many minutes.' },
        },
        required: ['action'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const action = oneOf(args, 'action', ['close', 'extend'] as const);
        const minutes = optionalNumber(args, 'minutes');
        return engine.core.work(f.id, async (w) => {
          const step = await openStepOrRefuse(w);
          if (action === 'extend') {
            if (!minutes || minutes <= 0) throw new Refusal('bad_input', "'minutes' is required for extend.");
            await extendStep(w, step, minutes, 'facilitator');
            return `Extended by ${String(minutes)} minutes. The engine said so in the group.`;
          }
          if (step.method !== null && step.options.length > 0) throw new Refusal('deciding_step', 'This step is decided by its method and closes when the result is in.');
          if (step.kind === 'close') throw new Refusal('closing_step', 'The closing step ends when the group confirmed the summary.');
          if (await store.openProposal(w.tx, w.f.id)) throw new Refusal('proposal_open', texts(w.f.language).proposalBusy());
          const invited = await inviteSilentVoices(w, step);
          if (invited > 0) {
            return `Not closed yet: ${String(invited)} ${invited === 1 ? 'person has' : 'people have'} not contributed to this step. The engine invited them privately and posted a neutral line in the group. Give them a moment, then call close again. Do not name them.`;
          }
          await closeStep(w, step, 'facilitator');
          return 'Closed. The engine announced it and opened what comes next.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_invite_silent',
        description: 'Invite the people who have not contributed to the open step yet: privately where the channel allows it, with a neutral line in the group. Nobody is named in the group. Each person is invited once per step.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        return engine.core.work(f.id, async (w) => {
          const step = await openStepOrRefuse(w);
          const invited = await inviteSilentVoices(w, step);
          return invited > 0 ? `Invited ${String(invited)}. Do not name them in the group.` : 'Everybody has contributed or was already invited in this step.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_set_decision',
        description: 'Set what a deciding step decides once the group has agreed on it: the method and the options (or the items to assign). Applies to the open step, or the next deciding step. The engine announces the options and how to vote.',
        properties: {
          method: { type: 'string', enum: [...METHODS] },
          options: { type: 'array', items: { type: 'string' } },
          points: { type: 'array', items: { type: 'number' } },
          statement: { type: 'string', description: 'Consent: the proposal.' },
          title: { type: 'string', description: 'What is being decided, in a few words.' },
        },
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const method = oneOf(args, 'method', METHODS);
        const options = stringList(args, 'options');
        const points = numberList(args, 'points');
        const statement = optionalString(args, 'statement');
        const title = optionalString(args, 'title');
        return engine.core.work(f.id, async (w) => {
          const steps = await store.listSteps(w.tx, w.f.id);
          const open = steps.find((s) => s.status === 'open');
          const target = open && (open.method !== null || ['decide', 'prioritise', 'assign'].includes(open.kind)) ? open : steps.find((s) => s.status === 'pending' && s.method !== null);
          if (!target) throw new Refusal('no_deciding_step', 'The agenda has no deciding step that is open or still to come.');
          const finalMethod = method ?? target.method;
          if (!finalMethod) throw new Refusal('bad_input', "'method' is required for this step.");
          if (finalMethod !== 'consent' && (!options || options.length < (finalMethod === 'assignment' ? 1 : 2))) throw new Refusal('bad_options', 'Name the options (at least two; for an assignment at least one item).');
          await setDecision(w, target, {
            method: finalMethod,
            options: toOptions(options ?? []),
            methodConfig: {
              ...target.methodConfig,
              ...(finalMethod === 'ranked' ? { points: points ?? target.methodConfig['points'] ?? [...w.config.rankedPoints] } : {}),
              ...(finalMethod === 'consent' ? { statement: statement ?? title ?? target.title } : {}),
            },
            ...(title ? { title } : {}),
          });
          return target.status === 'open' ? 'Set. The engine announced the options and how to vote.' : `Set for step ${String(target.position)}; it is announced when that step opens.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_contributions',
        description: 'The valid contributions of a step, numbered, with their authors: what you cluster, summarise and refer to. Default: the open step, or the latest step that has contributions.',
        properties: { step: { type: 'number', description: 'Position of the step in the agenda.' } },
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const position = optionalNumber(args, 'step');
        return engine.core.work(f.id, async (w) => {
          const step = await sourceStep(w, position);
          const participants = await store.listParticipants(w.tx, w.f.id);
          const numbered = await numberedContributions(w, step);
          const balance = await balanceOf(w, step);
          return [
            `Step ${String(step.position)} "${step.title}":`,
            ...numbered.map((n) => `#${String(n.number)} ${participants.find((p) => p.principalId === n.contribution.participantPrincipal)?.displayName ?? '?'} (${n.contribution.kind}): ${String(n.contribution.payload['summary'] ?? '')}`),
            `Per person: ${balance.counts.map((c) => `${c.participant.displayName} ${String(c.count)}`).join(', ')}`,
          ].join('\n');
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_propose_clusters',
        description: 'Propose groups for what was collected. Refer to contributions by their numbers from facilitation_contributions. The engine puts the clusters to the group; they become part of the record only when the group confirmed them.',
        properties: {
          step: { type: 'number', description: 'Position of the step the contributions come from. Default as in facilitation_contributions.' },
          clusters: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, members: { type: 'array', items: { type: 'number' } } }, required: ['label', 'members'] },
          },
        },
        required: ['clusters'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const position = optionalNumber(args, 'step');
        const raw = Array.isArray(args['clusters']) ? args['clusters'] : [];
        const clusters = raw.map((c) => {
          const o = asObject(c);
          return { label: requiredString(o, 'label'), members: numberList(o, 'members') ?? [] };
        });
        if (clusters.length === 0) throw new Refusal('bad_input', "'clusters' must name at least one cluster.");
        return engine.core.work(f.id, async (w) => {
          const open = await openStepOrRefuse(w);
          const from = await sourceStep(w, position);
          await proposeClusters(w, from, clusters, open.id);
          return 'The clusters were put to the group. They count once nobody objected; the engine announces it.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_propose_summary',
        description: 'Put a reflective summary of the open step to the group for confirmation. It enters the protocol only when the group confirmed it.',
        properties: { text: { type: 'string', description: 'The summary, in the language of the group, without opinion of your own.' } },
        required: ['text'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const text = requiredString(args, 'text');
        return engine.core.work(f.id, async (w) => {
          const step = await openStepOrRefuse(w);
          await openProposal(w, { kind: 'summary', summary: text, payload: { stepId: step.id }, proposedBy: 'facilitator', windowMinutes: w.f.settings.confirmWindowMinutes });
          return 'The summary was put to the group.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_decision',
        description: 'Put a decision the group has reached in discussion to the group for consent, with its rationale. It is recorded when nobody objects. For votes use the step\'s method instead; the engine records those itself.',
        properties: {
          statement: { type: 'string', description: 'The decision in the words of the group.' },
          rationale: { type: 'string', description: 'Why the group decided so, as the group said it.' },
        },
        required: ['statement'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const statement = requiredString(args, 'statement');
        const rationale = optionalString(args, 'rationale');
        return engine.core.work(f.id, async (w) => {
          const step = await openStepOrRefuse(w);
          await openProposal(w, { kind: 'decision', summary: statement, payload: { stepId: step.id, ...(rationale ? { rationale } : {}) }, proposedBy: 'facilitator', windowMinutes: w.f.settings.confirmWindowMinutes });
          return 'The decision was put to the group for consent.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_record_action_item',
        description: 'Propose an action item to its owner: what, who, by when. The engine asks the owner in the group; the item binds only when the owner said yes in their own message.',
        properties: {
          description: { type: 'string' },
          owner: { type: 'string', description: 'Name of the participant who should own it.' },
          dueDate: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-11-27T17:00:00+01:00.' },
        },
        required: ['description', 'owner', 'dueDate'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const description = requiredString(args, 'description');
        const ownerName = requiredString(args, 'owner');
        const dueDate = parseInstant(requiredString(args, 'dueDate'));
        if (!dueDate) throw new Refusal('bad_input', 'dueDate must be an ISO 8601 date-time with an offset.');
        return engine.core.work(f.id, async (w) => {
          if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
          if (dueDate.getTime() <= w.now.getTime()) throw new Refusal('bad_input', 'The due date is in the past.');
          const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
          const person = resolvePerson(ownerName, undefined, active.map((p) => ({ id: p.principalId, name: p.displayName })));
          if (typeof person === 'string') throw new Refusal(person, `'${ownerName}' is ${person === 'ambiguous_person' ? 'more than one participant; use the full name' : 'not a participant of this facilitation'}.`);
          const owner = active.find((p) => p.principalId === person.id);
          if (!owner) throw new Refusal('unknown_person', `'${ownerName}' is not an active participant.`);
          const item = await proposeActionItem(w, { description, owner, dueDate });
          return `Action item #${String(item.number)} was proposed to ${owner.displayName}. It binds once they said yes; the engine asked them.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_park',
        description: 'Park a point that does not belong to the current step in the visible parking lot, so the group stays on the step. It is listed as an open point at the close.',
        properties: { topic: { type: 'string', description: 'The point, in a few neutral words.' } },
        required: ['topic'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const topic = requiredString(args, 'topic');
        return engine.core.work(f.id, async (w) => {
          if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
          await w.event('parked', 'facilitator', { topic });
          w.bump();
          w.post({ purpose: 'parked', key: `${String(w.now.getTime())}:${topic.slice(0, 40)}`, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: texts(w.f.language).parked(topic) });
          return 'Parked and shown to the group.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_protocol',
        description: 'The protocol of this facilitation as the engine keeps it: agenda, contributions, confirmed clusters and summaries, decisions with rationale, action items, open points.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        // Visible to its participants only; an engine-started turn has no caller.
        return ctx.callerPrincipalId ? protocolFor(engine.core.pool(), f, ctx.callerPrincipalId) : buildProtocol(engine.core.pool(), f);
      },
    ),
  ];
}
