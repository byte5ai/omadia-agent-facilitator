// What the protocol and the handshake say (integration run, P6).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import type { FakeUser } from './fakeKernel.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
/** People the channel knows no mail address of. */
const NO_MAIL: FakeUser[] = [
  { id: 'nora', displayName: 'Nora' },
  { id: 'omar', displayName: 'Omar' },
];

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

async function say(conv: string, who: string, text: string): Promise<void> {
  await h.kernel.say(conv, who, text);
  await h.settle();
}
const sectionOf = (protocol: string, title: string): string[] => {
  const lines = protocol.split('\n');
  const start = lines.indexOf(`${title}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l === '');
  return end === -1 ? rest : rest.slice(0, end);
};

test('a runoff is in the protocol with what it was between, in the language of the group', { skip: PG_SKIP }, async () => {
  for (const [language, title, expected] of [
    ['en', 'Changes to the rules', /: runoff between Harbour and Garden$/],
    ['de', 'Regeländerungen', /: Stichwahl zwischen Harbour und Garden$/],
  ] as const) {
    const conv = h.kernel.conversation(`pt-runoff-${language}`, FOUR);
    await startActive(h, conv, { ...VOTE, language });
    await say(conv, 'anna', 'A');
    await say(conv, 'bert', 'A');
    await say(conv, 'cara', 'B');
    await say(conv, 'dave', 'B');
    for (const who of ['anna', 'bert', 'cara']) await say(conv, who, 'A');
    await say(conv, 'dave', 'B');
    assert.equal((await h.facilitation(conv)).phase, 'closed');
    const report = h.kernel.dms.filter((d) => d.principal === 'user:anna').at(-1)?.text ?? '';
    const changes = sectionOf(report, title);
    assert.equal(changes.length, 1);
    assert.match(changes[0] ?? '', expected);
    assert.doesNotMatch(changes[0] ?? '', /: $/, 'no empty detail');
  }
});

test('a grant for nobody is not in the protocol, and the initiator and the participants read the same about capabilities', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-grant', NO_MAIL);
  await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...VOTE, open: true }, { conversation: conv, caller: 'nora' });
  await say(conv, 'nora', 'A');
  await say(conv, 'omar', 'A');
  assert.equal((await h.facilitation(conv)).phase, 'closed');
  const toInitiator = h.kernel.dms.filter((d) => d.principal === 'user:nora').at(-1)?.text ?? '';
  const toParticipant = h.kernel.dms.filter((d) => d.principal === 'user:omar').at(-1)?.text ?? '';
  assert.ok(toInitiator.includes('Use of scoped capabilities:') && toParticipant.includes('Use of scoped capabilities:'));
  assert.doesNotMatch(toParticipant, /grant issued for 0 addresses/);
  assert.deepEqual(sectionOf(toParticipant, 'Use of scoped capabilities'), sectionOf(toInitiator, 'Use of scoped capabilities'));
});

test('with mail addresses both protocols still say the same about capabilities', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-grant-mail', FOUR.slice(0, 2));
  await startActive(h, conv, VOTE);
  await say(conv, 'anna', 'A');
  await say(conv, 'bert', 'A');
  const toInitiator = h.kernel.dms.filter((d) => d.principal === 'user:anna').at(-1)?.text ?? '';
  const toParticipant = h.kernel.dms.filter((d) => d.principal === 'user:bert').at(-1)?.text ?? '';
  assert.deepEqual(sectionOf(toParticipant, 'Use of scoped capabilities'), sectionOf(toInitiator, 'Use of scoped capabilities'));
});

test('the handshake says "no private messages" only when the facilitator really cannot write privately', { skip: PG_SKIP }, async () => {
  // The channel declares nothing about private messages (baseline snapshot),
  // but private messages work: the handshake must not deny it.
  h.kernel.absent.add('sessionCapabilities');
  try {
    const works = h.kernel.conversation('pt-dm-works', FOUR);
    await startActive(h, works, { ...VOTE, deadline: new Date(h.clock.now().getTime() + 3 * 3600_000).toISOString(), reminderOffsetsHours: [1] });
    assert.doesNotMatch(h.kernel.groupPosts(works)[0]?.text ?? '', /cannot write to anyone privately/);

    // No way to write privately at all: it says so, and that is true.
    h.kernel.absent.add('targetedSend');
    const none = h.kernel.conversation('pt-dm-none', FOUR);
    await startActive(h, none, VOTE);
    assert.match(h.kernel.groupPosts(none)[0]?.text ?? '', /I cannot write to anyone privately here, so reminders stay in the group/);
  } finally {
    h.kernel.absent.delete('sessionCapabilities');
    h.kernel.absent.delete('targetedSend');
  }
});

test('a channel that declares private messages without a way to send them is not believed', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('pt-dm-declared', FOUR);
  h.kernel.capabilities(conv, ['text'], ['text', 'private_messages']);
  h.kernel.absent.add('targetedSend');
  try {
    await startActive(h, conv, VOTE);
    assert.match(h.kernel.groupPosts(conv)[0]?.text ?? '', /I cannot write to anyone privately here/);
  } finally {
    h.kernel.absent.delete('targetedSend');
  }
});
