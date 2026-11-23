// The binding close of a session (spec 5.2, 5.7, 6.3; #2076; criteria 3,
// 38, 49, 51, 59).
//
// No session ends silently. When a live session ends, its summary
// (decisions, next steps, open points: open steps and topics parked while
// it ran) is frozen as the closing document of
// its own closing event (`session:<id>`, a row in the closings table, F2's
// result status model) and goes out in the session's conversation, drawn
// from that event's `closing` scope:
//
//   no confirmation required   result status `published`; the session is
//                              `closed` once the document is out
//   confirmation required      the session is `confirming`: a consent window
//                              starts when the document is delivered, in
//                              which its conversation accepts consent
//                              answers, status and stop, nothing else;
//                              then `confirmed`, or `not confirmed`
//                              (objection), and the session is `closed`
//
// Confirmation is required only where the method or the definition of done
// requires it: a free-text definition of done, or a consent decision taken
// in the session.
//
// Sessions at every terminal transition of the facilitation, in the same
// transaction: a scheduled session is cancelled with one short note in its
// conversation; a live one is closed (on stop or abort without a consent
// request); a confirming one continues its closing at the regular close and
// ends at once on stop or abort, its document sent again without a consent
// request and marked "not confirmed (facilitation stopped)".

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { one, rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Db, Queryable } from '../db/pool.js';
import { principalKey } from '../kernel.js';
import type { Closing, OutboxRow, ResultMark, Session } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { sessionTexts } from '../texts/sessions.js';
import type { EngineCore, Work } from './core.js';
import { onClosed, onConcluding } from './decide.js';
import type { InboundHandler, InboundResult } from './inbound.js';
import { PRIORITY, isPositiveReaction, normaliseCommand, registerInboundHandler } from './inbound.js';
import { scheduleJob } from './jobs.js';
import { abortInWork, onAborted } from './lifecycle.js';
import { isAgreement } from './proposals.js';
import { CLOSING_LIMITS, closingEventId, confirmationWindowMs, finalPatch, getClosingByEvent, markDocument, openClosing, patchClosing, resultStatusWords, stoppedMark, undeliveredMark } from './resultStatus.js';
import { FINAL_ELECTORATE_MAX_MS, FINAL_ELECTORATE_RETRY_MS, finalConsentElectorate } from './electorate.js';
import type { FinalConsentElectorate } from './electorate.js';
import { onDeadlineWait, registerJobHandler } from './scheduler.js';
import { verifySessionElectorate } from './sessionElectorate.js';
import { onConfirmingAnswer, sessionTitleOf } from './sessionLinks.js';

const SESSIONS = 'plg_omadia_agent_facilitator_sessions';
const OBJECTION = /^(?:objection|i object|einwand|veto|widerspruch|ich widerspreche)(?:\s*[:,-]\s*(.*))?$/is;
/** Jobs of session closings outlive the conclusion of the facilitation. */
export const SESSION_CLOSING_JOBS = ['session_confirmation'] as const;

const getSession = (q: Db | Work['tx'], id: string): Promise<Session | undefined> => one<Session>(q, `SELECT * FROM ${SESSIONS} WHERE id = $1`, [id]);

// ── the document ────────────────────────────────────────────────────────────

/** What a session produced, as a deterministic document (no model). */
async function summaryOf(w: Work, session: Session, eventId: string): Promise<string> {
  const t = sessionTexts(w.f.language);
  const since = session.startedAt ?? session.createdAt;
  const decisions = (await store.listDecisions(w.tx, w.f.id)).filter((d) => d.decidedAt >= since);
  const people = await store.listParticipants(w.tx, w.f.id);
  const nameOf = (principal: string): string => people.find((p) => p.principalId === principal)?.displayName ?? principal;
  const actions = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.createdAt >= since && a.status !== 'declined');
  const open = (await store.listSteps(w.tx, w.f.id)).filter((s) => s.status !== 'closed' && s.kind !== 'open' && s.kind !== 'close');
  // The parking lot of this session: what was parked while it ran (#60).
  const parked = (await store.listEvents(w.tx, w.f.id, ['parked'])).filter((e) => e.occurredAt >= since).map((e) => String(e.payload['topic']));
  const list = (lines: readonly string[]): string => (lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : t.summaryNone);
  return [
    t.summaryTitle(sessionTitleOf(session, w.f)),
    `${t.summaryDecisions}:\n${list(decisions.map((d) => d.statement))}`,
    `${t.summaryNextSteps}:\n${list(actions.map((a) => `${a.description} (${nameOf(a.ownerPrincipal)}, ${formatWhen(a.dueDate, w.f.timezone, w.f.language)})`))}`,
    `${t.summaryOpen}:\n${list([...open.map((s) => s.title), ...parked])}`,
    t.summaryFooter(eventId, 1),
  ].join('\n\n');
}

/** Only where the method or the definition of done requires it (5.2). */
async function confirmationRequired(w: Work, session: Session): Promise<boolean> {
  const dod = await w.tx.query<{ criteria: unknown }>(
    `SELECT criteria FROM plg_omadia_agent_facilitator_dod_versions WHERE facilitation_id = $1 AND consent_state IN ('initial', 'accepted') ORDER BY version DESC LIMIT 1`,
    [w.f.id],
  );
  const freeText = dod.rows.length > 0 && dod.rows[0]?.criteria === null;
  if (freeText) return true;
  const since = session.startedAt ?? session.createdAt;
  return (await store.listDecisions(w.tx, w.f.id)).some((d) => d.decidedAt >= since && d.method === 'consent');
}

// ── closing a session ───────────────────────────────────────────────────────

/**
 * End a live session with its summary. `stopped`: the facilitation was
 * stopped or aborted: the summary goes out without a consent request, final
 * at once.
 */
export async function closeSession(w: Work, session: Session, opts: { stopped?: boolean } = {}): Promise<Closing | undefined> {
  if (session.status !== 'live' || session.kind !== 'live') return undefined;
  const eventId = closingEventId('session', session.id);
  const requires = await confirmationRequired(w, session);
  const document = await summaryOf(w, session, eventId);
  const closing = await openClosing(w.tx, { facilitationId: w.f.id, kind: 'session', sessionId: session.id, document, requiresConfirmation: requires, now: w.now });
  const stopped = opts.stopped === true;
  const confirming = requires && !stopped;
  await update(w.tx, SESSIONS, { id: session.id }, {
    status: confirming ? 'confirming' : 'closed',
    endedAt: w.now,
    mediaConsent: session.mediaConsent === 'granted' ? 'withdrawn' : session.mediaConsent,
  });
  w.bump();
  await w.event('session_closed', 'engine', { sessionId: session.id, closingId: closing.id, requiresConfirmation: requires, stopped });
  const t = sessionTexts(w.f.language);
  const mark: ResultMark | undefined = stopped ? stoppedMark(requires) : requires ? undefined : { status: 'published' };
  if (mark) await patchClosing(w.tx, closing.id, finalPatch(mark, w.now));
  const until = formatWhen(new Date(w.now.getTime() + confirmationWindowMs(undefined)), w.f.timezone, w.f.language);
  postDocument(w, session, closing, mark ? markDocument(w.f.language, mark, closing.document) : `${closing.document}\n\n${t.summaryConsent(until)}`, 'session_summary');
  if (mark) protocolToHome(w, session, closing, mark);
  return closing;
}

/**
 * The final session protocol also goes to the home participants (spec 5.11,
 * criterion 63): in the home conversation, when the session ran in its own
 * chat. Stakeholders never get a session protocol.
 */
function protocolToHome(w: Work, session: Session, closing: Closing, mark: ResultMark): void {
  if (!session.conversationId) return;
  w.post({
    purpose: 'session_protocol',
    key: `${closing.id}:home`,
    to: 'group',
    conversationId: w.f.conversationId,
    deliveryClass: 'essential',
    versionBound: false,
    text: markDocument(w.f.language, mark, closing.document),
    closingEvent: closing.eventId,
    closing: { id: closing.id, version: closing.documentVersion },
  });
}

function postDocument(w: Work, session: Session, closing: Closing, text: string, purpose: string, key = closing.id): void {
  w.post({
    purpose,
    key,
    to: 'group',
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    deliveryClass: 'essential',
    versionBound: false,
    text,
    closingEvent: closing.eventId,
    closing: { id: closing.id, version: closing.documentVersion },
    ...(purpose === 'session_summary' ? { link: { kind: 'closing' as const, id: closing.id } } : {}),
  });
}

/** Set the result status of a session closing; the session is closed. */
async function finish(w: Work, closing: Closing, mark: ResultMark, opts: { resend?: boolean; undelivered?: boolean } = {}): Promise<void> {
  if (closing.endedAt) return;
  const session = closing.sessionId ? await getSession(w.tx, closing.sessionId) : undefined;
  await patchClosing(w.tx, closing.id, { ...finalPatch(mark, w.now), part: 'done', endedAt: w.now });
  if (session && session.status !== 'closed') await update(w.tx, SESSIONS, { id: session.id }, { status: 'closed', endedAt: session.endedAt ?? w.now });
  w.bump();
  await w.event('session_closing_final', 'engine', { closingId: closing.id, sessionId: closing.sessionId, status: mark.status, ...(mark.status === 'not_confirmed' ? { reason: mark.reason } : {}) });
  await resumeDeadline(w);
  if (!session) return;
  protocolToHome(w, session, closing, mark);
  const t = sessionTexts(w.f.language);
  const title = sessionTitleOf(session, w.f);
  if (opts.resend) {
    // Stop or abort: the summary with its consent request never goes out
    // any more (spec 5.2); the document again, without it, marked.
    await w.tx.query(
      `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'the consent request can no longer be answered'
        WHERE facilitation_id = $1 AND closing_id = $2 AND purpose = 'session_summary' AND status IN ('pending', 'sending')`,
      [w.f.id, closing.id],
    );
    postDocument(w, session, { ...closing, documentVersion: closing.documentVersion + 1 }, markDocument(w.f.language, mark, closing.document), 'session_summary_final');
    await patchClosing(w.tx, closing.id, { documentVersion: closing.documentVersion + 1 });
    return;
  }
  // A summary that never reached its conversation gets no status post there
  // either: nothing of its closing is sent after its delivery limit.
  if (opts.undelivered === true) return;
  postDocument(w, session, closing, mark.status === 'confirmed' ? t.summaryConfirmed(title) : t.summaryNotConfirmed(title, resultStatusWords(w.f.language, mark)), 'session_summary_status');
}

// ── delivery and the consent window ────────────────────────────────────────

/** After delivery (under the facilitation's lock): a delivered summary that
 *  needs confirmation opens its window; one that needs none is done; one
 *  that could not be delivered gets its status. */
export async function sessionSummariesDelivered(engine: EngineCore, client: Db, facilitationId: string): Promise<void> {
  const open = await rows<Closing>(client, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 AND kind = 'session' AND delivery_status = 'pending'`, [facilitationId]);
  if (open.length === 0) return;
  for (const closing of open) {
    // A first look without the lock decides only whether to take it; what is
    // done is decided again under the lock, on the sends as they are then.
    const seen = await summarySends(client, closing);
    if (closing.endedAt) {
      // Ended already (stop or abort): only its delivery status follows.
      if (seen.delivered || seen.gaveUp) await engine.workOn(client, facilitationId, async (w) => recordDelivery(w, closing.id));
      continue;
    }
    if (!seen.delivered && !seen.gaveUp && !deliveryOverdue(engine.now(), closing)) continue;
    await engine.workOn(client, facilitationId, async (w) => {
      const current = (await rows<Closing>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1 FOR UPDATE', [closing.id]))[0];
      if (!current || current.endedAt || current.deliveryStatus !== 'pending') return;
      const { delivered, gaveUp } = await summarySends(w.tx, current);
      if (!delivered && !gaveUp && !deliveryOverdue(w.now, current)) return;
      if (!delivered && !gaveUp) {
        const dropped = await w.tx.query(
          `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'the delivery limit of its closing passed'
            WHERE facilitation_id = $1 AND closing_id = $2 AND status IN ('pending', 'sending') RETURNING purpose`,
          [w.f.id, current.id],
        );
        await w.event('closing_send_dropped', 'engine', { closingId: current.id, reason: 'the delivery limit of its closing passed', sends: dropped.rows.length });
        w.engine.log(`facilitation ${w.f.id}: session summary ${current.eventId} not delivered within the delivery limit`);
      }
      if (!delivered) {
        await patchClosing(w.tx, current.id, { deliveryStatus: 'not_delivered' });
        await finish(w, current, undeliveredMark(current.requiresConfirmation), { undelivered: true });
        return;
      }
      const deliveredAt = delivered.sentAt ?? w.now;
      if (!current.requiresConfirmation || current.resultStatus !== null) {
        await patchClosing(w.tx, current.id, { deliveryStatus: 'delivered', deliveredAt, part: 'done', endedAt: w.now });
        await w.event('session_closing_final', 'engine', { closingId: current.id, sessionId: current.sessionId, status: current.resultStatus ?? 'published' });
        return;
      }
      const windowEndsAt = new Date(deliveredAt.getTime() + confirmationWindowMs(undefined));
      await patchClosing(w.tx, current.id, { deliveryStatus: 'delivered', deliveredAt, part: 'confirmation', partStartedAt: deliveredAt, windowEndsAt });
      await scheduleJob(w, 'session_confirmation', current.id, windowEndsAt, { closingId: current.id });
      await w.event('session_confirmation_open', 'engine', { closingId: current.id, until: windowEndsAt.toISOString() });
    });
  }
}

/** The sends of a session closing's current document version: a stop
 *  replaces the version that asked for consent (criterion 43). */
async function summarySends(q: Queryable, closing: Closing): Promise<{ delivered: OutboxRow | undefined; gaveUp: OutboxRow | undefined }> {
  const sent = await rows<OutboxRow>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND closing_id = $2 AND purpose IN ('session_summary', 'session_summary_final') AND document_version = $3`,
    [closing.facilitationId, closing.id, closing.documentVersion],
  );
  return { delivered: sent.find((r) => r.status === 'sent'), gaveUp: sent.find((r) => r.status === 'failed' || r.status === 'dropped') };
}

/** The delivery part has its own limit (spec 5.2: at most 7 days), like
 *  every closing; a summary that never got through is `not delivered`. */
const deliveryOverdue = (now: Date, closing: Closing): boolean => now.getTime() >= Math.min(closing.partStartedAt.getTime() + CLOSING_LIMITS.deliveryMs, closing.absoluteUntil.getTime());

/** The delivery status of a session closing that has ended already. */
async function recordDelivery(w: Work, closingId: string): Promise<void> {
  const current = (await rows<Closing>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1 FOR UPDATE', [closingId]))[0];
  if (!current || current.deliveryStatus !== 'pending') return;
  const { delivered, gaveUp } = await summarySends(w.tx, current);
  if (!delivered && !gaveUp) return;
  await patchClosing(w.tx, current.id, delivered ? { deliveryStatus: 'delivered', deliveredAt: delivered.sentAt ?? w.now } : { deliveryStatus: 'not_delivered' });
  await w.event(delivered ? 'closing_delivered' : 'result_undelivered', 'engine', { closingId: current.id, version: current.documentVersion });
}

/** A consent answer to a session summary: agreement lifts one's own
 *  objection, an objection needs a reason. Only answers bound to the
 *  summary count: a reply or a reaction to it, or any message in the
 *  session's own conversation while it is `confirming`. */
async function consentAnswer(w: Work, record: ConversationMessageRecord, bySession?: Session): Promise<InboundResult | undefined> {
  if (record.kind !== 'created' && record.kind !== 'reaction') return undefined;
  const target = record.kind === 'reaction' ? record.messageId : record.replyToMessageId;
  const open = await rows<Closing>(w.tx, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 AND kind = 'session' AND ended_at IS NULL AND requires_confirmation AND result_status IS NULL ORDER BY started_at`, [w.f.id]);
  const closing = open.find((c) => (target !== undefined && c.messageId === target) || (bySession !== undefined && c.sessionId === bySession.id));
  if (!closing) return undefined;
  // The window opens when the summary was delivered; before that nothing counts.
  if (closing.deliveryStatus !== 'delivered') return { outcome: 'session_consent_too_early' };
  const principal = principalKey(record.author);
  const voter = await eligible(w, closing, principal);
  if (!voter) return { outcome: 'session_consent_not_eligible' };
  const t = sessionTexts(w.f.language);
  if (record.kind === 'reaction') {
    if (!record.reaction || record.reaction.removed || !isPositiveReaction(record.reaction.name)) return undefined;
    await setObjection(w, closing, principal, undefined);
    return { outcome: 'session_consent' };
  }
  const command = normaliseCommand(record.text);
  if (isAgreement(command)) {
    await setObjection(w, closing, principal, undefined);
    return { outcome: 'session_consent' };
  }
  const objection = OBJECTION.exec((record.text ?? '').trim().replace(/^(@\S+\s+)+/u, '').replace(/[.!]+$/u, ''));
  if (!objection) return undefined;
  const reason = (objection[1] ?? '').trim();
  if (reason === '') {
    w.post({ purpose: 'session_consent_hint', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, closingEvent: closing.eventId, text: t.summaryObjectionNeedsReason(voter) });
    return { outcome: 'session_objection_without_reason' };
  }
  await setObjection(w, closing, principal, { reason, messageId: record.messageId });
  // Drawn from the session's own closing scope: it outlives the facilitation's.
  w.post({ purpose: 'session_objection', key: `${closing.id}:${record.eventId}`, to: 'group', deliveryClass: 'droppable', versionBound: false, closingEvent: closing.eventId, text: t.summaryObjection(voter, reason) });
  return { outcome: 'session_objection' };
}

/** Who may answer a session summary: an active home participant, or an
 *  active participant of that session. Returns the name. */
async function eligible(w: Work, closing: Closing, principal: string): Promise<string | undefined> {
  const home = await store.getParticipant(w.tx, w.f.id, principal);
  if (home?.status === 'active') return home.displayName;
  const guest = await w.tx.query<{ display_name: string }>(
    `SELECT display_name FROM plg_omadia_agent_facilitator_session_participants WHERE session_id = $1 AND principal_id = $2 AND status = 'active'`,
    [closing.sessionId, principal],
  );
  return guest.rows[0]?.display_name;
}

async function setObjection(w: Work, closing: Closing, principal: string, objection: { reason: string; messageId: string } | undefined): Promise<void> {
  const rest = closing.objections.filter((o) => o.principal !== principal);
  const objections = objection ? [...rest, { principal, ...objection }] : rest;
  await patchClosing(w.tx, closing.id, { objections });
  w.bump();
  await w.event(objection ? 'session_objection' : 'session_consent', principal, { closingId: closing.id, ...(objection ? { reason: objection.reason } : {}) });
}

/** The consent window ended: a standing objection of an eligible person
 *  means `not confirmed`, otherwise `confirmed`. */
async function windowEnded(w: Work, closingId: string): Promise<void> {
  const closing = await one<Closing>(w.tx, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1`, [closingId]);
  if (!closing || closing.endedAt || closing.resultStatus !== null) return;
  const standing: typeof closing.objections = [];
  for (const o of closing.objections) if (await eligible(w, closing, o.principal)) standing.push(o);
  if (standing.length > 0) return finish(w, closing, { status: 'not_confirmed', reason: 'objection' });
  // "Nobody objected" needs a verified electorate, as the final consent
  // does (spec 5.2 part 3, 5.5; criterion 59): asked fresh now, then hourly
  // for at most a day, else "participants could not be verified".
  const electorate = await sessionConsentElectorate(w, closing);
  if (electorate.state === 'verified') return finish(w, closing, { status: 'confirmed' });
  if (electorate.state === 'unverifiable') return finish(w, closing, { status: 'not_confirmed', reason: 'electorate_unverified' });
  await scheduleJob(w, 'session_confirmation', `${closing.id}:${electorate.at.toISOString()}`, electorate.at, { closingId: closing.id });
  const said = (await store.listEvents(w.tx, w.f.id, ['electorate_unverified'])).some((e) => e.payload['closingId'] === closing.id);
  if (said) return;
  await w.event('electorate_unverified', 'engine', { closingId: closing.id });
  const session = closing.sessionId ? await getSession(w.tx, closing.sessionId) : undefined;
  w.post({
    purpose: 'session_consent_hint',
    key: `${closing.id}:unverified`,
    to: 'group',
    ...(session?.conversationId ? { conversationId: session.conversationId } : {}),
    deliveryClass: 'droppable',
    versionBound: false,
    closingEvent: closing.eventId,
    text: texts(w.f.language).closing.electorateUnverified(),
  });
}

/** May a session summary's window pass now? The home electorate, and a
 *  session's own platform roster, must be verified. */
async function sessionConsentElectorate(w: Work, closing: Closing): Promise<FinalConsentElectorate> {
  const windowEndedAt = closing.windowEndsAt ?? w.now;
  const home = await finalConsentElectorate(w, windowEndedAt);
  if (home.state !== 'verified') return home;
  const session = closing.sessionId ? await getSession(w.tx, closing.sessionId) : undefined;
  if (!session || session.electorateSource !== 'platform_roster') return home;
  if ((await verifySessionElectorate(w, session)).verified) return home;
  const giveUpAt = windowEndedAt.getTime() + FINAL_ELECTORATE_MAX_MS;
  if (w.now.getTime() >= giveUpAt) return { state: 'unverifiable' };
  return { state: 'retry', at: new Date(Math.min(w.now.getTime() + FINAL_ELECTORATE_RETRY_MS, giveUpAt)) };
}

// ── sessions at the end of the facilitation (criterion 49) ─────────────────

/** A scheduled session that will not take place: cancelled, with one short
 *  note in its own conversation. */
async function cancelScheduled(w: Work, session: Session): Promise<void> {
  await update(w.tx, SESSIONS, { id: session.id }, { status: 'cancelled' });
  w.bump();
  await w.event('session_cancelled', 'engine', { sessionId: session.id });
  if (!session.conversationId) return;
  // Drawn from the session's own closing scope: the facilitation's
  // moderation is over, and so is the reservation of that conversation.
  const closing = await openClosing(w.tx, { facilitationId: w.f.id, kind: 'session', sessionId: session.id, document: sessionTexts(w.f.language).sessionCancelledThere(sessionTitleOf(session, w.f)), requiresConfirmation: false, now: w.now });
  await patchClosing(w.tx, closing.id, { ...finalPatch({ status: 'published' }, w.now), part: 'done', endedAt: w.now, deliveryStatus: 'pending' });
  postDocument(w, session, closing, closing.document, 'session_cancelled');
}

/** Entering `concluding`: scheduled sessions are cancelled, live ones closed;
 *  a confirming session goes on with its closing (criterion 51). */
export async function sessionsAtConclusion(w: Work): Promise<void> {
  for (const session of await store.listSessions(w.tx, w.f.id)) {
    if (session.kind !== 'live') continue;
    if (session.status === 'scheduled') await cancelScheduled(w, session);
    else if (session.status === 'live') await endLive(w, session);
  }
}

/** A live session at the end: an ad-hoc meeting just ends, an agreed
 *  session gets its binding close. */
async function endLive(w: Work, session: Session, opts: { stopped?: boolean } = {}): Promise<void> {
  if (session.title === null && session.scheduledStart === null && session.conversationId === null) {
    await update(w.tx, SESSIONS, { id: session.id }, { status: 'closed', endedAt: w.now });
    return;
  }
  await closeSession(w, session, opts);
}

/** Stop, abort, the end of the `configuring` scope, an error: every session
 *  ends at once; no consent request goes out that can no longer be answered. */
export async function sessionsAtAbort(w: Work): Promise<void> {
  for (const session of await store.listSessions(w.tx, w.f.id)) {
    if (session.kind === 'async') {
      if (session.status === 'live') await update(w.tx, SESSIONS, { id: session.id }, { status: 'closed', endedAt: w.now });
      continue;
    }
    if (session.status === 'scheduled') await cancelScheduled(w, session);
    else if (session.status === 'live') await endLive(w, session, { stopped: true });
    else if (session.status === 'confirming') {
      const closing = await getClosingByEvent(w.tx, w.f.id, closingEventId('session', session.id));
      if (closing && !closing.endedAt) await finish(w, closing, stoppedMark(true), { resend: true });
      else await update(w.tx, SESSIONS, { id: session.id }, { status: 'closed' });
    }
  }
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending' AND kind = 'session_confirmation'`, [w.f.id, w.now]);
}

/** The chat phase of a facilitation that closed regularly ends with it. */
async function chatPhaseEnds(w: Work): Promise<void> {
  await w.tx.query(`UPDATE ${SESSIONS} SET status = 'closed', ended_at = $2 WHERE facilitation_id = $1 AND kind = 'async' AND status = 'live'`, [w.f.id, w.now]);
  for (const session of await store.listSessions(w.tx, w.f.id)) {
    if (session.kind === 'live' && session.status === 'scheduled') await cancelScheduled(w, session);
    else if (session.kind === 'live' && session.status === 'live') await endLive(w, session);
  }
}

/** Consent answers to a session summary in the home conversation (a reply to
 *  the summary of a session that ran there). */
const homeConsentAnswers: InboundHandler = async ({ w, record }) => {
  if (record.conversationId !== w.f.conversationId) return undefined;
  return consentAnswer(w, record);
};

// ── the deadline waits for session closings (spec 5.6, criterion 59) ───────

const openConfirmations = (w: Work): Promise<Closing[]> =>
  rows<Closing>(w.tx, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 AND kind = 'session' AND requires_confirmation AND ended_at IS NULL`, [w.f.id]);

/**
 * At the deadline: every live session is closed first; while session
 * closings that require confirmation are open, the evaluation waits (the
 * `active` scope is held in its bounded deadline wait, and only consent
 * answers, status and stop are taken). When they have ended it runs once
 * with their outcomes: a summary that was not confirmed ends the
 * facilitation with an abort report naming it.
 */
async function deadlineWait(w: Work): Promise<boolean> {
  if (w.f.phase !== 'active') return false;
  for (const session of await store.listSessions(w.tx, w.f.id)) {
    if (session.kind === 'live' && session.status === 'live') await endLive(w, session);
  }
  const open = await openConfirmations(w);
  if (open.length > 0) {
    if (w.f.settings.deadlineWait !== true) {
      await w.patch({ settings: { ...w.f.settings, deadlineWait: true } });
      await w.event('deadline_wait', 'engine', { closings: open.map((c) => c.id) });
    }
    return true;
  }
  if (w.f.settings.deadlineWait !== true) return false;
  const { deadlineWait: _done, ...settings } = w.f.settings;
  await w.patch({ settings });
  const waited = (await w.event('deadline_wait_ended', 'engine', {}), await listClosingsOf(w));
  const failed = waited.find((c) => c.kind === 'session' && c.requiresConfirmation && c.resultStatus === 'not_confirmed');
  if (!failed) return false;
  const session = failed.sessionId ? await getSession(w.tx, failed.sessionId) : undefined;
  const t = sessionTexts(w.f.language);
  await abortInWork(w, {
    reason: t.notConfirmedAtDeadline(session ? sessionTitleOf(session, w.f) : '', resultStatusWords(w.f.language, { status: 'not_confirmed', reason: failed.resultReason ?? 'objection' })),
    actor: 'engine',
    detail: { closingId: failed.id },
  });
  return true;
}

const listClosingsOf = (w: Work): Promise<Closing[]> => rows<Closing>(w.tx, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 ORDER BY started_at`, [w.f.id]);

/** During the deadline wait nothing else changes: only consent answers to
 *  the waiting summaries (read before this), status and stop. */
const duringDeadlineWait: InboundHandler = async ({ w, record }) => {
  if (w.f.settings.deadlineWait !== true || w.f.phase !== 'active' || record.kind === 'reaction') return undefined;
  return { outcome: 'deadline_wait' };
};

/** A waiting session closing ended: the deadline is evaluated now. */
async function resumeDeadline(w: Work): Promise<void> {
  if (w.f.settings.deadlineWait !== true || w.f.phase !== 'active') return;
  if ((await openConfirmations(w)).length > 0) return;
  await scheduleJob(w, 'deadline', `after-sessions:${String(w.now.getTime())}`, w.now, {});
}

export function installSessionClose(): void {
  onDeadlineWait(deadlineWait);
  registerInboundHandler(duringDeadlineWait, PRIORITY.proposals + 5);
  registerInboundHandler(homeConsentAnswers, PRIORITY.proposals - 1);
  onConfirmingAnswer((w, session, record) => consentAnswer(w, record, session));
  registerJobHandler('session_confirmation', async (w, job) => windowEnded(w, String(job.payload['closingId'])));
  onConcluding(sessionsAtConclusion);
  onAborted(async (w) => sessionsAtAbort(w));
  onClosed(chatPhaseEnds);
}
