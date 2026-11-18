// The operator's facilitations view: what can be checked without a browser.
// (Rendering is checked in Chrome with scripts/ui-preview.mjs.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(join(process.cwd(), 'ui', 'index.html'), 'utf8');
const script = readFileSync(join(process.cwd(), 'ui', 'app.js'), 'utf8');

type Labels = Record<string, unknown>;

function loadLabels(): { LABELS: { en: Labels; de: Labels }; COLUMNS: string[]; PHASES: string[] } {
  const window: Record<string, unknown> = { location: { search: '' } };
  const element = () => ({ textContent: '', appendChild: () => undefined, addEventListener: () => undefined, setAttribute: () => undefined, value: '', hidden: false, focus: () => undefined });
  const document = { readyState: 'loading', documentElement: { getAttribute: () => null, lang: 'en' }, addEventListener: () => undefined, getElementById: element, createElement: element };
  vm.runInNewContext(script, { window, document, navigator: { language: 'de-DE' }, URLSearchParams, Intl, fetch: () => Promise.reject(new Error('no network in this test')) });
  return window['__facilitationsUi'] as ReturnType<typeof loadLabels>;
}

const keysOf = (value: unknown, prefix = ''): string[] =>
  value !== null && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix === '' ? k : `${prefix}.${k}`))
    : [prefix];

test('every label exists in English and German', () => {
  const { LABELS } = loadLabels();
  assert.deepEqual(keysOf(LABELS.de).sort(), keysOf(LABELS.en).sort());
  for (const key of keysOf(LABELS.en)) {
    const read = (labels: Labels): unknown => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], labels);
    assert.equal(typeof read(LABELS.en), 'string', key);
    assert.notEqual(read(LABELS.de), '', key);
  }
});

test('every column and phase has a label', () => {
  const { LABELS, COLUMNS, PHASES } = loadLabels();
  for (const language of [LABELS.en, LABELS.de]) {
    for (const column of COLUMNS) assert.ok((language['columns'] as Labels)[column], column);
    for (const phase of PHASES) assert.ok((language['phases'] as Labels)[phase], phase);
  }
});

test('the page fits the host: no inline script, no stylesheet of its own, script from the bundle', () => {
  assert.equal([...html.matchAll(/<script\b([^>]*)>/g)].length, 1);
  assert.match(html, /<script src="\.\/app\.js"><\/script>/, "the host serves with script-src 'self'");
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\son[a-z]+="/, 'no inline event handlers');
  assert.match(html, /_harness\/plugin-ui\.css/);
  assert.doesNotMatch(script, /innerHTML|document\.write|eval\(/, 'values from the API are only ever set as text');
});
