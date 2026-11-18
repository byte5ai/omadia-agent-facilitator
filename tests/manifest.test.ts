import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';

import { KERNEL_SERVICE_NAMES } from '../src/kernel.js';
import { ENGINE_VERSION } from '../src/plugin.js';

const root = process.cwd();
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; files: string[] };

test('version is the same in package.json, manifest.yaml and the engine', () => {
  const manifestVersion = /^\s{2}version:\s*"([^"]+)"/m.exec(manifest)?.[1];
  assert.equal(manifestVersion, pkg.version);
  assert.equal(ENGINE_VERSION, pkg.version);
});

test('the manifest declares the engine capability and an extension kind', () => {
  assert.match(manifest, new RegExp(`provides:\\n\\s+- "${FACILITATION_ENGINE_CAPABILITY}"`));
  assert.match(manifest, /^\s{2}kind: "extension"$/m);
});

test('every kernel service the engine resolves is declared: the pool as required, the others as optional', () => {
  const block = /optional_requires:\n((?:\s+- "[^"]+"\n)+)/.exec(manifest)?.[1] ?? '';
  const declared = [...block.matchAll(/- "([^"@]+)@/g)].map((m) => m[1]);
  assert.deepEqual([...declared, 'graphPool'].sort(), [...KERNEL_SERVICE_NAMES].sort());
  assert.match(manifest, /^requires:\n\s+- "graphPool@\^1"$/m);
});

test('permissions.sql names a ledger inside the plugin namespace and the shipped migrations directory', () => {
  assert.match(manifest, /ledger: "plg_omadia_agent_facilitator_migrations"/);
  assert.match(manifest, /migrations: "migrations"/);
  assert.ok(existsSync(join(root, 'migrations')));
  assert.ok(pkg.files.includes('migrations'));
});

test('nothing of the Conductor path is left in the manifest', () => {
  for (const gone of ['conductorEphemeralRuns', 'agentProvisioning', 'conversationBindings', 'conductorRoleAssignments']) {
    assert.ok(!manifest.includes(gone), `${gone} is still declared`);
  }
});
