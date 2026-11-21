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

import type { ExecutionGrantKind, FacilitationFollowupService, FollowupGrant, FollowupRefusal } from '@omadia/plugin-api';

import { DAY_MS, HOUR_MS } from '../clock.js';
import { principalKey } from '../kernel.js';
import { insert, one, update } from '../db/sql.js';
import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Disclosure, Facilitation, FollowupMeetingPlan, Job, Participant, Stakeholder, StakeholderRole } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { onFollowupEnded } from './actionItems.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { onClosed } from './decide.js';
import { onClosingEnded } from './closing.js';
import { onAborted } from './lifecycle.js';
import { getClosing, listClosings } from './resultStatus.js';
import { scheduleJob } from './jobs.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { buildProtocol, closingSummary, sendWithProtocol } from './protocol.js';
import { stakeholderProtocol } from './stakeholderProtocol.js';
import { withTimeout } from './outbox.js';
import { registerExternalJob, registerJobHandler } from './scheduler.js';
import type { ExternalJob } from './scheduler.js';
import { recordRefusal } from './refusals.js';
import { CLOSING_ABORT, CLOSING_RESULT, SCHEDULING_MEETING, ensureScope } from './scopes.js';
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

const isAddress = (a: string | null | undefined): a is string => typeof a === 'string' && a.includes('@');

/**
 * Fill in the mail addresses the channel's member list has (D21).
 *
 * Somebody who became a participant by writing is known by a name only. The
 * member list, read as the facilitator, may carry an address or a user
 * principal name. Addresses come from there and from nowhere else: nobody is
 * asked for one in the chat. Called outside any unit of work.
 */
export async function refreshAddresses(engine: EngineCore, facilitationId: string): Promise<{ withAddress: number; without: number }> {
  const db = engine.db();
  const f = await store.getFacilitation(db, facilitationId);
  if (!f) return { withAddress: 0, without: 0 };
  const active = (await store.listParticipants(db, f.id)).filter((p) => p.status === 'active');
  const missing = active.filter((p) => !isAddress(p.email));
  let found = 0;
  if (missing.length > 0) {
    try {
      const roster = await engine.deps.kernel.rosters()?.getRoster(f.channelType, f.conversationId, { agentSlug: f.facilitatorAgent });
      const addresses = new Map<string, string>();
      for (const member of roster?.participants ?? []) {
        const address = member.userRef.email ?? member.userPrincipalName;
        if (member.isBot !== true && isAddress(address)) addresses.set(principalKey(member.userRef), lower(address));
      }
      const fill = missing.filter((p) => addresses.has(p.principalId));
      if (fill.length > 0) {
        await engine.work(f.id, async (w) => {
          for (const p of fill) await store.patchParticipant(w.tx, f.id, p.principalId, { email: addresses.get(p.principalId) ?? null });
        });
        found = fill.length;
      }
    } catch (err) {
      engine.log(`facilitation ${f.id}: the member list could not be read for mail addresses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { withAddress: active.length - missing.length + found, without: missing.length - found };
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
  const db = engine.db();
  const f = await store.getFacilitation(db, facilitationId);
  if (!f) throw new Refusal('unknown_facilitation', 'No such facilitation.');
  const grant = await grantOf({ tx: db, f });
  const service: FacilitationFollowupService | undefined = engine.deps.kernel.followup();

  // The protocol is read by the group: every line is in its language.
  const log = texts(f.language).capabilityLog;
  const named = (capability: string): string => log.names[capability] ?? capability;
  const reasonOf = (code: string, detail?: string): string => `${(texts(f.language).followupReasons as Record<string, string>)[code] ?? code}${detail ? `: ${detail}` : ''}`;

  const when = (d: Date): string => formatWhen(d, f.timezone, f.language);

  const refuse = async <T>(capability: string, code: ScopedCode, detail?: string): Promise<ScopedOutcome<T>> => {
    await recordEvent(engine, f.id, 'capability_refused', 'engine', { capability, code, summary: log.refused(named(capability), reasonOf(code, detail)) });
    return { ok: false, code, ...(detail ? { detail } : {}) };
  };

  /**
   * The kernel's grant for one operation (kernel #2078): issued under the
   * scope the operation belongs to, for the people the group confirmed, as
   * they are right now. Whoever left since the last send is not covered any
   * more. The integration asks the kernel with it before it acts.
   */
  const kernelGrant = async (kind: ExecutionGrantKind): Promise<{ ok: true; grantId: string } | { ok: false; code: ScopedCode; detail?: string }> => {
    const grants = engine.deps.kernel.grants();
    if (!grants) return { ok: false, code: 'no_grant_service' };
    const scope = kind === 'followup_scheduling' ? await ensureScope(engine, f, 'scheduling', SCHEDULING_MEETING) : await ensureScope(engine, f, 'closing', f.phase === 'aborted' ? CLOSING_ABORT : CLOSING_RESULT);
    const issued = scope.ok ? await grants.issueGrant({ scopeId: scope.scope.scopeId, kind, subject: kind === 'followup_scheduling' ? SCHEDULING_MEETING : 'protocol', recipients: grant.allowed }) : { outcome: 'refused' as const, code: scope.code, message: scope.message };
    if (issued.outcome === 'issued') return { ok: true, grantId: issued.grant.id };
    await recordRefusal(engine, f.id, { code: issued.code, message: issued.message, what: `the grant for ${kind}` });
    return { ok: false, code: 'grant_refused', detail: issued.message };
  };

  const call = async <T extends { outcome: string }>(
    capability: string,
    kind: ExecutionGrantKind,
    recipients: readonly string[],
    summary: string,
    run: (svc: FacilitationFollowupService, grant: FollowupGrant) => Promise<T | FollowupRefusal>,
    /** The operation that completes what the grant was for: revoked after it. */
    last = false,
  ): Promise<ScopedOutcome<T>> => {
    if (f.settings.followupGrant !== 'active') return refuse(capability, 'grant_revoked');
    const outside = recipients.map(lower).filter((r) => !grant.allowed.includes(r));
    if (outside.length > 0) return refuse(capability, 'recipient_not_allowed', outside.join(', '));
    if (!service) return refuse(capability, 'no_service');
    const granted = await kernelGrant(kind);
    if (!granted.ok) return refuse(capability, granted.code, granted.detail);
    let result: T | FollowupRefusal;
    try {
      result = await withTimeout(run(service, { ...grant, grantId: granted.grantId }), followupLimits.timeoutMs, `the integration (${capability})`);
    } catch (err) {
      // No answer: it may or may not have happened. Never repeated.
      const detail = err instanceof Error ? err.message : String(err);
      await recordEvent(engine, f.id, 'capability_refused', 'integration', { capability, code: 'unknown_outcome', summary: log.outcomeUnknown(named(capability), detail) });
      return { ok: false, code: 'unknown_outcome', detail };
    }
    if (result.outcome === 'refused') {
      const refusal = result as FollowupRefusal;
      await recordEvent(engine, f.id, 'capability_refused', 'integration', { capability, code: refusal.code, summary: log.refusedByIntegration(named(capability), `${refusal.code}: ${refusal.message}`) });
      return { ok: false, code: refusal.code, detail: refusal.message };
    }
    await recordEvent(engine, f.id, 'capability_used', 'engine', { capability, summary });
    // The sends are confirmed, or the invitations are out: the grant has
    // done what it was issued for.
    if (last) {
      try {
        await engine.deps.kernel.grants()?.revokeGrant(granted.grantId, `${capability} done`);
      } catch (err) {
        engine.log(`facilitation ${f.id}: the grant for ${capability} could not be revoked: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: true, value: result as T };
  };

  return {
    grant,
    /** Busy intervals only: no subject, body, location or attendees. */
    freeBusy: (attendees: readonly string[], from: Date, to: Date) =>
      call('free/busy', 'followup_scheduling', attendees, log.freeBusy(attendees.length, when(from), when(to)), (svc, grant) =>
        svc.freeBusy(grant, { attendees: attendees.map(lower), from: from.toISOString(), to: to.toISOString() }),
      ),
    createInvitation: (request: { attendees: readonly string[]; subject: string; start: Date; end: Date; body: string; online: boolean }) =>
      call(
        'invitation',
        'followup_scheduling',
        request.attendees,
        log.invitation(request.subject, when(request.start), request.attendees.length),
        (svc, grant) => svc.createInvitation(grant, { ...request, attendees: request.attendees.map(lower), start: request.start.toISOString(), end: request.end.toISOString() }),
        true,
      ),
    sendMail: (recipients: readonly string[], subject: string, body: string) =>
      call('protocol mail', 'protocol_dispatch', recipients, log.mailed(recipients.length), (svc, grant) => svc.sendMail(grant, { recipients: recipients.map(lower), subject, body }), true),
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

async function claimJob<T>(
  engine: EngineCore,
  job: Job,
  attemptedStage: string | undefined,
  plan: (w: Work) => Promise<T | undefined>,
  /** What is kept with the stage, so that an unknown outcome can still say
   *  what was planned. */
  remember: (planned: T) => Record<string, unknown> = () => ({}),
): Promise<Claim<T>> {
  return engine.work(job.facilitationId, async (w) => {
    const current = await one<Job>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE id = $1 FOR UPDATE', [job.id]);
    if (!current || current.status !== 'pending' || current.leaseOwner !== engine.instanceId) return { state: 'skip' };
    if (current.payload['stage'] !== undefined) return { state: 'unknown' };
    const planned = await plan(w);
    if (planned === undefined) {
      await finishJob(w, job, { outcome: 'nothing_to_do' });
      return { state: 'skip' };
    }
    if (attemptedStage) await update(w.tx, 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { payload: { ...current.payload, ...remember(planned), stage: attemptedStage } });
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

interface Mail {
  recipients: string[];
  subject: string;
  body: string;
  /** A stakeholder's own, filtered protocol (spec 5.8). */
  stakeholder?: { id: string; disclosure: Disclosure; withheld: string[] };
}

/** The final protocol by mail: the participants' protocol to the
 *  participants, and to each confirmed stakeholder their own, filtered by
 *  disclosure (spec 5.8, criterion 30). Every protocol carries its result
 *  status; the status never widens or narrows the recipients. */
const protocolMail: ExternalJob = async (engine, job) => {
  await refreshAddresses(engine, job.facilitationId);
  const claim = await claimJob<Mail[]>(engine, job, 'mail_attempted', async (w) => {
    // Bound to its closing: never after its dispatch or absolute limit.
    const closing = typeof job.payload['closingId'] === 'string' ? await getClosing(w.tx, job.payload['closingId']) : undefined;
    if (closing && (w.now >= closing.absoluteUntil || (closing.dispatchUntil !== null && w.now >= closing.dispatchUntil))) {
      await w.event('protocol_mail', 'engine', { outcome: 'dropped', reason: 'the dispatch limit of its closing passed', closingId: closing.id });
      w.engine.log(`facilitation ${w.f.id}: protocol mail not sent, the dispatch limit of its closing passed`);
      return undefined;
    }
    const { participants, stakeholders } = await peopleOf(w);
    const t = texts(w.f.language);
    const subject = t.protocolMailSubject(w.f.goal);
    const toParticipants = job.payload['participants'] === false ? [] : uniqueMail(participants.map((p) => p.email));
    const mails: Mail[] = toParticipants.length > 0 ? [{ recipients: toParticipants, subject, body: await buildProtocol(w.tx, w.f) }] : [];
    // Recipients are checked again at every send: a participant who left is
    // no recipient, a stakeholder only while the group's confirmation stands.
    for (const s of stakeholders.filter((x) => x.role === 'receives_protocol')) {
      const address = uniqueMail([s.address])[0];
      if (!address || toParticipants.includes(address)) continue;
      const filtered = await stakeholderProtocol(w.tx, w.f, s.disclosure);
      mails.push({ recipients: [address], subject, body: filtered.text, stakeholder: { id: s.id, disclosure: s.disclosure, withheld: filtered.withheld } });
    }
    // A retry sends only the mails the provider refused before.
    const only = Array.isArray(job.payload['only']) ? (job.payload['only'] as string[]) : undefined;
    if (only) {
      const again = mails.filter((m) => m.recipients.some((r) => only.includes(r)));
      if (again.length === 0) return undefined;
      return again;
    }
    if (mails.length === 0) {
      // Nobody to mail to is not silence: the group reads why, and has the
      // protocol where it is (once, if it is not there already).
      const shown = await w.tx.query(`SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'protocol_in_group' LIMIT 1`, [w.f.id]);
      say(w, 'protocol_mail_unavailable', t.protocolMailNoAddresses(shown.rows.length > 0 ? undefined : await buildProtocol(w.tx, w.f)));
      await w.event('protocol_mail_skipped', 'engine', { reason: 'no_addresses' });
      return undefined;
    }
    return mails;
  }, (mails) => ({ planned: mails.map((m) => ({ recipients: m.recipients, ...(m.stakeholder ? { stakeholder: m.stakeholder } : {}) })) }));
  if (claim.state === 'skip') return;
  type Planned = Pick<Mail, 'recipients' | 'stakeholder'>;
  const outcomes: Array<{ mail: Planned; outcome: ScopedOutcome<{ outcome: string }> }> = [];
  if (claim.state === 'unknown') {
    // What was planned, with the outcome of each mail that had one before
    // the process ended; the rest is unknown. Never sent again.
    const current = await one<Job>(engine.db(), 'SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE id = $1', [job.id]);
    const planned = Array.isArray(current?.payload['planned']) ? (current.payload['planned'] as Planned[]) : [];
    const known = (current?.payload['outcomes'] ?? {}) as Record<string, string>;
    for (const [i, mail] of planned.entries()) outcomes.push({ mail, outcome: known[String(i)] === 'sent' ? { ok: true, value: { outcome: 'sent' } } : { ok: false, code: 'unknown_outcome' } });
    if (planned.length === 0) outcomes.push({ mail: { recipients: [] }, outcome: { ok: false, code: 'unknown_outcome' } });
  } else {
    const api = await scoped(engine, job.facilitationId);
    for (const [i, mail] of claim.plan.entries()) {
      const outcome = await api.sendMail(mail.recipients, mail.subject, mail.body);
      outcomes.push({ mail, outcome });
      // Each mail's outcome is kept as it comes.
      await engine.db().query(`UPDATE plg_omadia_agent_facilitator_jobs SET payload = jsonb_set(payload, '{outcomes}', coalesce(payload->'outcomes', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)) WHERE id = $1`, [
        job.id,
        String(i),
        outcome.ok ? 'sent' : outcome.code,
      ]);
    }
  }
  await engine.work(job.facilitationId, async (w) => {
    const t = texts(w.f.language);
    const failures = outcomes.filter((o) => !o.outcome.ok);
    // An unknown outcome is said before any other failure: it may have arrived.
    const failed = failures.find((o) => !o.outcome.ok && o.outcome.code === 'unknown_outcome') ?? failures[0];
    const sentTo = outcomes.filter((o) => o.outcome.ok).reduce((n, o) => n + o.mail.recipients.length, 0);
    // A mail the provider refused with an error was not sent: it is tried
    // again while its closing's dispatch runs (spec 5.2 part 4, criterion
    // 34). An unknown outcome is never sent again.
    const retried = await retryRefusedMails(w, job, outcomes);
    if (sentTo > 0 || (!failed && !retried)) say(w, 'protocol_sent', t.protocolSent(Number(job.payload['channel'] ?? 0), sentTo));
    if (failed && !failed.outcome.ok && failed.outcome.code === 'unknown_outcome') say(w, 'protocol_mail_unknown', t.protocolMailUnknown());
    else if (failed && !failed.outcome.ok && !retried) say(w, 'protocol_mail_unavailable', t.protocolMailUnavailable(t.followupReasons[failed.outcome.code]));
    // What became of the mail, per recipient. "Sent" is said of nobody the
    // integration did not confirm.
    const each = (o: ScopedOutcome<unknown>): string => (o.ok ? 'sent' : o.code === 'unknown_outcome' ? 'unknown' : 'not_sent');
    const recipients = outcomes.flatMap((o) =>
      o.mail.recipients.map((address) => ({ address, outcome: each(o.outcome), ...(o.mail.stakeholder ? { stakeholder: true, disclosure: o.mail.stakeholder.disclosure, withheld: o.mail.stakeholder.withheld } : {}) })),
    );
    const code = failed && !failed.outcome.ok ? failed.outcome.code : 'sent';
    await w.event('protocol_mail', 'engine', { outcome: code, recipients });
    await finishJob(w, job, { outcome: code });
  });
};

/** How often a refused protocol mail is tried again, and how far apart. */
const MAIL_RETRIES = 6;
const mailRetryDelayMs = (attempt: number): number => Math.min(HOUR_MS * 2 ** (attempt - 1), DAY_MS);

/** Schedule the next attempt of the mails the provider refused with an
 *  error, inside the dispatch of their closing. True when one is scheduled. */
async function retryRefusedMails(w: Work, job: Job, outcomes: ReadonlyArray<{ mail: Pick<Mail, 'recipients'>; outcome: { ok: boolean; code?: string } }>): Promise<boolean> {
  const refused = outcomes.filter((o) => !o.outcome.ok && o.outcome.code === 'provider_error').flatMap((o) => o.mail.recipients);
  const closingId = typeof job.payload['closingId'] === 'string' ? job.payload['closingId'] : undefined;
  const attempt = Number(job.payload['attempt'] ?? 1);
  if (refused.length === 0 || !closingId || attempt >= MAIL_RETRIES) return false;
  const closing = await getClosing(w.tx, closingId);
  const due = new Date(w.now.getTime() + mailRetryDelayMs(attempt));
  const until = Math.min(closing?.dispatchUntil?.getTime() ?? 0, closing?.absoluteUntil.getTime() ?? 0);
  if (!closing || closing.endedAt !== null || due.getTime() >= until) return false;
  await scheduleJob(w, 'protocol_mail', `retry:${closingId}:${String(attempt)}`, due, { channel: 0, participants: job.payload['participants'] ?? true, closingId, only: refused, attempt: attempt + 1 });
  await w.event('protocol_mail_retry', 'engine', { closingId, attempt: attempt + 1, recipients: refused.length, at: due.toISOString() });
  return true;
}

interface MeetingPlan {
  plan: FollowupMeetingPlan;
  attendees: string[];
  body: string;
  timezone: string;
  language: 'de' | 'en';
}

/** Schedule the follow-up meeting the group agreed on, from free/busy. */
const followupMeeting: ExternalJob = async (engine, job) => {
  await refreshAddresses(engine, job.facilitationId);
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
    const f = await store.getFacilitation(engine.db(), job.facilitationId);
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
export async function proposeStakeholder(w: Work, input: { displayName: string; address?: string; role: StakeholderRole; disclosure?: Disclosure; addedBy: string }): Promise<Stakeholder> {
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
    disclosure: input.disclosure ?? 'existence',
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

/**
 * The facilitation protocol at the close or the abort (spec 5.11): the grant
 * is issued, the participants get it privately (the initiator has it with the
 * report), and a mail job sends it by mail where the facilitation or the
 * operator asked for that, and always to confirmed stakeholders, each their
 * own filtered protocol. Session protocols never go to stakeholders (F1).
 */
async function dispatchFinalProtocol(w: Work): Promise<void> {
  await setGrant(w, 'active');
  const { participants, stakeholders } = await peopleOf(w);
  const t = texts(w.f.language);
  const protocol = await buildProtocol(w.tx, w.f);
  const grant = await grantOf(w);
  // A grant that reaches nobody is not a use of anything.
  if (grant.allowed.length > 0) {
    await w.event('grant_issued', 'engine', { addresses: grant.allowed.length, summary: t.capabilityLog.grantIssued(grant.allowed.length) });
  }
  const closing = (await listClosings(w.tx, w.f.id)).find((c) => c.kind === (w.f.phase === 'aborted' ? 'abort' : 'result'));
  const viaChannel = participants.filter((p) => p.principalId !== w.f.initiatorParticipant);
  for (const person of viaChannel) {
    sendWithProtocol(w, { principalId: person.principalId }, { purpose: 'protocol', key: person.principalId, text: t.protocolDirect(person.displayName, protocol) }, protocol, closing);
  }
  if (viaChannel.length > 0) {
    await w.event('capability_used', 'engine', { capability: 'protocol dispatch', participants: viaChannel.length, summary: t.capabilityLog.protocolSent(viaChannel.length) });
  }
  // Scheduled even when no address is known yet: the job reads the member
  // list again, and says so when there is still nobody to mail to.
  const byMail = w.f.followupPolicy.protocolMail === true || w.config.protocolMailEnabled;
  const toStakeholders = stakeholders.some((s) => s.role === 'receives_protocol');
  if (byMail || toStakeholders) await scheduleJob(w, 'protocol_mail', 'once', w.now, { channel: viaChannel.length, participants: byMail, ...(closing ? { closingId: closing.id } : {}) });
}

async function revoke(w: Work, reason: 'followup_ended' | 'period_ended'): Promise<void> {
  if (w.f.settings.followupGrant !== 'active') return;
  await setGrant(w, 'revoked');
  await w.event('grant_revoked', 'engine', { reason, summary: texts(w.f.language).capabilityLog.grantRevoked(reason) });
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
    await dispatchFinalProtocol(w);
    // A stop revokes the scheduling: an agreed invitation survives a regular
    // close, never a stop (spec 5.2, criterion 52).
    if (w.f.followupPolicy.meeting && w.f.closeReason !== 'stopped') await scheduleJob(w, 'followup_meeting', 'once', w.now, {});
    // With action items the grant ends with their follow-up; after a stop
    // with the dispatch of its protocol (spec 5.2); otherwise after a fixed time.
    if (w.f.followupState !== 'active' && w.f.closeReason !== 'stopped') await scheduleJob(w, 'grant_revoke', 'end', new Date(w.now.getTime() + w.config.followupGrantDays * DAY_MS), {});
  });
  onClosingEnded(async (w) => {
    if (w.f.closeReason === 'stopped' || w.f.phase === 'aborted') await revoke(w, 'period_ended');
  });
  // An abort dispatches its protocol too, marked `aborted`, to the same
  // recipients (spec 5.11, criterion 39). Nothing to dispatch for one that
  // was never opened.
  onAborted(async (w) => {
    if (w.f.activatedAt === null) return;
    // The grant ends with the dispatch of the abort's protocol.
    await dispatchFinalProtocol(w);
  });
  registerExternalJob('protocol_mail', protocolMail);
  registerExternalJob('followup_meeting', followupMeeting);
  onFollowupEnded((w) => revoke(w, 'followup_ended'));
  registerJobHandler('grant_revoke', (w) => revoke(w, 'period_ended'));
}
