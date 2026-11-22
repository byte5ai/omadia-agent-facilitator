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
//   "stop"     only as a direct reply to a reminder: ends that facilitation's
//              follow-up, nothing else (spec 5.3)
//
// Everything else is handed back, and the kernel answers as before. A direct
// reply to one of the facilitator's private messages is bound to it, when
// the channel states the reply (kernel #2090, `replyToMessageId`): "done" in
// reply to a reminder completes exactly that reminder's action item (spec
// 5.3, criterion 28). Without a reference what a message means is decided
// from the state, and where that leaves several possibilities the person is
// asked which, once, with choices that tell the facilitations apart.
//
// The answer is given by the kernel, as an authorized private message drawn
// from the scope named here.

import type { PrivateMessageReply, PrivateMessageRequest } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { ActionItem, Facilitation, Participant } from '../model.js';
import { texts } from '../texts/index.js';
import { endFollowup, markActionDone } from './actionItems.js';
import type { EngineCore } from './core.js';
import { normaliseCommand } from './inbound.js';
import { scopeForAction, syncPeople } from './scopes.js';
import { statusText } from './status.js';
import { guestSessionsOf, sessionTitleOf } from './sessionLinks.js';
import { sessionTexts } from '../texts/sessions.js';
import { formatWhen } from '../texts/index.js';

const DECLINED: PrivateMessageReply = { handled: false };

const STATUS = /^(?:status|stand|zwischenstand)(?:\s+#?(\d{1,2}))?$/u;
const DONE = /^(?:(?:done|erledigt|fertig)(?:\s*#?(\d{1,3})([a-z])?)?|#?(\d{1,3})([a-z])?\s*(?:done|erledigt|fertig))$/u;
const STOP = /^(?:stop|stopp)$/u;

/** The letter that tells one of a person's facilitations from the others in
 *  a question (`1a`, `1b`): by the order they were started. */
const letterOf = (index: number): string => String.fromCharCode(97 + (index % 26));

interface Taking {
  f: Facilitation;
  person: Participant;
}

/** The answer, drawn from the scope of the facilitation it is about. */
async function reply(engine: EngineCore, f: Facilitation, text: string, purpose: 'status' | 'stop'): Promise<PrivateMessageReply> {
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

async function answerDone(engine: EngineCore, taking: readonly Taking[], number: number | undefined, letter?: string): Promise<PrivateMessageReply> {
  const own: { taking: Taking; item: ActionItem; letter: string }[] = [];
  for (const [index, t] of taking.entries()) {
    if (letter !== undefined && letterOf(index) !== letter) continue;
    if (t.f.phase !== 'active' && t.f.followupState !== 'active') continue;
    for (const item of await store.listActionItems(engine.db(), t.f.id)) {
      if (item.status === 'confirmed' && item.ownerPrincipal === t.person.principalId) own.push({ taking: t, item, letter: letterOf(index) });
    }
  }
  const first = own[0];
  // Nothing of theirs is open: not a matter of a facilitation.
  if (!first) return DECLINED;
  const candidates = number !== undefined ? own.filter((o) => o.item.number === number) : own;
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!only) {
    const several = new Set(own.map((o) => o.taking.f.id)).size > 1;
    // Several facilitations number their items each from 1: the choice
    // carries the facilitation's letter, so every answer names one item.
    const lines = own.map((o) => `${String(o.item.number)}${several ? o.letter : ''}. ${o.item.description}${several ? ` (${o.taking.f.goal})` : ''}`);
    return reply(engine, first.taking.f, texts(first.taking.f.language).privateStatus.doneWhich(lines), 'status');
  }
  return completeItem(engine, only.taking, only.item);
}

/** Mark one action item done for its owner and say so privately. */
async function completeItem(engine: EngineCore, taking: Taking, item: ActionItem): Promise<PrivateMessageReply> {
  const only = { taking, item };
  const { f, person } = only.taking;
  const done = await engine.work(f.id, async (w) => {
    const current = (await store.listActionItems(w.tx, w.f.id)).find((a) => a.id === only.item.id);
    if (!current || current.status !== 'confirmed') return false;
    await markActionDone(w, current, person);
    return true;
  });
  if (!done) return DECLINED;
  const after = (await store.getFacilitation(engine.db(), f.id)) ?? f;
  return reply(engine, after, texts(f.language).privateStatus.done(only.item.number, only.item.description), 'status');
}

/** The facilitation (and the action item of a reminder) a private message
 *  replies to: a message the facilitator sent this person privately. */
async function repliedTo(engine: EngineCore, taking: readonly Taking[], replyToMessageId: string): Promise<{ taking: Taking; item?: ActionItem } | undefined> {
  if (taking.length === 0) return undefined;
  const hit = await engine.db().query<{ facilitation_id: string; purpose: string; item_id: string | null; target_principal: string }>(
    `SELECT o.facilitation_id, o.purpose, o.target_principal, j.payload->>'itemId' AS item_id
       FROM plg_omadia_agent_facilitator_outbox o
       LEFT JOIN plg_omadia_agent_facilitator_jobs j
         ON o.purpose = 'action_reminder_direct' AND j.facilitation_id = o.facilitation_id
        AND o.idempotency_key = o.facilitation_id::text || ':' || o.purpose || ':' || j.id::text
      WHERE o.channel_message_id = $1 AND o.target_kind = 'direct' AND o.facilitation_id = ANY($2::uuid[])
      ORDER BY o.seq DESC LIMIT 1`,
    [replyToMessageId, taking.map((t) => t.f.id)],
  );
  const row = hit.rows[0];
  const meant = row ? taking.find((t) => t.f.id === row.facilitation_id) : undefined;
  // Only a message that went to this very person binds their reply.
  if (!row || !meant || row.target_principal !== meant.person.principalId) return undefined;
  const item = row.item_id ? (await store.listActionItems(engine.db(), meant.f.id)).find((a) => a.id === row.item_id) : undefined;
  return { taking: meant, ...(item ? { item } : {}) };
}

/** "stop" as a direct reply to a reminder ends only that facilitation's
 *  follow-up (spec 5.3 table, criterion 28). */
async function stopFollowup(engine: EngineCore, taking: Taking): Promise<PrivateMessageReply> {
  const { f, person } = taking;
  const stopped = await engine.work(f.id, async (w) => {
    if (w.f.followupState !== 'active') return false;
    await w.event('followup_stopped', person.principalId, { private: true });
    await endFollowup(w);
    return true;
  });
  if (!stopped) return DECLINED;
  const after = (await store.getFacilitation(engine.db(), f.id)) ?? f;
  return reply(engine, after, texts(f.language).privateStatus.followupStopped(f.goal), 'stop');
}

/** The status of the sessions a person belongs to only as a session
 *  participant: agenda, session state and time slot; never names, tallies
 *  or anything of the home conversation. The first facilitation with such
 *  sessions, preferring one whose sessions are not over. */
async function guestStatusOf(engine: EngineCore, request: PrivateMessageRequest, principal: string): Promise<{ f: Facilitation; text: string } | undefined> {
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
  const first = found[0];
  if (!first) return undefined;
  const { f, sessions: all } = first;
  const sessions = all.some(running) ? all.filter(running) : all;
  const t = sessionTexts(f.language);
  const lines = sessions.map((s) =>
    t.guestStatusLine(sessionTitleOf(s, f), t.sessionState[s.status] ?? s.status, s.scheduledStart ? formatWhen(s.scheduledStart, f.timezone, f.language) : undefined),
  );
  await engine.work(f.id, (w) => w.event('private_status', principal, { scope: 'session' }));
  return { f, text: t.guestStatus(lines) };
}

/** A session participant only: the status of their sessions (criterion 46). */
async function answerGuestStatus(engine: EngineCore, request: PrivateMessageRequest, principal: string): Promise<PrivateMessageReply> {
  const guest = await guestStatusOf(engine, request, principal);
  return guest ? reply(engine, guest.f, guest.text, 'status') : DECLINED;
}

/** A person with both memberships (a home participant of one facilitation,
 *  only a session participant of another) gets each scope's part
 *  (criterion 46): the home answer, then the session status of the other. */
async function withGuestPart(engine: EngineCore, request: PrivateMessageRequest, principal: string, home: PrivateMessageReply): Promise<PrivateMessageReply> {
  if (home.handled !== true) return home;
  const guest = await guestStatusOf(engine, request, principal);
  return guest ? { ...home, text: `${home.text}\n\n${guest.text}` } : home;
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
    const stop = status || done ? false : STOP.test(command);
    if (!status && !done && !stop) return DECLINED;

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

    // A direct reply to one of the facilitator's private messages is about
    // that facilitation, and a reply to a reminder about its action item.
    // `replyToMessageId` since plugin-api 1.85.0 (omadia#2157); typed locally
    // so the plugin still builds against an older contract, which never sets it.
    const replyTo = (request as PrivateMessageRequest & { readonly replyToMessageId?: string }).replyToMessageId;
    const bound = replyTo ? await repliedTo(engine, taking, replyTo) : undefined;
    // Stop only as a reply to a reminder (spec 5.3), never to another message.
    if (stop) return bound?.item && bound.taking.f.followupState === 'active' ? await stopFollowup(engine, bound.taking) : DECLINED;
    // A reply bound to one facilitation answers for that one only; otherwise
    // a person with both memberships also gets their session part (criterion 46).
    if (status && bound) return await answerStatus(engine, [bound.taking], undefined);
    if (status) return await withGuestPart(engine, request, principal, await answerStatus(engine, taking, status[1] !== undefined ? Number(status[1]) : undefined));
    const number = done?.[1] ?? done?.[3];
    const letter = done?.[2] ?? done?.[4];
    if (bound?.item && number === undefined && bound.item.status === 'confirmed' && bound.item.ownerPrincipal === bound.taking.person.principalId) {
      return await completeItem(engine, bound.taking, bound.item);
    }
    return await answerDone(engine, bound ? [bound.taking] : taking, number !== undefined ? Number(number) : undefined, bound ? undefined : letter);
  } catch (err) {
    engine.log(`a private message to '${request.agentSlug}' could not be answered: ${err instanceof Error ? err.message : String(err)}`);
    return DECLINED;
  }
}
