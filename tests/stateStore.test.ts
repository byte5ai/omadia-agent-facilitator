import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { FacilitationStateStore } from '../src/stateStore.js';

describe('FacilitationStateStore', () => {
  it('walks pending → active → stopped for one conversation', () => {
    const store = new FacilitationStateStore();
    store.markPending({ conversationId: 'c1', channelType: 'teams', invitedBy: 'Owner' });
    assert.equal(store.get('c1')?.phase, 'pending');

    store.markActive({
      conversationId: 'c1',
      goal: 'g',
      definitionOfDone: 'd',
      runId: 'run-1',
      workflowSlug: 'eph-facilitation-1',
      expiresAt: '2026-08-22T10:00:00.000Z',
    });
    const active = store.get('c1');
    assert.equal(active?.phase, 'active');
    assert.equal(active?.invitedBy, 'Owner'); // survives the transition
    assert.equal(active?.channelType, 'teams'); // origin channel survives too

    assert.equal(store.markStopped('c1')?.phase, 'stopped');
    assert.equal(store.markStopped('missing'), undefined);
  });

  it('a repeated invite never downgrades an active facilitation', () => {
    const store = new FacilitationStateStore();
    store.markActive({
      conversationId: 'c1',
      goal: 'g',
      definitionOfDone: 'd',
      runId: 'run-1',
      workflowSlug: 'eph-x',
      expiresAt: '2026-08-22T10:00:00.000Z',
    });
    store.markPending({ conversationId: 'c1' });
    assert.equal(store.get('c1')?.phase, 'active');
  });

  it('latest() returns the most recently updated record', () => {
    let tick = 0;
    const store = new FacilitationStateStore(() => new Date(1700000000000 + tick++ * 1000));
    store.markPending({ conversationId: 'old' });
    store.markPending({ conversationId: 'new' });
    assert.equal(store.latest()?.conversationId, 'new');
  });
});

describe('restore (#330 restart rehydration)', () => {
  it('is create-only — a live record with a run always wins over a restored one', () => {
    const store = new FacilitationStateStore(() => new Date('2026-08-22T08:00:00.000Z'));
    store.markActive({ conversationId: 'c1', goal: 'live', definitionOfDone: 'd', runId: 'run-live', workflowSlug: 'w', expiresAt: 'x' });
    const clobbered = store.restore({ conversationId: 'c1', phase: 'active', runId: 'run-x', goal: 'durable' });
    assert.equal(clobbered, undefined);
    assert.equal(store.get('c1')?.runId, 'run-live');
    assert.equal(store.get('c1')?.goal, 'live');

    // Exception (cold boot): a pending marker without runId (bot_present
    // before hydration) is upgraded by the durable run; live invite context stays.
    store.markPending({ conversationId: 'p1', channelType: 'teams', invitedBy: 'Owner', invitedByRef: { id: 'aad-1' }, bindPending: true });
    const upgraded = store.restore({
      conversationId: 'p1',
      channelType: 'other',
      phase: 'active',
      runId: 'run-p',
      goal: 'G',
      definitionOfDone: 'D',
      nudgesSent: 2,
    });
    assert.equal(upgraded?.phase, 'active');
    assert.equal(upgraded?.runId, 'run-p');
    assert.equal(upgraded?.goal, 'G');
    assert.equal(upgraded?.nudgesSent, 2);
    assert.equal(upgraded?.channelType, 'teams');
    assert.equal(upgraded?.invitedBy, 'Owner');
    assert.equal(upgraded?.bindPending, undefined);
    // A pending-only durable row never "upgrades" a pending marker.
    store.markPending({ conversationId: 'p2', channelType: 'teams', bindPending: true });
    assert.equal(store.restore({ conversationId: 'p2', phase: 'pending' }), undefined);
    assert.equal(store.get('p2')?.bindPending, true);

    const restored = store.restore({ conversationId: 'c2', phase: 'active', runId: 'run-2', roleKey: 'facilitation-x' });
    assert.equal(restored?.restored, true);
    assert.equal(store.get('c2')?.runId, 'run-2');
  });
});

describe('durable-state helpers (0.6.0)', () => {
  it('restore carries the run-sourced fields; mergeRestored only fills gaps of restored records', () => {
    const store = new FacilitationStateStore();
    store.restore({
      conversationId: 'c1',
      phase: 'stopped',
      runId: 'run-1',
      goal: 'g',
      definitionOfDone: 'd',
      progress: { dodMet: false, summary: 's', updatedAt: '2026-10-15T12:00:00.000Z' },
      nudgesSent: 4,
      roleKey: 'facilitation-a',
    });
    assert.equal(store.get('c1')?.phase, 'stopped');
    assert.equal(store.get('c1')?.nudgesSent, 4);
    assert.equal(store.getByRunId('run-1')?.conversationId, 'c1');
    assert.equal(store.getByRunId('nope'), undefined);

    store.mergeRestored('c1', { channelType: 'teams', roleKey: 'facilitation-other' });
    assert.equal(store.get('c1')?.channelType, 'teams');
    assert.equal(store.get('c1')?.roleKey, 'facilitation-a'); // never overwritten

    store.markPending({ conversationId: 'live' });
    assert.equal(store.mergeRestored('live', { channelType: 'teams' }), undefined);
    assert.equal(store.get('live')?.channelType, undefined);
  });
});
