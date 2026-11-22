// Sessions (spec 6.3): a facilitation runs asynchronous phases in the chat and
// live sessions (meetings) with their own time slot. Every session has a
// capability snapshot the channel declares; the engine adapts to it and to its
// changes mid-session, and never processes a call's speech before the group
// was told and nobody objected.

import type { ConversationMessageRecord, SessionCapabilitySnapshot } from '@omadia/plugin-api';

import { MINUTE_MS } from '../clock.js';
import { insert, one, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Queryable } from '../db/pool.js';
import { principalKey } from '../kernel.js';
import type { Ballot } from '../methods/ballot.js';
import type { Facilitation, MediaConsent, Modality, Participant, Session, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { onClosed, recordBallot, roundOptions } from './decide.js';
import { PRIORITY, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { scheduleJob } from './jobs.js';
import { onAborted, onConfigured, onStepOpened, onVoteOpened } from './lifecycle.js';
import { onStepFinished } from './process.js';
import { baselineSnapshot, describeMeans, diffSnapshots, perceptionStatement, planMeans, withRealOutputs } from './media.js';
import { withTimeout } from './outbox.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { registerJobHandler } from './scheduler.js';
import { registerHandshakeNote } from './transparency.js';
import { registerContextSection } from './turn.js';
import { cardAnswers, closeAllCards, closeStepCards, installCardReaders, postIdeaCard, postStepCard } from './cards.js';
import { closeSession } from './sessionClose.js';
import { goLiveAtKernel, missedSession, notLive } from './sessionLinks.js';
import { activeMembers, asParticipant, sessionMember, verifySessionElectorate } from './sessionElectorate.js';
import { verifyElectorate, windowMayPass } from './electorate.js';

const TIME_NOTICE_MINUTES = 5;
const MIN_TIMEBOX_FOR_NOTICE = 10;
const POLL_MAX_OPTIONS = 6;
const SNAPSHOT_TIMEOUT_MS = 3_000;

type Snapshot = Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs' | 'modality'>;
const snapshotOf = (session: Session | undefined): Snapshot | undefined => (session?.capabilitySnapshot as Snapshot | null | undefined) ?? undefined;

/** The session that is going on: a running meeting, otherwise the chat. */
export async function currentSession(q: Queryable, facilitationId: string): Promise<Session | undefined> {
  const sessions = await store.listSessions(q, facilitationId);
  return sessions.find((s) => s.kind === 'live' && s.status === 'live') ?? sessions.find((s) => s.kind === 'async');
}

/** The capabilities of a conversation or a meeting, asked of the kernel.
 *  Never called inside a transaction. */
export async function fetchSnapshot(engine: Pick<EngineCore, 'deps' | 'now'>, f: Facilitation, sessionRef?: string, conversationId = f.conversationId): Promise<SessionCapabilitySnapshot> {
  const service = engine.deps.kernel.sessionCapabilities();
  if (!service) return real(engine, baselineSnapshot(f.channelType, conversationId, engine.now()));
  try {
    return real(
      engine,
      await withTimeout(
        service.getSnapshot({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId, ...(sessionRef ? { sessionRef } : {}) }),
        SNAPSHOT_TIMEOUT_MS,
        'the capability snapshot',
      ),
    );
  } catch {
    // A missing capability is information, never an error: assume the baseline.
    return real(engine, baselineSnapshot(f.channelType, conversationId, engine.now()));
  }
}

/** A snapshot with what the facilitator can really do privately. */
const real = <S extends Pick<SessionCapabilitySnapshot, 'outputs'>>(engine: Pick<EngineCore, 'deps'>, snapshot: S): S =>
  withRealOutputs(snapshot, engine.deps.kernel.conversationSend() !== undefined);

/** The chat phase of a facilitation is created with it, with what the channel
 *  offers there. */
async function createChatSession(engine: EngineCore, f: Facilitation): Promise<void> {
  const snapshot = await fetchSnapshot(engine, f);
  const db = engine.db();
  if ((await store.listSessions(db, f.id)).some((s) => s.kind === 'async')) return;
  await insert<Session>(db, 'plg_omadia_agent_facilitator_sessions', { facilitationId: f.id, kind: 'async', modality: 'chat', capabilitySnapshot: snapshot, status: 'live', startedAt: engine.now(), createdAt: engine.now() });
  // A meeting may already be running: the kernel reports a start, not a
  // state, so the conversation's snapshot is what tells. The session is on
  // record from the first moment; the handshake says what is perceived in it.
  if (snapshot.modality === 'online' || snapshot.modality === 'hybrid') {
    await insert<Session>(db, 'plg_omadia_agent_facilitator_sessions', {
      facilitationId: f.id,
      kind: 'live',
      meetingRef: snapshot.sessionRef ?? null,
      modality: snapshot.modality,
      capabilitySnapshot: snapshot,
      status: 'live',
      startedAt: engine.now(),
      createdAt: engine.now(),
    });
  }
}

/** The chat session inside a unit of work. If it is missing it is created
 *  with the baseline; the kernel is not asked here. */
async function ensureChatSession(w: Work): Promise<Session> {
  const existing = (await store.listSessions(w.tx, w.f.id)).find((s) => s.kind === 'async');
  if (existing) return existing;
  return insert<Session>(w.tx, 'plg_omadia_agent_facilitator_sessions', {
    facilitationId: w.f.id,
    kind: 'async',
    modality: 'chat',
    capabilitySnapshot: real(w.engine, baselineSnapshot(w.f.channelType, w.f.conversationId, w.now)),
    status: 'live',
    startedAt: w.now,
    createdAt: w.now,
  });
}

/** What a session start needs from the kernel, fetched before its unit of
 *  work: the session's capabilities and, for a linked session conversation,
 *  the kernel's move to `live`, which needs the conversation's readiness
 *  (criterion 60). */
export interface PreparedStart {
  snapshot?: SessionCapabilitySnapshot;
  live?: { ok: true } | { ok: false; missing: string };
}

export async function prepareSessionStart(engine: EngineCore, facilitationId: string, sessionId?: string): Promise<PreparedStart | undefined> {
  const db = engine.db();
  const f = await store.getFacilitation(db, facilitationId);
  if (!f) return undefined;
  const sessions = (await store.listSessions(db, f.id)).filter((s) => s.kind === 'live');
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : sessions.find((s) => s.status === 'scheduled');
  if (!session || session.status !== 'scheduled') return undefined;
  if (f.phase !== 'active' && f.phase !== 'configuring') return undefined;
  // A linked session: what its own conversation offers.
  const snapshot = await fetchSnapshot(engine, f, session.meetingRef ?? undefined, session.conversationId ?? f.conversationId);
  return { snapshot, ...(session.conversationId ? { live: await goLiveAtKernel(engine, f, session) } : {}) };
}

// ── live sessions ───────────────────────────────────────────────────────────

export interface ScheduleInput {
  title: string;
  start: Date;
  end?: Date;
  modality: Modality;
  meetingRef?: string;
  /** Hybrid: the people who sit in the room together. */
  room?: string[];
}

export async function scheduleSession(w: Work, input: ScheduleInput): Promise<Session> {
  const session = await insert<Session>(w.tx, 'plg_omadia_agent_facilitator_sessions', {
    facilitationId: w.f.id,
    kind: 'live',
    title: input.title,
    scheduledStart: input.start,
    scheduledEnd: input.end ?? null,
    meetingRef: input.meetingRef ?? null,
    modality: input.modality,
    createdAt: w.now,
  });
  const lead = new Date(input.start.getTime() - w.config.sessionAgendaLeadMinutes * MINUTE_MS);
  // The agenda goes out before the meeting; if that moment has passed, now.
  await scheduleJob(w, 'session_agenda', session.id, lead > w.now ? lead : w.now, { sessionId: session.id });
  await scheduleJob(w, 'session_start', session.id, input.start, { sessionId: session.id });
  if (input.end) await scheduleJob(w, 'session_end', session.id, input.end, { sessionId: session.id });
  if (input.room && input.room.length > 0) await w.event('session_room', 'facilitator', { sessionId: session.id, principals: input.room });
  w.bump();
  await w.event('session_scheduled', 'facilitator', { sessionId: session.id, title: input.title, start: input.start.toISOString(), modality: input.modality });
  return session;
}

const getSession = (q: Queryable, id: string): Promise<Session | undefined> => one<Session>(q, 'SELECT * FROM plg_omadia_agent_facilitator_sessions WHERE id = $1', [id]);

async function sendAgenda(w: Work, session: Session): Promise<void> {
  if (session.agendaSentAt || session.status === 'cancelled' || session.status === 'closed') return;
  const t = texts(w.f.language);
  const steps = (await store.listSteps(w.tx, w.f.id)).filter((s) => s.kind !== 'open');
  await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { agendaSentAt: w.now });
  w.post({
    purpose: 'session_agenda',
    key: session.id,
    to: 'group',
    // A linked session gets its agenda in its own conversation (5.3).
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    deliveryClass: 'essential',
    requiredPhases: ['configuring', 'active'],
    text: t.sessionAgenda(session.title ?? w.f.goal, formatWhen(session.scheduledStart ?? w.now, w.f.timezone, w.f.language), steps.map((s) => t.agendaLine(s.position, s.title, s.timeboxMinutes))),
  });
  await w.event('session_agenda_sent', 'engine', { sessionId: session.id });
}

export async function startSession(w: Work, session: Session, prefetched?: SessionCapabilitySnapshot, live?: PreparedStart['live']): Promise<Session> {
  if (session.status !== 'scheduled') return session;
  // A linked session conversation goes live only once the kernel moved it
  // there, which it does only where every message can be read (criterion 60).
  if (session.conversationId && live?.ok !== true) {
    await notLive(w, session, live && !live.ok ? live.missing : 'the readiness of the meeting chat was not checked');
    return session;
  }
  const t = texts(w.f.language);
  // Without a snapshot for the meeting the chat's capabilities are assumed.
  const chat = snapshotOf(await ensureChatSession(w));
  const snapshot: SessionCapabilitySnapshot = real(w.engine, prefetched ?? { ...baselineSnapshot(w.f.channelType, w.f.conversationId, w.now), ...(chat ? { inputs: chat.inputs, outputs: chat.outputs } : {}) });
  const perceived: Snapshot = { ...snapshot, modality: session.modality };
  const started = (await update<Session>(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { status: 'live', startedAt: w.now, capabilitySnapshot: { ...snapshot, modality: session.modality } })) ?? session;
  // A meeting the group scheduled here has an agenda to send; one that simply
  // started has not.
  const adHoc = session.title === null && session.scheduledStart === null;
  if (!adHoc) await sendAgenda(w, session);
  w.bump();
  await w.event('session_started', 'engine', { sessionId: session.id });
  if (adHoc) {
    // A meeting nobody scheduled here is not narrated. The facilitator speaks
    // only when it perceives something else in it than in the chat, in one line.
    const diff = diffSnapshots(chat, snapshot);
    if (diff.gained.length > 0 || diff.lost.length > 0) {
      w.post({
        purpose: 'session_started',
        key: session.id,
        to: 'group',
        deliveryClass: 'essential',
        requiredPhases: ['configuring', 'active'],
        text: t.meetingDiffers(diff.gained.map((c) => t.perceive[c]), diff.lost.map((c) => t.perceive[c])),
      });
    }
  } else {
    // The facilitator says what it perceives in THIS session, so nobody assumes more.
    w.post({
      purpose: 'session_started',
      key: session.id,
      to: 'group',
      ...(session.conversationId ? { conversationId: session.conversationId } : {}),
      deliveryClass: 'essential',
      requiredPhases: ['configuring', 'active'],
      text: t.sessionStarted(session.title ?? w.f.goal, session.scheduledEnd ? formatWhen(session.scheduledEnd, w.f.timezone, w.f.language) : undefined, perceptionStatement(perceived, t)),
    });
  }
  if (snapshot.inputs.includes('transcribed_speech')) await askMediaConsent(w, started);
  return started;
}

/**
 * A session ends: its binding close (sessionClose.ts). Its summary goes out
 * in its conversation and, where the method or the definition of done
 * requires it, waits for the group's confirmation (spec 5.2, 6.3). The chat
 * phase is not a session that ends this way.
 */
export async function endSession(w: Work, session: Session): Promise<void> {
  // A linked session that never went live within its slot does not take place.
  if (session.status === 'scheduled' && session.conversationId) {
    await missedSession(w, session, session.readinessDetail ?? undefined);
    return;
  }
  if (session.status !== 'live') return;
  // A meeting nobody scheduled or linked here is the chat with other means
  // (D26): it ends without a word, as it began. A session the group agreed
  // on ends with its binding close.
  const adHoc = session.title === null && session.scheduledStart === null && session.conversationId === null;
  if (session.kind !== 'live' || adHoc) {
    await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { status: 'closed', endedAt: w.now, mediaConsent: session.mediaConsent === 'granted' ? 'withdrawn' : session.mediaConsent });
    w.bump();
    await w.event('session_ended', 'engine', { sessionId: session.id });
    return;
  }
  await closeSession(w, session);
}

/**
 * A meeting started in the conversation (D26). One the group scheduled here is
 * started; one nobody scheduled gets its session now, with what the meeting
 * offers. Nothing waits for participants to join: a channel need not say who
 * does.
 */
export async function meetingStarted(w: Work, sessionRef: string, snapshot: SessionCapabilitySnapshot | undefined): Promise<void> {
  if (w.f.phase !== 'configuring' && w.f.phase !== 'active') return;
  // A linked session runs in its own conversation; a meeting of the home
  // conversation is never it.
  const live = (await store.listSessions(w.tx, w.f.id)).filter((s) => s.kind === 'live' && s.conversationId === null);
  if (live.some((s) => s.meetingRef === sessionRef && s.status !== 'scheduled')) return;
  const scheduled = live.find((s) => s.meetingRef === sessionRef) ?? live.find((s) => s.status === 'scheduled' && s.meetingRef === null);
  if (scheduled) {
    await startSession(w, scheduled, snapshot);
    return;
  }
  // A meeting was already running when the facilitation started (its session
  // has no reference yet): this is its start, reported late.
  const known = live.find((s) => s.status === 'live' && s.meetingRef === null);
  if (known) {
    await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: known.id }, { meetingRef: sessionRef });
    return;
  }
  // Another meeting is on record as running: only one is, at a time.
  if (live.some((s) => s.status === 'live')) return;
  const session = await insert<Session>(w.tx, 'plg_omadia_agent_facilitator_sessions', {
    facilitationId: w.f.id,
    kind: 'live',
    meetingRef: sessionRef,
    modality: snapshot && snapshot.modality !== 'chat' ? snapshot.modality : 'online',
    createdAt: w.now,
  });
  await startSession(w, session, snapshot);
}

/** The meeting is over: its session ends and the chat is what counts again. */
export async function meetingEnded(w: Work, sessionRef: string, chat: SessionCapabilitySnapshot | undefined): Promise<void> {
  const live = (await store.listSessions(w.tx, w.f.id)).filter((s) => s.kind === 'live' && s.status === 'live' && s.conversationId === null);
  const session = live.find((s) => s.meetingRef === sessionRef) ?? live[0];
  if (!session) return;
  await endSession(w, session);
  if (chat) await applySnapshot(w, chat);
}

// ── media consent and speech ────────────────────────────────────────────────

const setConsent = (w: Work, sessionId: string, mediaConsent: MediaConsent): Promise<unknown> => update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: sessionId }, { mediaConsent });

/** Processing a call's speech starts only after the facilitator announced it
 *  and no participant objected. */
async function askMediaConsent(w: Work, session: Session): Promise<void> {
  if (session.mediaConsent === 'pending' || session.mediaConsent === 'granted') return;
  await setConsent(w, session.id, 'pending');
  try {
    // Asked of the people in the call: in a linked session's own conversation.
    await openProposal(w, { kind: 'media_consent', summary: texts(w.f.language).mediaConsent(), payload: { sessionId: session.id }, proposedBy: 'engine', windowMinutes: w.f.settings.confirmWindowMinutes, ...(session.conversationId ? { conversationId: session.conversationId } : {}) });
  } catch (err) {
    if (!(err instanceof Refusal) || err.code !== 'proposal_open') throw err;
    // Another proposal is being decided: ask afterwards.
    await scheduleJob(w, 'media_consent', `${session.id}:${String(w.now.getTime())}`, new Date(w.now.getTime() + 5 * MINUTE_MS), { sessionId: session.id });
  }
}

const STOP_LISTENING = /^(?:stop listening|stop audio|do not listen|nicht mithören|nicht mithoeren|audio stoppen|aufnahme stoppen)$/;

/** Anyone can stop the processing of speech at any time. */
const stopListening: InboundHandler = async ({ w, record, author, command }) => {
  // Anyone in the call can stop it, also a session participant of a linked
  // session conversation (6.3).
  const inSession = record.conversationId !== w.f.conversationId;
  if ((!author && !inSession) || record.kind !== 'created' || !STOP_LISTENING.test(command)) return undefined;
  const session = inSession ? (await store.listSessions(w.tx, w.f.id)).find((s) => s.conversationId === record.conversationId) : await currentSession(w.tx, w.f.id);
  if (!session || (session.mediaConsent !== 'granted' && session.mediaConsent !== 'pending')) return undefined;
  await setConsent(w, session.id, 'withdrawn');
  const proposal = await store.openProposal(w.tx, w.f.id);
  if (proposal?.kind === 'media_consent') await w.tx.query(`UPDATE plg_omadia_agent_facilitator_proposals SET status = 'withdrawn', decided_at = $2 WHERE id = $1`, [proposal.id, w.now]);
  w.bump();
  await w.event('media_stopped', author?.principalId ?? principalKey(record.author), { sessionId: session.id, messageId: record.messageId });
  w.post({ purpose: 'media_stopped', key: record.eventId, to: 'group', deliveryClass: 'essential', text: texts(w.f.language).mediaStopped(author?.displayName ?? record.author.displayName ?? record.author.id) });
  return { outcome: 'media_stopped' };
};

/** The channel reported a changed snapshot mid-session: adapt, and say so. */
export async function applySnapshot(w: Work, reported: SessionCapabilitySnapshot): Promise<void> {
  if (w.f.phase !== 'active' && w.f.phase !== 'configuring') return;
  const snapshot = real(w.engine, reported);
  const t = texts(w.f.language);
  const sessions = await store.listSessions(w.tx, w.f.id);
  // A change of a linked session conversation concerns that session alone.
  if (snapshot.conversationId !== w.f.conversationId) {
    const linked = sessions.find((s) => s.conversationId === snapshot.conversationId);
    if (!linked || (linked.status !== 'live' && linked.status !== 'scheduled')) return;
    const changed = diffSnapshots(snapshotOf(linked), snapshot);
    if (!changed.changed) return;
    await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: linked.id }, { capabilitySnapshot: { ...snapshot, modality: linked.modality } });
    w.bump();
    await w.event('capabilities_changed', 'engine', { sessionId: linked.id, gained: changed.gained, lost: changed.lost });
    const tl = texts(w.f.language);
    const key = `${linked.id}:${snapshot.capturedAt}`;
    const there = { conversationId: linked.conversationId as string };
    if (changed.gained.length > 0) w.post({ purpose: 'capability_gained', key, to: 'group', ...there, deliveryClass: 'essential', text: tl.capabilityGained(changed.gained.map((c) => tl.perceive[c])) });
    if (changed.lost.length > 0) w.post({ purpose: 'capability_lost', key, to: 'group', ...there, deliveryClass: 'essential', text: tl.capabilityLost(changed.lost.map((c) => tl.perceive[c])) });
    if (changed.lost.includes('transcribed_speech') && linked.mediaConsent !== 'not_needed') await setConsent(w, linked.id, 'withdrawn');
    if (linked.status === 'live' && changed.gained.includes('transcribed_speech')) await askMediaConsent(w, { ...linked, mediaConsent: linked.mediaConsent === 'granted' ? 'not_needed' : linked.mediaConsent });
    return;
  }
  const session =
    (snapshot.sessionRef ? sessions.find((s) => s.kind === 'live' && s.meetingRef === snapshot.sessionRef && s.status === 'live') : undefined) ??
    sessions.find((s) => s.kind === 'live' && s.status === 'live') ??
    (await ensureChatSession(w));
  const diff = diffSnapshots(snapshotOf(session), snapshot);
  if (!diff.changed) return;
  await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { capabilitySnapshot: { ...snapshot, modality: session.kind === 'live' ? session.modality : snapshot.modality } });
  w.bump();
  await w.event('capabilities_changed', 'engine', { sessionId: session.id, gained: diff.gained, lost: diff.lost });
  const key = `${session.id}:${snapshot.capturedAt}`;
  if (diff.gained.length > 0) w.post({ purpose: 'capability_gained', key, to: 'group', deliveryClass: 'essential', text: t.capabilityGained(diff.gained.map((c) => t.perceive[c])) });
  if (diff.lost.length > 0) w.post({ purpose: 'capability_lost', key, to: 'group', deliveryClass: 'essential', text: t.capabilityLost(diff.lost.map((c) => t.perceive[c])) });
  if (diff.lost.includes('transcribed_speech') && session.mediaConsent !== 'not_needed') await setConsent(w, session.id, 'withdrawn');
  if (diff.gained.includes('transcribed_speech')) await askMediaConsent(w, { ...session, mediaConsent: session.mediaConsent === 'granted' ? 'not_needed' : session.mediaConsent });
}

// ── polls ───────────────────────────────────────────────────────────────────

export const pollIdOf = (step: Pick<Step, 'id' | 'round'>): string => `${step.id}:${String(step.round)}`;

/** An approval vote lets every option be ticked. `multipleAnswers` since
 *  plugin-api 1.84.0 (omadia#2155); older kernels drop it (typed locally: the
 *  1.82 contract this release builds against lacks it). */
const severalAnswers = (step: Pick<Step, 'method'>): { multipleAnswers?: boolean } => (step.method === 'approval' ? { multipleAnswers: true } : {});

/** A vote as a poll card, when the session has polls and the method fits one. */
async function postPoll(w: Work, step: Step): Promise<void> {
  // A question card is the richer form of the same vote; a poll next to it
  // would be the question twice.
  if (await postStepCard(w, step)) return;
  if (step.method !== 'single' && step.method !== 'approval') return;
  const options = roundOptions(step);
  if (options.length < 2 || options.length > POLL_MAX_OPTIONS) return;
  const snapshot = snapshotOf(await currentSession(w.tx, w.f.id));
  if (!snapshot || planMeans(snapshot).vote !== 'poll') return;
  const t = texts(w.f.language);
  const hint = t.pollHint(step.method === 'single' ? (options[0]?.key ?? 'A') : options.slice(0, 2).map((o) => o.key).join(', '));
  w.post({
    purpose: 'poll',
    key: pollIdOf(step),
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['active'],
    text: `${step.title}\n${hint}`,
    poll: { pollId: pollIdOf(step), question: step.title, options: options.map((o) => ({ id: o.key, label: o.label })), hint, ...severalAnswers(step) },
  });
  await w.event('poll_posted', 'engine', { stepId: step.id, round: step.round });
}

/** An answer in a poll is an authenticated ballot. One the platform could
 *  not verify (an anonymous guest) does not count until its owner confirmed. */
const pollAnswers: InboundHandler = async ({ w, record, author }) => {
  if (record.kind !== 'card_answer' || !record.cardAnswer) return undefined;
  if (w.f.phase !== 'active' || !author) return { outcome: 'poll_answer_ignored' };
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || record.cardAnswer.cardId !== pollIdOf(step)) return { outcome: 'poll_answer_stale' };
  const value = (record.cardAnswer.value ?? {}) as { optionId?: unknown; optionIds?: unknown };
  const chosen = (Array.isArray(value.optionIds) ? value.optionIds : [value.optionId]).filter((v): v is string => typeof v === 'string');
  const valid = chosen.filter((key) => roundOptions(step).some((o) => o.key === key));
  if (valid.length === 0 || valid.length !== chosen.length) return { outcome: 'poll_answer_invalid' };
  const ballot: Ballot | undefined =
    step.method === 'single' && valid.length === 1 ? { type: 'single', choice: valid[0] as string } : step.method === 'approval' ? { type: 'approval', choices: [...new Set(valid)] } : undefined;
  if (!ballot) return { outcome: 'poll_answer_invalid' };
  // Every answer to one card carries the card's message id: key it by person.
  const own: ConversationMessageRecord = { ...record, messageId: `${record.messageId}#${principalKey(record.author)}` };
  await recordBallot(w, { record: own, author, step, ballot, interpreted: record.cardAnswer.answererVerified === false, source: 'card' });
  return { outcome: 'poll_answer' };
};

// ── presence and balance in a hybrid session ────────────────────────────────

export interface RoomBalance {
  room: Participant[];
  remote: Participant[];
  /** The room speaks much more than the remote side: ask remote first. */
  remoteFirst: boolean;
}

export async function roomBalance(q: Queryable, f: Facilitation): Promise<RoomBalance | undefined> {
  const session = await currentSession(q, f.id);
  if (!session || session.kind !== 'live' || session.modality !== 'hybrid') return undefined;
  const marked = (await store.listEvents(q, f.id, ['session_room'])).filter((e) => e.payload['sessionId'] === session.id).at(-1);
  const inRoom = new Set((marked?.payload['principals'] as string[] | undefined) ?? []);
  if (inRoom.size === 0) return undefined;
  const active = (await store.listParticipants(q, f.id)).filter((p) => p.status === 'active');
  const room = active.filter((p) => inRoom.has(p.principalId));
  const remote = active.filter((p) => !inRoom.has(p.principalId));
  const step = await store.openStepOf(q, f.id);
  const contributions = step ? (await store.listContributions(q, f.id, step.id)).filter((c) => c.status === 'valid' || c.status === 'unconfirmed') : [];
  const perHead = (people: Participant[]): number => (people.length === 0 ? 0 : contributions.filter((c) => people.some((p) => p.principalId === c.participantPrincipal)).length / people.length);
  return { room, remote, remoteFirst: remote.length > 0 && perHead(room) > perHead(remote) };
}

/** A round-robin order for the round; remote voices first when the room dominates. */
export async function speakingOrder(w: Work): Promise<{ names: string[]; remoteFirst: boolean }> {
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const balance = await roomBalance(w.tx, w.f);
  const rounds = (await store.listEvents(w.tx, w.f.id, ['speaking_order'])).length;
  // Each round starts with the next person, so nobody is always first.
  const rotate = <T>(list: T[]): T[] => (list.length === 0 ? list : [...list.slice(rounds % list.length), ...list.slice(0, rounds % list.length)]);
  const ordered = balance?.remoteFirst ? [...rotate(balance.remote), ...rotate(balance.room)] : rotate(active);
  await w.event('speaking_order', 'engine', { order: ordered.map((p) => p.principalId) });
  const names = ordered.map((p) => p.displayName);
  w.post({ purpose: 'speaking_order', key: String(w.now.getTime()), to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: texts(w.f.language).speakingOrder(names, balance?.remoteFirst === true) });
  return { names, remoteFirst: balance?.remoteFirst === true };
}

export function installSessions(): void {
  registerInboundHandler(stopListening, PRIORITY.commands + 5);
  registerInboundHandler(cardAnswers, PRIORITY.proposals + 1);
  registerInboundHandler(pollAnswers, PRIORITY.proposals + 2);
  installCardReaders();
  onStepOpened(postIdeaCard);
  onStepFinished(closeStepCards);
  onAborted(async (w) => closeAllCards(w));
  onClosed(closeAllCards);
  onVoteOpened(postPoll);
  onConfigured(createChatSession);

  // In the handshake the facilitator says what it perceives here.
  registerHandshakeNote(async (w) => {
    const session = await ensureChatSession(w);
    const snapshot = snapshotOf(session);
    return snapshot ? { perception: perceptionStatement(snapshot, texts(w.f.language)) } : {};
  });

  // A time check before a timebox ends, while a meeting is running.
  onStepOpened(async (w, step) => {
    if (!step.timeboxEndsAt || !step.timeboxMinutes || step.timeboxMinutes < MIN_TIMEBOX_FOR_NOTICE) return;
    const session = await currentSession(w.tx, w.f.id);
    if (session?.kind !== 'live') return;
    await scheduleJob(w, 'time_notice', `${step.id}:${step.timeboxEndsAt.toISOString()}`, new Date(step.timeboxEndsAt.getTime() - TIME_NOTICE_MINUTES * MINUTE_MS), { stepId: step.id });
  });
  registerJobHandler('time_notice', async (w, job) => {
    const step = await store.getStep(w.tx, String(job.payload['stepId']));
    if (!step || step.status !== 'open' || w.f.phase !== 'active') return;
    const live = await currentSession(w.tx, w.f.id);
    w.post({ purpose: 'time_notice', key: job.id, to: 'group', ...(live?.conversationId ? { conversationId: live.conversationId } : {}), deliveryClass: 'droppable', requiredPhases: ['active'], versionBound: false, text: texts(w.f.language).timeNotice(step.title, TIME_NOTICE_MINUTES) });
  });

  const withSession = (fn: (w: Work, session: Session, prepared: unknown) => Promise<unknown>) => async (w: Work, job: { payload: Record<string, unknown> }, prepared: unknown): Promise<void> => {
    const session = await getSession(w.tx, String(job.payload['sessionId']));
    if (session && (w.f.phase === 'active' || w.f.phase === 'configuring')) await fn(w, session, prepared);
  };
  registerJobHandler('session_agenda', withSession(sendAgenda));
  registerJobHandler(
    'session_start',
    withSession((w, session, prepared) => startSession(w, session, (prepared as PreparedStart | undefined)?.snapshot, (prepared as PreparedStart | undefined)?.live)),
    (engine, job) => prepareSessionStart(engine, job.facilitationId, String(job.payload['sessionId'])),
  );
  registerJobHandler('session_end', withSession(endSession));
  registerJobHandler('media_consent', withSession(async (w, session) => (session.status === 'live' ? askMediaConsent(w, { ...session, mediaConsent: 'not_needed' }) : undefined)));

  registerProposalKind('media_consent', {
    describe: (w, p) => texts(w.f.language).proposalKinds.media_consent(p.summary),
    // Being listened to is never agreed to by a message meant for something else.
    boundOnly: true,
    unanimous: (w) => w.config.mediaConsentExplicit,
    // In a linked session the people in the call decide, guests included:
    // anyone of them can object (spec 6.3).
    electorate: async (w, p) => {
      const session = await getSession(w.tx, String(p.payload['sessionId']));
      return session?.conversationId ? (await activeMembers(w.tx, session.id)).map(asParticipant) : undefined;
    },
    verifyElectorate: async (w, p) => {
      const session = await getSession(w.tx, String(p.payload['sessionId']));
      return session?.conversationId ? (await verifySessionElectorate(w, session)).verified : windowMayPass(await verifyElectorate(w));
    },
    answerer: async (w, p, record) => {
      const session = await getSession(w.tx, String(p.payload['sessionId']));
      if (!session?.conversationId || record.conversationId !== session.conversationId) return undefined;
      const member = await sessionMember(w.tx, session.id, principalKey(record.author));
      return member ? asParticipant(member) : undefined;
    },
    accept: async (w, p) => {
      await setConsent(w, String(p.payload['sessionId']), 'granted');
      await w.event('media_consent', 'group', { sessionId: p.payload['sessionId'], granted: true });
      const there = await getSession(w.tx, String(p.payload['sessionId']));
      w.post({ purpose: 'media_consent', key: p.id, to: 'group', ...(there?.conversationId ? { conversationId: there.conversationId } : {}), deliveryClass: 'essential', text: texts(w.f.language).mediaConsentGranted() });
    },
    reject: async (w, p) => {
      await setConsent(w, String(p.payload['sessionId']), 'refused');
      await w.event('media_consent', 'group', { sessionId: p.payload['sessionId'], granted: false });
      const there = await getSession(w.tx, String(p.payload['sessionId']));
      w.post({ purpose: 'media_consent', key: p.id, to: 'group', ...(there?.conversationId ? { conversationId: there.conversationId } : {}), deliveryClass: 'essential', text: texts(w.f.language).mediaConsentRefused() });
    },
  });

  // What the session offers, for the facilitator's turn.
  registerContextSection(async (q, f) => {
    const session = await currentSession(q, f.id);
    const snapshot = snapshotOf(session);
    if (!session || !snapshot) return undefined;
    const lines = [`# Means in this session (${session.kind === 'live' ? `meeting, ${session.modality}` : 'chat'})`, ...describeMeans(planMeans(snapshot))];
    // A question card that is open is how people answer right now.
    const openCard = (await store.listCards(q, f.id)).find((c) => c.state === 'open');
    if (openCard) {
      lines[1] = `Answers: a question card is open ("${openCard.card.title}"). People answer on the card or in the chat, and the newest answer of a person counts. Do not ask anybody to repeat an answer in the other form, and do not read the card's questions out again.`;
    }
    if (snapshot.inputs.includes('transcribed_speech')) lines.push(`Consent to process speech: ${session.mediaConsent}.`);
    const balance = await roomBalance(q, f);
    if (balance) {
      lines.push(`In the room: ${balance.room.map((p) => p.displayName).join(', ') || 'nobody'}. Remote: ${balance.remote.map((p) => p.displayName).join(', ') || 'nobody'}.`);
      if (balance.remoteFirst) lines.push('The room has spoken more than the remote side: ask the remote voices first.');
    }
    return lines.join('\n');
  });
}
