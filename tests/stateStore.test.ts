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
  it('is create-only — a live record always wins over a restored one', () => {
    const store = new FacilitationStateStore(() => new Date('2026-08-22T08:00:00.000Z'));
    store.markPending({ conversationId: 'c1', channelType: 'teams' });
    const clobbered = store.restore({ conversationId: 'c1', phase: 'active', runId: 'run-x' });
    assert.equal(clobbered, undefined);
    assert.equal(store.get('c1')?.phase, 'pending');

    const restored = store.restore({ conversationId: 'c2', phase: 'active', runId: 'run-2', roleKey: 'facilitation-x' });
    assert.equal(restored?.restored, true);
    assert.equal(store.get('c2')?.runId, 'run-2');
  });
});
