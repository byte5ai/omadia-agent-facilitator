import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { effectiveTtlHours, parseDeadline, wasClamped } from '../src/deadline.js';

const NOW = new Date('2026-10-15T11:30:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

describe('parseDeadline', () => {
  it('accepts ISO date-times with Z or an explicit offset', () => {
    const z = parseDeadline('2026-10-16T10:00:00Z', NOW);
    assert.deepEqual(z.ok && [z.value, z.date.toISOString()], ['2026-10-16T10:00:00Z', '2026-10-16T10:00:00.000Z']);
    const offset = parseDeadline('2026-10-16T12:00+02:00', NOW);
    assert.deepEqual(offset.ok && [offset.value, offset.date.toISOString()], ['2026-10-16T12:00+02:00', '2026-10-16T10:00:00.000Z']);
  });

  it('refuses ambiguous local times, garbage and past deadlines', () => {
    assert.deepEqual(parseDeadline('2026-10-16T12:00:00', NOW), { ok: false, reason: 'format' });
    assert.deepEqual(parseDeadline('Freitag 15 Uhr', NOW), { ok: false, reason: 'format' });
    assert.deepEqual(parseDeadline('2026-13-45T99:00:00Z', NOW), { ok: false, reason: 'format' });
    assert.deepEqual(parseDeadline('2026-10-15T11:00:00Z', NOW), { ok: false, reason: 'past' });
  });
});

describe('effectiveTtlHours / wasClamped', () => {
  it('outlives the deadline by the grace period, never shortens a longer TTL', () => {
    // Incident: ttlHours=18 while the vote deadline was 22.5h out.
    const deadline = new Date('2026-10-16T10:00:00.000Z');
    assert.equal(effectiveTtlHours({ ttlHours: 18, deadline, now: NOW }), 24.5);
    assert.equal(effectiveTtlHours({ ttlHours: 48, deadline, now: NOW }), 48);
    assert.equal(effectiveTtlHours({ ttlHours: 18, now: NOW }), 18);
  });

  it('flags a kernel clamp beyond the tolerance only', () => {
    const requested = 24 * HOUR_MS;
    assert.equal(wasClamped(requested, new Date(NOW.getTime() + requested - 1000).toISOString(), NOW), false);
    assert.equal(wasClamped(requested, new Date(NOW.getTime() + 10 * HOUR_MS).toISOString(), NOW), true);
    assert.equal(wasClamped(requested, 'not a date', NOW), false);
  });
});
