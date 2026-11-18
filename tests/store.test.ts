import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { insert } from '../src/db/sql.js';
import { inTransaction, withFacilitationLock } from '../src/db/tx.js';
import type { Facilitation } from '../src/model.js';
import { PG_SKIP, openTestDb } from './pg.js';
import type { TestDb } from './pg.js';

let db: TestDb;
before(async () => {
  if (!PG_SKIP) db = await openTestDb();
});
after(async () => {
  if (!PG_SKIP) await db.close();
});

const T0 = new Date('2026-11-18T09:00:00Z');

function newFacilitation(conversationId: string, overrides: Partial<store.NewFacilitation> = {}): store.NewFacilitation {
  return {
    facilitatorAgent: 'mira',
    channelType: 'teams',
    conversationId,
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
    ...overrides,
  };
}

const EXPECTED_TABLES = [
  'facilitation_access_audit',
  'facilitation_acks',
  'facilitation_action_items',
  'facilitation_clusters',
  'facilitation_contributions',
  'facilitation_decisions',
  'facilitation_dod_versions',
  'facilitation_events',
  'facilitation_inbound',
  'facilitation_jobs',
  'facilitation_outbox',
  'facilitation_participants',
  'facilitation_proposals',
  'facilitation_sessions',
  'facilitation_stakeholders',
  'facilitation_steps',
  'facilitations',
];

test('migrations create every table of spec 5.1 and are recorded in the plugin ledger', { skip: PG_SKIP }, async () => {
  const result = await db.pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'facilitation%' ORDER BY tablename`,
    [db.schema],
  );
  assert.deepEqual(
    result.rows.map((r) => r.tablename),
    EXPECTED_TABLES,
  );
  const again = await db.runMigrations();
  assert.deepEqual(again.applied, [], 'a second pass applies nothing');
  assert.equal(again.ledger, 'plg_omadia_agent_facilitator_migrations');
});

test('one active facilitation per conversation; a closed one frees the conversation', { skip: PG_SKIP }, async () => {
  const first = await store.createFacilitation(db.pool, newFacilitation('conv-unique'));
  await assert.rejects(store.createFacilitation(db.pool, newFacilitation('conv-unique')), /facilitations_one_active_per_conversation/);
  await store.patchFacilitation(db.pool, first.id, { phase: 'closed', closedAt: T0 });
  const second = await store.createFacilitation(db.pool, newFacilitation('conv-unique'));
  assert.notEqual(second.id, first.id);
  assert.equal((await store.findLiveByConversation(db.pool, 'teams', 'conv-unique'))?.id, second.id);
});

test('rows round-trip with typed columns: jsonb, timestamps, defaults', { skip: PG_SKIP }, async () => {
  const deadline = new Date('2026-11-21T09:00:00Z');
  const created = await store.createFacilitation(db.pool, newFacilitation('conv-roundtrip', { deadline }));
  const loaded = (await store.getFacilitation(db.pool, created.id)) as Facilitation;
  assert.equal(loaded.phase, 'configuring');
  assert.equal(loaded.stateVersion, 0);
  assert.deepEqual(loaded.reminderPolicy, { offsetsHours: [24, 2] });
  assert.equal(loaded.deadline?.toISOString(), deadline.toISOString());
  assert.equal(loaded.followupState, 'none');
  assert.equal(await store.bumpStateVersion(db.pool, created.id), 1);
  assert.equal(await store.bumpStateVersion(db.pool, created.id), 2);
});

test('steps, participants, definition of done and contributions hang off the facilitation', { skip: PG_SKIP }, async () => {
  const f = await store.createFacilitation(db.pool, newFacilitation('conv-children'));
  const steps = await store.replaceSteps(db.pool, f.id, [
    { kind: 'open', title: 'Opening' },
    {
      kind: 'decide',
      title: 'Vote',
      method: 'ranked',
      options: [
        { key: 'A', label: 'Alpha' },
        { key: 'B', label: 'Beta' },
      ],
      methodConfig: { points: [3, 2, 1] },
    },
  ]);
  assert.deepEqual(steps.map((s) => [s.position, s.kind, s.status]), [
    [1, 'open', 'pending'],
    [2, 'decide', 'pending'],
  ]);
  assert.deepEqual(steps[1]?.options, [
    { key: 'A', label: 'Alpha' },
    { key: 'B', label: 'Beta' },
  ]);

  const anna = await store.addParticipant(db.pool, {
    facilitationId: f.id,
    principalId: 'anna',
    displayName: 'Anna',
    source: 'roster',
    joinedAt: T0,
    changedAt: T0,
  });
  assert.equal(anna?.status, 'active');
  assert.equal(await store.addParticipant(db.pool, { facilitationId: f.id, principalId: 'anna', displayName: 'Anna', source: 'roster', joinedAt: T0, changedAt: T0 }), undefined);

  const v1 = await store.addDodVersion(db.pool, { facilitationId: f.id, text: 'A venue is chosen', criteria: { type: 'decisions_reached' }, proposedBy: 'user:anna', consentState: 'initial', effectiveAt: T0, createdAt: T0 });
  const v2 = await store.addDodVersion(db.pool, { facilitationId: f.id, text: 'A venue and a date', proposedBy: 'bert', consentState: 'proposed', createdAt: T0 });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal((await store.currentDod(db.pool, f.id))?.version, 1, 'a proposed version is not in force');

  const stepId = steps[1]?.id as string;
  const vote = {
    facilitationId: f.id,
    stepId,
    round: 1,
    participantPrincipal: 'anna',
    kind: 'vote' as const,
    payload: { ranking: ['A', 'B'] },
    source: 'message' as const,
    sourceMessageId: 'm1',
    sourceRevision: 0,
    status: 'valid' as const,
    recordedAt: T0,
  };
  const first = await store.addContribution(db.pool, vote);
  await assert.rejects(store.addContribution(db.pool, vote), /facilitation_contributions_source_unique/);
  await store.patchContribution(db.pool, first.id, { status: 'superseded' });
  await store.addContribution(db.pool, { ...vote, sourceRevision: 1, payload: { ranking: ['B', 'A'] } });
  assert.equal((await store.findLiveBySourceMessage(db.pool, f.id, 'm1'))?.sourceRevision, 1);
  await assert.rejects(
    store.addContribution(db.pool, { ...vote, sourceMessageId: null, source: 'message' }),
    /violates check constraint/,
    'only a spoken contribution may lack a source message',
  );
});

test('the protocol is append-only and goes away with its facilitation', { skip: PG_SKIP }, async () => {
  const f = await store.createFacilitation(db.pool, newFacilitation('conv-events'));
  const event = await store.appendEvent(db.pool, { facilitationId: f.id, kind: 'handshake', actor: 'engine', occurredAt: T0, payload: { text: 'hello' } });
  await assert.rejects(db.pool.query('UPDATE facilitation_events SET kind = $1 WHERE id = $2', ['edited', event.id]), /append-only/);
  await insert(db.pool, 'facilitation_access_audit', { facilitationId: f.id, action: 'content_read', actor: 'op@example.com', reason: 'complaint', occurredAt: T0 });
  await db.pool.query('DELETE FROM facilitations WHERE id = $1', [f.id]);
  assert.deepEqual(await store.listEvents(db.pool, f.id), []);
  const audit = await db.pool.query('SELECT 1 FROM facilitation_access_audit WHERE facilitation_id = $1', [f.id]);
  assert.equal(audit.rowCount, 1, 'the audit outlives the facilitation');
});

test('an inbound event is claimed once', { skip: PG_SKIP }, async () => {
  const f = await store.createFacilitation(db.pool, newFacilitation('conv-inbound'));
  const row = { facilitationId: f.id, eventId: 'e1', messageId: 'm1', revision: 0, kind: 'created', authorPrincipal: 'anna', outcome: 'processing', processedAt: T0 };
  assert.ok(await store.claimInbound(db.pool, row));
  assert.equal(await store.claimInbound(db.pool, row), undefined);
});

test('the facilitation lock serialises work across connections and a transaction rolls back whole', { skip: PG_SKIP }, async () => {
  const f = await store.createFacilitation(db.pool, newFacilitation('conv-lock'));
  const order: string[] = [];
  const slow = withFacilitationLock(db.pool, f.id, async () => {
    order.push('slow:start');
    await new Promise((r) => setTimeout(r, 60));
    order.push('slow:end');
  });
  const fast = withFacilitationLock(db.pool, f.id, async () => {
    order.push('fast');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow:start', 'slow:end', 'fast']);

  // The database lock itself, not only the in-process queue: a second session
  // cannot take it while the first holds it.
  await withFacilitationLock(db.pool, f.id, async () => {
    const other = await db.pool.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 2043)) AS locked', [f.id]);
    assert.equal(other.rows[0]?.locked, false);
  });
  const free = await db.pool.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 2043)) AS locked, pg_advisory_unlock_all()', [f.id]);
  assert.equal(free.rows[0]?.locked, true, 'released afterwards');

  await withFacilitationLock(db.pool, f.id, async (client) => {
    await assert.rejects(
      inTransaction(client, async (tx) => {
        await store.bumpStateVersion(tx, f.id);
        throw new Error('boom');
      }),
      /boom/,
    );
  });
  assert.equal((await store.getFacilitation(db.pool, f.id))?.stateVersion, 0);
});
