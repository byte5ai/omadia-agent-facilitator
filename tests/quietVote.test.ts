// D19 (live runs): in a vote the facilitator answered small talk with model
// text, up to an unprompted "correction" nobody understood. In a step that is
// decided by choosing between announced options, a message gets a model turn
// only when it is meant for the facilitator.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { ANNA, BERT, CARA, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

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
const outcomes = async (conv: string): Promise<string[]> =>
  (await h.db.pool.query<{ outcome: string }>('SELECT outcome FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 ORDER BY seq', [(await h.facilitation(conv)).id])).rows.map((r) => r.outcome);

test('in a vote, small talk gets no model turn; ballots and commands are handled as before', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qv-vote', [ANNA, BERT, CARA]);
  await h.tool('facilitation_start', { goal: 'Pick the name', method: 'ranked', options: ['Alpha', 'Bravo', 'Charlie'], open: true }, { conversation: conv });
  const turns = (): number => h.kernel.turns.length;
  const posts = (): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
  h.kernel.onTurn = () => 'Model text nobody asked for.';
  try {
    const before = turns();
    await say(conv, 'anna', 'Ich überlege noch.');
    await say(conv, 'bert', 'Testnachricht im Thread, die ich gleich wieder lösche.');
    await say(conv, 'cara', 'Schönes Wetter heute');
    assert.equal(turns(), before, 'no model turn');
    assert.ok(!posts().includes('Model text nobody asked for.'));
    assert.deepEqual((await outcomes(conv)).slice(-3), ['not_addressed', 'not_addressed', 'not_addressed']);

    // A ballot and a command, without a model.
    await say(conv, 'anna', 'A > C > B');
    assert.match(posts().at(-1) ?? '', /^Recorded for you, Anna/);
    await say(conv, 'bert', 'status');
    assert.match(posts().at(-1) ?? '', /^Status: running/);
    assert.equal(turns(), before);

    // Meant for the facilitator: a question, the facilitator's name, the process.
    await say(conv, 'bert', 'Wie viele Punkte bekommt der erste Platz?');
    await say(conv, 'bert', 'Mira, ich bin unsicher');
    await say(conv, 'cara', 'Können wir die Abstimmung verlängern');
    assert.equal(turns(), before + 3);

    // Looks like a vote the engine could not read: the model may ask.
    await say(conv, 'cara', 'ich nehme Bravo und dann den Rest');
    assert.equal(turns(), before + 4);
  } finally {
    h.kernel.onTurn = () => '[silent]';
  }
});

test('outside a vote between options every message still reaches the facilitator', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('qv-discuss', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'Talk it through', open: true }, { conversation: conv });
  const before = h.kernel.turns.length;
  await say(conv, 'anna', 'Ich überlege noch.');
  assert.equal(h.kernel.turns.length, before + 1);

  // Consent and assignment are answered in free words.
  const consent = h.kernel.conversation('qv-consent', [ANNA, BERT]);
  await h.tool('facilitation_start', { goal: 'We go with plan B', method: 'consent', statement: 'Plan B', open: true }, { conversation: consent });
  const mid = h.kernel.turns.length;
  await say(consent, 'anna', 'Ich habe da noch Bauchschmerzen wegen der Kosten');
  assert.equal(h.kernel.turns.length, mid + 1);
  assert.ok(await store.openStepOf(h.db.pool, (await h.facilitation(consent)).id));
});
