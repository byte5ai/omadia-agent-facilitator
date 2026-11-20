// Quotas per facilitator and per instance (spec B §5.10, #2065): separate
// per-facilitator quotas, limits configurable per facilitator, and the shared
// instance limit, each reached with a `system` notice.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfig, parseFacilitatorLimits } from '../src/config.js';
import { ANNA, BERT, createHarness } from './harness.js';
import { PG_SKIP } from './pg.js';

test('facilitator_limits reads per agent slug; a bad value falls back to none', () => {
  assert.deepEqual(parseFacilitatorLimits('mira: active=1, starts=10; rita: messages=200'), { mira: { active: 1, startsPerHour: 10 }, rita: { messages: 200 } });
  assert.equal(parseFacilitatorLimits('mira: active=0'), undefined);
  assert.equal(parseFacilitatorLimits('mira active=1'), undefined);
  const logged: string[] = [];
  assert.deepEqual(parseConfig((k) => (k === 'facilitator_limits' ? 'mira: speed=3' : undefined) as never, (m) => logged.push(m)).facilitatorLimits, {});
  assert.equal(logged.length, 1);
});

test('two facilitators do not share a quota; one has its own limit; the instance limit holds for all together', { skip: PG_SKIP }, async () => {
  const h = await createHarness({ config: { maxActivePerFacilitator: 2, maxActiveInstance: 3, startsPerHourPerFacilitator: 100, facilitatorLimits: { mira: { active: 1 } } } });
  try {
    const start = (agent: string, n: number): Promise<string> =>
      h.tool('facilitation_start', { goal: `g${String(n)}`, definitionOfDone: 'd' }, { agent, conversation: h.kernel.conversation(`qt-${agent}-${String(n)}`, [ANNA, BERT]) });
    // Mira's own limit is one.
    assert.match(await start('mira', 1), /^Facilitation created/);
    assert.match(await start('mira', 2), /^Refused \(quota_active\): System notice: this facilitator already runs 1 facilitations/);
    // Rita has the default limit of two, untouched by Mira.
    assert.match(await start('rita', 1), /^Facilitation created/);
    assert.match(await start('rita', 2), /^Facilitation created/);
    // Three run on the instance: a third facilitator is refused by the instance limit.
    assert.match(await start('jonas', 1), /^Refused \(quota_instance\): System notice:/);
  } finally {
    await h.close();
  }
});
