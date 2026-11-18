// Facilitation-scoped capabilities (spec 5.11): the only reach a facilitator
// has into mail and calendars.
//
//   Protocol dispatch     the confirmed protocol to participants and confirmed
//                         stakeholders. Never anything else, to anyone else.
//   Follow-up scheduling  free/busy (no event details) of participants and
//                         confirmed stakeholders, and the invitation for the
//                         follow-up meeting the group agreed on.
//
// The grant is bound to one facilitation, issued when it closes and revoked
// when its follow-up ends. The engine checks every recipient against it
// before the integration is called (the integration checks again), and every
// use is written to the protocol.

import type { FacilitationFollowupService, FollowupGrant, FollowupRefusal } from '@omadia/plugin-api';

import { DAY_MS } from '../clock.js';
import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { FollowupMeetingPlan, Participant, Stakeholder, StakeholderRole } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { onFollowupEnded } from './actionItems.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { onClosed } from './decide.js';
import { scheduleJob } from './jobs.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { buildProtocol, closingSummary } from './protocol.js';
import { registerJobHandler } from './scheduler.js';
import { MAX_WINDOW_DAYS, alignToGrid, findSlot } from './slots.js';

const lower = (s: string): string => s.trim().toLowerCase();

interface People {
  participants: Participant[];
  stakeholders: Stakeholder[];
}

async function peopleOf(w: Pick<Work, 'tx' | 'f'>): Promise<People> {
  return {
    participants: (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active'),
    // Only stakeholders the group confirmed.
    stakeholders: (await store.listStakeholders(w.tx, w.f.id)).filter((s) => s.confirmed),
  };
}

/** Everybody the grant may touch: participants and confirmed stakeholders. */
export async function grantOf(w: Pick<Work, 'tx' | 'f'>): Promise<FollowupGrant> {
  const { participants, stakeholders } = await peopleOf(w);
  const allowed = [...participants.map((p) => p.email), ...stakeholders.map((s) => s.address)].filter((a): a is string => typeof a === 'string' && a.includes('@')).map(lower);
  return { facilitationId: w.f.id, allowed: [...new Set(allowed)] };
}

export type ScopedOutcome<T> = { ok: true; value: T } | { ok: false; code: keyof ReturnType<typeof texts>['followupReasons']; detail?: string };

/**
 * The integration, as the engine may use it for this facilitation. Every call
 * is refused here first when the grant is not active or a recipient is outside
 * it, and every call is written to the protocol.
 */
export async function scoped(w: Work, engine: Pick<EngineCore, 'deps'>) {
  const grant = await grantOf(w);
  const service: FacilitationFollowupService | undefined = engine.deps.kernel.followup();

  const guard = async (capability: string, recipients: readonly string[]): Promise<ScopedOutcome<FacilitationFollowupService>> => {
    const refuse = async (code: 'grant_revoked' | 'recipient_not_allowed' | 'no_service', detail?: string): Promise<ScopedOutcome<FacilitationFollowupService>> => {
      await w.event('capability_refused', 'engine', { capability, code, summary: `${capability}: refused (${code}${detail ? `: ${detail}` : ''})` });
      return { ok: false, code, ...(detail ? { detail } : {}) };
    };
    if (w.f.settings.followupGrant !== 'active') return refuse('grant_revoked');
    const outside = recipients.map(lower).filter((r) => !grant.allowed.includes(r));
    if (outside.length > 0) return refuse('recipient_not_allowed', outside.join(', '));
    if (!service) return refuse('no_service');
    return { ok: true, value: service };
  };

  const settle = async <T extends { outcome: string }>(capability: string, summary: string, result: T | FollowupRefusal): Promise<ScopedOutcome<T>> => {
    if (result.outcome === 'refused') {
      const refusal = result as FollowupRefusal;
      await w.event('capability_refused', 'integration', { capability, code: refusal.code, summary: `${capability}: refused by the integration (${refusal.code}: ${refusal.message})` });
      return { ok: false, code: refusal.code, detail: refusal.message };
    }
    await w.event('capability_used', 'engine', { capability, summary });
    return { ok: true, value: result as T };
  };

  return {
    grant,
    /** Busy intervals only: no subject, body, location or attendees. */
    async freeBusy(attendees: readonly string[], from: Date, to: Date) {
      const allowed = await guard('free/busy', attendees);
      if (!allowed.ok) return allowed;
      const result = await allowed.value.freeBusy(grant, { attendees: attendees.map(lower), from: from.toISOString(), to: to.toISOString() });
      return settle('free/busy', `free/busy read for ${String(attendees.length)} people, ${from.toISOString()} to ${to.toISOString()}`, result);
    },
    async createInvitation(request: { attendees: readonly string[]; subject: string; start: Date; end: Date; body: string; online: boolean }) {
      const allowed = await guard('invitation', request.attendees);
      if (!allowed.ok) return allowed;
      const result = await allowed.value.createInvitation(grant, { ...request, attendees: request.attendees.map(lower), start: request.start.toISOString(), end: request.end.toISOString() });
      return settle('invitation', `invitation "${request.subject}" for ${request.start.toISOString()} sent to ${String(request.attendees.length)} people`, result);
    },
    async sendMail(recipients: readonly string[], subject: string, body: string) {
      const allowed = await guard('protocol mail', recipients);
      if (!allowed.ok) return allowed;
      const result = await allowed.value.sendMail(grant, { recipients: recipients.map(lower), subject, body });
      return settle('protocol mail', `protocol mailed to ${String(recipients.length)} addresses`, result);
    },
  };
}

const setGrant = (w: Work, state: 'active' | 'revoked'): Promise<unknown> =>
  w.tx.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || jsonb_build_object('followupGrant', $2::text) WHERE id = $1`, [w.f.id, state]);

/** Send the confirmed protocol to participants and confirmed stakeholders. */
export async function dispatchProtocol(w: Work, engine: Pick<EngineCore, 'deps'>): Promise<void> {
  const t = texts(w.f.language);
  const { participants, stakeholders } = await peopleOf(w);
  const protocol = await buildProtocol(w.tx, w.f);
  // The initiator already received the protocol with the report.
  const viaChannel = participants.filter((p) => p.principalId !== w.f.initiatorParticipant);
  for (const person of viaChannel) {
    w.post({ purpose: 'protocol', key: person.principalId, to: { principalId: person.principalId }, deliveryClass: 'essential', text: t.protocolDirect(person.displayName, protocol) });
  }
  await w.event('capability_used', 'engine', { capability: 'protocol dispatch', summary: `protocol sent privately to ${String(viaChannel.length)} participants` });

  const mailTo = [...participants.map((p) => p.email), ...stakeholders.filter((s) => s.role === 'receives_protocol').map((s) => s.address)].filter((a): a is string => typeof a === 'string' && a.includes('@'));
  let mailed = 0;
  if (w.config.protocolMailEnabled && mailTo.length > 0) {
    const sent = await (await scoped(w, engine)).sendMail([...new Set(mailTo.map(lower))], t.protocolMailSubject(w.f.goal), protocol);
    if (sent.ok) mailed = new Set(mailTo.map(lower)).size;
    else w.post({ purpose: 'protocol_mail_unavailable', key: 'once', to: 'group', deliveryClass: 'essential', text: t.protocolMailUnavailable(t.followupReasons[sent.code]) });
  }
  // The group already has the result; it hears about the dispatch only when
  // something left the conversation by mail.
  if (mailed > 0) w.post({ purpose: 'protocol_sent', key: 'once', to: 'group', deliveryClass: 'essential', text: t.protocolSent(viaChannel.length, mailed) });
}

/** Schedule the follow-up meeting the group agreed on, from free/busy. */
export async function scheduleFollowupMeeting(w: Work, engine: Pick<EngineCore, 'deps'>, plan: FollowupMeetingPlan, extraAttendees: readonly string[] = []): Promise<'created' | 'no_slot' | 'unavailable'> {
  const t = texts(w.f.language);
  const say = (text: string): void => w.post({ purpose: 'followup_meeting', key: plan.subject, to: 'group', deliveryClass: 'essential', text });
  const { participants, stakeholders } = await peopleOf(w);
  const attendees = [
    ...new Set(
      [...participants.map((p) => p.email), ...stakeholders.filter((s) => s.role === 'invited_to_followups').map((s) => s.address), ...extraAttendees]
        .filter((a): a is string => typeof a === 'string' && a.includes('@'))
        .map(lower),
    ),
  ];
  if (attendees.length === 0) {
    say(t.followupUnavailable(plan.subject, t.followupReasons.no_addresses));
    return 'unavailable';
  }
  const api = await scoped(w, engine);
  // Free/busy comes on a quarter-hour grid counted from `from`, for a window
  // shorter than 62 days.
  const from = alignToGrid(new Date(Math.max(Date.parse(plan.from), w.now.getTime())));
  const to = new Date(Math.min(Date.parse(plan.to), from.getTime() + MAX_WINDOW_DAYS * DAY_MS));
  const availability = await api.freeBusy(attendees, from, to);
  if (!availability.ok) {
    say(t.followupUnavailable(plan.subject, t.followupReasons[availability.code]));
    return 'unavailable';
  }
  const busy = availability.value.outcome === 'ok' ? availability.value.busy : [];
  // A person missing from the answer is "availability unknown", not "free".
  const unknown = attendees.filter((a) => !busy.some((b) => lower(b.attendee) === a)).length;
  const slot = findSlot({ from, to, durationMinutes: plan.durationMinutes, timezone: w.f.timezone, busy: busy.flatMap((b) => b.intervals) });
  if (!slot) {
    say(t.followupNoSlot(plan.subject));
    return 'no_slot';
  }
  const summary = t.closeSummary(await closingSummary(w));
  const created = await api.createInvitation({ attendees, subject: plan.subject, start: slot.start, end: slot.end, body: t.invitationBody(w.f.goal, summary), online: plan.online });
  if (!created.ok) {
    say(t.followupUnavailable(plan.subject, t.followupReasons[created.code]));
    return 'unavailable';
  }
  const joinUrl = created.value.outcome === 'created' ? created.value.joinUrl : undefined;
  say(t.followupCreated(plan.subject, formatWhen(slot.start, w.f.timezone, w.f.language), !plan.online || joinUrl !== undefined, unknown));
  return 'created';
}

/** Add a stakeholder: only after the group confirmed. */
export async function proposeStakeholder(w: Work, input: { displayName: string; address?: string; role: StakeholderRole; addedBy: string }): Promise<Stakeholder> {
  if (w.f.phase !== 'active' && w.f.phase !== 'configuring') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  if (input.address !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.address)) throw new Refusal('bad_input', 'That is not a mail address.');
  const t = texts(w.f.language);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const known = participants.find((p) => p.displayName.toLowerCase() === input.displayName.toLowerCase());
  if (!known && input.address === undefined) throw new Refusal('bad_input', 'A stakeholder who is not in this conversation needs a mail address.');
  const stakeholder = await insert<Stakeholder>(w.tx, 'plg_omadia_agent_facilitator_stakeholders', {
    facilitationId: w.f.id,
    principal: known?.principalId ?? null,
    address: input.address ? lower(input.address) : (known?.email ?? null),
    displayName: input.displayName,
    role: input.role,
    addedBy: input.addedBy,
    createdAt: w.now,
  });
  await openProposal(w, {
    kind: 'stakeholder',
    summary: t.proposeStakeholder(input.displayName, t.stakeholderRoles[input.role]),
    payload: { stakeholderId: stakeholder.id },
    proposedBy: input.addedBy,
    windowMinutes: w.f.settings.confirmWindowMinutes,
  });
  return stakeholder;
}

/** Agree a follow-up meeting: the group consents before anything is read. */
export async function proposeFollowupMeeting(w: Work, plan: FollowupMeetingPlan): Promise<void> {
  if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const from = new Date(plan.from);
  const to = new Date(plan.to);
  if (!(to > from)) throw new Refusal('bad_input', 'The latest end must be after the earliest start.');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) throw new Refusal('bad_input', `The window must be shorter than ${String(MAX_WINDOW_DAYS + 1)} days.`);
  const t = texts(w.f.language);
  await openProposal(w, {
    kind: 'followup_meeting',
    summary: t.proposeFollowupMeeting(plan.subject, plan.durationMinutes, formatWhen(from, w.f.timezone, w.f.language), formatWhen(to, w.f.timezone, w.f.language)),
    payload: { plan },
    proposedBy: 'facilitator',
    windowMinutes: w.f.settings.confirmWindowMinutes,
  });
}

async function revoke(w: Work, reason: string): Promise<void> {
  if (w.f.settings.followupGrant !== 'active') return;
  await setGrant(w, 'revoked');
  await w.event('grant_revoked', 'engine', { summary: `grant revoked: ${reason}` });
}

export function installCapabilities(): void {
  registerProposalKind('stakeholder', {
    describe: (_w, p) => p.summary,
    accept: async (w, p) => {
      await update(w.tx, 'plg_omadia_agent_facilitator_stakeholders', { id: String(p.payload['stakeholderId']) }, { confirmed: true, confirmedAt: w.now });
      await w.event('stakeholder_confirmed', 'group', { stakeholderId: p.payload['stakeholderId'] });
    },
    // Somebody the group did not confirm is not a stakeholder.
    reject: async (w, p) => {
      await w.tx.query('DELETE FROM plg_omadia_agent_facilitator_stakeholders WHERE id = $1 AND confirmed = false', [String(p.payload['stakeholderId'])]);
    },
  });

  registerProposalKind('followup_meeting', {
    describe: (_w, p) => p.summary,
    accept: async (w, p) => {
      await w.patch({ followupPolicy: { ...w.f.followupPolicy, meeting: p.payload['plan'] as FollowupMeetingPlan } });
      await w.event('followup_meeting_agreed', 'group', { plan: p.payload['plan'] });
    },
  });

  // At the close the grant is issued and used for what the group agreed on.
  // This runs in the closing unit of work, while the facilitator can still
  // post in the conversation.
  onClosed(async (w) => {
    await setGrant(w, 'active');
    const issued = { ...w.f, settings: { ...w.f.settings, followupGrant: 'active' as const } };
    const work: Work = { ...w, get f() { return issued; } };
    const grant = await grantOf(work);
    await w.event('grant_issued', 'engine', { summary: `grant issued for ${String(grant.allowed.length)} addresses (participants and confirmed stakeholders)` });
    try {
      await dispatchProtocol(work, w.engine);
      if (w.f.followupPolicy.meeting) await scheduleFollowupMeeting(work, w.engine, w.f.followupPolicy.meeting);
    } catch (err) {
      // A failing integration never undoes the close.
      w.engine.log(`facilitation ${w.f.id}: follow-up capabilities failed: ${err instanceof Error ? err.message : String(err)}`);
      await w.event('capability_refused', 'engine', { capability: 'follow-up', summary: `follow-up failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    // With action items the grant ends with their follow-up; otherwise after
    // a fixed time.
    if (w.f.followupState !== 'active') await scheduleJob(w, 'grant_revoke', 'end', new Date(w.now.getTime() + w.config.followupGrantDays * DAY_MS), {});
  });
  onFollowupEnded((w) => revoke(w, 'the follow-up ended'));
  registerJobHandler('grant_revoke', (w) => revoke(w, 'the follow-up period ended'));
}
