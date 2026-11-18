import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_DEFAULTS, parseConfig, parseNumberList } from '../src/config.js';

const reader = (values: Record<string, unknown>) => <T,>(key: string): T | undefined => values[key] as T | undefined;

test('defaults apply when nothing is configured', () => {
  assert.deepEqual(parseConfig(reader({})), CONFIG_DEFAULTS);
});

test('owner defaults: retention 90 days, reminders 24 h and 2 h before the deadline', () => {
  const config = parseConfig(reader({}));
  assert.equal(config.retentionDays, 90);
  assert.deepEqual(config.reminderOffsetsHours, [24, 2]);
  assert.equal(config.changeWindowHours, 12);
});

test('reminder offsets are sorted furthest first', () => {
  assert.deepEqual(parseConfig(reader({ reminder_offsets_hours: '2, 48,24' })).reminderOffsetsHours, [48, 24, 2]);
});

test('invalid values fall back to the default and are logged', () => {
  const logs: string[] = [];
  const config = parseConfig(
    reader({ language: 'fr', timezone: 'Mars/Olympus', retention_days: -3, ranked_points: '3,x', change_window_hours: 'soon' }),
    (m) => logs.push(m),
  );
  assert.equal(config.language, 'de');
  assert.equal(config.timezone, 'Europe/Berlin');
  assert.equal(config.retentionDays, 90);
  assert.deepEqual(config.rankedPoints, [3, 2, 1]);
  assert.equal(config.changeWindowHours, 12);
  assert.equal(logs.length, 5);
});

test('numbers stored as strings are accepted', () => {
  const config = parseConfig(reader({ retention_days: '30', max_active_per_facilitator: '4', protocol_mail_enabled: 'true' }));
  assert.equal(config.retentionDays, 30);
  assert.equal(config.maxActivePerFacilitator, 4);
  assert.equal(config.protocolMailEnabled, true);
});

test('parseNumberList refuses empty and non-positive entries', () => {
  assert.equal(parseNumberList(''), undefined);
  assert.equal(parseNumberList('3,0'), undefined);
  assert.deepEqual(parseNumberList(' 5 , 3,1 '), [5, 3, 1]);
});
