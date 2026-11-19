// Postgres for tests, set up the way the kernel sets up the database of an
// archetype plugin (kernel #2088):
//
//   - one SCHEMA per test database;
//   - a MIGRATION role that owns the schema and runs the migration files
//     (sorted, one transaction, a ledger), as the kernel's runner does;
//   - a RUNTIME role the engine works as: no attribute, member of no role,
//     `search_path` set on the role before its first login, and only SELECT,
//     INSERT, UPDATE and DELETE on the tables of its schema. It cannot create
//     or alter anything, cannot write the migration ledger and reaches no
//     table outside its schema;
//   - no pool for the engine: `db.pool` is the two things the kernel hands
//     out, one statement and one transaction.
//
// Without FACILITATOR_TEST_DATABASE_URL there is no database and `PG_SKIP`
// carries the reason; tests pass it as `{ skip: PG_SKIP }` so they are
// reported as skipped, never as passed. The URL must be a role that may
// create roles and schemas (the throwaway cluster's superuser).

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

import { dbOf } from '../src/db/pool.js';
import type { Db, KernelSql } from '../src/db/pool.js';

const url = process.env['FACILITATOR_TEST_DATABASE_URL'];

export const PG_SKIP: string | false = url ? false : 'needs Postgres (FACILITATOR_TEST_DATABASE_URL)';

export const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
export const LEDGER = 'plg_omadia_agent_facilitator_migrations';
/** The kernel's default for the runtime pool of an archetype plugin. */
export const KERNEL_RUNTIME_POOL_MAX = 4;

export interface MigrationRun {
  applied: string[];
  skipped: string[];
  ledger: string;
  durationMs: number;
}

export interface TestDb {
  /** The engine's database: one statement, or one transaction, as the runtime role. */
  pool: Db;
  /** What the kernel puts on `ctx.sql` for the plugin (without the migration runner). */
  sql: Required<KernelSql>;
  /** The runtime role's `pg` pool, for a test that has to play the pooler itself. */
  runtime: pg.Pool;
  /** The cluster's own user: for what the runtime role may not see or do. */
  admin: pg.Pool;
  schema: string;
  runtimeRole: string;
  migrationRole: string;
  /** Run SQL (several statements are fine) as the migration role, in the schema. */
  asMigrationRole(text: string): Promise<void>;
  /** What `ctx.sql.runMigrations()` does; returns the files it applied. */
  runMigrations(): Promise<MigrationRun>;
  close(): Promise<void>;
}

function as(role: string, password: string): string {
  const target = new URL(url ?? '');
  target.username = role;
  target.password = password;
  return target.toString();
}

/** `ctx.sql.query` / `ctx.sql.transaction` over a pool, as the kernel builds them. */
export function kernelSql(pool: pg.Pool, schema: string): Required<KernelSql> {
  const answer = <R>(res: { rows: R[]; rowCount: number | null }) => ({ rows: res.rows, rowCount: res.rowCount ?? 0 });
  return {
    schema,
    query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => answer(await pool.query<R>(text, params ? [...params] : undefined)),
    async transaction<T>(work: (tx: { query<R extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: readonly R[]; rowCount: number }> }) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let open = true;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path = "${schema}"`);
        const value = await work({
          query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
            if (!open) throw new Error('this transaction has ended; a statement sent after its callback settled is refused');
            return answer(await client.query<R>(text, params ? [...params] : undefined));
          },
        });
        open = false;
        await client.query('COMMIT');
        return value;
      } catch (err) {
        open = false;
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        open = false;
        client.release();
      }
    },
  } as Required<KernelSql>;
}

export async function openTestDb(max = KERNEL_RUNTIME_POOL_MAX): Promise<TestDb> {
  if (!url) throw new Error('openTestDb() called without a database; guard the test with { skip: PG_SKIP }');
  const id = randomBytes(6).toString('hex');
  const schema = `fac_test_${id}`;
  const runtimeRole = `fac_test_${id}_rt`;
  const migrationRole = `fac_test_${id}_mig`;
  const password = randomBytes(18).toString('hex');
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  // As the kernel: the roles are plain, the migration role owns the schema,
  // and the runtime role's search_path is set before it ever logs in.
  await admin.query(`CREATE ROLE ${migrationRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await admin.query(`ALTER ROLE ${runtimeRole} SET search_path = ${schema}`);
  await admin.query(`ALTER ROLE ${migrationRole} SET search_path = ${schema}`);
  await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${migrationRole}`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`);
  await admin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeRole}`);

  const runtime = new pg.Pool({ connectionString: as(runtimeRole, password), max });

  const runMigrations = async (): Promise<MigrationRun> => {
    const started = Date.now();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const migration = new pg.Pool({ connectionString: as(migrationRole, password), max: 1 });
    const applied: string[] = [];
    const skipped: string[] = [];
    try {
      const client = await migration.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path = "${schema}"`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
        // The runtime role reads the ledger and never writes it.
        await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${LEDGER} FROM ${runtimeRole}`);
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
    } finally {
      await migration.end();
    }
    return { applied, skipped, ledger: LEDGER, durationMs: Date.now() - started };
  };

  const asMigrationRole = async (text: string): Promise<void> => {
    const migration = new pg.Pool({ connectionString: as(migrationRole, password), max: 1 });
    try {
      const client = await migration.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path = "${schema}"`);
        await client.query(text);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await migration.end();
    }
  };

  await runMigrations();
  const sql = kernelSql(runtime, schema);
  const db = dbOf(sql);
  if (!db) throw new Error('the test accessor is incomplete');
  return {
    pool: db,
    sql,
    runtime,
    admin,
    schema,
    runtimeRole,
    migrationRole,
    asMigrationRole,
    runMigrations,
    async close() {
      await runtime.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP OWNED BY ${runtimeRole}`);
      await admin.query(`DROP OWNED BY ${migrationRole}`);
      await admin.query(`DROP ROLE ${runtimeRole}`);
      await admin.query(`DROP ROLE ${migrationRole}`);
      await admin.end();
    },
  };
}
