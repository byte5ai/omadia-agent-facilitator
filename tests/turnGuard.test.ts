// What a facilitator turn may say in the group is checked against the state,
// whatever the model was told (second integration run, S3, S5, S6).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { checkTurnText } from '../src/engine/turnGuard.js';
import type { TurnState } from '../src/engine/turnGuard.js';
import { FOUR, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const VOTE = { method: 'single', options: ['Harbour', 'Garden'] };
const STATE: TurnState = { missing: ['Anna Arndt', 'Dirk Dorn'], voteOpen: true, live: true };

test('S3: a text that names who has not contributed is refused, in German and English', () => {
  for (const text of [
    'Aktuell haben noch nicht alle beigetragen: Anna Arndt und du selbst (Dirk Dorn). Das sind 50 % der Gruppe.',
    'Es fehlen noch Anna und Dirk.',
    'We are still waiting for Anna Arndt.',
    "Dirk hasn't voted yet.",
    'Not yet: anna, dirk',
  ]) {
    assert.deepEqual(checkTurnText(text, STATE), { ok: false, reason: 'names_missing' }, text);
  }
});

test('S3: naming somebody for another reason, or somebody who has contributed, passes', () => {
  for (const text of [
    'Danke, Dirk. Ich nehme das als Frage zum Ablauf auf.',
    'Bert hat noch nicht gesagt, welche Farbe er meint.', // Bert has contributed
    'Noch nicht alle haben beigetragen. Ich nenne hier niemanden.',
    'Anna, good point about the harbour.',
  ]) {
    assert.deepEqual(checkTurnText(text, STATE), { ok: true }, text);
  }
});

test('S6: a text that says the vote or the facilitation is closed while it is open is refused', () => {
  for (const text of [
    'Ihr habt alle vier bereits abgestimmt. Die Abstimmung ist damit geschlossen. Warum möchtest du die Deadline noch vorziehen?',
    'The vote is closed.',
    'Die Moderation ist beendet.',
    'Voting has ended, thank you all.',
  ]) {
    assert.deepEqual(checkTurnText(text, { ...STATE, missing: [] }), { ok: false, reason: 'claims_closed' }, text);
  }
  for (const text of [
    'Die Abstimmung ist noch nicht geschlossen; sie läuft bis zur Deadline.',
    'Die Abstimmung wird geschlossen, sobald alle abgestimmt haben.',
    'The vote is open until Friday.',
    'Once everybody has voted, the vote is closed.',
  ]) {
    assert.deepEqual(checkTurnText(text, { ...STATE, missing: [] }), { ok: true }, text);
  }
  // Nothing is open: saying so is true.
  assert.deepEqual(checkTurnText('The vote is closed.', { missing: [], voteOpen: false, live: false }), { ok: true });
});

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

async function turn(conv: string, who: string, text: string, answer: Harness['kernel']['onTurn']): Promise<string[]> {
  const before = h.kernel.groupPosts(conv).length;
  h.kernel.onTurn = answer;
  try {
    await h.kernel.say(conv, who, text);
    await h.settle();
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
  return h.kernel.groupPosts(conv).slice(before).map((p) => p.text);
}

test('S3: the group never reads from the facilitator who has not contributed; a neutral line goes out instead', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tg-names', FOUR);
  const f = await startActive(h, conv, VOTE);
  await h.kernel.say(conv, 'bert', 'A');
  await h.kernel.say(conv, 'cara', 'B');
  await h.settle();
  const posted = await turn(conv, 'dave', 'Can we close this now, who is missing?', () => 'Not everybody has voted yet: Anna and you yourself (Dave) are missing. That is 50 % of the group.');
  assert.deepEqual(posted, ['Not everybody has contributed yet. I do not name anybody here; reminders go to the people concerned.']);
  const refused = await h.db.pool.query<{ payload: { reason: string } }>(`SELECT payload FROM plg_omadia_agent_facilitator_events WHERE facilitation_id = $1 AND kind = 'text_refused'`, [f.id]);
  assert.deepEqual(refused.rows.map((r) => r.payload.reason), ['names_missing']);
});

test('S6: a claim that the vote is closed is replaced by what is true', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tg-closed', FOUR);
  await startActive(h, conv, { ...VOTE, deadline: new Date(h.clock.now().getTime() + 5 * 3600_000).toISOString(), closeRule: 'at_deadline' });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await h.kernel.say(conv, who, 'A');
  await h.settle();
  assert.equal((await h.facilitation(conv)).phase, 'active', 'open until the deadline');
  const posted = await turn(conv, 'dave', 'I propose to move the deadline to today', () => 'All four of you have voted. The vote is closed. Why do you want to move the deadline?');
  assert.equal(posted.length, 1);
  assert.match(posted[0] ?? '', /^"Pick a venue" is still open until /);
});

test('S5: a turn whose tool refused does not end in silence: the group reads why', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tg-refused', FOUR);
  await startActive(h, conv, { ...VOTE, deadline: new Date(h.clock.now().getTime() + 5 * 3600_000).toISOString(), closeRule: 'at_deadline' });
  for (const who of ['anna', 'bert', 'cara', 'dave']) await h.kernel.say(conv, who, 'A');
  await h.settle();
  const { buildTools } = await import('../src/tools/index.js');
  const posted = await turn(conv, 'dave', 'All four have voted, please close the vote now', async (request) => {
    const step = buildTools(h.engine).find((t) => t.spec.name === 'facilitation_step');
    const answer = await step?.handler({ action: 'close' }, h.kernel.context('mira', conv, 'dave', request.inboundEventId));
    assert.match(answer ?? '', /^Refused \(deciding_step\)/);
    return '[silent]';
  });
  assert.deepEqual(posted, ['This step is decided by its vote. It closes when the result is in: once everybody has contributed, or at the deadline if that is what was agreed.']);
});

test('S5: a refusal the model already explained is not said twice, and a turn without a refusal stays silent', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tg-refused-said', FOUR);
  await startActive(h, conv, VOTE);
  const { buildTools } = await import('../src/tools/index.js');
  const said = await turn(conv, 'dave', 'Please close the vote now', async (request) => {
    const step = buildTools(h.engine).find((t) => t.spec.name === 'facilitation_step');
    await step?.handler({ action: 'close' }, h.kernel.context('mira', conv, 'dave', request.inboundEventId));
    return 'The vote closes by itself once everybody has voted.';
  });
  assert.deepEqual(said, ['The vote closes by itself once everybody has voted.']);
  assert.deepEqual(await turn(conv, 'dave', 'Thanks!', () => '[silent]'), []);
});

test('the description of facilitation_propose_change says that a proposal is passed on, not questioned', async () => {
  const { buildTools } = await import('../src/tools/index.js');
  const description = buildTools({} as never).find((t) => t.spec.name === 'facilitation_propose_change')?.spec.description ?? '';
  assert.match(description, /pass it on/);
  assert.match(description, /do not question/i);
});
