// Tools for what happens after the close: stakeholders and the follow-up
// meeting. Both are agreed by the group before anything is sent or read.

import { rows } from '../db/sql.js';
import type { ActionItem, Disclosure, Facilitation, StakeholderRole } from '../model.js';
import * as store from '../db/store.js';
import { proposeFollowupMeeting, proposeStakeholder, refreshAddresses } from '../engine/capabilities.js';
import { markActionDone } from '../engine/actionItems.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { parseInstant } from '../engine/lifecycle.js';
import { defineTool, liveFacilitation, oneOf, optionalNumber, optionalString, requiredString } from './toolkit.js';
import type { ToolDefinition } from './toolkit.js';

const ROLES: readonly StakeholderRole[] = ['receives_protocol', 'invited_to_followups'];
const DISCLOSURES: readonly Disclosure[] = ['full', 'existence', 'none'];

export function followupTools(engine: FacilitationEngine): ToolDefinition[] {
  return [
    // For the facilitator's ordinary turn. In follow-up the engine leaves a
    // mention to that turn (one mention, one reply); this is how the turn
    // gets the item closed. It posts, so the kernel drops the turn's own text.
    defineTool(
      engine,
      {
        name: 'facilitation_action_done',
        description:
          'After a facilitation closed, while its action items are followed up: the person who wrote this message says that one of THEIR action items is done ("done", "done 2", "erledigt 2"). Call it for that and nothing else. The engine closes the item and says so in the group; you write nothing on top. Whose item it is comes from the message, never from an argument: nobody can close an item for somebody else.',
        properties: { number: { type: 'number', description: 'The number of the action item, if the person named one.' } },
      },
      async (args, ctx) => {
        if (!ctx.callerPrincipalId) throw new Refusal('no_caller', 'It is not known who wrote this message, so no action item can be closed for them.');
        const caller = ctx.callerPrincipalId;
        const db = engine.core.db();
        const following = await rows<Facilitation>(
          db,
          `SELECT * FROM plg_omadia_agent_facilitator_facilitations WHERE facilitator_agent = $1 AND channel_type = $2 AND conversation_id = $3 AND followup_state = 'active' ORDER BY closed_at`,
          [ctx.agentSlug, ctx.channelType, ctx.conversationId],
        );
        if (following.length === 0) throw new Refusal('no_followup', 'No action items are being followed up in this conversation.');
        const number = optionalNumber(args, 'number');
        const open: { f: Facilitation; item: ActionItem }[] = [];
        for (const f of following) {
          for (const item of await store.listActionItems(db, f.id)) if (item.status === 'confirmed') open.push({ f, item });
        }
        const named = number !== undefined ? open.filter((o) => o.item.number === number) : open;
        const own = named.filter((o) => o.item.ownerPrincipal === caller);
        if (own.length === 0) {
          if (number !== undefined && named.length > 0) throw new Refusal('not_owner', `Action item ${String(number)} is not theirs to close. Only its owner can say that it is done.`);
          throw new Refusal('no_open_item', number !== undefined ? `There is no open action item ${String(number)} here.` : 'This person has no open action item here.');
        }
        const only = own[0];
        if (own.length > 1 || !only) {
          return `Nothing was closed: several of their action items are open (${own.map((o) => `${String(o.item.number)}: ${o.item.description}`).join('; ')}). Ask which one is done.`;
        }
        const owner = await store.getParticipant(db, only.f.id, caller);
        if (!owner) throw new Refusal('no_open_item', 'This person has no open action item here.');
        const closed = await engine.core.work(only.f.id, async (w) => {
          const current = (await store.listActionItems(w.tx, w.f.id)).find((a) => a.id === only.item.id);
          if (!current || current.status !== 'confirmed') return false;
          await markActionDone(w, current, owner);
          return true;
        });
        if (!closed) throw new Refusal('no_open_item', 'That action item is not open any more.');
        return `Action item ${String(only.item.number)} is closed and that was said in the group. Do not repeat it. Answer ${'[silent]'} now.`;
      },
    ),

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
          disclosure: {
            type: 'string',
            enum: ['full', 'existence', 'none'],
            description: 'What the protocol says about parts left out for this person: full (every part they may know, contributions never), existence (default: also a note that something was left out), none (neither content nor a hint).',
          },
        },
        required: ['name', 'role'],
      },
      async (args, ctx) => {
        const f = await liveFacilitation(engine, ctx);
        const role = oneOf(args, 'role', ROLES);
        if (!role) throw new Refusal('bad_input', "'role' is required.");
        const address = optionalString(args, 'address');
        const disclosure = oneOf(args, 'disclosure', DISCLOSURES) ?? 'existence';
        return engine.core.work(f.id, async (w) => {
          const { proposed } = await proposeStakeholder(w, { displayName: requiredString(args, 'name'), ...(address ? { address } : {}), role, disclosure, addedBy: ctx.callerPrincipalId ?? 'facilitator' });
          if (proposed) return 'Put to the group. The person becomes a stakeholder only when nobody objects.';
          return w.f.phase === 'configuring'
            ? 'Noted. Nothing was posted yet: it is put to the group once the facilitation is open. The person becomes a stakeholder only when nobody objects.'
            : 'Noted. Another proposal is being decided; it is put to the group afterwards. The person becomes a stakeholder only when nobody objects.';
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
