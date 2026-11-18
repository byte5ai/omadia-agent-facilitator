// Small SQL helpers: snake_case columns to camelCase rows, and insert/update
// builders so a column list is written once. Table and column names come from
// the engine's own code only, never from input.

import type { Queryable } from './pool.js';

export type Table =
  | 'facilitations'
  | 'facilitation_sessions'
  | 'facilitation_stakeholders'
  | 'facilitation_steps'
  | 'facilitation_participants'
  | 'facilitation_dod_versions'
  | 'facilitation_contributions'
  | 'facilitation_clusters'
  | 'facilitation_decisions'
  | 'facilitation_action_items'
  | 'facilitation_events'
  | 'facilitation_outbox'
  | 'facilitation_inbound'
  | 'facilitation_jobs'
  | 'facilitation_proposals'
  | 'facilitation_acks'
  | 'facilitation_access_audit';

const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (key: string): string => key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

export function camelize<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out as T;
}

/** jsonb parameters travel as text: `pg` would turn a JS array into a
 *  Postgres array literal, which is not JSON. */
function param(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

export async function rows<T>(q: Queryable, text: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await q.query(text, params.map(param));
  return result.rows.map((r) => camelize<T>(r));
}

export async function one<T>(q: Queryable, text: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(q, text, params))[0];
}

export async function insert<T>(q: Queryable, table: Table, values: Record<string, unknown>, suffix = ''): Promise<T> {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const columns = keys.map(toSnake).join(', ');
  const placeholders = keys.map((_k, i) => `$${String(i + 1)}`).join(', ');
  const row = await one<T>(
    q,
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ${suffix} RETURNING *`,
    keys.map((k) => values[k]),
  );
  if (!row) throw new Error(`insert into ${table} returned no row`);
  return row;
}

/** Insert that tolerates a unique conflict; undefined when the row existed. */
export async function insertIfAbsent<T>(
  q: Queryable,
  table: Table,
  values: Record<string, unknown>,
  conflict = '',
): Promise<T | undefined> {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const columns = keys.map(toSnake).join(', ');
  const placeholders = keys.map((_k, i) => `$${String(i + 1)}`).join(', ');
  return one<T>(
    q,
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT ${conflict} DO NOTHING RETURNING *`,
    keys.map((k) => values[k]),
  );
}

export async function update<T>(
  q: Queryable,
  table: Table,
  where: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<T | undefined> {
  const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const whereKeys = Object.keys(where);
  if (patchKeys.length === 0) throw new Error(`update ${table}: empty patch`);
  const set = patchKeys.map((k, i) => `${toSnake(k)} = $${String(i + 1)}`).join(', ');
  const cond = whereKeys.map((k, i) => `${toSnake(k)} = $${String(patchKeys.length + i + 1)}`).join(' AND ');
  return one<T>(q, `UPDATE ${table} SET ${set} WHERE ${cond} RETURNING *`, [
    ...patchKeys.map((k) => patch[k]),
    ...whereKeys.map((k) => where[k]),
  ]);
}
