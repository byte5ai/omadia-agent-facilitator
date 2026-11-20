// D20: the configuration of 0.7.x was carried into 1.0.x key by key, with a
// privacy bypass nobody had decided on for the engine.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONFIG_KEYS, FACILITATOR_SETTING_KEYS, OBSOLETE_CONFIG_KEYS, parseConfig } from '../src/config.js';
import { onMigrate, privacyNote } from '../src/plugin.js';

const manifest = readFileSync(join(process.cwd(), 'manifest.yaml'), 'utf8');
const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

const OLD = {
  facilitator_agent_slug: 'facilitator',
  initiator_role_key: 'initiator',
  reporting_mode: 'private',
  moderation_style: 'neutral',
  auto_setup: true,
  disclose_report_target: true,
};

test('an upgrade drops the keys of 0.7.x and keeps what 1.0.x reads and what the operator set for the kernel', async () => {
  const logs: string[] = [];
  const previousConfig = { ...OLD, language: 'de', reminder_offsets_hours: '0.1', _privacy_mode: 'bypass', something_else: 1 };
  const { newConfig } = await onMigrate({ fromVersion: '0.7.3', toVersion: '1.0.4', previousConfig, log: (m: string) => logs.push(m) } as never);
  assert.deepEqual(newConfig, { language: 'de', reminder_offsets_hours: '0.1', _privacy_mode: 'bypass', something_else: 1 });
  assert.deepEqual(previousConfig.facilitator_agent_slug, 'facilitator', 'the snapshot is not changed');
  const said = logs.join('\n');
  for (const key of Object.keys(OLD)) assert.ok(said.includes(key), `${key} is named as dropped`);
  assert.match(said, /something_else/, 'a key the engine does not know is said, not dropped');
  assert.match(said, /_privacy_mode.*bypass/s, 'a bypass that is carried over is said');
  assert.deepEqual((await onMigrate({ fromVersion: '1.0.4', toVersion: '1.0.5', previousConfig: newConfig, log: () => undefined } as never)).newConfig, newConfig, 'idempotent');
});

test('the privacy mode in force is stated at activation, and a mode that hides tool answers is a warning', () => {
  assert.match(privacyNote('bypass'), /^privacy: mode 'bypass'/);
  assert.match(privacyNote(undefined), /^privacy: WARNING.*guarded/s);
  assert.match(privacyNote('guarded'), /cannot read what its tools answer/);
  assert.match(privacyNote('per_tool'), /^privacy: WARNING/);
});

test('the manifest declares the bypass it needs, with the reason', () => {
  const block = /\nprivacy:\n {2}recommendation:\n {4}mode: "bypass"\n {4}reason: "([^"\n]{80,})"/.exec(manifest);
  assert.ok(block, 'privacy.recommendation with mode bypass and a reason');
  assert.match(block[1] ?? '', /tool/i);
});

test('every setting the engine reads is a field of the manifest and documented, and nothing else is', () => {
  // The setup block only: the archetype's per-facilitator settings use the
  // same shape and are checked below.
  const setup = manifest.slice(manifest.indexOf('\nsetup:\n'));
  const fields = [...setup.matchAll(/^ {4}- key: "([a-z_]+)"/gm)].map((m) => m[1] ?? '');
  assert.deepEqual([...fields].sort(), [...CONFIG_KEYS].sort());
  for (const key of CONFIG_KEYS) assert.ok(readme.includes(`\`${key}\``), `README documents ${key}`);
  for (const key of OBSOLETE_CONFIG_KEYS) assert.ok(!fields.includes(key));
  // Every documented key is really read.
  const asked: string[] = [];
  parseConfig((key) => {
    asked.push(key);
    return undefined;
  });
  assert.deepEqual([...new Set(asked)].sort(), [...CONFIG_KEYS].sort());
});

test('every per-facilitator setting the engine reads is documented', () => {
  for (const key of FACILITATOR_SETTING_KEYS) assert.ok(readme.includes(`\`${key}\``), `README documents ${key}`);
});
