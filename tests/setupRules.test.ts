// Rules a setup has to satisfy before anything is created.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { FOUR, createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const SETUP = { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', method: 'single', options: ['Harbour', 'Garden'] };

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

// ── S7: a close rule that contradicts the definition of done ────────────────

test('S7: "open until the deadline" together with "done when everybody has voted" is refused, with the way out', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('tr-rule', FOUR);
  const deadline = new Date(h.clock.now().getTime() + 5 * 3600_000).toISOString();
  for (const definitionOfDone of ['Abgeschlossen, wenn alle abgestimmt haben oder die Deadline erreicht ist', 'Done when everybody has voted or the deadline is reached']) {
    const answer = await h.tool('facilitation_start', { ...SETUP, definitionOfDone, deadline, closeRule: 'at_deadline' }, { conversation: conv });
    assert.match(answer, /^Refused \(close_rule_contradiction\)/);
    assert.match(answer, /all_contributed/);
  }
  assert.equal((await h.db.pool.query('SELECT 1 FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1', [conv])).rows.length, 0, 'nothing was created');
  // Each of the two alone is fine.
  assert.match(await h.tool('facilitation_start', { ...SETUP, definitionOfDone: 'Done when everybody has voted or the deadline is reached', deadline }, { conversation: conv }), /^Facilitation created/);
  const other = h.kernel.conversation('tr-rule-deadline', FOUR);
  assert.match(await h.tool('facilitation_start', { ...SETUP, deadline, closeRule: 'at_deadline' }, { conversation: other }), /^Facilitation created/);
});
