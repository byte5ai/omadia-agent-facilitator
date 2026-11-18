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
import { insert, one, update } from '../db/sql.js';
import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Facilitation, FollowupMeetingPlan, Job, Participant, Stakeholder, StakeholderRole } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { onFollowupEnded } from './actionItems.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { onClosed } from './decide.js';
import { scheduleJob } from './jobs.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { buildProtocol, closingSummary } from './protocol.js';
import { withTimeout } from './outbox.js';
import { registerExternalJob, registerJobHandler } from './scheduler.js';
import type { ExternalJob } from './scheduler.js';
import { MAX_WINDOW_DAYS, alignToGrid, findSlot } from './slots.js';

const lower = (s: string): string => s.trim().toLowerCase();

interface People {
  participants: Participant[];
  stakeholders: Stakeholder[];
}

async function peopleOf(w: { tx: Queryable; f: Facilitation }): Promise<People> {
  return {
    participants: (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active'),
    // Only stakeholders the group confirmed.
    stakeholders: (await store.listStakeholders(w.tx, w.f.id)).filter((s) => s.confirmed),
  };
}

/** Everybody the grant may touch: participants and confirmed stakeholders. */
export async function grantOf(w: { tx: Queryable; f: Facilitation }): Promise<FollowupGrant> {
  const { participants, stakeholders } = await peopleOf(w);
  const allowed = [...participants.map((p) => p.email), ...stakeholders.map((s) => s.address)].filter((a): a is string => typeof a === 'string' && a.includes('@')).map(lower);
  return { facilitationId: w.f.id, allowed: [...new Set(allowed)] };
}

export type ScopedCode = keyof ReturnType<typeof texts>['followupReasons'];
export type ScopedOutcome<T> = { ok: true; value: T } | { ok: false; code: ScopedCode; detail?: string };

/** How long one call to the integration may take. */
export const followupLimits = { timeoutMs: 20_000 };

const recordEvent = (engine: EngineCore, facilitationId: string, kind: string, actor: string, payload: Record<string, unknown>): Promise<void> =>
  engine.work(facilitationId, (w) => w.event(kind, actor, payload));

/**
 * The integration, as the engine may use it for one facilitation.
 *
 * Called OUTSIDE any unit of work: no lock and no transaction is held while
 * the integration is asked, and every call has a timeout. A call is refused
 * here first when the grant is not active or a recipient is outside it, and
 * every call, refusal and unknown outcome is written to the protocol.
 */
export async function scoped(engine: EngineCore, facilitationId: string) {
  const pool = engine.pool();
  const f = await store.getFacilitation(pool, facilitationId);
  if (!f) throw new Refusal('unknown_facilitation', 'No such facilitation.');
  const grant = await grantOf({ tx: pool, f });
  const service: FacilitationFollowupService | undefined = engine.deps.kernel.followup();

  const refuse = async <T>(capability: string, code: ScopedCode, detail?: string): Promise<ScopedOutcome<T>> => {
    await recordEvent(engine, f.id, 'capability_refused', 'engine', { capability, code, summary: `${capability}: refused (${code}${detail ? `: ${detail}` : ''})` });
    return { ok: false, code, ...(detail ? { detail } : {}) };
  };

  const call = async <T extends { outcome: string }>(capability: string, recipients: readonly string[], summary: string, run: (svc: FacilitationFollowupService) => Promise<T | FollowupRefusal>): Promise<ScopedOutcome<T>> => {
    if (f.settings.followupGrant !== 'active') return refuse(capability, 'grant_revoked');
    const outside = recipients.map(lower).filter((r) => !grant.allowed.includes(r));
    if (outside.length > 0) return refuse(capability, 'recipient_not_allowed', outside.join(', '));
    if (!service) return refuse(capability, 'no_service');
    let result: T | FollowupRefusal;
    try {
      result = await withTimeout(run(service), followupLimits.timeoutMs, `the integration (${capability})`);
    } catch (err) {
      // No answer: it may or may not have happened. Never repeated.
      const detail = err instanceof Error ? err.message : String(err);
      await recordEvent(engine, f.id, 'capability_refused', 'integration', { capability, code: 'unknown_outcome', summary: `${capability}: outcome unknown (${detail})` });
      return { ok: false, code: 'unknown_outcome', detail };
    }
    if (result.outcome === 'refused') {
      const refusal = result as FollowupRefusal;
      await recordEvent(engine, f.id, 'capability_refused', 'integration', { capability, code: refusal.code, summary: `${capability}: refused by the integration (${refusal.code}: ${refusal.message})` });
      return { ok: false, code: refusal.code, detail: refusal.message };
    }
    await recordEvent(engine, f.id, 'capability_used', 'engine', { capability, summary });
    return { ok: true, value: result as T };
  };

  return {
    grant,
    /** Busy intervals only: no subject, body, location or attendees. */
    freeBusy: (attendees: readonly string[], from: Date, to: Date) =>
      call('free/busy', attendees, `free/busy read for ${String(attendees.length)} people, ${from.toISOString()} to ${to.toISOString()}`, (svc) =>
        svc.freeBusy(grant, { attendees: attendees.map(lower), from: from.toISOString(), to: to.toISOString() }),
      ),
    createInvitation: (request: { attendees: readonly string[]; subject: string; start: Date; end: Date; body: string; online: boolean }) =>
      call('invitation', request.attendees, `invitation "${request.subject}" for ${request.start.toISOString()} sent to ${String(request.attendees.length)} people`, (svc) =>
        svc.createInvitation(grant, { ...request, attendees: request.attendees.map(lower), start: request.start.toISOString(), end: request.end.toISOString() }),
      ),
    sendMail: (recipients: readonly string[], subject: string, body: string) =>
      call('protocol mail', recipients, `protocol mailed to ${String(recipients.length)} addresses`, (svc) => svc.sendMail(grant, { recipients: recipients.map(lower), subject, body })),
  };
}

const setGrant = (w: Work, state: 'active' | 'revoked'): Promise<unknown> =>
  w.tx.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || jsonb_build_object('followupGrant', $2::text) WHERE id = $1`, [w.f.id, state]);

const uniqueMail = (list: Array<string | null | undefined>): string[] => [...new Set(list.filter((a): a is string => typeof a === 'string' && a.includes('@')).map(lower))];

// ── jobs outside the lock ───────────────────────────────────────────────────
//
// Mail and invitation happen after the close is committed, as jobs keyed by
// facilitation and purpose. Before the call that cannot be taken back, the job
// writes down that it is about to make it. If the process dies or the answer
// is lost, the next run finds that mark and does NOT call again: the group is
// told that the outcome is unknown. So nobody gets a second mail or a second
// invitation.

type Claim<T> = { state: 'skip' } | { state: 'unknown' } | { state: 'go'; plan: T };

async function claimJob<T>(engine: EngineCore, job: Job, attemptedStage: string | undefined, plan: (w: Work) => Promise<T | undefined>): Promise<Claim<T>> {
  return engine.work(job.facilitationId, async (w) => {
    const current = await one<Job>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE id = $1 FOR UPDATE', [job.id]);
    if (!current || current.status !== 'pending' || current.leaseOwner !== engine.instanceId) return { state: 'skip' };
    if (current.payload['stage'] !== undefined) return { state: 'unknown' };
    const planned = await plan(w);
    if (planned === undefined) {
      await finishJob(w, job, { outcome: 'nothing_to_do' });
      return { state: 'skip' };
    }
    if (attemptedStage) await update(w.tx, 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { payload: { ...current.payload, stage: attemptedStage } });
    return { state: 'go', plan: planned };
  });
}

const markStage = (engine: EngineCore, job: Job, stage: string): Promise<unknown> =>
  engine.work(job.facilitationId, (w) => w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET payload = payload || jsonb_build_object('stage', $2::text) WHERE id = $1`, [job.id, stage]));

/** Store the result with the job and mark it done, in the unit of work that
 *  also tells the group. */
async function finishJob(w: Work, job: Job, result: Record<string, unknown>): Promise<void> {
  await w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_jobs SET status = 'done', finished_at = $2, lease_owner = NULL, lease_until = NULL, payload = payload || jsonb_build_object('result', $3::jsonb) WHERE id = $1`,
    [job.id, w.now, JSON.stringify(result)],
  );
}

const say = (w: Work, purpose: string, text: string): void => w.post({ purpose, key: 'once', to: 'group', deliveryClass: 'essential', text });

/** Mail the confirmed protocol to participants and confirmed stakeholders. */
const protocolMail: ExternalJob = async (engine, job) => {
  const claim = await claimJob(engine, job, 'mail_attempted', async (w) => {
    const { participants, stakeholders } = await peopleOf(w);
    const recipients = uniqueMail([...participants.map((p) => p.email), ...stakeholders.filter((s) => s.role === 'receives_protocol').map((s) => s.address)]);
    if (recipients.length === 0) return undefined;
    return { recipients, subject: texts(w.f.language).protocolMailSubject(w.f.goal), body: await buildProtocol(w.tx, w.f) };
  });
  if (claim.state === 'skip') return;
  const outcome: ScopedOutcome<{ outcome: string }> =
    claim.state === 'unknown' ? { ok: false, code: 'unknown_outcome' } : await (await scoped(engine, job.facilitationId)).sendMail(claim.plan.recipients, claim.plan.subject, claim.plan.body);
  await engine.work(job.facilitationId, async (w) => {
    const t = texts(w.f.language);
    if (outcome.ok && claim.state === 'go') say(w, 'protocol_sent', t.protocolSent(Number(job.payload['channel'] ?? 0), claim.plan.recipients.length));
    else if (!outcome.ok && outcome.code === 'unknown_outcome') say(w, 'protocol_mail_unknown', t.protocolMailUnknown());
    else if (!outcome.ok) say(w, 'protocol_mail_unavailable', t.protocolMailUnavailable(t.followupReasons[outcome.code]));
    await finishJob(w, job, outcome.ok ? { outcome: 'sent' } : { outcome: outcome.code });
  });
};

interface MeetingPlan {
  plan: FollowupMeetingPlan;
  attendees: string[];
  body: string;
  timezone: string;
  language: 'de' | 'en';
}

/** Schedule the follow-up meeting the group agreed on, from free/busy. */
const followupMeeting: ExternalJob = async (engine, job) => {
  const claim = await claimJob<MeetingPlan>(engine, job, undefined, async (w) => {
    const plan = w.f.followupPolicy.meeting;
    if (!plan) return undefined;
    const { participants, stakeholders } = await peopleOf(w);
    const t = texts(w.f.language);
    return {
      plan,
      attendees: uniqueMail([...participants.map((p) => p.email), ...stakeholders.filter((s) => s.role === 'invited_to_followups').map((s) => s.address)]),
      body: t.invitationBody(w.f.goal, t.closeSummary(await closingSummary(w))),
      timezone: w.f.timezone,
      language: w.f.language,
    };
  });
  if (claim.state === 'skip') return;
  const finish = (text: string, result: Record<string, unknown>): Promise<void> =>
    engine.work(job.facilitationId, async (w) => {
      w.post({ purpose: 'followup_meeting', key: 'once', to: 'group', deliveryClass: 'essential', text });
      await finishJob(w, job, result);
    });
  if (claim.state === 'unknown') {
    const f = await store.getFacilitation(engine.pool(), job.facilitationId);
    const subject = f?.followupPolicy.meeting?.subject ?? '';
    await finish(texts(f?.language ?? 'en').followupUnknown(subject), { outcome: 'unknown_outcome' });
    return;
  }
  const { plan, attendees, body, timezone, language } = claim.plan;
  const t = texts(language);
  if (attendees.length === 0) {
    await finish(t.followupUnavailable(plan.subject, t.followupReasons.no_addresses), { outcome: 'no_addresses' });
    return;
  }
  const api = await scoped(engine, job.facilitationId);
  // Free/busy comes on a quarter-hour grid counted from `from`, for a window
  // shorter than 62 days. Reading it can be repeated; it changes nothing.
  const from = alignToGrid(new Date(Math.max(Date.parse(plan.from), engine.now().getTime())));
  const to = new Date(Math.min(Date.parse(plan.to), from.getTime() + MAX_WINDOW_DAYS * DAY_MS));
  const availability = await api.freeBusy(attendees, from, to);
  if (!availability.ok) {
    await finish(t.followupUnavailable(plan.subject, t.followupReasons[availability.code]), { outcome: availability.code });
    return;
  }
  const busy = availability.value.outcome === 'ok' ? availability.value.busy : [];
  // A person missing from the answer is "availability unknown", not "free".
  const unknown = attendees.filter((a) => !busy.some((b) => lower(b.attendee) === a)).length;
  const slot = findSlot({ from, to, durationMinutes: plan.durationMinutes, timezone, busy: busy.flatMap((b) => b.intervals) });
  if (!slot) {
    await finish(t.followupNoSlot(plan.subject), { outcome: 'no_slot' });
    return;
  }
  // From here on the job is not repeated: an invitation cannot be taken back.
  await markStage(engine, job, 'inviting');
  const created = await api.createInvitation({ attendees, subject: plan.subject, start: slot.start, end: slot.end, body, online: plan.online });
  if (!created.ok) {
    await finish(created.code === 'unknown_outcome' ? t.followupUnknown(plan.subject) : t.followupUnavailable(plan.subject, t.followupReasons[created.code]), { outcome: created.code });
    return;
  }
  const joinUrl = created.value.outcome === 'created' ? created.value.joinUrl : undefined;
  await finish(t.followupCreated(plan.subject, formatWhen(slot.start, timezone, language), !plan.online || joinUrl !== undefined, unknown), {
    outcome: 'created',
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
  });
};

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

  // At the close the grant is issued. Nothing in this unit of work talks to
  // an integration: the protocol goes to the participants through the
  // outbox, mail and invitation become jobs that run after the commit,
  // outside the lock.
  onClosed(async (w) => {
    await setGrant(w, 'active');
    const { participants, stakeholders } = await peopleOf(w);
    // The protocol the participants get is the one the initiator got with the
    // report: built before anything is written about sending it.
    const t = texts(w.f.language);
    const protocol = await buildProtocol(w.tx, w.f);
    const grant = await grantOf(w);
    // A grant that reaches nobody is not a use of anything.
    if (grant.allowed.length > 0) {
      await w.event('grant_issued', 'engine', { summary: `grant issued for ${String(grant.allowed.length)} addresses (participants and confirmed stakeholders)` });
    }

    // The initiator already received the protocol with the report.
    const viaChannel = participants.filter((p) => p.principalId !== w.f.initiatorParticipant);
    for (const person of viaChannel) {
      w.post({ purpose: 'protocol', key: person.principalId, to: { principalId: person.principalId }, deliveryClass: 'essential', text: t.protocolDirect(person.displayName, protocol) });
    }
    await w.event('capability_used', 'engine', { capability: 'protocol dispatch', summary: `protocol sent privately to ${String(viaChannel.length)} participants` });

    const mailTo = uniqueMail([...participants.map((p) => p.email), ...stakeholders.filter((s) => s.role === 'receives_protocol').map((s) => s.address)]);
    if (w.config.protocolMailEnabled && mailTo.length > 0) await scheduleJob(w, 'protocol_mail', 'once', w.now, { channel: viaChannel.length });
    if (w.f.followupPolicy.meeting) await scheduleJob(w, 'followup_meeting', 'once', w.now, {});
    // With action items the grant ends with their follow-up; otherwise after
    // a fixed time.
    if (w.f.followupState !== 'active') await scheduleJob(w, 'grant_revoke', 'end', new Date(w.now.getTime() + w.config.followupGrantDays * DAY_MS), {});
  });
  registerExternalJob('protocol_mail', protocolMail);
  registerExternalJob('followup_meeting', followupMeeting);
  onFollowupEnded((w) => revoke(w, 'the follow-up ended'));
  registerJobHandler('grant_revoke', (w) => revoke(w, 'the follow-up period ended'));
}
