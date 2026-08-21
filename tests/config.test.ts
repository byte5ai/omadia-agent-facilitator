import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { CONFIG_DEFAULTS, parseConfig } from '../src/config.js';

function accessor(values: Record<string, unknown>): <T>(key: string) => T | undefined {
  return <T>(key: string) => values[key] as T | undefined;
}

describe('parseConfig', () => {
  it('returns the declared defaults on an empty config', () => {
    assert.deepEqual(parseConfig(accessor({})), CONFIG_DEFAULTS);
  });

  it('accepts valid overrides (including numeric strings from setup fields)', () => {
    const config = parseConfig(
      accessor({
        facilitator_agent_slug: ' moderator ',
        initiator_role_key: 'management',
        default_ttl_hours: '48',
        reporting_mode: 'interim',
        language: 'en',
        disclose_report_target: false,
      }),
    );
    assert.equal(config.facilitatorAgentSlug, 'moderator');
    assert.equal(config.initiatorRoleKey, 'management');
    assert.equal(config.defaultTtlHours, 48);
    assert.equal(config.reportingMode, 'interim');
    assert.equal(config.language, 'en');
    assert.equal(config.discloseReportTarget, false);
  });

  it('falls back loudly on invalid values instead of failing activation', () => {
    const logs: string[] = [];
    const config = parseConfig(
      accessor({ default_ttl_hours: -5, reporting_mode: 'loud', language: 'fr' }),
      (msg) => logs.push(msg),
    );
    assert.equal(config.defaultTtlHours, CONFIG_DEFAULTS.defaultTtlHours);
    assert.equal(config.reportingMode, 'result-only');
    assert.equal(config.language, 'de');
    assert.ok(logs.some((l) => l.includes('default_ttl_hours')));
    assert.ok(logs.some((l) => l.includes('reporting_mode')));
  });
});
