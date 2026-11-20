// Quiet recording (spec 5.3, 5.14): a contribution in the announced format
// gets a reaction on its message where the channel supports reactions, and
// nothing at all where it does not. A reading from free text still asks.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };

test('a channel with reactions: a ballot gets a thumbs-up on its own message, and no post', { skip: PG_SKIP }, async () => {
  h.kernel.reactionSupport = true;
  try {
    const conv = h.kernel.conversation('re-with', [ANNA, BERT, CARA]);
    await startActive(h, conv, VOTE);
    const posts = h.kernel.groupPosts(conv).length;
    const ballot = await h.kernel.say(conv, 'anna', 'A');
    await h.settle();
    assert.equal(h.kernel.groupPosts(conv).length, posts, 'no echo');
    assert.deepEqual(h.kernel.reactions.filter((r) => r.conversationId === conv), [{ as: 'mira', conversationId: conv, messageId: ballot.messageId, reaction: 'acknowledge' }]);
    // A reaction is no message of the facilitation.
    const f = await h.facilitation(conv);
    assert.equal(f.messagesSent, (await store.listEvents(h.db.pool, f.id, ['message_sent'])).filter((e) => e.payload['purpose'] !== 'reaction').length);
    // Free text still gets its one question, and no reaction.
    const free = await h.kernel.say(conv, 'bert', 'the place by the water, I guess');
    await h.settle();
    await h.tool('facilitation_record_contribution', { messageId: free.messageId, kind: 'vote', summary: 'Harbour', ballot: 'A' }, { conversation: conv, caller: 'bert' });
    assert.match(h.kernel.groupPosts(conv).at(-1)?.text ?? '', /^Bert, I read your message as: A \(Harbour\)/);
    assert.equal(h.kernel.reactions.filter((r) => r.conversationId === conv).length, 1);
  } finally {
    h.kernel.reactionSupport = false;
  }
});

test('a channel without reactions: a ballot is recorded with no output at all', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('re-without', [ANNA, BERT, CARA]);
  await startActive(h, conv, VOTE);
  const posts = h.kernel.groupPosts(conv).length;
  await h.kernel.say(conv, 'anna', 'A');
  await h.settle();
  assert.equal(h.kernel.groupPosts(conv).length, posts);
  assert.deepEqual(h.kernel.reactions.filter((r) => r.conversationId === conv), []);
  const f = await h.facilitation(conv);
  assert.deepEqual((await store.listContributions(h.db.pool, f.id)).map((c) => c.status), ['valid']);
});
