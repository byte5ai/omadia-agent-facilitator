// Private messages to the facilitator (spec 2043 §5.3, kernel #2089).
//
// A facilitator is no assistant: a private request gets the kernel's fixed
// answer. Two things are different for a person who takes part in a
// facilitation of this facilitator, and only the kernel decides who that is
// (a person registered on an open scope):
//
//   "status"   the status of that facilitation, and nothing else
//   "done"     an owner reports an action item of theirs as done, as they
//              would in the group
//
// Everything else is handed back, and the kernel answers as before. A private
// chat has no reply reference (Teams gives none), so a message refers to
// nothing by itself: what it means is decided from the state, and where
// that leaves several possibilities the person is asked which.
//
// The answer is given by the kernel, as an authorized private message drawn
// from the scope named here.

import type { PrivateMessageReply, PrivateMessageRequest } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { ActionItem, Facilitation, Participant } from '../model.js';
import { texts } from '../texts/index.js';
import { markActionDone } from './actionItems.js';
import type { EngineCore } from './core.js';
import { normaliseCommand } from './inbound.js';
import { scopeForAction, syncPeople } from './scopes.js';
import { statusText } from './status.js';
import { guestSessionsOf, sessionTitleOf } from './sessionLinks.js';
import { sessionTexts } from '../texts/sessions.js';
import { formatWhen } from '../texts/index.js';

const DECLINED: PrivateMessageReply = { handled: false };

const STATUS = /^(?:status|stand|zwischenstand)(?:\s+#?(\d{1,2}))?$/u;
const DONE = /^(?:(?:done|erledigt|fertig)(?:\s*#?(\d{1,3}))?|#?(\d{1,3})\s*(?:done|erledigt|fertig))$/u;

interface Taking {
  f: Facilitation;
  person: Participant;
}

/** The answer, drawn from the scope of the facilitation it is about. */
async function reply(engine: EngineCore, f: Facilitation, text: string, purpose: 'status' | 'other'): Promise<PrivateMessageReply> {
  const found = await scopeForAction(engine, f, 'status');
  if (!found.ok) {
    engine.log(`facilitation ${f.id}: a private request could not be answered (${found.code}: ${found.message})`);
    return DECLINED;
  }
  await syncPeople(engine, f, found.value.scope);
  return { handled: true, text, authorization: { ...found.value.authorization, purpose, emission: 'template' } };
}

async function answerStatus(engine: EngineCore, taking: readonly Taking[], number: number | undefined): Promise<PrivateMessageReply> {
  const first = taking[0];
  if (!first) return DECLINED;
  const meant = number !== undefined ? taking[number - 1] : taking.length === 1 ? first : undefined;
  // Several facilitations and no number that names one: ask, do not guess.
  if (!meant) return reply(engine, first.f, texts(first.f.language).privateStatus.which(taking.map((t) => t.f.goal)), 'status');
  const text = await statusText(engine.db(), meant.f, 'private');
  await engine.work(meant.f.id, (w) => w.event('private_status', meant.person.principalId, {}));
  return reply(engine, meant.f, text, 'status');
}

async function answerDone(engine: EngineCore, taking: readonly Taking[], number: number | undefined): Promise<PrivateMessageReply> {
  const own: { taking: Taking; item: ActionItem }[] = [];
  for (const t of taking) {
    if (t.f.phase !== 'active' && t.f.followupState !== 'active') continue;
    for (const item of await store.listActionItems(engine.db(), t.f.id)) {
      if (item.status === 'confirmed' && item.ownerPrincipal === t.person.principalId) own.push({ taking: t, item });
    }
  }
  const first = own[0];
  // Nothing of theirs is open: not a matter of a facilitation.
  if (!first) return DECLINED;
  const candidates = number !== undefined ? own.filter((o) => o.item.number === number) : own;
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!only) {
    const several = new Set(own.map((o) => o.taking.f.id)).size > 1;
    const lines = own.map((o) => `${String(o.item.number)}. ${o.item.description}${several ? ` (${o.taking.f.goal})` : ''}`);
    return reply(engine, first.taking.f, texts(first.taking.f.language).privateStatus.doneWhich(lines), 'other');
  }
  const { f, person } = only.taking;
  const done = await engine.work(f.id, async (w) => {
    const current = (await store.listActionItems(w.tx, w.f.id)).find((a) => a.id === only.item.id);
    if (!current || current.status !== 'confirmed') return false;
    await markActionDone(w, current, person);
    return true;
  });
  if (!done) return DECLINED;
  const after = (await store.getFacilitation(engine.db(), f.id)) ?? f;
  return reply(engine, after, texts(f.language).privateStatus.done(only.item.number, only.item.description), 'other');
}

/** The status of the sessions a session participant belongs to: agenda,
 *  session state and time slot; never names, tallies or anything of the
 *  home conversation. */
async function answerGuestStatus(engine: EngineCore, request: PrivateMessageRequest, principal: string): Promise<PrivateMessageReply> {
  // The sessions that are not over come first: that is what a guest asks about.
  const found: { f: Facilitation; sessions: Awaited<ReturnType<typeof guestSessionsOf>> }[] = [];
  for (const processId of request.processIds) {
    const f = await store.getFacilitation(engine.db(), processId);
    if (!f || f.facilitatorAgent !== request.agentSlug || f.channelType !== request.channelType) continue;
    const sessions = await guestSessionsOf(engine.db(), f.id, principal);
    if (sessions.length > 0) found.push({ f, sessions });
  }
  const running = (s: { status: string }): boolean => s.status === 'scheduled' || s.status === 'live' || s.status === 'confirming';
  found.sort((a, b) => Number(b.sessions.some(running)) - Number(a.sessions.some(running)));
  for (const { f, sessions: all } of found) {
    const sessions = all.some(running) ? all.filter(running) : all;
    const t = sessionTexts(f.language);
    const lines = sessions.map((s) =>
      t.guestStatusLine(sessionTitleOf(s, f), t.sessionState[s.status] ?? s.status, s.scheduledStart ? formatWhen(s.scheduledStart, f.timezone, f.language) : undefined),
    );
    await engine.work(f.id, (w) => w.event('private_status', principal, { scope: 'session' }));
    return reply(engine, f, t.guestStatus(lines), 'status');
  }
  return DECLINED;
}

/**
 * Decide what a private message of a participant is, and answer it or hand
 * it back. Never throws: a failure is a decline, and the kernel gives the
 * ordinary answer.
 */
export async function answerPrivateMessage(engine: EngineCore, request: PrivateMessageRequest): Promise<PrivateMessageReply> {
  try {
    const command = normaliseCommand(request.text);
    const status = STATUS.exec(command);
    const done = status ? null : DONE.exec(command);
    if (!status && !done) return DECLINED;

    const principal = `user:${request.principalId.toLowerCase()}`;
    const taking: Taking[] = [];
    for (const processId of request.processIds) {
      const f = await store.getFacilitation(engine.db(), processId);
      if (!f || f.facilitatorAgent !== request.agentSlug || f.channelType !== request.channelType) continue;
      const person = await store.getParticipant(engine.db(), f.id, principal);
      if (person?.status === 'active') taking.push({ f, person });
    }
    taking.sort((a, b) => a.f.createdAt.getTime() - b.f.createdAt.getTime());
    if (taking.length === 0) {
      // A session participant only: the status of their sessions, nothing of
      // the home conversation (criterion 46).
      return status ? await answerGuestStatus(engine, request, principal) : DECLINED;
    }

    if (status) return await answerStatus(engine, taking, status[1] !== undefined ? Number(status[1]) : undefined);
    const number = done?.[1] ?? done?.[2];
    return await answerDone(engine, taking, number !== undefined ? Number(number) : undefined);
  } catch (err) {
    engine.log(`a private message to '${request.agentSlug}' could not be answered: ${err instanceof Error ? err.message : String(err)}`);
    return DECLINED;
  }
}
