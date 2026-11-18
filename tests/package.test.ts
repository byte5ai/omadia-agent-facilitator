// The artifact that is published, checked the way a kernel will check it.
//
// 1.0.0 declared `compat.core >=1.0`: the Hub offered it to kernels that
// cannot run it, where it would have replaced a working 0.7.3. And a sibling
// package was refused at install for one file the kernel's zip ingest does
// not accept. Both are properties of the built package, so this suite builds
// the REAL zip (`npm run build && npm run package`) and reads it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';

import { APP_PACKAGE_EXTENSIONS, BASENAME_ALLOWLIST, DECL_EXTENSIONS, EXTENSION_ALLOWLIST, UI_BUNDLE_EXTENSIONS, kernelIngestRefusal, kernelIngestRules, readZipEntries } from './support/kernelZipIngest.js';
import type { ZipEntry } from './support/kernelZipIngest.js';

const root = process.cwd();
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string; peerDependencies: Record<string, string> };
const zipPath = join(root, 'out', `${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}.zip`);
/** The lowest host contract the engine runs on (`isSubscribed` of 1.56 is feature-detected). */
const FLOOR = '1.55.0';
const FILE = 0o100644;

let entries: ZipEntry[] = [];
before(() => {
  for (const script of ['build', 'package']) {
    const run = spawnSync('npm', ['run', '-s', script], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `npm run ${script} failed:\n${run.stdout}\n${run.stderr}`);
  }
  entries = readZipEntries(zipPath);
});

// ── compatibility ───────────────────────────────────────────────────────────

test('compat.core has the real floor: the package is not offered to a kernel that cannot run it', () => {
  const core = /^compat:\n(?:\s+.*\n)*?\s+core:\s*"([^"]+)"/m.exec(manifest)?.[1];
  assert.equal(core, `>=${FLOOR} <2.0`);
});

test('the peer requirement states the same floor as compat.core', () => {
  assert.equal(pkg.peerDependencies['@omadia/plugin-api'], `>=${FLOOR}`);
});

test('the zip carries the manifest with that range and the version of package.json', () => {
  const unzip = spawnSync('unzip', ['-p', zipPath, 'manifest.yaml'], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);
  assert.match(unzip.stdout, new RegExp(`core: ">=${FLOOR.replace(/\./g, '\\.')} <2\\.0"`));
  assert.match(unzip.stdout, new RegExp(`^\\s{2}version: "${pkg.version.replace(/\./g, '\\.')}"`, 'm'));
});

// ── the kernel's zip ingest ─────────────────────────────────────────────────

test('the mirror refuses what the kernel refuses', () => {
  const refusal = (name: string, unixMode = FILE): string | undefined => kernelIngestRefusal({ name, unixMode });
  assert.equal(refusal('dist/plugin.js'), undefined);
  assert.equal(refusal('dist/plugin.d.ts'), undefined);
  assert.equal(refusal('migrations/0001_facilitation_engine.sql'), undefined);
  assert.equal(refusal('ui/index.html'), undefined);
  assert.equal(refusal('ui/font.woff2'), undefined);
  assert.equal(refusal('LICENSE'), undefined);
  assert.equal(refusal('dist/'), undefined);
  assert.equal(refusal('dist/font.woff2'), 'zip.forbidden_extension (.woff2)', 'fonts only below ui/');
  assert.equal(refusal('ui/app.css'), 'zip.forbidden_extension (.css)');
  assert.equal(refusal('TEMPLATE_REVISION'), 'zip.forbidden_extension (<none>)', 'a name without an extension');
  assert.equal(refusal('dist/.tsbuildinfo'), 'zip.forbidden_extension (<none>)');
  assert.equal(refusal('dist/link.js', 0o120777), 'zip.symlink');
  assert.equal(refusal('../outside.js'), 'zip.path_escape');
  assert.equal(refusal('/etc/passwd.txt'), 'zip.path_escape');
});

test('every entry of the real zip passes the kernel ingest rules', () => {
  assert.ok(entries.length > 0, 'the zip has entries');
  const refused = entries.map((entry) => ({ name: entry.name, reason: kernelIngestRefusal(entry) })).filter((e) => e.reason !== undefined);
  assert.deepEqual(refused, [], `the kernel would refuse this package:\n${refused.map((e) => `  ${e.name}: ${String(e.reason)}`).join('\n')}`);
});

test('the zip is flat and carries what the host needs: manifest, entry, migrations, view, playbook', () => {
  const names = new Set(entries.map((e) => e.name));
  for (const needed of ['manifest.yaml', 'package.json', 'dist/plugin.js', 'migrations/0001_facilitation_engine.sql', 'ui/index.html', 'ui/app.js', 'skills/facilitator-playbook.md', 'README.md', 'CHANGELOG.md']) {
    assert.ok(names.has(needed), `${needed} is missing from the zip`);
  }
  assert.ok(![...names].some((n) => n.startsWith('node_modules/') || n.startsWith('tests/') || n.startsWith('src/')), 'no sources, tests or dependencies');
});

test('nothing in the directories that are packaged could be refused later', () => {
  // The zip is built from these; a file added to one of them tomorrow is
  // caught here even before it is packaged under another name.
  const listed = spawnSync('git', ['ls-files', 'migrations', 'skills', 'ui', 'assets'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '');
  const refused = listed.filter((name) => kernelIngestRefusal({ name, unixMode: FILE }) !== undefined);
  assert.deepEqual(refused, []);
});

// ── the mirror against the kernel source ────────────────────────────────────

const KERNEL_EXTRACTOR = resolve(root, '..', 'odoo-bot', 'middleware', 'src', 'plugins', 'zipExtractor.ts');

test('the mirrored rules are the rules of the kernel checkout next to this repo', { skip: existsSync(KERNEL_EXTRACTOR) ? false : 'no kernel checkout at ../odoo-bot' }, () => {
  const rules = kernelIngestRules(KERNEL_EXTRACTOR);
  assert.ok(rules);
  const same = (mirror: readonly string[], kernel: readonly string[], what: string): void => assert.deepEqual([...mirror].sort(), [...kernel].sort(), what);
  same(EXTENSION_ALLOWLIST, rules.extensionAllowlist, 'EXTENSION_ALLOWLIST');
  same(DECL_EXTENSIONS, rules.declExtensions, 'DECL_EXTENSIONS');
  same(UI_BUNDLE_EXTENSIONS, rules.uiBundleExtensions, 'UI_BUNDLE_EXTENSIONS');
  same(APP_PACKAGE_EXTENSIONS, rules.appPackageExtensions, 'APP_PACKAGE_EXTENSIONS');
  same(BASENAME_ALLOWLIST, rules.basenames, 'basename allowlist');
});
