// The electorate of a step run inside a live session (spec 5.5; #2076).
//
// Every step declares its electorate: by default the active home
// participants; a step run inside a live session may declare that session's
// participants instead. Session-only participants never count as missing for
// home steps, and membership is tracked per scope: leaving a meeting chat
// ends only the session membership.
//
// A linked session fixes the source of its member list when it is linked,
// like the home scope does at start:
//
//   platform_roster   the meeting chat's member list was complete then; before
//                     every automatic decision of a session step it is asked
//                     for again, fresh, and the members follow it
//   declared_list     whoever the channel names (joins) or who writes there;
//                     nobody is removed by others
//
// Home participants are never changed by a session's list.

import * as store from '../db/store.js';
import type { Queryable } from '../db/pool.js';
import { insertIfAbsent, one, rows } from '../db/sql.js';
import { principalKey, rosterStatusOf } from '../kernel.js';
import type { RosterStatus } from '../kernel.js';
import type { Facilitation, Participant, Session, SessionParticipant, Step } from '../model.js';
import { sessionTexts } from '../texts/sessions.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import type { InboundHandler } from './inbound.js';
import { PRIORITY, registerInboundHandler } from './inbound.js';
import { onStepOpened } from './lifecycle.js';
import { isBot } from './membership.js';
import { sessionTitleOf } from './sessionLinks.js';
import { parseBallot } from '../methods/ballot.js';
import { roundOptions } from './decide.js';

const SESSIONS = 'plg_omadia_agent_facilitator_sessions';
/** How long the fresh member list of a session conversation may take. */
const SESSION_ROSTER_TIMEOUT_MS = 5_000;
const MEMBERS = 'plg_omadia_agent_facilitator_session_participants';

export const activeMembers = (q: Queryable, sessionId: string): Promise<SessionParticipant[]> =>
  rows<SessionParticipant>(q, `SELECT * FROM ${MEMBERS} WHERE session_id = $1 AND status = 'active' ORDER BY joined_at, principal_id`, [sessionId]);

/** A session member in the shape the methods count with. */
export function asParticipant(m: SessionParticipant): Participant {
  return {
    scope: 'session',
    facilitationId: m.facilitationId,
    principalId: m.principalId,
    canonicalPrincipal: m.principalId,
    displayName: m.displayName,
    email: null,
    source: 'joined',
    status: 'active',
    joinedAt: m.joinedAt,
    leftAt: null,
    changedAt: m.joinedAt,
    changedByEvent: null,
  };
}

export interface StepElectorate {
  /** Who is expected to contribute to the step. */
  people: Participant[];
  /** The session whose participants they are; absent: the home participants. */
  session?: Session;
}

/** The electorate of a step: its session's members, or the active home
 *  participants. */
export async function stepElectorate(q: Queryable, f: Pick<Facilitation, 'id'>, step: Pick<Step, 'electorateSessionId'> | undefined): Promise<StepElectorate> {
  if (step?.electorateSessionId) {
    const session = await one<Session>(q, `SELECT * FROM ${SESSIONS} WHERE id = $1`, [step.electorateSessionId]);
    if (session) return { people: (await activeMembers(q, session.id)).map(asParticipant), session };
  }
  return { people: (await store.listParticipants(q, f.id)).filter((p) => p.status === 'active') };
}

/** Everybody a ballot of the step may name: the home participants, and
 *  for a session step its members too. */
export async function namingPeople(q: Queryable, f: Pick<Facilitation, 'id'>, step: Pick<Step, 'electorateSessionId'> | undefined): Promise<Participant[]> {
  const home = await store.listParticipants(q, f.id);
  if (!step?.electorateSessionId) return home;
  const members = (await activeMembers(q, step.electorateSessionId)).map(asParticipant).filter((m) => !home.some((p) => p.principalId === m.principalId));
  return [...home, ...members];
}

/** The member of a session, if this person is one. */
export const sessionMember = (q: Queryable, sessionId: string, principal: string): Promise<SessionParticipant | undefined> =>
  one<SessionParticipant>(q, `SELECT * FROM ${MEMBERS} WHERE session_id = $1 AND principal_id = $2 AND status = 'active'`, [sessionId, principal]);

// ── fixing the source when a session is linked ─────────────────────────────

/**
 * When a session conversation is linked: its member list is asked for once.
 * Complete: the platform roster is the source and its people are the
 * session's members. Otherwise the session keeps a declared list.
 */
export async function fixSessionElectorate(engine: EngineCore, f: Facilitation, sessionId: string, conversationId: string): Promise<void> {
  let status: RosterStatus = 'unknown';
  let humans: { principal: string; name: string }[] = [];
  try {
    const roster = await engine.deps.kernel.rosters()?.getRoster(f.channelType, conversationId, { agentSlug: f.facilitatorAgent, fresh: true });
    humans = (roster?.participants ?? [])
      .filter((p) => p.isBot !== true && !isBot({ kind: p.userRef.kind, id: p.userRef.id, ...(p.isBot !== undefined ? { isBot: p.isBot } : {}) }))
      .map((p) => ({ principal: principalKey(p.userRef), name: p.userRef.displayName ?? p.userRef.id }));
    status = humans.length === 0 ? 'unknown' : rosterStatusOf(roster);
  } catch (err) {
    engine.log(`facilitation ${f.id}: the member list of a session conversation could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  await engine.work(f.id, async (w) => {
    const source = status === 'complete' ? 'platform_roster' : 'declared_list';
    await w.tx.query(`UPDATE ${SESSIONS} SET electorate_source = $2 WHERE id = $1 AND electorate_source IS NULL`, [sessionId, source]);
    if (source === 'platform_roster') await syncMembers(w, sessionId, humans, false);
    await w.event('session_electorate', 'engine', { sessionId, source, members: humans.length });
  });
}

/** The session's members follow a complete member list: who is in it is a
 *  member; with `removeMissing`, who is not any more has left the session. */
async function syncMembers(w: Work, sessionId: string, humans: readonly { principal: string; name: string }[], removeMissing: boolean): Promise<void> {
  for (const h of humans) {
    const home = (await store.getParticipant(w.tx, w.f.id, h.principal))?.status === 'active';
    const added = await insertIfAbsent<SessionParticipant>(w.tx, MEMBERS, { facilitationId: w.f.id, sessionId, principalId: h.principal, displayName: h.name, status: 'active', joinedAt: w.now, home }, '(session_id, principal_id)');
    if (!added) await w.tx.query(`UPDATE ${MEMBERS} SET status = 'active', left_at = NULL WHERE session_id = $1 AND principal_id = $2 AND status = 'left'`, [sessionId, h.principal]);
  }
  if (!removeMissing) return;
  const keep = humans.map((h) => h.principal);
  await w.tx.query(`UPDATE ${MEMBERS} SET status = 'left', left_at = $3 WHERE session_id = $1 AND status = 'active' AND NOT (principal_id = ANY($2::text[]))`, [sessionId, keep, w.now]);
}

/**
 * Before an automatic decision of a session step: is the session's member
 * list complete and current? With the platform roster the meeting chat is
 * asked again, fresh; a declared list is complete by its own rules.
 */
export async function verifySessionElectorate(w: Work, session: Session): Promise<{ verified: true } | { verified: false; reason: Exclude<RosterStatus, 'complete'> }> {
  // A declared session list is never known to be complete: nobody named it
  // (5.5); a step of it is decided by its window, its timebox or the group.
  if (session.electorateSource !== 'platform_roster' || !session.conversationId) return { verified: false, reason: 'unknown' };
  const call = w.engine.deps.kernel.rosters()?.getRoster(w.f.channelType, session.conversationId, { agentSlug: w.f.facilitatorAgent, fresh: true });
  let timer: NodeJS.Timeout | undefined;
  // Bounded like the home check: the facilitation's lock is held meanwhile.
  const roster = call
    ? await Promise.race([call.catch(() => undefined), new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), SESSION_ROSTER_TIMEOUT_MS)))]).finally(() => clearTimeout(timer))
    : undefined;
  const humans = (roster?.participants ?? []).filter((p) => p.isBot !== true && !isBot({ kind: p.userRef.kind, id: p.userRef.id }));
  const status: RosterStatus = humans.length === 0 ? 'unknown' : rosterStatusOf(roster);
  if (status === 'partial' || status === 'unknown') return { verified: false, reason: status };
  await syncMembers(w, session.id, humans.map((p) => ({ principal: principalKey(p.userRef), name: p.userRef.displayName ?? p.userRef.id })), true);
  return { verified: true };
}

// ── declaring a step's electorate ───────────────────────────────────────────

/** The live linked session a step can be run inside of right now. */
async function liveLinkedSession(q: Queryable, facilitationId: string): Promise<Session | undefined> {
  return one<Session>(q, `SELECT * FROM ${SESSIONS} WHERE facilitation_id = $1 AND kind = 'live' AND status = 'live' AND conversation_id IS NOT NULL ORDER BY started_at DESC NULLS LAST LIMIT 1`, [facilitationId]);
}

/**
 * Declare the electorate of the open step: `session` (the participants of
 * the live session it runs inside of) or `home`. Only before anybody
 * contributed to it: an electorate never changes under counted votes.
 */
export async function declareStepElectorate(w: Work, scope: 'session' | 'home'): Promise<{ step: Step; session?: Session }> {
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) throw new Refusal('no_open_step', 'No step is open.');
  const counted = (await store.listContributions(w.tx, w.f.id, step.id)).some((c) => c.status === 'valid' || c.status === 'unconfirmed');
  if (counted) throw new Refusal('step_has_contributions', 'People have contributed to this step already; its electorate does not change now.');
  if (scope === 'home') {
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET electorate_session_id = NULL WHERE id = $1`, [step.id]);
    w.bump();
    await w.event('step_electorate', 'facilitator', { stepId: step.id, scope: 'home' });
    return { step: { ...step, electorateSessionId: null } };
  }
  const session = await liveLinkedSession(w.tx, w.f.id);
  if (!session) throw new Refusal('no_live_session', 'No session runs in a linked meeting chat right now; a step can declare the session participants only while one does.');
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET electorate_session_id = $2 WHERE id = $1`, [step.id, session.id]);
  w.bump();
  await w.event('step_electorate', 'facilitator', { stepId: step.id, scope: 'session', sessionId: session.id });
  const t = sessionTexts(w.f.language);
  w.post({ purpose: 'step_electorate', key: step.id, to: 'group', conversationId: session.conversationId as string, deliveryClass: 'essential', versionBound: false, text: t.stepElectorateSession(step.title, sessionTitleOf(session, w.f)) });
  return { step: { ...step, electorateSessionId: session.id }, session };
}

// ── who may contribute to a session step ───────────────────────────────────

/** In a session step only its members contribute; everybody else's message
 *  takes no effect on it (5.3: "messages from people who are not eligible
 *  for the step"). Status, stop and answers to proposals are read before. */
const onlyMembers: InboundHandler = async ({ w, record, command }) => {
  // Edits are left alone: an edit never displaces what was counted before.
  if (record.kind !== 'created' && record.kind !== 'card_answer') return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step?.electorateSessionId || w.f.phase !== 'active') return undefined;
  if (await sessionMember(w.tx, step.electorateSessionId, principalKey(record.author))) return undefined;
  if (record.kind === 'card_answer') return { outcome: 'not_eligible_for_step' };
  // What would count: a ballot of the step, or a point while it collects.
  // Anything else (a question, "next") is read as before.
  const ballot = step.method ? parseBallot({ method: step.method, options: roundOptions(step), text: command }) : undefined;
  const counts = ballot ? ballot.kind !== 'not_a_ballot' : step.kind === 'collect';
  return counts ? { outcome: 'not_eligible_for_step' } : undefined;
};

/** A step that was planned for the session declares it when it opens during
 *  a live linked session (`methodConfig.electorate = 'session'`). */
async function declaredAtOpen(w: Work, step: Step): Promise<void> {
  if (step.methodConfig['electorate'] !== 'session' || step.electorateSessionId) return;
  const session = await liveLinkedSession(w.tx, w.f.id);
  if (!session) return;
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET electorate_session_id = $2 WHERE id = $1`, [step.id, session.id]);
  await w.event('step_electorate', 'engine', { stepId: step.id, scope: 'session', sessionId: session.id });
}

export function installSessionElectorate(): void {
  registerInboundHandler(onlyMembers, PRIORITY.followup + 1);
  onStepOpened(declaredAtOpen);
}
