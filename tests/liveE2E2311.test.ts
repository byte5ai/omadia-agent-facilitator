// Findings of the live runs on Slack, Discord and Telegram (2026-11-23).
//
// K1: the kernel (up to plugin-api 1.87) states the channel's routing
//     principal as the caller of a tool (`user:slack-user:<id>`,
//     `user:<e-mail>`), while message authors are `user:<id>`. The initiator
//     was a second, nameless participant, "everyone voted" never closed the
//     vote and the private report to the initiator was refused.
// K2: an unmentioned top-level "1, 3, 2" in the facilitated channel was not
//     counted, although the text vote numbers its options and suggests it.
// Handshake: "you vote on the card" when the card went out as text.
// Status: a facilitation that was stopped still answered "status", so the
//     group got two status posts once a new one ran.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ channel: 'slack' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);

/** The kernel of 1.87: the routing principal as the caller of a tool call. */
function routingPrincipalAsCaller(): () => void {
  const original = h.kernel.context.bind(h.kernel);
  h.kernel.context = ((agentSlug: string, conversationId: string, callerId: string, inboundEventId?: string) => {
    const context = original(agentSlug, conversationId, callerId, inboundEventId);
    return { ...context, callerPrincipalId: `user:slack-user:${callerId}` };
  }) as typeof h.kernel.context;
  return () => {
    h.kernel.context = original;
  };
}

test('K1: the initiator stated by the routing principal is one named participant, the vote closes when everyone voted, the report reaches them', { skip: PG_SKIP }, async () => {
  const restore = routingPrincipalAsCaller();
  try {
    const conv = h.kernel.conversation('e2e-k1', [ANNA, BERT]);
    const dmsBefore = h.kernel.dms.length;
    await h.tool('facilitation_start', { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true }, { conversation: conv, caller: 'anna' });
    const f = await h.facilitation(conv);
    assert.equal(f.initiatorParticipant, 'user:anna');
    const participants = await store.listParticipants(h.db.pool, f.id);
    assert.deepEqual(participants.map((p) => p.principalId).sort(), ['user:anna', 'user:bert']);
    assert.equal(participants.find((p) => p.principalId === 'user:anna')?.displayName, 'Anna');
    await say(conv, 'anna', 'A');
    assert.equal((await h.facilitation(conv)).phase, 'active', 'one of two voted');
    await say(conv, 'bert', 'A');
    assert.equal((await h.facilitation(conv)).phase, 'closed', 'everyone voted, so the vote closes');
    const report = h.kernel.dms.slice(dmsBefore).filter((d) => d.principal === 'user:anna' && d.text.includes('you started this facilitation'));
    assert.equal(report.length, 1, 'the initiator gets the report privately');
    assert.equal((await store.listEvents(h.db.pool, f.id, ['initiator_report_skipped'])).length, 0);
  } finally {
    restore();
  }
});

test('K2: an unmentioned top-level ballot by option numbers is counted', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('e2e-k2', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'Pick a tool', method: 'ranked', options: ['Linear', 'GitHub Issues', 'Jira'], open: true }, { conversation: conv, caller: 'anna' });
  await say(conv, 'bert', '1, 3, 2');
  const f = await h.facilitation(conv);
  const outcome = (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq DESC LIMIT 1', [f.id])).rows[0]?.outcome;
  assert.equal(outcome, 'ballot');
});

test('handshake: a card that goes out as text is answered in the chat, not "on the card"', { skip: PG_SKIP }, async () => {
  const previous = h.kernel.cardSupport;
  h.kernel.cardSupport = { kinds: ['single_choice', 'multiple_choice', 'ranking', 'consent', 'assignment', 'text'], maxQuestions: 1, update: false, asText: true } as typeof previous;
  try {
    const conv = h.kernel.conversation('e2e-text-card', [ANNA, BERT]);
    await h.tool('facilitation_start', { goal: 'Pick a tool', method: 'ranked', options: ['Linear', 'Jira'], open: true }, { conversation: conv, caller: 'anna' });
    const handshake = posts(conv)[0] ?? '';
    assert.doesNotMatch(handshake, /vote on the card/);
    assert.match(handshake, /Reply in the chat/);
  } finally {
    h.kernel.cardSupport = previous;
  }
});

test('status: a stopped facilitation does not answer it any more', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('e2e-status', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'First', method: 'single', options: ['A1', 'B1'], open: true }, { conversation: conv, caller: 'anna' });
  await say(conv, 'anna', 'stop');
  assert.equal((await h.facilitation(conv)).phase, 'aborted');
  await h.tool('facilitation_start', { goal: 'Second', method: 'single', options: ['A2', 'B2'], open: true }, { conversation: conv, caller: 'anna' });
  const before = posts(conv).length;
  await say(conv, 'bert', 'status');
  const statusPosts = posts(conv).slice(before).filter((p) => p.startsWith('Status:'));
  assert.equal(statusPosts.length, 1, 'one status post, from the running facilitation');
  assert.match(statusPosts[0] ?? '', /Second/);
});

test('status: a facilitation in follow-up leaves the group status to the one that runs', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('e2e-status-followup', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'First', method: 'single', options: ['A1', 'B1'], open: true }, { conversation: conv, caller: 'anna' });
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  const first = await h.facilitation(conv);
  assert.equal(first.phase, 'closed');
  // Still listening for follow-up (action items), as in the live run.
  await store.patchFacilitation(h.db.pool, first.id, { followupState: 'active' });
  await h.tool('facilitation_start', { goal: 'Second', method: 'single', options: ['A2', 'B2'], open: true }, { conversation: conv, caller: 'anna' });
  const before = posts(conv).length;
  await say(conv, 'bert', 'status');
  const statusPosts = posts(conv).slice(before).filter((p) => p.startsWith('Status:'));
  assert.equal(statusPosts.length, 1, 'one status post, from the running facilitation');
  assert.match(statusPosts[0] ?? '', /Second/);
});
