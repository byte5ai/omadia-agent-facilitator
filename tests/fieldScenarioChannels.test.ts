// The field scenario without Teams (byte5ai/omadia#2066, review change
// 2026-11-18; spec 2043 §6.4): on an instance with no Teams configuration, a
// facilitator with its own identity on Slack, Discord or Telegram runs the
// field scenario there. Readiness is per channel identity: a Teams identity
// does not make it ready elsewhere, and a missing Teams identity does not
// make it "not ready" where it has one of its own.
//
// The simulated transport is the fake kernel set to that channel type; there
// is no Teams in it at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import { ANNA, BERT, CARA, DAVE, FOUR, createHarness, startActive } from './harness.js';
import { PG_SKIP } from './pg.js';

const VENUES = { method: 'ranked', options: ['Harbour', 'Old Town', 'Castle Hill'], points: [3, 2, 1] };

for (const channel of ['slack', 'discord', 'telegram'] as const) {
  test(`${channel} without Teams: the field scenario runs through the facilitator's own ${channel} identity`, { skip: PG_SKIP }, async () => {
    const h = await createHarness({ start: '2026-11-16T08:00:00Z', channel });
    try {
      h.kernel.names.set('mira', 'Mira');
      // Its only identity is on this channel: no Teams identity anywhere.
      h.kernel.ownIdentities.set('mira', [channel]);
      const conv = h.kernel.conversation(`${channel}-field`, FOUR);
      const f = await startActive(h, conv, { ...VENUES, deadline: new Date(h.clock.now().getTime() + 72 * HOUR_MS).toISOString() });
      assert.equal(f.channelType, channel);
      const posts = (): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
      assert.match(posts()[0] ?? '', /^Hello, I am Mira/);

      for (const [who, vote] of [
        ['anna', '@Mira A > C > B'],
        ['bert', 'B > A'],
        ['cara', 'A > B > C'],
        ['dave', 'C > A'],
      ] as const) {
        await h.kernel.say(conv, who, vote);
        await h.settle();
      }
      const closed = await h.facilitation(conv);
      assert.equal(closed.phase, 'closed', 'the fourth vote concludes the facilitation');
      assert.match(posts().find((t) => t.startsWith('Result for')) ?? '', /- Pick a venue: Harbour \(Harbour 10, Old Town 6, Castle Hill 6\)/);
      assert.ok(h.kernel.groupPosts(conv).every((p) => p.as === 'mira'), 'every post as the facilitator itself');
    } finally {
      await h.close();
    }
  });

  test(`${channel}: a facilitator whose only identity is on Teams is refused there and nothing starts`, { skip: PG_SKIP }, async () => {
    const h = await createHarness({ start: '2026-11-16T08:00:00Z', channel });
    try {
      h.kernel.ownIdentities.set('mira', ['teams']);
      const conv = h.kernel.conversation(`${channel}-teams-only`, [ANNA, BERT, CARA, DAVE]);
      const answer = await h.tool('facilitation_start', { goal: 'Pick a venue', ...VENUES, open: true }, { conversation: conv });
      assert.match(answer, /no_identity|identity of its own|own identity|bot of its own/i);
      assert.equal(h.kernel.groupPosts(conv).length, 0, 'it never speaks through another bot');
      const started = await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1', [conv]);
      assert.equal(started.rowCount, 0);
    } finally {
      await h.close();
    }
  });
}
