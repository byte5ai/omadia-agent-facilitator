// Tools for rule changes by consent and for closing on a free-text
// definition of done.

import * as store from '../db/store.js';
import type { MethodId } from '../model.js';
import { principalKey } from '../kernel.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { parseInstant } from '../engine/lifecycle.js';
import { proposeChange, proposeDodMet } from '../engine/transparency.js';
import type { ChangeRequest } from '../engine/transparency.js';
import { toOptions } from '../methods/ballot.js';
import { storedMessage } from './lifecycleTools.js';
import { defineTool, liveFacilitation, numberList, oneOf, optionalNumber, optionalString, requiredString, stringList } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const METHODS: readonly MethodId[] = ['ranked', 'single', 'approval', 'consent', 'assignment'];
const CHANGES = ['definition_of_done', 'deadline', 'close_rule', 'method'] as const;

export function transparencyTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_propose_change',
        description:
          'Put a change of the RULES to the group when somebody proposes one: the definition of done, the deadline, the close rule, or the method of a step that is decided by a vote. This is not how the group moves on: to close the open step, skip ahead or go to the vote, use facilitation_step. Anyone may propose: when a participant proposes a change, pass it on with this tool in the same turn; do not question it, do not decide it yourself and do not answer it from memory. It takes effect when no active participant objects within the window announced at the start (never past the deadline); the engine announces the outcome with the new version. Pass the message id of the person who proposed it.',
        properties: {
          change: { type: 'string', enum: [...CHANGES] },
          messageId: { type: 'string', description: 'The message in which a participant proposed the change (from the turn input).' },
          definitionOfDone: { type: 'string', description: 'For definition_of_done: the new wording.' },
          deadline: { type: 'string', description: 'For deadline: ISO 8601 with offset.' },
          closeRule: { type: 'string', enum: ['all_contributed', 'at_deadline'] },
          step: { type: 'number', description: 'For method: position of the step that is decided by a vote (never a collecting or discussing step). Default: the open one.' },
          method: { type: 'string', enum: [...METHODS] },
          options: { type: 'array', items: { type: 'string' }, description: "For method: leave out to keep the step's options. Other options are accepted only with replaceOptions." },
          replaceOptions: { type: 'boolean', description: 'For method: the group proposed to vote on different options than the step has. Only then pass new options.' },
          points: { type: 'array', items: { type: 'number' } },
          statement: { type: 'string' },
        },
        required: ['change'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const type = oneOf(args, 'change', CHANGES);
        if (!type) throw new Refusal('bad_input', "'change' is required.");
        const messageId = optionalString(args, 'messageId');
        // Who proposed it is taken from the stored message, not from an argument.
        const record = messageId ? await storedMessage(engine, ctx, messageId) : undefined;
        const proposer = record ? { principalId: principalKey(record.author), messageId: record.messageId } : { principalId: 'facilitator' };
        return engine.core.work(f.id, async (w) => {
          let change: ChangeRequest;
          if (type === 'definition_of_done') {
            change = { type, text: requiredString(args, 'definitionOfDone') };
          } else if (type === 'deadline') {
            const deadline = parseInstant(requiredString(args, 'deadline'));
            if (!deadline) throw new Refusal('bad_deadline', 'The deadline must be an ISO 8601 date-time with an offset.');
            change = { type, deadline };
          } else if (type === 'close_rule') {
            const closeRule = oneOf(args, 'closeRule', ['all_contributed', 'at_deadline'] as const);
            if (!closeRule) throw new Refusal('bad_input', "'closeRule' is required.");
            change = { type, closeRule };
          } else {
            const steps = await store.listSteps(w.tx, w.f.id);
            const position = optionalNumber(args, 'step');
            const step = position !== undefined ? steps.find((s) => s.position === position) : (steps.find((s) => s.status === 'open' && s.method !== null) ?? steps.find((s) => s.status === 'pending' && s.method !== null));
            if (!step) throw new Refusal('bad_input', 'There is no step that is decided by a vote, so there is no method to change.');
            if (step.method === null) {
              throw new Refusal(
                'not_a_deciding_step',
                `Step ${String(step.position)} ("${step.title}") is not decided by a vote, so it has no method to change. If the group wants to move on or go to the vote, call facilitation_step with action "close". Nothing was put to the group.`,
              );
            }
            const method = oneOf(args, 'method', METHODS) ?? step.method;
            const labels = stringList(args, 'options');
            // Options come from the step. A model that fills them in from the
            // chat or from the agenda would put a vote to the group that
            // nobody asked for.
            const own = (list: readonly string[]): string => [...list].map((l) => l.trim().toLowerCase()).sort().join('\u0000');
            const differs = labels !== undefined && step.options.length > 0 && own(labels) !== own(step.options.map((o) => o.label));
            if (differs && args['replaceOptions'] !== true) {
              throw new Refusal(
                'foreign_options',
                `These are not the options of this step (${step.options.map((o) => o.label).join(', ')}). Leave 'options' out to keep them. Only if a participant proposed to vote on different options, pass them with replaceOptions: true. Nothing was put to the group.`,
              );
            }
            const options = labels && (differs || step.options.length === 0) ? toOptions(labels) : step.options;
            if (method !== 'consent' && options.length < (method === 'assignment' ? 1 : 2)) throw new Refusal('bad_options', 'Name the options (at least two).');
            const points = numberList(args, 'points');
            const statement = optionalString(args, 'statement');
            change = { type, stepId: step.id, method, options, ...(points ? { points } : {}), ...(statement ? { statement } : {}) };
          }
          const proposal = await proposeChange(w, change, proposer);
          return `Put to the group. It holds if nobody objects until ${proposal.windowEndsAt.toISOString()}; the outcome is announced in the group by itself. Moderate objections like any other; do not announce an outcome yourself.`;
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_close',
        description:
          'Only when the definition of done is free text: put "the definition of done is met" to the group, with the summary of decisions, next steps and open points. The facilitation concludes when nobody objects. A machine-checkable definition of done concludes by itself.',
      },
      async (_args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        return engine.core.work(f.id, async (w) => {
          await proposeDodMet(w);
          return 'The closing summary was put to the group. The facilitation concludes when nobody objects.';
        });
      },
    ),
  ];
}
