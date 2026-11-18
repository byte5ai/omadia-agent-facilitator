#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in test runner (`node:test`) + assert drive the tests; esbuild
 * (already a dev dependency) transpiles each `tests/*.test.ts` into
 * `.test-build/` first. `@omadia/plugin-api` and `pg` stay external and
 * resolve from node_modules.
 *
 * Postgres: most of the engine is SQL (advisory locks, leases, partial unique
 * indexes), so those tests need a real server.
 *   1. FACILITATOR_TEST_DATABASE_URL set  -> that database is used.
 *   2. otherwise, `initdb` + `pg_ctl` on the PATH -> a throwaway cluster is
 *      started in a temp directory and removed afterwards.
 *   3. neither -> the Postgres-backed tests are SKIPPED and this script says
 *      so in its last line. Skipped is not passed.
 * Each test file works in its own schema, so files run in parallel.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

const only = process.argv.slice(2);
const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  external: ['@omadia/plugin-api', 'pg'],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** Start a throwaway cluster; returns its URL and a stop function. */
async function startThrowawayPostgres() {
  const dataDir = mkdtempSync(join(tmpdir(), 'facilitator-pg-'));
  const port = await freePort();
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
  const init = run('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  const start = run('pg_ctl', [
    '-D', dataDir, '-w', '-l', join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200 -c fsync=off`,
    'start',
  ]);
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr || start.stdout}`);
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let databaseUrl = process.env.FACILITATOR_TEST_DATABASE_URL;
let throwaway;
if (!databaseUrl && has('initdb') && has('pg_ctl')) {
  try {
    throwaway = await startThrowawayPostgres();
    databaseUrl = throwaway.url;
    console.log('▶ started a throwaway Postgres cluster');
  } catch (err) {
    console.error(`▶ could not start a throwaway Postgres: ${err.message}`);
  }
}

console.log('▶ node --test');
let status = 1;
try {
  const res = spawnSync(process.execPath, ['--test', ...built], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: { ...process.env, ...(databaseUrl ? { FACILITATOR_TEST_DATABASE_URL: databaseUrl } : {}) },
  });
  status = res.status ?? 1;
} finally {
  throwaway?.stop();
}

console.log(
  databaseUrl
    ? '▶ Postgres-backed tests RAN against a real server'
    : '▶ Postgres-backed tests were SKIPPED: set FACILITATOR_TEST_DATABASE_URL or install Postgres (initdb, pg_ctl)',
);
process.exit(status);
