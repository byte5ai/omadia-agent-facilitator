import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { CONFIG_DEFAULTS } from '../src/config.js';
import { createMembershipHandler } from '../src/membership.js';
import { FacilitationStateStore } from '../src/stateStore.js';
import type { ConversationBindingsService, ConversationMembershipEventShape } from '../src/services.js';

function bindingsFake(): { service: ConversationBindingsService; bindCalls: Array<Record<string, unknown>> } {
  const bindCalls: Array<Record<string, unknown>> = [];
  return {
    bindCalls,
    service: {
      bind: async (input) => {
        bindCalls.push(input as unknown as Record<string, unknown>);
        return { bound: true };
      },
      unbind: async () => ({ unbound: true }),
      attachWorkflow: async () => ({ attached: true }),
      observedInvite: () => undefined,
    },
  };
}

function handler(store: FacilitationStateStore, opts?: {
  bindings?: ConversationBindingsService;
  log?: (m: string) => void;
}): ReturnType<typeof createMembershipHandler> {
  return createMembershipHandler({
    store,
    config: CONFIG_DEFAULTS,
    getConversationBindings: () => opts?.bindings,
    log: opts?.log ?? (() => undefined),
  });
}

const BOT_ADDED: ConversationMembershipEventShape = {
  kind: 'bot_added',
  channelId: 'de.byte5.channel.teams',
  channelType: 'teams',
  conversationId: 'c1',
  conversationType: 'group',
  members: [{ kind: 'teams-aad', id: 'bot' }],
  addedBy: { kind: 'teams-aad', id: 'aad-owner', displayName: 'Owner' },
  occurredAt: '2026-08-21T10:00:00.000Z',
};

describe('createMembershipHandler', () => {
  it('bot_added creates a pending record with the inviter', () => {
    const store = new FacilitationStateStore();
    handler(store)(BOT_ADDED);

    const record = store.get('c1');
    assert.equal(record?.phase, 'pending');
    assert.equal(record?.invitedBy, 'Owner');
    assert.equal(record?.channelType, 'teams');
    assert.deepEqual(record?.invitedByRef, { id: 'aad-owner', displayName: 'Owner' });
  });

  it('C2b - a group bot_added triggers the invite-guarded auto-bind', async () => {
    const store = new FacilitationStateStore();
    const { service, bindCalls } = bindingsFake();
    handler(store, { bindings: service })(BOT_ADDED);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(bindCalls, [{ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'c1' }]);
  });

  it('C2b - no auto-bind for direct conversations or without the kernel service', async () => {
    const store = new FacilitationStateStore();
    const { service, bindCalls } = bindingsFake();
    handler(store, { bindings: service })({ ...BOT_ADDED, conversationType: 'direct' });
    const logs: string[] = [];
    handler(store, { log: (m) => logs.push(m) })(BOT_ADDED);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(bindCalls, []);
    assert.ok(logs.some((l) => l.includes('conversationBindings')));
  });

  it('other event kinds are ignored', () => {
    const store = new FacilitationStateStore();
    const run = handler(store);
    run({ ...BOT_ADDED, kind: 'members_added' });
    run({ ...BOT_ADDED, kind: 'members_removed' });
    assert.equal(store.get('c1'), undefined);
  });

  it('a throwing store is isolated (logged, never rethrown into the fan-out)', () => {
    const store = {
      markPending: () => {
        throw new Error('boom');
      },
    } as unknown as FacilitationStateStore;
    const logs: string[] = [];
    const run = handler(store, { log: (m) => logs.push(m) });
    run(BOT_ADDED); // must not throw
    assert.ok(logs.some((l) => l.includes('failed')));
  });
});

// #330 round 3 — bot_present is eligibility, never an eager bind: binding
// every chat the bot merely talks in would hijack conversations nobody asked
// to be facilitated.
describe('createMembershipHandler — bot_present', () => {
  it('marks pending with bindPending and does NOT bind', () => {
    const bindings = bindingsFake();
    const store = new FacilitationStateStore();
    const handler = createMembershipHandler({
      store,
      config: CONFIG_DEFAULTS,
      getConversationBindings: () => bindings.service,
      log: () => undefined,
    });
    handler({
      kind: 'bot_present',
      channelId: 'de.byte5.channel.teams',
      channelType: 'teams',
      conversationId: 'grp-present',
      conversationType: 'group',
      members: [],
      addedBy: { kind: 'teams-aad', id: 'aad-1', displayName: 'Marcel Wege' },
      occurredAt: '2026-08-24T07:00:00.000Z',
    });
    const record = store.get('grp-present');
    assert.equal(record?.phase, 'pending');
    assert.equal(record?.bindPending, true);
    assert.equal(record?.invitedBy, 'Marcel Wege');
    assert.deepEqual(bindings.bindCalls, []);
  });

  it('never downgrades an existing record, and ignores non-group presence', () => {
    const bindings = bindingsFake();
    const store = new FacilitationStateStore();
    const handler = createMembershipHandler({
      store,
      config: CONFIG_DEFAULTS,
      getConversationBindings: () => bindings.service,
      log: () => undefined,
    });
    handler({
      kind: 'bot_added', channelId: 'x', channelType: 'teams', conversationId: 'grp-1',
      conversationType: 'group', members: [], occurredAt: '2026-08-24T07:00:00.000Z',
    });
    handler({
      kind: 'bot_present', channelId: 'x', channelType: 'teams', conversationId: 'grp-1',
      conversationType: 'group', members: [], occurredAt: '2026-08-24T07:01:00.000Z',
    });
    assert.equal(store.get('grp-1')?.bindPending, undefined, 'real invite must not gain bindPending');

    handler({
      kind: 'bot_present', channelId: 'x', channelType: 'teams', conversationId: 'dm-1',
      conversationType: 'direct', members: [], occurredAt: '2026-08-24T07:00:00.000Z',
    });
    assert.equal(store.get('dm-1'), undefined);
  });
});
