// D25 (live): "the protocol goes to the participants by mail" had no effect.
// The mail was only ever sent when an operator had switched it on for the
// whole instance; a request could not ask for it.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { FakeFollowup } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
let followup: FakeFollowup;
before(async () => {
  if (PG_SKIP) return;
  // The instance default: protocol mail is NOT switched on by the operator.
  h = await createHarness({ start: '2026-11-18T09:00:00Z' });
  followup = new FakeFollowup();
  h.kernel.followup = followup;
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function vote(conv: string, who: string[]): Promise<void> {
  for (const person of who) {
    await h.kernel.say(conv, person, 'A');
    await h.settle();
  }
  await h.tick();
}
const VOTE = { goal: 'Pick a venue', method: 'single', options: ['Harbour', 'Garden'], open: true };
const mailEvents = async (conv: string) => (await store.listEvents(h.db.pool, (await h.facilitation(conv)).id, ['protocol_mail'])).map((e) => e.payload);

test('a facilitation set up with the protocol by mail sends it through the follow-up service, and says so only then', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pm-asked', [ANNA, BERT]);
  const started = await tool(conv, 'facilitation_start', { ...VOTE, protocolByMail: true });
  assert.doesNotMatch(started, /mail is not available/i);
  assert.match(posts(conv)[0] ?? '', /\nProtocol: after the close it also goes by mail to the participants whose address the channel knows\.\n/);
  const before = followup.mails.length;
  await vote(conv, ['anna', 'bert']);
  const sent = followup.mails.slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual([...(sent[0]?.recipients ?? [])].sort(), ['anna@example.com', 'bert@example.com']);
  assert.match(sent[0]?.body ?? '', /^Protocol: Pick a venue/);
  assert.ok(posts(conv).some((p) => /^The protocol has been sent: .* by mail to 2 addresses\.$/.test(p)));
  assert.deepEqual(await mailEvents(conv), [{ outcome: 'sent', recipients: [{ address: 'anna@example.com', outcome: 'sent' }, { address: 'bert@example.com', outcome: 'sent' }] }]);
});

test('without the wish no mail is sent and none is announced', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pm-not-asked', [ANNA, BERT]);
  await tool(conv, 'facilitation_start', VOTE);
  assert.doesNotMatch(posts(conv)[0] ?? '', /mail/i);
  const before = followup.mails.length;
  await vote(conv, ['anna', 'bert']);
  assert.equal(followup.mails.length, before);
  assert.ok(!posts(conv).some((p) => /by mail/.test(p)));
  assert.deepEqual(await mailEvents(conv), []);
});

test('a mail that was refused or whose outcome is unknown is never called sent, and each recipient has its outcome on record', { skip: PG_SKIP }, async () => {
  const refused = h.kernel.conversation('pm-refused', [ANNA, BERT]);
  await tool(refused, 'facilitation_start', { ...VOTE, protocolByMail: true });
  followup.configured = false;
  try {
    await vote(refused, ['anna', 'bert']);
  } finally {
    followup.configured = true;
  }
  assert.ok(!posts(refused).some((p) => /has been sent/.test(p) && /by mail/.test(p)));
  assert.ok(posts(refused).some((p) => /^The protocol could not be mailed \(no calendar integration is set up for this instance\)/.test(p)));
  assert.deepEqual(await mailEvents(refused), [{ outcome: 'not_configured', recipients: [{ address: 'anna@example.com', outcome: 'not_sent' }, { address: 'bert@example.com', outcome: 'not_sent' }] }]);

  const unknown = h.kernel.conversation('pm-unknown', [ANNA, BERT]);
  await tool(unknown, 'facilitation_start', { ...VOTE, protocolByMail: true });
  followup.afterEffects.set('sendMail', 'throw');
  try {
    await vote(unknown, ['anna', 'bert']);
  } finally {
    followup.afterEffects.delete('sendMail');
  }
  assert.ok(!posts(unknown).some((p) => /has been sent/.test(p) && /by mail/.test(p)));
  assert.deepEqual((await mailEvents(unknown)).map((e) => [e['outcome'], (e['recipients'] as { outcome: string }[]).map((r) => r.outcome)]), [['unknown_outcome', ['unknown', 'unknown']]]);
});

test('asked for on an instance without a mail integration: said at the start, nothing is promised', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pm-no-service', [ANNA, BERT]);
  h.kernel.followup = undefined;
  try {
    const started = await tool(conv, 'facilitation_start', { ...VOTE, protocolByMail: true });
    assert.match(started, /Tell the group: Sending the protocol by mail is not available on this instance/);
    assert.doesNotMatch(posts(conv)[0] ?? '', /by mail/);
    assert.equal((await h.facilitation(conv)).followupPolicy.protocolMail, undefined);
  } finally {
    h.kernel.followup = followup;
  }
});
