import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';

import { KERNEL_SERVICE_NAMES } from '../src/kernel.js';
import { ENGINE_VERSION } from '../src/plugin.js';

const root = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; files: string[] };

test('version is the same in package.json, manifest.yaml and the engine', () => {
  const manifestVersion = /^\s{2}version:\s*"([^"]+)"/m.exec(manifest)?.[1];
  assert.equal(manifestVersion, pkg.version);
  assert.equal(ENGINE_VERSION, pkg.version);
});

test('the manifest is of kind archetype and keeps the engine capability for kernels that find it by that', () => {
  assert.match(manifest, new RegExp(`provides:\\n\\s+- "${FACILITATION_ENGINE_CAPABILITY}"`));
  assert.match(manifest, /^\s{2}kind: "archetype"$/m);
  assert.match(manifest, /^\s{2}core: ">=1\.69\.0 <2\.0"$/m);
});

/** The entries of one list of the `archetype:` block. */
function archetypeList(field: string): string[] {
  const block = new RegExp(`^  ${field}:\\n((?:    - "[^"]+"\\n)+)`, 'm').exec(manifest)?.[1] ?? '';
  return [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1] ?? '');
}

test('the archetype block states the facilitator descriptor the kernel enforces', () => {
  assert.match(manifest, /^archetype:\n  id: "facilitator"$/m);
  const omits = ['plugin_grant', 'tool_grant', 'memory', 'default_agent', 'channel_binding', 'fast_path', 'agent_to_agent', 'consultation', 'sub_agent', 'assistance'];
  assert.deepEqual(archetypeList('omits'), omits);
  assert.deepEqual(archetypeList('adds'), ['conversation_messages', 'agent_turn', 'own_identity_send', 'session_capabilities']);
  assert.deepEqual(archetypeList('requires'), ['own_channel_identity']);
  const reasons = /^  omission_reasons:\n((?:    [a-z_]+: "[^"]+"\n)+)/m.exec(manifest)?.[1] ?? '';
  assert.deepEqual([...reasons.matchAll(/^    ([a-z_]+):/gm)].map((m) => m[1]), omits, 'one reason per omission, and none for anything else');
  for (const field of ['label', 'label_plural', 'description']) {
    assert.match(manifest, new RegExp(`^  ${field}:\\n    en: "[^"]+"\\n    de: "[^"]+"$`, 'm'), `${field} in en and de`);
  }
  assert.match(manifest, /^  noun: "a facilitator"$/m);
  assert.match(manifest, /^  role_contract: \|\n    ## Neutrality contract \(fixed, takes precedence\)$/m);
});

test('working modes are not omitted: a moderation mode is allowed, the kernel refuses identity replacement (spec 2043 §2.3)', () => {
  assert.ok(!archetypeList('omits').includes('persona_skill'));
  assert.ok(!/^    persona_skill:/m.test(manifest));
});

test('the German manifest texts use the product terms', () => {
  const german = manifest.split('\n').filter((line) => /^\s+de: /.test(line)).join('\n');
  for (const retired of ['Facilitation', 'Channel-Identität']) assert.ok(!german.includes(retired), `${retired} in a German text`);
  assert.match(manifest, /Kanalidentität/);
});

test('every kernel service the engine resolves is declared as optional, and the shared pool is not asked for', () => {
  const block = /optional_requires:\n((?:\s+- "[^"]+"\n)+)/.exec(manifest)?.[1] ?? '';
  // A lookup of the first major names the service alone; a later major is
  // named with it (`conversationSend@2`), and the kernel answers only for a
  // major the manifest declares.
  const declared = [...block.matchAll(/- "([^"@]+)@\^?(\d+)"/g)].map((m) => (m[2] === '1' ? m[1] : `${String(m[1])}@${String(m[2])}`));
  assert.deepEqual([...declared].sort(), [...KERNEL_SERVICE_NAMES].sort());
  // No `graphPool` anywhere among the requirements: this is what tells the
  // kernel that the plugin works in its own schema.
  assert.match(manifest, /^requires: \[\]$/m);
  assert.ok(!/^\s*- "graphPool/m.test(manifest));
});

test('no statement and no migration names a schema', () => {
  const sources = [...readdirSync(join(root, 'migrations')).map((f) => join(root, 'migrations', f)), ...walk(join(root, 'src'))];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/\bpublic\./.test(text), `${file} names the schema public`);
    assert.ok(!/SET search_path|CREATE EXTENSION|pg_advisory_lock|\bLISTEN [a-z_"]/.test(text.replace(/^\s*(--|\/\/|\*).*$/gm, '')), `${file} relies on a session or on something outside its schema`);
  }
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

test('the set-up guide and the README say which model a facilitator needs', () => {
  assert.match(manifest, /Sonnet-class model/);
  assert.match(manifest, /Modell der Sonnet-Klasse/);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /needs a Sonnet-class model/);
});
