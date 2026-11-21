#!/usr/bin/env node
/**
 * check-acceptance-matrix.mjs — keep docs/acceptance-matrix.md honest (#2068).
 *
 * The matrix maps every acceptance criterion of spec B §9 (1 to 64) to the
 * automated tests that prove it. This check fails when
 *   - a criterion has no row, or more than one;
 *   - a row names no test of this repository;
 *   - a referenced test file does not exist, or does not contain the quoted
 *     title fragment (a renamed or deleted test breaks the matrix);
 *   - a test whose title starts with a criterion number ("21. ...") is not
 *     referenced in that criterion's row (a new acceptance test is mapped).
 *
 * Reference syntax inside a row: `file.test.ts` › "title fragment". Several
 * fragments may follow one file: `file.test.ts` › "one"; "two". References to
 * other repositories (`omadia:...`, `teams:...`) are documentation and not
 * checked here; their repositories run them in their own CI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = join(root, 'docs', 'acceptance-matrix.md');
const TESTS = join(root, 'tests');
const CRITERIA = 64;

const problems = [];
const text = readFileSync(MATRIX, 'utf8');

/** criterion number -> the text of its row */
const rows = new Map();
for (const line of text.split('\n')) {
  const m = /^\|\s*(\d+)\s*\|/.exec(line);
  if (!m) continue;
  const n = Number(m[1]);
  if (rows.has(n)) problems.push(`criterion ${n}: more than one row`);
  rows.set(n, line);
}
for (let n = 1; n <= CRITERIA; n++) if (!rows.has(n)) problems.push(`criterion ${n}: no row`);
for (const n of rows.keys()) if (n < 1 || n > CRITERIA) problems.push(`criterion ${n}: not a criterion of spec B §9`);

const sources = new Map();
const source = (file) => {
  if (!sources.has(file)) {
    const path = join(TESTS, file);
    sources.set(file, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  }
  return sources.get(file);
};

/** The titles of a test file's tests (first argument of `test(`), unescaped. */
const TITLE = /\btest\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g;
const titles = (body) => [...body.matchAll(TITLE)].map((m) => m[2].replace(/\\(.)/g, '$1'));

/** criterion number -> files its row references */
const referenced = new Map();
const REF = /`([A-Za-z0-9_.-]+\.test\.ts)`\s*›\s*((?:"[^"]+"\s*;?\s*)+)/g;
for (const [n, row] of rows) {
  const files = new Set();
  for (const m of row.matchAll(REF)) {
    const file = m[1];
    files.add(file);
    const body = source(file);
    if (body === undefined) {
      problems.push(`criterion ${n}: tests/${file} does not exist`);
      continue;
    }
    for (const f of m[2].matchAll(/"([^"]+)"/g)) {
      if (!titles(body).some((t) => t.includes(f[1]))) problems.push(`criterion ${n}: tests/${file} has no test "${f[1]}"`);
    }
  }
  if (files.size === 0) problems.push(`criterion ${n}: the row names no test of this repository`);
  referenced.set(n, files);
}

// Every test named by a criterion number is mapped in that criterion's row.
const NUMBERED = /\btest\(\s*['`](\d+)[a-z]?[.:]\s/g;
for (const file of readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'))) {
  for (const m of source(file).matchAll(NUMBERED)) {
    const n = Number(m[1]);
    if (n < 1 || n > CRITERIA) continue;
    if (!referenced.get(n)?.has(file)) problems.push(`criterion ${n}: tests/${file} has a test named "${n}. ..." that the row does not reference`);
  }
}

if (problems.length > 0) {
  console.error(`acceptance matrix: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`acceptance matrix: criteria 1-${CRITERIA} each mapped to tests that exist`);
