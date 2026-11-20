// Result status and delivery status of closing documents (spec 5.2, 5.11).
//
// One model for both kinds of protocol: a session protocol (F1, #2076) and
// the facilitation protocol (#2064, #2078). A closing event is one row in
// `plg_omadia_agent_facilitator_closings`; its document is frozen with a
// version, and the closing procedure sets exactly one result status:
//
//   published       no confirmation was required
//   confirmed       the consent window passed without a standing objection,
//                   with a verified electorate
//   not_confirmed   with its reason: objection, electorate_unverified,
//                   not_delivered, stopped
//   aborted         an abort report
//
// The delivery status (`delivered`, `not delivered`) is kept apart from it.
// Every status goes to the same recipients, visibly marked; nothing is ever
// marked confirmed that was not.

import { DAY_MS, HOUR_MS } from '../clock.js';
import type { Queryable } from '../db/pool.js';
import { insertIfAbsent, one, rows, update } from '../db/sql.js';
import type { Closing, ClosingKind, DeliveryStatus, NotConfirmedReason, ResultMark } from '../model.js';
import { texts } from '../texts/index.js';

/** The limits of the closing procedure, each counted from its part's start. */
export const CLOSING_LIMITS = {
  deliveryMs: 7 * DAY_MS,
  /** The consent window of a final confirmation: default and upper bound. */
  confirmationDefaultMs: 24 * HOUR_MS,
  confirmationMaxMs: 72 * HOUR_MS,
  /** The electorate is queried again hourly, at most this long. */
  verifyRetryMs: HOUR_MS,
  verifyMaxMs: 24 * HOUR_MS,
  dispatchMs: 7 * DAY_MS,
  /** Nothing of a closing is sent after this, counted from the event. */
  absoluteMs: 30 * DAY_MS,
} as const;

/** A configured confirmation window, bounded to (0, 72 h]. */
export function confirmationWindowMs(hours: number | undefined): number {
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0) return CLOSING_LIMITS.confirmationDefaultMs;
  return Math.min(hours * HOUR_MS, CLOSING_LIMITS.confirmationMaxMs);
}

/** The result status a closing has, or undefined while it is not final. */
export function markOf(c: Pick<Closing, 'resultStatus' | 'resultReason'>): ResultMark | undefined {
  if (c.resultStatus === null) return undefined;
  if (c.resultStatus === 'not_confirmed') return { status: 'not_confirmed', reason: c.resultReason ?? 'objection' };
  return { status: c.resultStatus };
}

/** The status of a document that went out without its consent request
 *  because the facilitation was stopped (criteria 43, 52). */
export const stoppedMark = (requiresConfirmation: boolean): ResultMark =>
  requiresConfirmation ? { status: 'not_confirmed', reason: 'stopped' } : { status: 'published' };

/** The status of a document whose delivery failed at the end of its
 *  delivery part (criterion 44). */
export const undeliveredMark = (requiresConfirmation: boolean): ResultMark =>
  requiresConfirmation ? { status: 'not_confirmed', reason: 'not_delivered' } : { status: 'published' };

/** "not confirmed (facilitation stopped)", in the facilitation's language. */
export function resultStatusWords(language: 'de' | 'en', mark: ResultMark): string {
  const t = texts(language).resultStatus;
  const word = t[mark.status];
  return mark.status === 'not_confirmed' ? `${word} (${t.reasons[mark.reason] ?? mark.reason})` : word;
}

export const deliveryStatusWords = (language: 'de' | 'en', status: DeliveryStatus): string => texts(language).resultStatus.deliveryStatus[status] ?? status;

/** The line every final document starts with: its result status, visibly. */
export const resultStatusLine = (language: 'de' | 'en', mark: ResultMark): string => `${texts(language).resultStatus.label}: ${resultStatusWords(language, mark)}`;

/** A final document as it is sent: the status line first, then the text. */
export const markDocument = (language: 'de' | 'en', mark: ResultMark, document: string): string => `${resultStatusLine(language, mark)}\n\n${document}`;

// ── closing rows ────────────────────────────────────────────────────────────

const TABLE = 'plg_omadia_agent_facilitator_closings';

/** The scope event id of a closing (kernel `closing` scope per event). */
export const closingEventId = (kind: ClosingKind, sessionId?: string): string => (kind === 'session' ? `session:${sessionId ?? ''}` : kind);

export interface NewClosing {
  facilitationId: string;
  kind: ClosingKind;
  sessionId?: string;
  document: string;
  requiresConfirmation: boolean;
  /** The result of `concluding` waits for open session closings first. */
  waiting?: boolean;
  now: Date;
}

/** Open a closing event with its frozen document. Idempotent per event: the
 *  first one stays. */
export async function openClosing(q: Queryable, input: NewClosing): Promise<Closing> {
  const eventId = closingEventId(input.kind, input.sessionId);
  const existing = await getClosingByEvent(q, input.facilitationId, eventId);
  if (existing) return existing;
  const inserted = await insertIfAbsent<Closing>(q, TABLE, {
    facilitationId: input.facilitationId,
    kind: input.kind,
    sessionId: input.sessionId ?? null,
    eventId,
    document: input.document,
    documentVersion: 1,
    requiresConfirmation: input.requiresConfirmation,
    part: input.waiting === true ? 'waiting' : 'delivery',
    partStartedAt: input.now,
    // An abort report is final the moment it is written.
    ...(input.kind === 'abort' ? { resultStatus: 'aborted', finalAt: input.now } : {}),
    absoluteUntil: new Date(input.now.getTime() + CLOSING_LIMITS.absoluteMs),
    startedAt: input.now,
  }, '(facilitation_id, event_id)');
  if (inserted) return inserted;
  const raced = await getClosingByEvent(q, input.facilitationId, eventId);
  if (!raced) throw new Error(`closing ${eventId} of facilitation ${input.facilitationId} could not be opened`);
  return raced;
}

export const getClosing = (q: Queryable, id: string): Promise<Closing | undefined> => one<Closing>(q, `SELECT * FROM ${TABLE} WHERE id = $1`, [id]);

export const getClosingByEvent = (q: Queryable, facilitationId: string, eventId: string): Promise<Closing | undefined> =>
  one<Closing>(q, `SELECT * FROM ${TABLE} WHERE facilitation_id = $1 AND event_id = $2`, [facilitationId, eventId]);

export const listClosings = (q: Queryable, facilitationId: string): Promise<Closing[]> =>
  rows<Closing>(q, `SELECT * FROM ${TABLE} WHERE facilitation_id = $1 ORDER BY started_at, id`, [facilitationId]);

/** jsonb travels as text: `objections` is serialised here. */
export const patchClosing = (q: Queryable, id: string, patch: Partial<Omit<Closing, 'id' | 'facilitationId' | 'kind' | 'sessionId' | 'eventId'>>): Promise<Closing | undefined> =>
  update<Closing>(q, TABLE, { id }, patch.objections === undefined ? patch : { ...patch, objections: JSON.stringify(patch.objections) });

/** Set the result status: the document is final from now on. */
export function finalPatch(mark: ResultMark, now: Date): Pick<Closing, 'resultStatus' | 'resultReason' | 'finalAt'> {
  return { resultStatus: mark.status, resultReason: mark.status === 'not_confirmed' ? (mark.reason as NotConfirmedReason) : null, finalAt: now };
}
