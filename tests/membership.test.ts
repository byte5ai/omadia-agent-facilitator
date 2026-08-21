import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createMembershipHandler } from '../src/membership.js';
import { FacilitationStateStore } from '../src/stateStore.js';
import type { ConversationMembershipEventShape } from '../src/services.js';

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
    createMembershipHandler({ store, log: () => undefined })(BOT_ADDED);

    const record = store.get('c1');
    assert.equal(record?.phase, 'pending');
    assert.equal(record?.invitedBy, 'Owner');
    assert.equal(record?.channelType, 'teams');
  });

  it('other event kinds are ignored', () => {
    const store = new FacilitationStateStore();
    const handler = createMembershipHandler({ store, log: () => undefined });
    handler({ ...BOT_ADDED, kind: 'members_added' });
    handler({ ...BOT_ADDED, kind: 'members_removed' });
    assert.equal(store.get('c1'), undefined);
  });

  it('a throwing store is isolated (logged, never rethrown into the fan-out)', () => {
    const store = {
      markPending: () => {
        throw new Error('boom');
      },
    } as unknown as FacilitationStateStore;
    const logs: string[] = [];
    const handler = createMembershipHandler({ store, log: (m) => logs.push(m) });
    handler(BOT_ADDED); // must not throw
    assert.ok(logs.some((l) => l.includes('failed')));
  });
});
