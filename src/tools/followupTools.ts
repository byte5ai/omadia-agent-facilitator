// Tools for what happens after the close: stakeholders and the follow-up
// meeting. Both are agreed by the group before anything is sent or read.

import type { StakeholderRole } from '../model.js';
import * as store from '../db/store.js';
import { proposeFollowupMeeting, proposeStakeholder, refreshAddresses } from '../engine/capabilities.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { parseInstant } from '../engine/lifecycle.js';
import { defineTool, liveFacilitation, oneOf, optionalNumber, optionalString, requiredString } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const ROLES: readonly StakeholderRole[] = ['receives_protocol', 'invited_to_followups'];

export function followupTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    defineTool(
      engine,
      {
        name: 'facilitation_stakeholder',
        description:
          'Propose a stakeholder to the group: somebody who receives the protocol or is invited to follow-up meetings. The engine puts it to the group; only a stakeholder the group confirmed is ever written to.',
        properties: {
          name: { type: 'string' },
          address: { type: 'string', description: 'Mail address; required for somebody who is not in this conversation.' },
          role: { type: 'string', enum: [...ROLES] },
        },
        required: ['name', 'role'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const role = oneOf(args, 'role', ROLES);
        if (!role) throw new Refusal('bad_input', "'role' is required.");
        const address = optionalString(args, 'address');
        return engine.core.work(f.id, async (w) => {
          await proposeStakeholder(w, { displayName: requiredString(args, 'name'), ...(address ? { address } : {}), role, addedBy: ctx.callerPrincipalId ?? 'facilitator' });
          return 'Put to the group. The person becomes a stakeholder only when nobody objects.';
        });
      },
    ),

    defineTool(
      engine,
      {
        name: 'facilitation_plan_followup_meeting',
        description:
          'Agree a follow-up meeting with the group: subject, length, and between which dates. After the close the engine reads free/busy (only when people are busy, never what their appointments are) of participants and confirmed stakeholders, picks the first common free time in working hours and sends the invitation. You cannot schedule anything yourself.',
        properties: {
          subject: { type: 'string' },
          durationMinutes: { type: 'number' },
          earliest: { type: 'string', description: 'ISO 8601 with offset: earliest start.' },
          latest: { type: 'string', description: 'ISO 8601 with offset: latest end. Less than 62 days after the earliest start.' },
          online: { type: 'boolean', description: 'Default true: with a meeting link.' },
        },
        required: ['subject', 'durationMinutes', 'earliest', 'latest'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const from = parseInstant(requiredString(args, 'earliest'));
        const to = parseInstant(requiredString(args, 'latest'));
        const duration = optionalNumber(args, 'durationMinutes');
        if (!from || !to) throw new Refusal('bad_input', 'earliest and latest must be ISO 8601 date-times with an offset.');
        if (!duration || duration < 15 || duration > 480) throw new Refusal('bad_input', 'durationMinutes must be between 15 and 480.');
        // Free/busy and the invitation go by mail address, and addresses come
        // from the channel's member list only.
        const addresses = await refreshAddresses(engine.core, f.id);
        const invited = (await store.listStakeholders(engine.core.db(), f.id)).filter((s) => s.confirmed && s.role === 'invited_to_followups' && s.address).length;
        if (addresses.withAddress + invited === 0) {
          throw new Refusal(
            'no_addresses',
            'This channel does not provide the mail addresses of the participants, so I can neither look for a common free time nor send an invitation. Tell the group exactly that, and that they can set the meeting up themselves. Do not ask anybody for an address: addresses are never collected in the chat. Nothing was put to the group.',
          );
        }
        const total = addresses.withAddress + addresses.without;
        const partial =
          addresses.without > 0
            ? ` ${String(addresses.without)} of ${String(total)} participants ${addresses.without === 1 ? 'has' : 'have'} no mail address here and will not get the invitation; say so, without naming anybody and without asking for addresses.`
            : '';
        return engine.core.work(f.id, async (w) => {
          await proposeFollowupMeeting(w, { subject: requiredString(args, 'subject'), durationMinutes: duration, from: from.toISOString(), to: to.toISOString(), online: args['online'] !== false });
          return `Put to the group. If nobody objects, it is scheduled after the close and the group is told the time. Do not schedule or announce anything yourself.${partial}`;
        });
      },
    ),
  ];
}
