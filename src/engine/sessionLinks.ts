// Linked session conversations (spec 5.3; #2076, #2089; criteria 22, 45,
// 46, 48, 60).
//
// A live session may run in another conversation than the home one, for
// example the chat of a scheduled Teams meeting. The link is requested
// INSIDE that conversation: a home participant addresses the facilitator
// there and names the facilitation. The kernel hands that message over as a
// typed link request (no read access before the link), and only such a
// request lets the facilitation reserve the conversation. A request made
// only from the home conversation takes nothing.
//
// The session conversation then has its own reservation, its own
// subscription and its own cursor, and is read as the session's state
// allows (the kernel enforces the same table):
//
//   scheduled   messages addressed to the facilitator (questions, preparation)
//   live        every human message: moderation
//   confirming  every human message; only consent answers, status and stop
//   closed      nothing; the reservation is released
//
// People in the session conversation who are not home participants are
// session participants only. They see what is posted in that conversation
// and the session summary, never the home conversation's history.

import type { ConversationMessageMode, ConversationMessageRecord, LinkRequest, LinkRequestReply, SessionConversationState } from '@omadia/plugin-api';

import { MINUTE_MS } from '../clock.js';
import { insertIfAbsent, one, rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Queryable } from '../db/pool.js';
import { principalKey } from '../kernel.js';
import type { Facilitation, Session, SessionParticipant } from '../model.js';
import { sessionTexts } from '../texts/sessions.js';
import { formatWhen } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import type { InboundResult } from './inbound.js';
import { normaliseCommand } from './inbound.js';
import { scheduleJob } from './jobs.js';
import { ensureScope, scopeKeyFor } from './scopes.js';

const SESSIONS = 'plg_omadia_agent_facilitator_sessions';
const GUESTS = 'plg_omadia_agent_facilitator_session_participants';
/** How soon a session that could not go live for missing readiness is tried again. */
export const READINESS_RETRY_MS = 5 * MINUTE_MS;

const STATUS_OR_STOP = /^(status|stand|zwischenstand|stop|stopp)$/u;

export const sessionOfConversation = (q: Queryable, facilitationId: string, conversationId: string): Promise<Session | undefined> =>
  one<Session>(q, `SELECT * FROM ${SESSIONS} WHERE facilitation_id = $1 AND conversation_id = $2`, [facilitationId, conversationId]);

export const linkedSessions = (q: Queryable, facilitationId: string): Promise<Session[]> =>
  rows<Session>(q, `SELECT * FROM ${SESSIONS} WHERE facilitation_id = $1 AND conversation_id IS NOT NULL ORDER BY created_at, id`, [facilitationId]);

export const listSessionGuests = (q: Queryable, sessionId: string): Promise<SessionParticipant[]> =>
  rows<SessionParticipant>(q, `SELECT * FROM ${GUESTS} WHERE session_id = $1 ORDER BY joined_at`, [sessionId]);

export const sessionTitleOf = (session: Pick<Session, 'title'>, f: Pick<Facilitation, 'goal' | 'language'>): string => session.title ?? sessionTexts(f.language).defaultSessionTitle();

/** The kernel's session state for a session's state in the engine. */
export const kernelStateOf = (session: Pick<Session, 'status'>): SessionConversationState => session.status;

/** How a session conversation is read in its state (5.3). */
export function sessionReadMode(session: Pick<Session, 'status'>): ConversationMessageMode {
  if (session.status === 'scheduled') return 'addressed';
  if (session.status === 'live' || session.status === 'confirming') return 'all';
  return 'none';
}

// ── link requests ───────────────────────────────────────────────────────────

/** The facilitations a link request may name: running ones the author is an
 *  active home participant of. */
async function namedFacilitations(engine: EngineCore, request: LinkRequest): Promise<{ named: Facilitation[]; candidates: Facilitation[] }> {
  const db = engine.db();
  const candidates: Facilitation[] = [];
  for (const processId of request.processIds) {
    const f = await store.getFacilitation(db, processId);
    if (!f || f.facilitatorAgent !== request.agentSlug || f.channelType !== request.channelType) continue;
    if (f.phase !== 'configuring' && f.phase !== 'active') continue;
    candidates.push(f);
  }
  const text = (request.text ?? '').toLowerCase();
  const named = candidates.filter((f) => f.goal.trim().length > 0 && text.includes(f.goal.trim().toLowerCase()));
  return { named, candidates };
}

/**
 * A link request (kernel `onLinkRequest`). Decided at once: the kernel waits
 * for the answer before it lets the facilitator's ordinary turn run. The
 * link itself (reservation, readiness, subscription, confirmations) follows
 * inside, as the kernel's request is only valid for a short while anyway.
 */
export async function handleLinkRequest(engine: EngineCore, request: LinkRequest): Promise<LinkRequestReply> {
  try {
    const { named, candidates } = await namedFacilitations(engine, request);
    const language = candidates[0]?.language ?? 'en';
    if (!sessionTexts('en').linkKeyword.test(request.text) && !sessionTexts('de').linkKeyword.test(request.text) && named.length === 0) return { handled: false };
    // The facilitation it names; with a single running one, that one.
    const pool = named.length > 0 ? named : candidates.length === 1 ? candidates : [];
    if (pool.length !== 1) {
      if (candidates.length === 0) return { handled: false };
      return { handled: true, answer: sessionTexts(language).linkWhich(candidates.map((f) => f.goal)) };
    }
    const f = pool[0] as Facilitation;
    const t = sessionTexts(f.language);
    const principal = `user:${request.principalId.toLowerCase()}`;
    const person = await store.getParticipant(engine.db(), f.id, principal);
    // Criterion 48: only a home participant, from inside the target.
    if (person?.status !== 'active') return { handled: true, answer: t.linkNotParticipant() };
    await linkConversation(engine, f, request, person.displayName);
    return { handled: true };
  } catch (err) {
    engine.log(`a link request to '${request.agentSlug}' failed: ${err instanceof Error ? err.message : String(err)}`);
    return { handled: false };
  }
}

/** The session the conversation is linked for: one the request names by
 *  title, else the next scheduled one without a conversation, else a new one. */
async function sessionFor(engine: EngineCore, f: Facilitation, text: string): Promise<{ session?: Session; title?: string }> {
  const open = (await store.listSessions(engine.db(), f.id)).filter((s) => s.kind === 'live' && s.status === 'scheduled' && s.conversationId === null);
  const lower = text.toLowerCase();
  const byTitle = open.find((s) => s.title !== null && lower.includes(s.title.toLowerCase()));
  if (byTitle) return { session: byTitle };
  const next = [...open].sort((a, b) => (a.scheduledStart?.getTime() ?? Infinity) - (b.scheduledStart?.getTime() ?? Infinity))[0];
  return next ? { session: next } : {};
}

async function linkConversation(engine: EngineCore, f: Facilitation, request: LinkRequest, linkedByName: string): Promise<void> {
  const t = sessionTexts(f.language);
  const execution = engine.deps.kernel.execution();
  const messages = engine.deps.kernel.messages();
  if (!execution || !messages) return;
  // Already linked (a repeated request, a restart): nothing new is taken.
  const existing = await sessionOfConversation(engine.db(), f.id, request.conversationId);
  if (existing) return;
  const found = await sessionFor(engine, f, request.text);
  let session = found.session;
  if (!session) {
    session = await engine.work(f.id, (w) =>
      insertIfAbsent<Session>(w.tx, SESSIONS, { facilitationId: f.id, kind: 'live', title: t.defaultSessionTitle(), modality: 'online', createdAt: w.now }),
    );
  }
  if (!session) return;
  const title = sessionTitleOf(session, f);

  const reserved = await execution.reserveConversation({
    agentSlug: f.facilitatorAgent,
    processId: f.id,
    channelType: f.channelType,
    conversationId: request.conversationId,
    linkRequestId: request.linkRequestId,
    sessionId: session.id,
  });
  if (reserved.outcome === 'refused') {
    engine.log(`facilitation ${f.id}: linking ${request.conversationId} was refused (${reserved.code}: ${reserved.message})`);
    await engine.work(f.id, async (w) => {
      await w.event('session_link_refused', principalKey({ id: request.principalId }), { sessionId: session.id, conversationId: request.conversationId, code: reserved.code });
      const holder = /discussion/.test(reserved.message) ? 'discussion' : 'process';
      w.post({
        purpose: 'session_link',
        key: `${session.id}:${request.linkRequestId}`,
        to: 'group',
        deliveryClass: 'essential',
        versionBound: false,
        text: reserved.code === 'conversation_busy' ? t.linkBusy(title, holder) : t.linkFailed(title, reserved.code),
      });
    });
    return;
  }

  // The link is on record in the same moment the reservation was taken; a
  // restart finds it and goes on from here.
  const recorded = await engine.work(f.id, async (w) => {
    // Guarded: another link may have taken this session a moment ago.
    const taken = await w.tx.query(
      `UPDATE ${SESSIONS} SET conversation_id = $2, linked_by = $3, linked_at = $4
        WHERE id = $1 AND conversation_id IS NULL AND status = 'scheduled'
          AND NOT EXISTS (SELECT 1 FROM ${SESSIONS} o WHERE o.facilitation_id = $5 AND o.conversation_id = $2)`,
      [session.id, request.conversationId, `user:${request.principalId.toLowerCase()}`, w.now, f.id],
    );
    if ((taken.rowCount ?? 0) === 0) return false;
    w.bump();
    await w.event('session_linked', `user:${request.principalId.toLowerCase()}`, { sessionId: session.id, conversationId: request.conversationId });
    w.post({ purpose: 'session_link', key: `${session.id}:there`, to: 'group', conversationId: request.conversationId, deliveryClass: 'essential', versionBound: false, text: t.linkConfirmedHere(f.goal, title) });
    w.post({ purpose: 'session_link', key: `${session.id}:home`, to: 'group', deliveryClass: 'essential', versionBound: false, text: t.linkConfirmedHome(linkedByName, title) });
    return true;
  });
  // Lost the race for this session: the conversation is given back (the sync
  // does the same after a crash).
  if (!recorded) {
    await execution.releaseConversation({ processId: f.id, channelType: f.channelType, conversationId: request.conversationId, reason: 'link not recorded' });
    return;
  }
  await syncSessionConversations(engine, f.id);
  await checkSessionReadiness(engine, f.id, session.id);
}

/** The link request answer for a request made in the home conversation:
 *  nothing is taken there (criterion 48). */
export const linkFromHomeText = (f: Pick<Facilitation, 'language'>): string => sessionTexts(f.language).linkFromHome();

// ── readiness of a session conversation (criterion 60) ─────────────────────

/**
 * Check whether the facilitator can read every message of a session's
 * conversation, as a checked action under the facilitation's scope. The
 * result is kept on the session; when it is missing the home conversation
 * is told (once per change), and the session does not go live.
 */
export async function checkSessionReadiness(engine: EngineCore, facilitationId: string, sessionId: string): Promise<'ready' | 'not_ready' | 'unknown'> {
  const f = await store.getFacilitation(engine.db(), facilitationId);
  const session = await one<Session>(engine.db(), `SELECT * FROM ${SESSIONS} WHERE id = $1`, [sessionId]);
  const sends = engine.deps.kernel.conversationSend();
  if (!f || !session?.conversationId || !sends) return 'unknown';
  const key = scopeKeyFor(f, 'readiness', false);
  const scope = await ensureScope(engine, f, key.kind, key.eventId);
  if (!scope.ok) return 'unknown';
  const outcome = await sends.checkReadiness({
    agentSlug: f.facilitatorAgent,
    channelType: f.channelType,
    conversationId: session.conversationId,
    authorization: { scopeId: scope.scope.scopeId, processId: f.id, phase: f.phase === 'configuring' ? 'configuring' : 'active' },
  });
  if (outcome.outcome !== 'checked') return 'unknown';
  const ready = outcome.report.ready;
  const missing = outcome.report.missing.map((m) => `${m.code}: ${m.message}`).join('; ');
  await recordReadiness(engine, f.id, session.id, ready, missing);
  return ready ? 'ready' : 'not_ready';
}

/** Keep the readiness on the session and tell the home conversation what
 *  changed: missing, or ready again. */
export async function recordReadiness(engine: EngineCore, facilitationId: string, sessionId: string, ready: boolean, missing: string): Promise<void> {
  await engine.work(facilitationId, async (w) => {
    const session = await one<Session>(w.tx, `SELECT * FROM ${SESSIONS} WHERE id = $1`, [sessionId]);
    if (!session) return;
    const next = ready ? 'ready' : 'not_ready';
    if (session.readiness === next && (ready || session.readinessDetail === missing)) return;
    await update(w.tx, SESSIONS, { id: session.id }, { readiness: next, readinessDetail: ready ? null : missing || null });
    await w.event('session_readiness', 'engine', { sessionId: session.id, ready, missing });
    const t = sessionTexts(w.f.language);
    const title = sessionTitleOf(session, w.f);
    if (!ready) {
      w.post({ purpose: 'session_readiness', key: `${session.id}:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'essential', versionBound: false, text: t.notReadyHome(title, missing || 'the channel reports it cannot deliver every message') });
    } else if (session.readiness === 'not_ready') {
      w.post({ purpose: 'session_readiness', key: `${session.id}:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.readyAgainHome(title) });
    }
  });
}

/**
 * Before a linked session goes live (outside any unit of work): the kernel
 * moves its conversation to `live`, which it refuses when the channel cannot
 * deliver every message there. `false`: the session stays scheduled.
 */
export async function goLiveAtKernel(engine: EngineCore, f: Facilitation, session: Session): Promise<{ ok: true } | { ok: false; missing: string }> {
  if (!session.conversationId) return { ok: true };
  const execution = engine.deps.kernel.execution();
  if (!execution?.setSessionState) return { ok: false, missing: 'this kernel cannot run a session in a linked conversation' };
  const moved = await execution.setSessionState({ processId: f.id, channelType: f.channelType, conversationId: session.conversationId, state: 'live', reason: 'session starts' });
  if (moved.outcome === 'refused') return { ok: false, missing: moved.code === 'not_ready' ? moved.message : `${moved.code}: ${moved.message}` };
  const messages = engine.deps.kernel.messages();
  await messages?.subscribe({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: session.conversationId, processId: f.id }, { mode: 'all' });
  return { ok: true };
}

/** A linked session could not go live: on record, the home conversation is
 *  told, and the start is tried again shortly. */
export async function notLive(w: Work, session: Session, missing: string): Promise<void> {
  // Its time is over: it does not take place, and nothing is tried again.
  if (session.scheduledEnd && w.now >= session.scheduledEnd) {
    await missedSession(w, session, missing);
    return;
  }
  await update(w.tx, SESSIONS, { id: session.id }, { readiness: 'not_ready', readinessDetail: missing });
  await w.event('session_not_live', 'engine', { sessionId: session.id, missing });
  if (session.readiness !== 'not_ready' || session.readinessDetail !== missing) {
    w.post({ purpose: 'session_readiness', key: `${session.id}:start:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'essential', versionBound: false, text: sessionTexts(w.f.language).notReadyHome(sessionTitleOf(session, w.f), missing) });
  }
  await scheduleJob(w, 'session_start', `${session.id}:retry:${String(w.now.getTime())}`, new Date(w.now.getTime() + READINESS_RETRY_MS), { sessionId: session.id });
}

// ── keeping the kernel in line with the sessions ───────────────────────────

/**
 * The session states of the engine are the truth; the kernel's state of each
 * session conversation and the subscription there follow them. Called after
 * every unit of work and on every scheduler pass. Idempotent.
 */
export async function syncSessionConversations(engine: EngineCore, facilitationId: string): Promise<void> {
  const execution = engine.deps.kernel.execution();
  const messages = engine.deps.kernel.messages();
  if (!execution || !messages) return;
  const f = await store.getFacilitation(engine.db(), facilitationId);
  if (!f) return;
  const sessions = await linkedSessions(engine.db(), f.id);
  const reservations = await execution.listReservations(f.id);
  // A reservation taken for a link that never reached the database (a crash
  // between the two, or a link that lost a race): given back.
  for (const r of reservations) {
    if (r.role !== 'session' || r.releasedAt !== undefined || sessions.some((s) => s.conversationId === r.conversationId)) continue;
    await execution.releaseConversation({ processId: f.id, channelType: f.channelType, conversationId: r.conversationId, reason: 'link not on record' });
    engine.log(`facilitation ${f.id}: released ${r.conversationId}, its link is not on record`);
  }
  for (const session of sessions) {
    const conversationId = session.conversationId as string;
    const reservation = reservations.filter((r) => r.conversationId === conversationId && r.role === 'session').at(-1);
    const kernelState = reservation?.sessionState ?? (reservation?.releasedAt ? 'closed' : 'scheduled');
    // The kernel went live before the start's unit of work, which did not
    // happen (a stop, a failure): a cancelled session closes there; a
    // scheduled one is started again.
    let wanted: SessionConversationState = kernelStateOf(session);
    if (wanted === 'cancelled' && (kernelState === 'live' || kernelState === 'confirming')) wanted = 'closed';
    if (wanted === 'scheduled' && kernelState === 'live') {
      await engine.work(f.id, (w) => scheduleJob(w, 'session_start', `${session.id}:resume`, w.now, { sessionId: session.id }));
      continue;
    }
    // `live` is only entered through `goLiveAtKernel` (readiness first).
    if (wanted !== kernelState && wanted !== 'live' && wanted !== 'scheduled' && kernelState !== 'closed' && kernelState !== 'cancelled' && execution.setSessionState) {
      const moved = await execution.setSessionState({ processId: f.id, channelType: f.channelType, conversationId, state: wanted, reason: `session ${wanted}` });
      if (moved.outcome === 'refused') engine.log(`facilitation ${f.id}: session conversation ${conversationId} stays '${kernelState}' at the kernel (${moved.code}: ${moved.message})`);
    }
    const mode = sessionReadMode(session);
    if (mode === 'none') continue;
    const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId, processId: f.id };
    if ((await messages.modeOf(scope)) === mode) continue;
    const subscribed = await messages.subscribe(scope, { mode });
    if (subscribed.outcome === 'refused') engine.log(`facilitation ${f.id}: session conversation ${conversationId} is not read as '${mode}' (${subscribed.code}: ${subscribed.message})`);
  }
}

/** Read what the kernel stored in the session conversations after their cursors. */
export async function replaySessionConversations(engine: EngineCore, f: Facilitation, receive: (record: ConversationMessageRecord) => Promise<void>): Promise<void> {
  const messages = engine.deps.kernel.messages();
  if (!messages) return;
  for (const session of await linkedSessions(engine.db(), f.id)) {
    if (sessionReadMode(session) === 'none' || !session.conversationId) continue;
    const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: session.conversationId, processId: f.id };
    let after = session.inboundCursor ?? undefined;
    for (;;) {
      const page = await messages.listSince(scope, { ...(after !== undefined ? { after } : {}), limit: 100 });
      for (const record of page.events) await receive(record);
      if (!page.nextCursor || page.events.length === 0) break;
      after = page.nextCursor;
    }
  }
}

// ── inbound messages from a session conversation ───────────────────────────

type ConfirmingAnswer = (w: Work, session: Session, record: ConversationMessageRecord) => Promise<InboundResult | undefined>;
let confirmingAnswer: ConfirmingAnswer | undefined;
/** Who reads a consent answer to a session summary in `confirming`
 *  (sessionClose.ts). */
export function onConfirmingAnswer(handler: ConfirmingAnswer): void {
  confirmingAnswer = handler;
}

/** A record of a session conversation moves that session's cursor; one of
 *  the home conversation the facilitation's. */
export async function advanceSessionCursor(w: Work, record: ConversationMessageRecord): Promise<boolean> {
  if (record.conversationId === w.f.conversationId) return false;
  await w.tx.query(`UPDATE ${SESSIONS} SET inbound_cursor = $3 WHERE facilitation_id = $1 AND conversation_id = $2`, [w.f.id, record.conversationId, record.eventId]);
  return true;
}

/** A person of the session conversation who is not a home participant is a
 *  session participant (5.3). */
async function noteGuest(w: Work, session: Session, record: ConversationMessageRecord): Promise<void> {
  const principal = principalKey(record.author);
  const home = await store.getParticipant(w.tx, w.f.id, principal);
  if (home) return;
  const added = await insertIfAbsent<SessionParticipant>(
    w.tx,
    GUESTS,
    { facilitationId: w.f.id, sessionId: session.id, principalId: principal, displayName: record.author.displayName ?? record.author.id, status: 'active', joinedAt: w.now },
    '(session_id, principal_id)',
  );
  if (added) await w.event('session_participant_joined', principal, { sessionId: session.id });
}

/**
 * What a message of a session conversation may do in the session's state
 * (5.3). `undefined`: it is read by the ordinary handlers, answering in that
 * conversation; otherwise its outcome.
 */
export async function gateSessionRecord(w: Work, record: ConversationMessageRecord): Promise<InboundResult | undefined> {
  if (record.conversationId === w.f.conversationId) return undefined;
  const session = await sessionOfConversation(w.tx, w.f.id, record.conversationId);
  // Criterion 22: nothing from another conversation counts.
  if (!session) return { outcome: 'foreign_conversation' };
  w.answerIn(record.conversationId);
  if (session.status === 'closed' || session.status === 'cancelled') return { outcome: 'session_closed' };
  if (record.kind !== 'transcript_segment') await noteGuest(w, session, record);
  const command = normaliseCommand(record.text);
  if (session.status === 'scheduled') {
    // Before the session: questions and preparation, no contributions.
    if (record.kind === 'created' && STATUS_OR_STOP.test(command)) return undefined;
    const readable = (record.kind === 'created' || record.kind === 'edited') && (record.text ?? '').trim() !== '';
    return readable && (w.f.phase === 'configuring' || w.f.phase === 'active') ? { outcome: 'session_preparation', modelTurn: true } : { outcome: 'session_not_live' };
  }
  if (session.status === 'confirming') {
    // Only consent answers to its summary, status and stop take effect.
    if (record.kind === 'created' && STATUS_OR_STOP.test(command)) return undefined;
    if (record.kind === 'transcript_segment') return { outcome: 'session_confirming_only' };
    return (await confirmingAnswer?.(w, session, record)) ?? { outcome: 'session_confirming_only' };
  }
  return undefined;
}

/** Is this person a home participant, or only a session participant? */
export async function guestSessionsOf(q: Queryable, facilitationId: string, principal: string): Promise<Session[]> {
  return rows<Session>(
    q,
    `SELECT s.* FROM ${SESSIONS} s JOIN ${GUESTS} g ON g.session_id = s.id
      WHERE g.facilitation_id = $1 AND g.principal_id = $2 AND g.status = 'active' ORDER BY s.created_at`,
    [facilitationId, principal],
  );
}

/** Every facilitation with a session conversation the kernel may still hold
 *  for it, on a scheduler pass. One that fails does not stop the others. */
export async function syncAllSessionConversations(engine: EngineCore): Promise<void> {
  const due = await engine.db().query<{ facilitation_id: string }>(
    `SELECT DISTINCT facilitation_id FROM ${SESSIONS}
      WHERE conversation_id IS NOT NULL
        AND (status IN ('scheduled', 'live', 'confirming') OR coalesce(ended_at, created_at) > $1)`,
    [new Date(engine.now().getTime() - 7 * 24 * 60 * MINUTE_MS)],
  );
  for (const row of due.rows) {
    try {
      await syncSessionConversations(engine, row.facilitation_id);
    } catch (err) {
      engine.log(`facilitation ${row.facilitation_id}: its session conversations could not be brought up to date: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * A meeting started or ended in a linked session conversation: that session
 * starts (through the kernel's `live`, readiness first) or ends with its
 * binding close. Joins and leaves are put on record.
 */
export async function linkedMeetingEvent(engine: EngineCore, agentSlug: string, event: { kind: string; conversationId: string; sessionRef: string; participants?: readonly unknown[] }): Promise<void> {
  const row = await engine.db().query<{ facilitation_id: string; id: string }>(
    `SELECT s.facilitation_id, s.id FROM ${SESSIONS} s JOIN plg_omadia_agent_facilitator_facilitations f ON f.id = s.facilitation_id
      WHERE s.conversation_id = $1 AND s.status IN ('scheduled', 'live') AND f.facilitator_agent = $2 AND f.phase IN ('configuring', 'active')
      ORDER BY s.created_at DESC LIMIT 1`,
    [event.conversationId, agentSlug],
  );
  const found = row.rows[0];
  if (!found) return;
  if (event.kind === 'participant_joined' || event.kind === 'participant_left') {
    await engine.work(found.facilitation_id, (w) => w.event('session_presence', 'engine', { kind: event.kind, sessionId: found.id, sessionRef: event.sessionRef, participants: event.participants ?? [] }));
    return;
  }
  const { prepareSessionStart, startSession, endSession } = await import('./sessions.js');
  if (event.kind === 'session_started') {
    const prepared = await prepareSessionStart(engine, found.facilitation_id, found.id);
    await engine.work(found.facilitation_id, async (w) => {
      const session = await one<Session>(w.tx, `SELECT * FROM ${SESSIONS} WHERE id = $1`, [found.id]);
      if (session) await startSession(w, session, prepared?.snapshot, prepared?.live);
    });
    return;
  }
  if (event.kind === 'session_ended') {
    await engine.work(found.facilitation_id, async (w) => {
      const session = await one<Session>(w.tx, `SELECT * FROM ${SESSIONS} WHERE id = $1`, [found.id]);
      if (session) await endSession(w, session);
    });
  }
}

/** A linked session that never went live within its time slot: cancelled,
 *  and the home conversation is told why. */
export async function missedSession(w: Work, session: Session, missing: string | undefined): Promise<void> {
  if (session.status !== 'scheduled') return;
  await update(w.tx, SESSIONS, { id: session.id }, { status: 'cancelled', endedAt: w.now });
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending' AND kind = 'session_start' AND payload->>'sessionId' = $3`, [w.f.id, w.now, session.id]);
  w.bump();
  await w.event('session_cancelled', 'engine', { sessionId: session.id, reason: missing ?? 'not started' });
  w.post({ purpose: 'session_readiness', key: `${session.id}:missed`, to: 'group', deliveryClass: 'essential', versionBound: false, text: sessionTexts(w.f.language).sessionMissed(sessionTitleOf(session, w.f), missing) });
}

/** The status of the session that runs in this conversation: its title,
 *  state, time slot and the open agenda step; no names, tallies or anything
 *  of the home conversation (5.3, criterion 46). */
export async function sessionStatusText(w: Pick<Work, 'tx' | 'f'>, conversationId: string): Promise<string> {
  const t = sessionTexts(w.f.language);
  const session = await sessionOfConversation(w.tx, w.f.id, conversationId);
  if (!session) return t.guestStatus([]);
  const step = await store.openStepOf(w.tx, w.f.id);
  const when = session.scheduledStart ? formatWhen(session.scheduledStart, w.f.timezone, w.f.language) : undefined;
  const lines = [t.guestStatusLine(sessionTitleOf(session, w.f), t.sessionState[session.status] ?? session.status, when)];
  if (step && session.status === 'live') lines.push(t.openStepLine(step.title));
  return t.guestStatus(lines, 1);
}

/** What the facilitator's model is told for a turn in a session
 *  conversation: the session and its agenda, never the home conversation's
 *  people, contributions or tallies (5.3, 5.8). */
export async function sessionTurnContext(q: Queryable, f: Facilitation, conversationId: string): Promise<string> {
  const session = await sessionOfConversation(q, f.id, conversationId);
  const steps = (await store.listSteps(q, f.id)).filter((s) => s.kind !== 'open');
  const open = steps.find((s) => s.status === 'open');
  return [
    '# Session',
    `Session: ${session ? sessionTitleOf(session, f) : 'linked session'} (${session?.status ?? 'unknown'}).`,
    `Agenda: ${steps.map((s) => `${String(s.position)}. ${s.title}${s.status === 'closed' ? ' (closed)' : ''}`).join('; ') || 'none'}.`,
    open ? `Open step: ${open.title}.` : 'No step is open.',
    'People here may be session participants only. You know nothing of the home conversation in this turn: do not name participants, contributions, tallies, who is missing or the protocol. Answer about the session and what was said here.',
  ].join('\n');
}
