// Postgres for tests: one schema per test database, migrations applied the way
// the kernel's runner does (sorted files, one transaction, a ledger).
//
// Without FACILITATOR_TEST_DATABASE_URL there is no database and `PG_SKIP`
// carries the reason; tests pass it as `{ skip: PG_SKIP }` so they are
// reported as skipped, never as passed.

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

import type { PoolLike } from '../src/db/pool.js';

const url = process.env['FACILITATOR_TEST_DATABASE_URL'];

export const PG_SKIP: string | false = url ? false : 'needs Postgres (FACILITATOR_TEST_DATABASE_URL)';

export const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
export const LEDGER = 'plg_omadia_agent_facilitator_migrations';

export interface TestDb {
  pool: PoolLike;
  schema: string;
  /** What `ctx.sql.runMigrations()` does; returns the files it applied. */
  runMigrations(): Promise<{ applied: string[]; skipped: string[]; ledger: string; durationMs: number }>;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  if (!url) throw new Error('openTestDb() called without a database; guard the test with { skip: PG_SKIP }');
  const schema = `fac_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 12, options: `-c search_path=${schema}` });

  const runMigrations = async () => {
    const started = Date.now();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const client = await pool.connect();
    const applied: string[] = [];
    const skipped: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${LEDGER} (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const done = new Set((await client.query(`SELECT filename FROM ${LEDGER}`)).rows.map((r) => String(r.filename)));
      for (const file of files) {
        if (done.has(file)) {
          skipped.push(file);
          continue;
        }
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query(`INSERT INTO ${LEDGER} (filename) VALUES ($1)`, [file]);
        applied.push(file);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { applied, skipped, ledger: LEDGER, durationMs: Date.now() - started };
  };

  await runMigrations();
  return {
    pool: pool as unknown as PoolLike,
    schema,
    runMigrations,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
