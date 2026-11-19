// Migration 0005: the append-only rule of the event log inside the plugin's
// own schema, after the kernel moved the tables of an earlier version.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { MIGRATIONS_DIR, PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const VOTE = { method: 'single', options: ['Thai', 'Pizza'] };

test('0005, the safety net: a trigger that came along with its table but still calls a function outside the schema is bound to the one inside', { skip: PG_SKIP }, async () => {
  // What a move that takes only the tables leaves: the trigger came along
  // with its table, the function it calls stayed in public.
  const fn = `fac_test_left_behind_${h.db.schema}`;
  await h.db.admin.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plg_omadia_agent_facilitator_events is append-only'; END; $$`);
  await h.db.admin.query(`DROP TRIGGER plg_omadia_agent_facilitator_events_no_update ON ${h.db.schema}.plg_omadia_agent_facilitator_events`);
  await h.db.admin.query(`CREATE TRIGGER plg_omadia_agent_facilitator_events_no_update BEFORE UPDATE ON ${h.db.schema}.plg_omadia_agent_facilitator_events FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
  const functionSchema = async (): Promise<string | undefined> =>
    (
      await h.db.admin.query<{ nspname: string }>(
        `SELECT n.nspname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE t.tgname = 'plg_omadia_agent_facilitator_events_no_update' AND cn.nspname = $1`,
        [h.db.schema],
      )
    ).rows[0]?.nspname;
  assert.equal(await functionSchema(), 'public');
  await h.db.asMigrationRole(readFileSync(join(MIGRATIONS_DIR, '0005_own_schema_trigger_function.sql'), 'utf8'));
  assert.equal(await functionSchema(), h.db.schema);
  await h.db.admin.query(`DROP FUNCTION public.${fn}()`);

  const conv = h.kernel.conversation('od-append-only', [ANNA, BERT]);
  const f = await startActive(h, conv, VOTE);
  await assert.rejects(h.db.pool.query('UPDATE plg_omadia_agent_facilitator_events SET kind = $1 WHERE facilitation_id = $2', ['edited', f.id]), /append-only/);
});
