import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseSnapshot, RunStatePersister, snapshotOf } from '../src/persistence.js';
import type { EphemeralRunsService } from '../src/services.js';
import { FacilitationStateStore } from '../src/stateStore.js';

function activeStore(): FacilitationStateStore {
  const store = new FacilitationStateStore();
  store.markPending({ conversationId: 'c1', channelType: 'teams', invitedBy: 'Owner', invitedByRef: { id: 'aad-1' } });
  store.markActive({
    conversationId: 'c1',
    goal: 'g',
    definitionOfDone: 'd',
    runId: 'run-1',
    workflowSlug: 'eph-1',
    expiresAt: '2026-10-17T00:00:00.000Z',
    roleKey: 'facilitation-1',
  });
  return store;
}

function service(saveRunState?: EphemeralRunsService['saveRunState']): EphemeralRunsService {
  return {
    createEphemeralRun: async () => {
      throw new Error('unused');
    },
    ...(saveRunState ? { saveRunState } : {}),
  };
}

describe('snapshot codec', () => {
  it('carries phase/progress/nudges/role/channel and NO inviter PII', () => {
    const store = activeStore();
    store.recordProgress('c1', { dodMet: false, summary: 's' });
    store.reserveNudge('c1', 12);
    const snap = snapshotOf(store.get('c1')!);
    assert.equal(snap.v, 1);
    assert.equal(snap.phase, 'active');
    assert.equal(snap.nudgesSent, 1);
    assert.equal(snap.roleKey, 'facilitation-1');
    assert.equal(snap.channelType, 'teams');
    assert.equal(snap.progress?.summary, 's');
    const json = JSON.stringify(snap);
    assert.ok(!json.includes('Owner') && !json.includes('aad-1'), json);
    assert.ok(!json.includes('"goal"'), json);
  });

  it('truncates an oversized summary even when the tool cap was bypassed', () => {
    const store = activeStore();
    store.recordProgress('c1', { dodMet: false, summary: '€'.repeat(50_000) });
    const snap = snapshotOf(store.get('c1')!);
    assert.equal(snap.progress?.summary.length, 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(snap), 'utf8') < 16 * 1024);
  });

  it('parseSnapshot rejects unknown versions and drops malformed fields', () => {
    assert.equal(parseSnapshot(null), undefined);
    assert.equal(parseSnapshot({ v: 2, phase: 'active' }), undefined);
    const parsed = parseSnapshot({ v: 1, phase: 'active', nudgesSent: 1.5, roleKey: 7 });
    assert.deepEqual(parsed, { v: 1, phase: 'active' });
  });
});

describe('RunStatePersister', () => {
  it('chains writes per run and serializes the CURRENT record at execution time', async () => {
    const store = activeStore();
    const saved: Array<{ summary: string | undefined; startedWhileBusy: boolean }> = [];
    let busy = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const persister = new RunStatePersister({
      agentId: 'a',
      store,
      getEphemeralRuns: () =>
        service(async ({ state }) => {
          const startedWhileBusy = busy;
          busy = true;
          if (first) {
            first = false;
            await gate;
          }
          saved.push({ summary: (state.progress as { summary?: string } | undefined)?.summary, startedWhileBusy });
          busy = false;
          return { saved: true };
        }),
      log: () => undefined,
    });

    store.recordProgress('c1', { dodMet: false, summary: 'A' });
    const p1 = persister.persist('c1');
    store.recordProgress('c1', { dodMet: false, summary: 'B' });
    const p2 = persister.persist('c1');
    store.recordProgress('c1', { dodMet: true, summary: 'C' });
    release();
    await Promise.all([p1, p2]);

    assert.equal(saved.length, 2);
    assert.equal(saved.every((s) => !s.startedWhileBusy), true); // never two in flight
    assert.equal(saved[saved.length - 1]!.summary, 'C'); // last write carries the latest state
  });

  it('is a no-op without a run id or on an old kernel, and never throws', async () => {
    const logs: string[] = [];
    const pendingOnly = new FacilitationStateStore();
    pendingOnly.markPending({ conversationId: 'p1' });
    let calls = 0;
    const counting = new RunStatePersister({
      agentId: 'a',
      store: pendingOnly,
      getEphemeralRuns: () =>
        service(async () => {
          calls += 1;
          return { saved: true };
        }),
      log: (m) => logs.push(m),
    });
    await counting.persist('p1');
    await counting.persist('missing');
    assert.equal(calls, 0);

    const old = new RunStatePersister({ agentId: 'a', store: activeStore(), getEphemeralRuns: () => service(), log: (m) => logs.push(m) });
    await old.persist('c1');

    const throwing = new RunStatePersister({
      agentId: 'a',
      store: activeStore(),
      getEphemeralRuns: () =>
        service(async () => {
          throw new Error('boom');
        }),
      log: (m) => logs.push(m),
    });
    await throwing.persist('c1'); // resolves
    assert.ok(logs.some((l) => l.includes('boom')));

    const refused = new RunStatePersister({
      agentId: 'a',
      store: activeStore(),
      getEphemeralRuns: () => service(async () => ({ saved: false })),
      log: (m) => logs.push(m),
    });
    await refused.persist('c1');
    assert.ok(logs.some((l) => l.includes('not saved')));
  });
});
