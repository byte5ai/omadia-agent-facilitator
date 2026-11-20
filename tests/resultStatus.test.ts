// The result status model (spec 5.2, 5.11): result status and delivery
// status are separate, every final document is marked, a stop or a failed
// delivery marks a document "not confirmed" only where its confirmation was
// required, and a closing event's document is frozen with its version.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import {
  CLOSING_LIMITS,
  closingEventId,
  confirmationWindowMs,
  finalPatch,
  getClosingByEvent,
  listClosings,
  markDocument,
  markOf,
  openClosing,
  patchClosing,
  resultStatusWords,
  stoppedMark,
  undeliveredMark,
} from '../src/engine/resultStatus.js';
import { PG_SKIP, openTestDb } from './pg.js';
import type { TestDb } from './pg.js';

let db: TestDb;
before(async () => {
  if (!PG_SKIP) db = await openTestDb();
});
after(async () => {
  if (!PG_SKIP) await db.close();
});

const T0 = new Date('2026-11-20T09:00:00Z');

test('every result status reads with its reason, in both languages', () => {
  assert.equal(resultStatusWords('en', { status: 'published' }), 'published');
  assert.equal(resultStatusWords('en', { status: 'confirmed' }), 'confirmed');
  assert.equal(resultStatusWords('en', { status: 'aborted' }), 'aborted');
  assert.equal(resultStatusWords('en', { status: 'not_confirmed', reason: 'stopped' }), 'not confirmed (facilitation stopped)');
  assert.equal(resultStatusWords('en', { status: 'not_confirmed', reason: 'electorate_unverified' }), 'not confirmed (participants could not be verified)');
  assert.equal(resultStatusWords('de', { status: 'not_confirmed', reason: 'not_delivered' }), 'nicht bestätigt (nicht zugestellt)');
  assert.equal(resultStatusWords('de', { status: 'not_confirmed', reason: 'objection' }), 'nicht bestätigt (Einwand)');
  assert.match(markDocument('en', { status: 'confirmed' }, 'Protocol: x'), /^Result status: confirmed\n\nProtocol: x$/);
});

test('a stop or a failed delivery is "not confirmed" only where confirmation was required', () => {
  assert.deepEqual(stoppedMark(true), { status: 'not_confirmed', reason: 'stopped' });
  assert.deepEqual(stoppedMark(false), { status: 'published' });
  assert.deepEqual(undeliveredMark(true), { status: 'not_confirmed', reason: 'not_delivered' });
  assert.deepEqual(undeliveredMark(false), { status: 'published' });
});

test('the confirmation window defaults to 24 h and never exceeds 72 h', () => {
  assert.equal(confirmationWindowMs(undefined), 24 * HOUR_MS);
  assert.equal(confirmationWindowMs(0), 24 * HOUR_MS);
  assert.equal(confirmationWindowMs(12), 12 * HOUR_MS);
  assert.equal(confirmationWindowMs(200), 72 * HOUR_MS);
  assert.equal(CLOSING_LIMITS.absoluteMs, 30 * 24 * HOUR_MS);
});

test('a closing event keeps its frozen document, version and separate statuses', { skip: PG_SKIP }, async () => {
  const f = await store.createFacilitation(db.pool, {
    facilitatorAgent: 'mira',
    channelType: 'teams',
    conversationId: 'conv-result-status',
    initiatorPrincipal: 'user:anna',
    goal: 'Pick a venue',
    format: 'decision',
    language: 'en',
    timezone: 'Europe/Berlin',
    closeRule: 'all_contributed',
    reminderPolicy: { offsetsHours: [24, 2] },
    followupPolicy: { actionItems: false, leadHours: 24 },
    settings: { changeWindowHours: 12, runoffWindowHours: 12, confirmWindowMinutes: 30 },
    createdAt: T0,
  });
  const result = await openClosing(db.pool, { facilitationId: f.id, kind: 'result', document: 'Result v1', requiresConfirmation: true, waiting: true, now: T0 });
  assert.equal(result.eventId, closingEventId('result'));
  assert.equal(result.part, 'waiting');
  assert.equal(result.documentVersion, 1);
  assert.equal(result.resultStatus, null);
  assert.equal(result.deliveryStatus, 'pending');
  assert.equal(result.absoluteUntil.getTime(), T0.getTime() + CLOSING_LIMITS.absoluteMs);
  assert.equal(markOf(result), undefined);

  // Idempotent per event: the first frozen document stays.
  const again = await openClosing(db.pool, { facilitationId: f.id, kind: 'result', document: 'Result v2', requiresConfirmation: false, now: T0 });
  assert.equal(again.id, result.id);
  assert.equal(again.document, 'Result v1');

  const objected = await patchClosing(db.pool, result.id, { objections: [{ principal: 'user:ben', reason: 'too early', messageId: 'm1' }] });
  assert.equal(objected?.objections[0]?.reason, 'too early');
  const stopped = await patchClosing(db.pool, result.id, { ...finalPatch(stoppedMark(true), T0), deliveryStatus: 'not_delivered' });
  assert.deepEqual(stopped && markOf(stopped), { status: 'not_confirmed', reason: 'stopped' });
  assert.equal(stopped?.deliveryStatus, 'not_delivered');

  const abort = await openClosing(db.pool, { facilitationId: f.id, kind: 'abort', document: 'Abort report', requiresConfirmation: false, now: T0 });
  assert.deepEqual(markOf(abort), { status: 'aborted' });
  assert.ok(abort.finalAt);

  assert.equal((await listClosings(db.pool, f.id)).length, 2);
  assert.equal((await getClosingByEvent(db.pool, f.id, 'abort'))?.id, abort.id);

  // Concurrent openers of one event get the same row.
  await db.pool.query(`DELETE FROM plg_omadia_agent_facilitator_closings WHERE id = $1`, [abort.id]);
  const [a, b] = await Promise.all([1, 2].map((n) => openClosing(db.pool, { facilitationId: f.id, kind: 'abort', document: `Abort ${String(n)}`, requiresConfirmation: false, now: T0 })));
  assert.equal(a?.id, b?.id);

  // A reason exactly for "not confirmed", refused by the table itself.
  await assert.rejects(db.pool.query(`UPDATE plg_omadia_agent_facilitator_closings SET result_status = 'published', result_reason = 'objection' WHERE id = $1`, [result.id]));
  await assert.rejects(db.pool.query(`UPDATE plg_omadia_agent_facilitator_closings SET result_status = 'not_confirmed', result_reason = NULL WHERE id = $1`, [result.id]));
});
