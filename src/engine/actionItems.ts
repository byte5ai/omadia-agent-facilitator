// Action items (spec 5.4, 5.6): an item binds only when its owner confirmed it
// in their own message and it has a due date. If the group agreed on
// follow-up, the owner is reminded before the due date and the status is
// posted at the agreed time; follow-up runs after the close and ends when
// every item is done or past its due date.

import { correlate } from './correlation.js';
import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../clock.js';
import { insert, one, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Ack, ActionItem, Participant } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { mention } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { markEnded } from './lifecycle.js';
import { onClosed } from './decide.js';
import { PRIORITY, ackResolvers, isPositiveReaction, isYes, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { scheduleJob } from './jobs.js';
import { registerJobHandler } from './scheduler.js';

const due = (w: Pick<Work, 'f'>, item: ActionItem): string => formatWhen(item.dueDate, w.f.timezone, w.f.language);

export interface NewActionItem {
  description: string;
  owner: Participant;
  dueDate: Date;
  decisionId?: string;
}

/** Propose an action item to its owner. It counts once they said yes. */
export async function proposeActionItem(w: Work, input: NewActionItem): Promise<ActionItem> {
  const t = texts(w.f.language);
  // Beyond the follow-up horizon nothing would be followed up: refused
  // visibly when agreed, never accepted silently (spec 5.8, criterion 26).
  const latest = latestDueDate(w);
  if (input.dueDate.getTime() > latest.getTime()) {
    throw new Refusal('due_beyond_horizon', t.dueBeyondHorizon(formatWhen(latest, w.f.timezone, w.f.language), w.config.followupHorizonDays));
  }
  const next = await one<{ n: number }>(w.tx, 'SELECT coalesce(max(number), 0) + 1 AS n FROM plg_omadia_agent_facilitator_action_items WHERE facilitation_id = $1', [w.f.id]);
  const item = await insert<ActionItem>(w.tx, 'plg_omadia_agent_facilitator_action_items', {
    facilitationId: w.f.id,
    decisionId: input.decisionId ?? null,
    number: next?.n ?? 1,
    description: input.description,
    ownerPrincipal: input.owner.principalId,
    dueDate: input.dueDate,
    createdAt: w.now,
  });
  const ack = await insert<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', {
    facilitationId: w.f.id,
    principal: input.owner.principalId,
    kind: 'action_item',
    refId: item.id,
    detail: { summary: `#${String(item.number)} ${item.description}` },
    createdAt: w.now,
  });
  w.bump();
  await w.event('action_item_proposed', 'facilitator', { number: item.number, description: item.description, owner: item.ownerPrincipal, due: item.dueDate.toISOString() });
  w.post({
    purpose: 'action_item',
    key: item.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['active'],
    text: t.actionPrompt(input.owner.displayName, item.number, item.description, due(w, item)),
    mentions: [mention(input.owner)],
    link: { kind: 'ack', id: ack.id },
  });
  return item;
}

/** The follow-up deadline: the earlier of the last due date plus the grace
 *  period and the instance's horizon after `closed` (spec 5.2, 5.8). */
export function followupEnd(w: Pick<Work, 'config' | 'now'>, lastDue: Date): Date {
  const grace = lastDue.getTime() + w.config.followupGraceDays * DAY_MS;
  const horizon = w.now.getTime() + w.config.followupHorizonDays * DAY_MS;
  return new Date(Math.min(grace, horizon));
}

/** The latest due date that can still be agreed: the horizon minus the
 *  grace period, counted from now (the close is not earlier than now). */
export const latestDueDate = (w: Pick<Work, 'config' | 'now'>): Date => new Date(w.now.getTime() + (w.config.followupHorizonDays - w.config.followupGraceDays) * DAY_MS);

/** Follow-up starts when the facilitation closed with confirmed items and
 *  the group agreed to it. */
async function startFollowup(w: Work): Promise<void> {
  if (!w.f.followupPolicy.actionItems) return;
  // A stopped facilitation never enters `following_up` (spec 5.2, crit. 56).
  if (w.f.closeReason === 'stopped') return;
  const items = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.status === 'confirmed');
  if (items.length === 0) return;
  const last = new Date(Math.max(...items.map((a) => a.dueDate.getTime())));
  const end = followupEnd(w, last);
  await w.patch({ followupState: 'active', followupEndsAt: end });
  for (const item of items) {
    const at = new Date(item.dueDate.getTime() - w.f.followupPolicy.leadHours * HOUR_MS);
    await scheduleJob(w, 'action_reminder', item.id, at > w.now ? at : new Date(w.now.getTime() + MINUTE_MS), { itemId: item.id });
  }
  const statusAt = w.f.followupPolicy.statusAt ? new Date(w.f.followupPolicy.statusAt) : undefined;
  if (statusAt && statusAt > w.now) await scheduleJob(w, 'action_status', 'agreed', statusAt, {});
  await scheduleJob(w, 'followup_end', 'end', end, {});
  await w.event('followup_started', 'engine', { items: items.length, until: end.toISOString() });
}

const endHooks: Array<(w: Work) => Promise<void>> = [];
/** What ends with the follow-up (the scoped capability grants). */
export function onFollowupEnded(hook: (w: Work) => Promise<void>): void {
  if (!endHooks.includes(hook)) endHooks.push(hook);
}

export async function endFollowup(w: Work): Promise<void> {
  if (w.f.followupState !== 'active') return;
  await w.patch({ followupState: 'ended' });
  await markEnded(w);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending' AND kind IN ('action_reminder', 'action_status', 'followup_end')`, [w.f.id, w.now]);
  await w.event('followup_ended', 'engine', {});
  for (const hook of endHooks) await hook(w);
  w.post({ purpose: 'followup_ended', key: 'end', to: 'group', deliveryClass: 'essential', text: texts(w.f.language).followupEnded() });
}

/** The action items for a status post: what an owner accepted, and the
 *  nominations nobody accepted as open points (criterion 37). */
export async function actionStatusLines(w: Pick<Work, 'tx' | 'f'>): Promise<string[]> {
  const t = texts(w.f.language);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const name = (principal: string): string => participants.find((p) => p.principalId === principal)?.displayName ?? principal;
  const items = await store.listActionItems(w.tx, w.f.id);
  return [
    ...items.filter((a) => a.status === 'confirmed' || a.status === 'done').map((a) => t.actionLine(a.number, a.description, name(a.ownerPrincipal), formatWhen(a.dueDate, w.f.timezone, w.f.language), t.actionStatusWords[a.status])),
    ...items.filter((a) => a.status === 'proposed').map((a) => t.notAccepted(a.number, a.description, name(a.ownerPrincipal))),
  ];
}

const DONE = /^(?:(?:done|erledigt|fertig)\s*#?(\d{1,3})|#?(\d{1,3})\s*(?:done|erledigt|fertig))$/;
/** What a "done" message says: the number it names, or none. Undefined:
 *  not a "done" message. */
export function readDone(command: string): { number?: number } | undefined {
  const match = DONE.exec(command);
  if (match) return { number: Number(match[1] ?? match[2]) };
  return DONE_BARE.test(command) ? {} : undefined;
}

/** "done" without saying which one. */
const DONE_BARE = /^(?:done|erledigt|fertig)$/;

/** An owner's item is done: on record, said in the group, and the follow-up
 *  ends with the last open one. */
export async function markActionDone(w: Work, item: ActionItem, owner: Pick<Participant, 'principalId' | 'displayName'>, messageId?: string): Promise<void> {
  await update(w.tx, 'plg_omadia_agent_facilitator_action_items', { id: item.id }, { status: 'done', doneAt: w.now });
  w.bump();
  await w.event('action_item_done', owner.principalId, { number: item.number, ...(messageId !== undefined ? { messageId } : { private: true }) });
  w.post({ purpose: 'action_done', key: item.id, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).actionDone(owner.displayName, item.number, item.description) });
  const open = (await store.listActionItems(w.tx, w.f.id)).some((a) => a.status === 'confirmed');
  if (!open && w.f.followupState === 'active') await endFollowup(w);
}

/**
 * "done" with a mention, in a conversation where this facilitation runs next
 * to the follow-up of an earlier one: the kernel gave the message to both.
 * When it is not about an item of this facilitation and its author owns an
 * item of that follow-up (open, or closed by this very message a moment
 * ago), the follow-up answers it; this facilitation
 * does not start a turn for it as well.
 */
async function meantForFollowup(w: Work, record: ConversationMessageRecord, principal: string): Promise<boolean> {
  if (record.addressedToBot !== true || w.f.phase !== 'active') return false;
  // The follow-up may have handled the message first: the item is done by
  // then, and with the last item the follow-up itself has ended.
  const theirs = await w.tx.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_action_items a JOIN plg_omadia_agent_facilitator_facilitations f ON f.id = a.facilitation_id
      WHERE f.id <> $1 AND f.facilitator_agent = $2 AND f.channel_type = $3 AND f.conversation_id = $4 AND a.owner_principal = $5
        AND ((a.status = 'confirmed' AND f.followup_state = 'active') OR (a.status = 'done' AND a.done_at > $6))
      LIMIT 1`,
    [w.f.id, w.f.facilitatorAgent, w.f.channelType, w.f.conversationId, principal, new Date(w.now.getTime() - MINUTE_MS)],
  );
  return theirs.rows.length > 0;
}

/** "done 2" from the owner, during the facilitation or its follow-up. */
const doneMessages: InboundHandler = async ({ w, record, author, command }) => {
  if (!author || record.kind !== 'created') return undefined;
  if (w.f.phase !== 'active' && w.f.followupState !== 'active') return undefined;
  const match = DONE.exec(command);
  if (!match && !DONE_BARE.test(command)) return undefined;
  // Several processes here that could take it: exactly one question.
  const route = await correlate(w, record, author, { kind: 'done', ...(match ? { number: Number(match[1] ?? match[2]) } : {}) });
  if (route === 'asked') return { outcome: 'which_process' };
  if (route === 'others') return { outcome: 'left_to_other_process' };
  const t = texts(w.f.language);
  let number: number;
  if (match) {
    number = Number(match[1] ?? match[2]);
  } else if (DONE_BARE.test(command)) {
    // Without a number it can only mean the author's own open item. One: that
    // is the one. Several: the engine asks which, and closes nothing.
    const own = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.status === 'confirmed' && a.ownerPrincipal === author.principalId);
    const only = own[0];
    if (!only) return (await meantForFollowup(w, record, author.principalId)) ? { outcome: 'left_to_followup' } : undefined;
    if (own.length > 1) {
      w.post({ purpose: 'action_done_which', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.actionDoneWhich(author.displayName, own.map((a) => a.number)) });
      return { outcome: 'action_done_which' };
    }
    number = only.number;
  } else {
    return undefined;
  }
  const item = (await store.listActionItems(w.tx, w.f.id)).find((a) => a.number === number);
  if (!item || item.status !== 'confirmed') return (await meantForFollowup(w, record, author.principalId)) ? { outcome: 'left_to_followup' } : undefined;
  if (item.ownerPrincipal !== author.principalId) {
    w.post({ purpose: 'action_not_yours', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.actionNotYours(author.displayName, number) });
    return { outcome: 'action_not_owner' };
  }
  await markActionDone(w, item, author, record.messageId);
  return { outcome: 'action_done' };
};

/**
 * A "yes" to a nomination after the result was frozen at `concluding` (spec
 * 5.4, criterion 37): it changes nothing, the item stays an open point, and
 * the facilitator says so once. Only a reply to (or a reaction on) the
 * nomination's own message counts as that "yes", or a free-standing one when
 * nothing else is open that it could answer.
 */
async function somethingElseWaits(w: Work, principal: string): Promise<boolean> {
  if (await store.openProposal(w.tx, w.f.id)) return true;
  const other = await w.tx.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_facilitations f
      WHERE f.id <> $1 AND f.channel_type = $2 AND f.conversation_id = $3 AND f.phase IN ('configuring', 'active', 'concluding')
        AND (EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_acks k WHERE k.facilitation_id = f.id AND k.status = 'pending' AND k.principal = $4)
             OR EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_proposals p WHERE p.facilitation_id = f.id AND p.status = 'open'))
      LIMIT 1`,
    [w.f.id, w.f.channelType, w.f.conversationId, principal],
  );
  return other.rows.length > 0;
}

const lateAcceptance: InboundHandler = async ({ w, record, author, command }) => {
  if (!author || w.f.phase === 'active' || w.f.phase === 'configuring') return undefined;
  const reaction = record.kind === 'reaction' && record.reaction !== undefined && !record.reaction.removed && isPositiveReaction(record.reaction.name);
  if (!reaction && !(record.kind === 'created' && isYes(command))) return undefined;
  const late = await w.tx.query<{ ack_id: string; item_id: string; prompt: string | null; answered: boolean }>(
    `SELECT k.id AS ack_id, a.id AS item_id, k.prompt_message_id AS prompt, coalesce((k.detail->>'lateAnswered')::boolean, false) AS answered
       FROM plg_omadia_agent_facilitator_acks k JOIN plg_omadia_agent_facilitator_action_items a ON a.id = k.ref_id
      WHERE k.facilitation_id = $1 AND k.kind = 'action_item' AND k.status = 'cancelled' AND k.principal = $2 AND a.status = 'proposed'
      ORDER BY a.number`,
    [w.f.id, author.principalId],
  );
  const target = reaction ? record.messageId : record.replyToMessageId;
  const bound = late.rows.filter((r) => r.prompt !== null && r.prompt === target);
  // Free-standing means a new message that replies to nothing: a reaction or
  // a reply elsewhere is about that other message. Nor is it free-standing
  // while anything else waits for this person's yes in this conversation
  // (another facilitation's nomination, an open proposal here).
  const freeStanding = bound.length === 0 && !reaction && record.replyToMessageId === undefined && late.rows.length === 1 && !(await somethingElseWaits(w, author.principalId));
  const hit = freeStanding ? late.rows[0] : bound[0];
  if (!hit) return undefined;
  if (hit.answered) return { outcome: 'late_acceptance_repeated' };
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_acks SET detail = detail || '{"lateAnswered": true}'::jsonb WHERE id = $1`, [hit.ack_id]);
  const item = await one<ActionItem>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_action_items WHERE id = $1', [hit.item_id]);
  if (!item) return undefined;
  await w.event('late_acceptance', author.principalId, { number: item.number, messageId: record.messageId });
  w.post({ purpose: 'late_acceptance', key: hit.ack_id, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).lateAcceptance(author.displayName, item.number, item.description) });
  return { outcome: 'late_acceptance' };
};

export function installActionItems(): void {
  registerInboundHandler(doneMessages, PRIORITY.followup);
  registerInboundHandler(lateAcceptance, PRIORITY.acknowledgements + 1);
  onClosed(startFollowup);

  // The owner says yes or no in their own message.
  ackResolvers['action_item'] = async (w, ack, author, record, confirmed) => {
    const t = texts(w.f.language);
    await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: confirmed ? 'confirmed' : 'declined', resolvedAt: w.now, resolvedByMessageId: record.messageId });
    const item = await one<ActionItem>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_action_items WHERE id = $1', [ack.refId]);
    if (!item || item.status !== 'proposed') return;
    await update(w.tx, 'plg_omadia_agent_facilitator_action_items', { id: item.id }, confirmed ? { status: 'confirmed', ownerConfirmed: true, confirmedAt: w.now } : { status: 'declined' });
    w.bump();
    await w.event(confirmed ? 'action_item_confirmed' : 'action_item_declined', author.principalId, { number: item.number, messageId: record.messageId });
    w.post({
      purpose: confirmed ? 'action_confirmed' : 'action_declined',
      key: item.id,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: confirmed ? t.actionConfirmed(author.displayName, item.number, item.description, due(w, item)) : t.actionDeclined(author.displayName, item.number, item.description),
    });
  };

  // The owner is reminded before the due date, privately. Only when that
  // cannot arrive (no private messages here, or this person cannot be
  // reached) the reminder is said in the group instead: once, not both.
  registerJobHandler('action_reminder', async (w, job) => {
    if (w.f.followupState !== 'active') return;
    const item = await one<ActionItem>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_action_items WHERE id = $1', [String(job.payload['itemId'])]);
    if (!item || item.status !== 'confirmed') return;
    const owner = await store.getParticipant(w.tx, w.f.id, item.ownerPrincipal);
    if (!owner) return;
    const t = texts(w.f.language);
    await update(w.tx, 'plg_omadia_agent_facilitator_action_items', { id: item.id }, { remindersSent: item.remindersSent + 1 });
    const inGroup = { purpose: 'action_reminder', text: t.actionReminderGroup(owner.displayName, item.number, item.description, due(w, item)), mentions: [mention(owner)] };
    if (w.engine.deps.kernel.conversationSend() === undefined) {
      w.post({ ...inGroup, key: job.id, to: 'group', deliveryClass: 'droppable', versionBound: false });
    } else {
      w.post({
        purpose: 'action_reminder_direct',
        key: job.id,
        to: { principalId: owner.principalId },
        deliveryClass: 'droppable',
        versionBound: false,
        text: t.actionReminder(owner.displayName, item.number, item.description, due(w, item)),
        fallback: inGroup,
      });
    }
    await w.event('action_item_reminder', 'engine', { number: item.number });
  });

  registerJobHandler('action_status', async (w) => {
    if (w.f.followupState !== 'active') return;
    w.post({ purpose: 'action_status', key: 'agreed', to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).actionStatus(await actionStatusLines(w)) });
  });

  // Every item is done or past its due date.
  registerJobHandler('followup_end', async (w) => endFollowup(w));
}
