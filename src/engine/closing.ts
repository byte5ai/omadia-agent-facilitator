// The closing procedure (spec 5.2, #2064, #2078, #2063 criterion 38).
//
// Every closing event is one row of `plg_omadia_agent_facilitator_closings`
// (resultStatus.ts) with its frozen closing document. Its parts run in
// order, each with its own limit counted from the part's start, all inside
// the absolute limit of 30 days from the event:
//
//   waiting       the result of `concluding` waits until every session
//                 closing that needs confirmation has ended
//   delivery      the document reaches the group (<= 7 days); otherwise its
//                 delivery status is `not delivered`
//   confirmation  only where required: a consent window (default 24 h, at
//                 most 72 h) from the confirmed delivery; no standing
//                 objection and a verified electorate -> `confirmed`, else
//                 `not confirmed` with its reason
//   dispatch      the final protocol to its recipients (<= 7 days)
//
// The result of `concluding` closes the facilitation when its result status
// is set. Moderation never re-opens. Session closings (F1, #2076) use the
// same rows with kind `session`.

import { HOUR_MS } from '../clock.js';
import type { Db, Queryable } from '../db/pool.js';
import { insert, one, rows } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Closing, OutboxRow, Proposal, ResultMark } from '../model.js';
import { texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { scheduleJob } from './jobs.js';
import { registerProposalKind } from './proposals.js';
import { CLOSING_LIMITS, confirmationWindowMs, finalPatch, listClosings, markOf, openClosing, patchClosing, resultStatusLine, resultStatusWords, stoppedMark, undeliveredMark } from './resultStatus.js';
import { finalConsentElectorate } from './electorate.js';
import { registerJobHandler } from './scheduler.js';

export const RESULT_PURPOSE = 'result';
/** The outbox purposes that carry the closing document of each kind. */
export const DOCUMENT_PURPOSES: Readonly<Record<Closing['kind'], readonly string[]>> = {
  result: [RESULT_PURPOSE],
  abort: ['abort'],
  session: ['session_summary', 'session_protocol'],
};
export const FINAL_CONFIRMATION = 'final_confirmation';

// ── hooks ──────────────────────────────────────────────────────────────────

/** What happens once the result is final: the facilitation closes (decide.ts). */
export type FinalHook = (w: Work, closing: Closing) => Promise<void>;
let onResultFinal: FinalHook = async () => {};
export function setResultFinal(hook: FinalHook): void {
  onResultFinal = hook;
}

// ── the document ─────────────────────────────────────────────────────────────

const windowHours = (w: Pick<Work, 'config'>): number => confirmationWindowMs(w.config.finalConfirmWindowHours) / HOUR_MS;

/** What the group reads: the document, then its consent request (while a
 *  confirmation is still to come) or its result status. */
function groupText(w: Pick<Work, 'f' | 'config'>, c: Closing): string {
  const mark = markOf(c);
  if (mark) return `${c.document}\n\n${resultStatusLine(w.f.language, mark)}`;
  if (c.requiresConfirmation) return `${c.document}\n\n${texts(w.f.language).closing.confirmRequest(windowHours(w))}`;
  return `${c.document}\n\n${resultStatusLine(w.f.language, { status: 'published' })}`;
}

/** Queue the closing document for the group, as its current version. */
function postDocument(w: Work, c: Closing): void {
  w.post({
    purpose: RESULT_PURPOSE,
    key: `${c.id}:${String(c.documentVersion)}`,
    to: 'group',
    deliveryClass: 'essential',
    text: groupText(w, c),
    closing: { id: c.id, version: c.documentVersion },
  });
}

/** Session closings that need confirmation and have not ended (spec 5.2,
 *  part 1; F1 opens them). */
export async function sessionClosingsPending(q: Queryable, facilitationId: string): Promise<boolean> {
  const open = await q.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_closings
      WHERE facilitation_id = $1 AND kind = 'session' AND requires_confirmation AND result_status IS NULL AND ended_at IS NULL LIMIT 1`,
    [facilitationId],
  );
  return open.rows.length > 0;
}

/** Open the closing of the result of `concluding` and send it where nothing
 *  has to be waited for. */
export async function openResultClosing(w: Work, input: { document: string; requiresConfirmation: boolean }): Promise<Closing> {
  const waiting = await sessionClosingsPending(w.tx, w.f.id);
  const closing = await openClosing(w.tx, { facilitationId: w.f.id, kind: 'result', document: input.document, requiresConfirmation: input.requiresConfirmation, waiting, now: w.now });
  await w.event('closing_opened', 'engine', { closingId: closing.id, eventId: closing.eventId, requiresConfirmation: closing.requiresConfirmation, waiting });
  if (closing.part === 'delivery') postDocument(w, closing);
  return closing;
}

export const resultClosingOf = (q: Queryable, facilitationId: string): Promise<Closing | undefined> =>
  one<Closing>(q, `SELECT * FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 AND kind = 'result'`, [facilitationId]);

const confirmationOf = (q: Queryable, closing: Closing): Promise<Proposal | undefined> =>
  one<Proposal>(q, `SELECT * FROM plg_omadia_agent_facilitator_proposals WHERE facilitation_id = $1 AND kind = $2 AND payload->>'closingId' = $3 ORDER BY opened_at DESC LIMIT 1`, [
    closing.facilitationId,
    FINAL_CONFIRMATION,
    closing.id,
  ]);

// ── the parts ────────────────────────────────────────────────────────────────

/** The result status is set: the document is final, dispatch begins. */
async function finalize(w: Work, c: Closing, mark: ResultMark): Promise<Closing> {
  const dispatchUntil = new Date(Math.min(w.now.getTime() + CLOSING_LIMITS.dispatchMs, c.absoluteUntil.getTime()));
  const final = (await patchClosing(w.tx, c.id, { ...finalPatch(mark, w.now), part: 'dispatch', partStartedAt: w.now, dispatchUntil })) ?? c;
  await w.event('closing_final', 'engine', { closingId: c.id, status: mark.status, ...(mark.status === 'not_confirmed' ? { reason: mark.reason } : {}), deliveryStatus: final.deliveryStatus });
  if (c.kind === 'result') await onResultFinal(w, final);
  return final;
}

/** The document reached the group. */
async function delivered(w: Work, c: Closing, row: OutboxRow): Promise<void> {
  const at = row.sentAt ?? w.now;
  const next = (await patchClosing(w.tx, c.id, { deliveryStatus: 'delivered', deliveredAt: at })) ?? c;
  await w.event('closing_delivered', 'engine', { closingId: c.id, version: c.documentVersion });
  const mark = markOf(next);
  if (mark) {
    // Final already (a stop re-delivered it): its delivery part has ended.
    if (next.part === 'delivery') await finalize(w, next, mark);
    return;
  }
  if (!c.requiresConfirmation) {
    await finalize(w, next, { status: 'published' });
    return;
  }
  // The window starts with the confirmed delivery, also after the deadline,
  // and lies inside the closing (spec 5.2, criterion 34).
  const windowEndsAt = new Date(Math.min(at.getTime() + confirmationWindowMs(w.config.finalConfirmWindowHours), c.absoluteUntil.getTime()));
  const verifyUntil = new Date(Math.min(windowEndsAt.getTime() + CLOSING_LIMITS.verifyMaxMs, c.absoluteUntil.getTime()));
  await patchClosing(w.tx, c.id, { part: 'confirmation', partStartedAt: w.now, windowEndsAt, verifyUntil });
  await insert<Proposal>(w.tx, 'plg_omadia_agent_facilitator_proposals', {
    facilitationId: w.f.id,
    kind: FINAL_CONFIRMATION,
    summary: c.document,
    payload: { closingId: c.id },
    proposedBy: 'engine',
    announceMessageId: row.channelMessageId,
    windowEndsAt,
    openedAt: w.now,
  });
  await scheduleJob(w, 'closing_window', `${c.id}:window`, windowEndsAt, { closingId: c.id });
  w.bump();
}

/** Delivery failed for good, or its limit passed (criterion 44). */
async function undelivered(w: Work, c: Closing, error: string): Promise<void> {
  const next = (await patchClosing(w.tx, c.id, { deliveryStatus: 'not_delivered' })) ?? c;
  await w.event('result_undelivered', 'engine', { closingId: c.id, error });
  w.engine.log(`facilitation ${w.f.id}: closing document ${c.eventId} v${String(c.documentVersion)} not delivered (${error})`);
  await finalize(w, next, markOf(next) ?? undeliveredMark(c.requiresConfirmation));
}

/** Decide a confirmation at its window's end (with the electorate as it was
 *  just queried). */
async function decideConfirmation(w: Work, c: Closing): Promise<void> {
  const t = texts(w.f.language);
  const proposal = await confirmationOf(w.tx, c);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const active = participants.filter((p) => p.status === 'active');
  const standing = (proposal?.objections ?? []).filter((o) => active.some((p) => p.principalId === o.principal));
  let mark: ResultMark;
  // A standing objection decides; otherwise the electorate must be verified,
  // asked fresh now and hourly for at most a day (F3, spec 5.2, 5.5).
  const electorate = standing.length > 0 ? undefined : await finalConsentElectorate(w, c.windowEndsAt ?? w.now);
  if (standing.length > 0) mark = { status: 'not_confirmed', reason: 'objection' };
  else if (electorate?.state === 'verified') mark = { status: 'confirmed' };
  else if (electorate?.state === 'retry') {
    // Said once.
    await scheduleJob(w, 'closing_window', `${c.id}:${electorate.at.toISOString()}`, electorate.at, { closingId: c.id });
    if (!(await store.listEvents(w.tx, w.f.id, ['electorate_unverified'])).some((e) => e.payload['closingId'] === c.id)) {
      await w.event('electorate_unverified', 'engine', { closingId: c.id });
      w.post({ purpose: 'closing_status', key: `${c.id}:unverified`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.closing.electorateUnverified() });
    }
    return;
  } else mark = { status: 'not_confirmed', reason: 'electorate_unverified' };
  if (proposal) {
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_proposals SET status = $2, decided_at = $3, objections = $4::jsonb WHERE id = $1`, [
      proposal.id,
      mark.status === 'confirmed' ? 'accepted' : 'rejected',
      w.now,
      JSON.stringify(standing),
    ]);
  }
  await patchClosing(w.tx, c.id, { objections: standing });
  const name = (id: string): string => participants.find((p) => p.principalId === id)?.displayName ?? t.unnamedPerson;
  w.post({
    purpose: 'closing_status',
    key: `${c.id}:final`,
    to: 'group',
    deliveryClass: 'essential',
    text: t.closing.statusPost(resultStatusWords(w.f.language, mark), standing.map((o) => `${name(o.principal)}: ${o.reason}`)),
    closing: { id: c.id, version: c.documentVersion },
  });
  const current = (await one<Closing>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1', [c.id])) ?? c;
  await finalize(w, current, mark);
}

/** Are the sends of a closing settled (nothing pending, no job waiting)? */
async function dispatchSettled(q: Queryable, c: Closing): Promise<boolean> {
  const waiting = await q.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE closing_id = $1 AND status IN ('pending', 'sending')
     UNION ALL
     SELECT 1 FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $2 AND status = 'pending' AND kind = ANY($3::text[]) AND coalesce(payload->>'closingId', $1::text) = $1::text
     LIMIT 1`,
    [c.id, c.facilitationId, `{protocol_mail}`],
  );
  return waiting.rows.length === 0;
}

const endHooks: Array<(w: Work, c: Closing) => Promise<void>> = [];
/** What follows when a closing has ended (the facilitation's end, retention). */
export function onClosingEnded(hook: (w: Work, c: Closing) => Promise<void>): void {
  if (!endHooks.includes(hook)) endHooks.push(hook);
}

/**
 * Move every open closing of a facilitation along. Runs after every
 * delivery, under the facilitation's lock, on the locked connection.
 */
export async function advanceClosings(engine: EngineCore, client: Db, facilitationId: string): Promise<void> {
  await adoptLegacyResult(engine, client, facilitationId);
  const open = (await listClosings(client, facilitationId)).filter((c) => c.endedAt === null);
  for (const c of open) {
    // A part that ends can let the next one end at once (a published result
    // with nothing to dispatch): a few steps per pass.
    for (let step = 0; step < 4; step += 1) {
      const before = await one<Closing>(client, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1', [c.id]);
      if (!before || before.endedAt !== null) break;
      await advanceOne(engine, client, facilitationId, before);
      const after = await one<Closing>(client, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1', [c.id]);
      if (!after || (after.part === before.part && after.endedAt === before.endedAt)) break;
    }
  }
}

async function advanceOne(engine: EngineCore, client: Db, facilitationId: string, c: Closing): Promise<void> {
  {
    await engine.workOn(client, facilitationId, async (w) => {
      const now = w.now.getTime();
      const current = (await one<Closing>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1 FOR UPDATE', [c.id])) ?? c;
      if (current.endedAt !== null) return;
      if (current.part === 'waiting') {
        if (await sessionClosingsPending(w.tx, w.f.id)) return;
        const next = (await patchClosing(w.tx, current.id, { part: 'delivery', partStartedAt: w.now })) ?? current;
        await w.event('closing_waited', 'engine', { closingId: current.id });
        postDocument(w, next);
        return;
      }
      if (current.part === 'delivery') {
        // The closing document of each kind: the result, the abort report;
        // a session's summary (F1) under its own purpose.
        const sends = await rows<OutboxRow>(
          w.tx,
          `SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE closing_id = $1 AND purpose = ANY($2::text[]) AND document_version = $3 ORDER BY seq`,
          [current.id, `{${DOCUMENT_PURPOSES[current.kind].join(',')}}`, current.documentVersion],
        );
        const sent = sends.find((r) => r.status === 'sent');
        if (sent) return delivered(w, current, sent);
        const gaveUp = sends.find((r) => r.status === 'failed' || r.status === 'dropped');
        if (gaveUp) return undelivered(w, current, gaveUp.lastError ?? gaveUp.dropReason ?? 'unknown');
        if (now >= current.partStartedAt.getTime() + CLOSING_LIMITS.deliveryMs || now >= current.absoluteUntil.getTime()) {
          await w.tx.query(`UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'the delivery limit of its closing passed' WHERE closing_id = $1 AND status IN ('pending', 'sending')`, [current.id]);
          return undelivered(w, current, 'not delivered within the delivery limit');
        }
        return;
      }
      if (current.part === 'dispatch') {
        const over = (current.dispatchUntil !== null && now >= current.dispatchUntil.getTime()) || now >= current.absoluteUntil.getTime();
        if (!over && !(await dispatchSettled(w.tx, current))) return;
        if (over) {
          await w.tx.query(`UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'the dispatch limit of its closing passed' WHERE closing_id = $1 AND status IN ('pending', 'sending')`, [current.id]);
        }
        const ended = (await patchClosing(w.tx, current.id, { part: 'done', partStartedAt: w.now, endedAt: w.now })) ?? current;
        await w.event('closing_ended', 'engine', { closingId: current.id, over });
        for (const hook of endHooks) await hook(w, ended);
      }
    });
  }
}

/** A facilitation that concluded before 1.6 has its result in the outbox
 *  but no closing: it gets one (published, as it was then), and its result
 *  rows become that closing's document. */
async function adoptLegacyResult(engine: EngineCore, client: Db, facilitationId: string): Promise<void> {
  const f = await store.getFacilitation(client, facilitationId);
  if (!f || f.phase !== 'concluding' || (await resultClosingOf(client, facilitationId))) return;
  await engine.workOn(client, facilitationId, async (w) => {
    const closing = await openClosing(w.tx, { facilitationId, kind: 'result', document: String(w.f.result?.['text'] ?? ''), requiresConfirmation: false, now: w.f.concludedAt ?? w.now });
    const adopted = await w.tx.query(`UPDATE plg_omadia_agent_facilitator_outbox SET closing_id = $2, document_version = 1 WHERE facilitation_id = $1 AND purpose = $3 AND closing_id IS NULL`, [facilitationId, closing.id, RESULT_PURPOSE]);
    await w.event('closing_adopted', 'engine', { closingId: closing.id, rows: adopted.rowCount ?? 0 });
    if ((adopted.rowCount ?? 0) === 0) postDocument(w, closing);
  });
}

/**
 * Stop after `concluding` (spec 5.2, criterion 52): an open consent window
 * ends, no further answers count, the frozen result is delivered (again)
 * without a consent request, marked `not confirmed (facilitation stopped)`
 * where confirmation was required and `published` otherwise. No separate
 * abort report. Returns the closing, or undefined when there is none.
 */
export async function stopResultClosing(w: Work, actor: string): Promise<Closing | undefined> {
  const c = await resultClosingOf(w.tx, w.f.id);
  if (!c || c.resultStatus !== null) return c;
  const mark = stoppedMark(c.requiresConfirmation);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_proposals SET status = 'withdrawn', decided_at = $2 WHERE facilitation_id = $1 AND status = 'open'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending' AND kind = 'closing_window'`, [w.f.id, w.now]);
  // The version that asked for consent is not sent any more; the new one
  // carries the status instead of the request.
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_outbox SET status = 'dropped', drop_reason = 'replaced: the facilitation was stopped' WHERE closing_id = $1 AND status IN ('pending', 'sending')`, [c.id]);
  const redeliver = c.requiresConfirmation || c.deliveryStatus !== 'delivered';
  const next =
    (await patchClosing(w.tx, c.id, {
      ...finalPatch(mark, w.now),
      ...(redeliver ? { documentVersion: c.documentVersion + 1, part: 'delivery' as const, partStartedAt: w.now, deliveryStatus: 'pending' as const, deliveredAt: null } : {}),
    })) ?? c;
  await w.event('closing_stopped', actor, { closingId: c.id, status: mark.status, version: next.documentVersion });
  if (redeliver) postDocument(w, next);
  else await finalize(w, next, mark);
  w.bump();
  return next;
}

export function installClosing(): void {
  // Answered only by the closing's own window, never earlier: withdrawing a
  // consent before the window ends is allowed (spec 5.7).
  registerProposalKind(FINAL_CONFIRMATION, {
    describe: (_w, p) => p.summary,
    accept: async () => {},
    windowOnly: true,
  });
  registerJobHandler('closing_window', async (w, job) => {
    const c = await one<Closing>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_closings WHERE id = $1', [String(job.payload['closingId'])]);
    if (!c || c.part !== 'confirmation' || c.resultStatus !== null) return;
    await decideConfirmation(w, c);
  });
}
