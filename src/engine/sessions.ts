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
import { resolvePerson } from '../methods/ballot.js';
import type { Ack, Contribution, Facilitation, MediaConsent, Modality, Participant, Session, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { mention } from './contributions.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { recordBallot, roundOptions } from './decide.js';
import { PRIORITY, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { scheduleJob } from './jobs.js';
import { onConfigured, onStepOpened, onVoteOpened } from './lifecycle.js';
import { baselineSnapshot, describeMeans, diffSnapshots, perceptionStatement, planMeans } from './media.js';
import { withTimeout } from './outbox.js';
import { openProposal, registerProposalKind } from './proposals.js';
import { registerJobHandler } from './scheduler.js';
import { registerHandshakeNote } from './transparency.js';
import { registerContextSection } from './turn.js';

const TIME_NOTICE_MINUTES = 5;
const MIN_TIMEBOX_FOR_NOTICE = 10;
const POLL_MAX_OPTIONS = 6;
const SNAPSHOT_TIMEOUT_MS = 3_000;

type Snapshot = Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs' | 'modality'>;
const snapshotOf = (session: Session | undefined): Snapshot | undefined => (session?.capabilitySnapshot as Snapshot | null | undefined) ?? undefined;

/** The session that is going on: a running meeting, otherwise the chat. */
export async function currentSession(q: Queryable, facilitationId: string): Promise<Session | undefined> {
  const sessions = await store.listSessions(q, facilitationId);
  return sessions.find((s) => s.kind === 'live' && s.status === 'running') ?? sessions.find((s) => s.kind === 'async');
}

/** The capabilities of a conversation or a meeting, asked of the kernel.
 *  Never called inside a transaction. */
export async function fetchSnapshot(engine: Pick<EngineCore, 'deps' | 'now'>, f: Facilitation, sessionRef?: string): Promise<SessionCapabilitySnapshot> {
  const service = engine.deps.kernel.sessionCapabilities();
  if (!service) return baselineSnapshot(f.channelType, f.conversationId, engine.now());
  try {
    return await withTimeout(
      service.getSnapshot({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, ...(sessionRef ? { sessionRef } : {}) }),
      SNAPSHOT_TIMEOUT_MS,
      'the capability snapshot',
    );
  } catch {
    // A missing capability is information, never an error: assume the baseline.
    return baselineSnapshot(f.channelType, f.conversationId, engine.now());
  }
}

/** The chat phase of a facilitation is created with it, with what the channel
 *  offers there. */
async function createChatSession(engine: EngineCore, f: Facilitation): Promise<void> {
  const snapshot = await fetchSnapshot(engine, f);
  const pool = engine.pool();
  if ((await store.listSessions(pool, f.id)).some((s) => s.kind === 'async')) return;
  await insert<Session>(pool, 'plg_omadia_agent_facilitator_sessions', { facilitationId: f.id, kind: 'async', modality: 'chat', capabilitySnapshot: snapshot, status: 'running', startedAt: engine.now(), createdAt: engine.now() });
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
    capabilitySnapshot: baselineSnapshot(w.f.channelType, w.f.conversationId, w.now),
    status: 'running',
    startedAt: w.now,
    createdAt: w.now,
  });
}

/** What a session start needs from the kernel, fetched before its unit of work. */
export async function prepareSessionStart(engine: EngineCore, facilitationId: string, sessionId?: string): Promise<SessionCapabilitySnapshot | undefined> {
  const pool = engine.pool();
  const f = await store.getFacilitation(pool, facilitationId);
  if (!f) return undefined;
  const sessions = (await store.listSessions(pool, f.id)).filter((s) => s.kind === 'live');
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : sessions.find((s) => s.status === 'scheduled');
  if (!session || session.status !== 'scheduled') return undefined;
  return fetchSnapshot(engine, f, session.meetingRef ?? undefined);
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
  if (session.agendaSentAt || session.status === 'cancelled' || session.status === 'ended') return;
  const t = texts(w.f.language);
  const steps = (await store.listSteps(w.tx, w.f.id)).filter((s) => s.kind !== 'open');
  await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { agendaSentAt: w.now });
  w.post({
    purpose: 'session_agenda',
    key: session.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['configuring', 'active'],
    text: t.sessionAgenda(session.title ?? w.f.goal, formatWhen(session.scheduledStart ?? w.now, w.f.timezone, w.f.language), steps.map((s) => t.agendaLine(s.position, s.title, s.timeboxMinutes))),
  });
  await w.event('session_agenda_sent', 'engine', { sessionId: session.id });
}

export async function startSession(w: Work, session: Session, prefetched?: SessionCapabilitySnapshot): Promise<Session> {
  if (session.status !== 'scheduled') return session;
  const t = texts(w.f.language);
  // Without a snapshot for the meeting the chat's capabilities are assumed.
  const chat = snapshotOf(await ensureChatSession(w));
  const snapshot: SessionCapabilitySnapshot = prefetched ?? { ...baselineSnapshot(w.f.channelType, w.f.conversationId, w.now), ...(chat ? { inputs: chat.inputs, outputs: chat.outputs } : {}) };
  const perceived: Snapshot = { ...snapshot, modality: session.modality };
  const started = (await update<Session>(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { status: 'running', startedAt: w.now, capabilitySnapshot: { ...snapshot, modality: session.modality } })) ?? session;
  await sendAgenda(w, session);
  w.bump();
  await w.event('session_started', 'engine', { sessionId: session.id });
  // The facilitator says what it perceives in THIS session, so nobody assumes more.
  w.post({
    purpose: 'session_started',
    key: session.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['configuring', 'active'],
    text: t.sessionStarted(session.title ?? w.f.goal, session.scheduledEnd ? formatWhen(session.scheduledEnd, w.f.timezone, w.f.language) : undefined, perceptionStatement(perceived, t)),
  });
  if (snapshot.inputs.includes('transcribed_speech')) await askMediaConsent(w, started);
  return started;
}

export async function endSession(w: Work, session: Session): Promise<void> {
  if (session.status !== 'running') return;
  await update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: session.id }, { status: 'ended', endedAt: w.now, mediaConsent: session.mediaConsent === 'granted' ? 'withdrawn' : session.mediaConsent });
  w.bump();
  await w.event('session_ended', 'engine', { sessionId: session.id });
  w.post({ purpose: 'session_ended', key: session.id, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).sessionEnded(session.title ?? w.f.goal) });
}

// ── media consent and speech ────────────────────────────────────────────────

const setConsent = (w: Work, sessionId: string, mediaConsent: MediaConsent): Promise<unknown> => update(w.tx, 'plg_omadia_agent_facilitator_sessions', { id: sessionId }, { mediaConsent });

/** Processing a call's speech starts only after the facilitator announced it
 *  and no participant objected. */
async function askMediaConsent(w: Work, session: Session): Promise<void> {
  if (session.mediaConsent === 'pending' || session.mediaConsent === 'granted') return;
  await setConsent(w, session.id, 'pending');
  try {
    await openProposal(w, { kind: 'media_consent', summary: texts(w.f.language).mediaConsent(), payload: { sessionId: session.id }, proposedBy: 'engine', windowMinutes: w.f.settings.confirmWindowMinutes });
  } catch (err) {
    if (!(err instanceof Refusal) || err.code !== 'proposal_open') throw err;
    // Another proposal is being decided: ask afterwards.
    await scheduleJob(w, 'media_consent', `${session.id}:${String(w.now.getTime())}`, new Date(w.now.getTime() + 5 * MINUTE_MS), { sessionId: session.id });
  }
}

const STOP_LISTENING = /^(?:stop listening|stop audio|do not listen|nicht mithören|nicht mithoeren|audio stoppen|aufnahme stoppen)$/;

/** Anyone can stop the processing of speech at any time. */
const stopListening: InboundHandler = async ({ w, record, author, command }) => {
  if (!author || record.kind !== 'created' || !STOP_LISTENING.test(command)) return undefined;
  const session = await currentSession(w.tx, w.f.id);
  if (!session || (session.mediaConsent !== 'granted' && session.mediaConsent !== 'pending')) return undefined;
  await setConsent(w, session.id, 'withdrawn');
  const proposal = await store.openProposal(w.tx, w.f.id);
  if (proposal?.kind === 'media_consent') await w.tx.query(`UPDATE plg_omadia_agent_facilitator_proposals SET status = 'withdrawn', decided_at = $2 WHERE id = $1`, [proposal.id, w.now]);
  w.bump();
  await w.event('media_stopped', author.principalId, { sessionId: session.id, messageId: record.messageId });
  w.post({ purpose: 'media_stopped', key: record.eventId, to: 'group', deliveryClass: 'essential', text: texts(w.f.language).mediaStopped(author.displayName) });
  return { outcome: 'media_stopped' };
};

/** Record what somebody said in the call. It is NOT authenticated input: it
 *  stays unconfirmed until that person confirms it in the chat. */
export async function recordSpoken(w: Work, input: { speaker: string; kind: Contribution['kind']; summary: string; ballot?: Ballot }): Promise<{ speaker: Participant; contribution: Contribution }> {
  if (w.f.phase !== 'active') throw new Refusal('not_active', `The facilitation is ${w.f.phase}.`);
  const session = await currentSession(w.tx, w.f.id);
  if (!snapshotOf(session)?.inputs.includes('transcribed_speech')) throw new Refusal('no_speech', 'This session gives no transcribed speech. Only what is written counts; say so if somebody assumes otherwise.');
  if (session?.mediaConsent !== 'granted') throw new Refusal('no_consent', 'The group has not consented to the processing of speech (or it was stopped). Nothing spoken may be recorded.');
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) throw new Refusal('no_open_step', 'No step is open.');
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const person = resolvePerson(input.speaker, undefined, active.map((p) => ({ id: p.principalId, name: p.displayName })));
  if (typeof person === 'string') throw new Refusal(person, `'${input.speaker}' is not a participant I can match.`);
  const speaker = active.find((p) => p.principalId === person.id) as Participant;
  const contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: step.id,
    round: step.round,
    participantPrincipal: speaker.principalId,
    kind: input.kind,
    payload: { summary: input.summary, text: input.summary, ...(input.ballot ? { ballot: input.ballot } : {}) },
    source: 'speech',
    status: 'unconfirmed',
    interpreted: true,
    recordedAt: w.now,
  });
  const ack = await insert<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', { facilitationId: w.f.id, principal: speaker.principalId, kind: 'contribution', refId: contribution.id, detail: { summary: input.summary }, createdAt: w.now });
  w.bump();
  await w.event('contribution_recorded', speaker.principalId, { contributionId: contribution.id, kind: input.kind, summary: input.summary, status: 'unconfirmed', source: 'speech' });
  w.post({
    purpose: 'echo',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active'],
    text: texts(w.f.language).spokenEcho(speaker.displayName, input.summary),
    mentions: [mention(speaker)],
    link: { kind: 'ack', id: ack.id },
  });
  return { speaker, contribution };
}

/** The channel reported a changed snapshot mid-session: adapt, and say so. */
export async function applySnapshot(w: Work, snapshot: SessionCapabilitySnapshot): Promise<void> {
  if (w.f.phase !== 'active' && w.f.phase !== 'configuring') return;
  const t = texts(w.f.language);
  const sessions = await store.listSessions(w.tx, w.f.id);
  const session =
    (snapshot.sessionRef ? sessions.find((s) => s.kind === 'live' && s.meetingRef === snapshot.sessionRef && s.status === 'running') : undefined) ??
    sessions.find((s) => s.kind === 'live' && s.status === 'running') ??
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

/** A vote as a poll card, when the session has polls and the method fits one. */
async function postPoll(w: Work, step: Step): Promise<void> {
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
    poll: { pollId: pollIdOf(step), question: step.title, options: options.map((o) => ({ id: o.key, label: o.label })), hint },
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
  registerInboundHandler(pollAnswers, PRIORITY.proposals + 2);
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
    w.post({ purpose: 'time_notice', key: job.id, to: 'group', deliveryClass: 'droppable', requiredPhases: ['active'], versionBound: false, text: texts(w.f.language).timeNotice(step.title, TIME_NOTICE_MINUTES) });
  });

  const withSession = (fn: (w: Work, session: Session, prepared: unknown) => Promise<unknown>) => async (w: Work, job: { payload: Record<string, unknown> }, prepared: unknown): Promise<void> => {
    const session = await getSession(w.tx, String(job.payload['sessionId']));
    if (session && (w.f.phase === 'active' || w.f.phase === 'configuring')) await fn(w, session, prepared);
  };
  registerJobHandler('session_agenda', withSession(sendAgenda));
  registerJobHandler(
    'session_start',
    withSession((w, session, prepared) => startSession(w, session, prepared as SessionCapabilitySnapshot | undefined)),
    (engine, job) => prepareSessionStart(engine, job.facilitationId, String(job.payload['sessionId'])),
  );
  registerJobHandler('session_end', withSession(endSession));
  registerJobHandler('media_consent', withSession(async (w, session) => (session.status === 'running' ? askMediaConsent(w, { ...session, mediaConsent: 'not_needed' }) : undefined)));

  registerProposalKind('media_consent', {
    describe: (w, p) => texts(w.f.language).proposalKinds.media_consent(p.summary),
    // Being listened to is never agreed to by a message meant for something else.
    boundOnly: true,
    unanimous: (w) => w.config.mediaConsentExplicit,
    accept: async (w, p) => {
      await setConsent(w, String(p.payload['sessionId']), 'granted');
      await w.event('media_consent', 'group', { sessionId: p.payload['sessionId'], granted: true });
      w.post({ purpose: 'media_consent', key: p.id, to: 'group', deliveryClass: 'essential', text: texts(w.f.language).mediaConsentGranted() });
    },
    reject: async (w, p) => {
      await setConsent(w, String(p.payload['sessionId']), 'refused');
      await w.event('media_consent', 'group', { sessionId: p.payload['sessionId'], granted: false });
      w.post({ purpose: 'media_consent', key: p.id, to: 'group', deliveryClass: 'essential', text: texts(w.f.language).mediaConsentRefused() });
    },
  });

  // What the session offers, for the facilitator's turn.
  registerContextSection(async (q, f) => {
    const session = await currentSession(q, f.id);
    const snapshot = snapshotOf(session);
    if (!session || !snapshot) return undefined;
    const lines = [`# Means in this session (${session.kind === 'live' ? `meeting, ${session.modality}` : 'chat'})`, ...describeMeans(planMeans(snapshot))];
    if (snapshot.inputs.includes('transcribed_speech')) lines.push(`Consent to process speech: ${session.mediaConsent}.`);
    const balance = await roomBalance(q, f);
    if (balance) {
      lines.push(`In the room: ${balance.room.map((p) => p.displayName).join(', ') || 'nobody'}. Remote: ${balance.remote.map((p) => p.displayName).join(', ') || 'nobody'}.`);
      if (balance.remoteFirst) lines.push('The room has spoken more than the remote side: ask the remote voices first.');
    }
    return lines.join('\n');
  });
}
