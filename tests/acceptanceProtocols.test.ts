// Session protocol vs facilitation protocol (spec B §5.8, §5.11; §9
// criterion 63; #2068): a session that closes while its facilitation goes on
// gives its participants the session protocol and its stakeholders nothing;
// only the facilitation's close dispatches the facilitation protocol to them.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-20T08:00:00Z' });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
  h.kernel.names.set('mira', 'Mira');
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
const say = async (conv: string, who: string, text: string): Promise<void> => {
  await h.kernel.say(conv, who, text);
  await h.settle();
};
const agreed = async (conv: string): Promise<void> => {
  for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'agreed');
  if ((await h.facilitation(conv)).phase === 'active') await passWindow(h, conv);
};
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const SESSION_SUMMARY = /Summary of the session "Kick-off call"/;

test('63. a first session closes while the facilitation continues: participants get the session protocol, stakeholders nothing; only the close dispatches the facilitation protocol to them', { skip: PG_SKIP }, async () => {
  const home = h.kernel.conversation('ap-63-home', [ANNA, BERT, CARA]);
  const meeting = h.kernel.conversation('ap-63-meeting', [ANNA, BERT, CARA]);
  const goal = 'Offsite plan 63';
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'A plan is agreed', agenda: [{ kind: 'collect', title: 'Ideas' }, { kind: 'close', title: 'Close' }] });
  await tool(home, 'facilitation_open');
  await tool(home, 'facilitation_stakeholder', { name: 'Sam Stake', address: 'sam@example.com', role: 'receives_protocol', disclosure: 'full' });
  await agreed(home);
  const f = await h.facilitation(home);
  assert.ok((await store.listStakeholders(h.db.pool, f.id)).some((s) => s.address === 'sam@example.com' && s.confirmed), 'a confirmed stakeholder');

  // The first session runs in the linked meeting chat and closes.
  await tool(home, 'facilitation_session', { action: 'schedule', title: 'Kick-off call', start: inMinutes(60), end: inMinutes(120), modality: 'online' });
  await h.kernel.linkRequest(meeting, 'anna', `@mira link this chat to ${goal}`);
  await h.settle();
  await h.kernel.sessionEvent('mira', meeting, 'meeting-ap63', 'session_started');
  await h.settle();
  await say(meeting, 'bert', 'A boat trip');
  const mails = followup.mails.length;
  await h.kernel.sessionEvent('mira', meeting, 'meeting-ap63', 'session_ended');
  await h.settle();
  await h.tick();

  assert.equal((await h.facilitation(home)).phase, 'active', 'the facilitation continues');
  assert.ok(posts(meeting).some((t) => SESSION_SUMMARY.test(t)), 'the session participants get the session protocol');
  assert.ok(posts(home).some((t) => SESSION_SUMMARY.test(t)), 'and so do the home participants');
  assert.deepEqual(followup.mails.slice(mails).filter((m) => m.recipients.includes('sam@example.com')), [], 'the stakeholder gets nothing of the session');

  // The facilitation closes: only now does its protocol go to the stakeholder.
  await tool(home, 'facilitation_step', { action: 'close' });
  await tool(home, 'facilitation_step', { action: 'close' });
  await agreed(home);
  await h.tick();
  await h.tick();
  assert.notEqual((await h.facilitation(home)).phase, 'active');
  const toSam = followup.mails.slice(mails).filter((m) => m.recipients.includes('sam@example.com'));
  assert.equal(toSam.length, 1, 'exactly one dispatch to the stakeholder: the facilitation protocol');
  assert.match(toSam[0]?.body ?? '', new RegExp(`^Protocol: ${goal}\\nResult status: `));
  assert.doesNotMatch(toSam[0]?.body ?? '', /^Summary of the session/m, 'not the session protocol as a document of its own');
  assert.doesNotMatch(toSam[0]?.body ?? '', /A boat trip/, 'never contributions');
});
