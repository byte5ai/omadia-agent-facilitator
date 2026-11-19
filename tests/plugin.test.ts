import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { ENGINE_SERVICE_NAME, NO_DATABASE_REASON, activate } from '../src/plugin.js';
import type { FacilitationEngineInfo } from '../src/plugin.js';

function bareContext(overrides: Partial<Record<string, unknown>> = {}) {
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const tools: string[] = [];
  const routes: string[] = [];
  const ui: unknown[] = [];
  const nav: unknown[] = [];
  const ctx = {
    agentId: '@omadia/agent-facilitator',
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    config: { get: () => undefined },
    routes: {
      register: (prefix: string) => {
        routes.push(prefix);
        return () => undefined;
      },
    },
    jobs: { register: () => () => undefined },
    uiRoutes: {
      register: (descriptor: unknown) => {
        ui.push(descriptor);
        return () => undefined;
      },
      registerNav: (entry: unknown) => {
        nav.push(entry);
        return () => undefined;
      },
    },
    tools: {
      register: (spec: { name: string }) => {
        tools.push(spec.name);
        return () => undefined;
      },
    },
    services: {
      get: () => undefined,
      getOptional: () => undefined,
      has: () => false,
      provide: (name: string, impl: unknown) => {
        provided.set(name, impl);
        return () => provided.delete(name);
      },
    },
    ...overrides,
  } as unknown as PluginContext;
  return { ctx, logs, provided, tools, routes, ui, nav };
}

test('without the SQL grant the engine activates, reports itself unavailable and says why', async () => {
  const { ctx, logs, provided } = bareContext();
  const handle = await activate(ctx);
  assert.equal(handle.info.available, false);
  assert.equal(handle.info.unavailableReason, NO_DATABASE_REASON);
  assert.ok(logs.some((l) => l.includes(NO_DATABASE_REASON)));
  assert.equal((provided.get(ENGINE_SERVICE_NAME) as FacilitationEngineInfo).available, false);
  await handle.close();
  assert.equal(provided.has(ENGINE_SERVICE_NAME), false, 'close() withdraws the engine capability');
});

test('every missing kernel service is logged once, none of them stops activation', async () => {
  const { ctx, logs } = bareContext();
  await activate(ctx);
  for (const name of ['conversationMessages', 'agentTurn', 'conversationSend', 'targetedSend', 'facilitation.followup']) {
    assert.equal(logs.filter((l) => l.includes(`'${name}'`)).length, 1, name);
  }
});

test('a failing migration makes the engine unavailable instead of failing activation', async () => {
  const { ctx } = bareContext({
    // The database is there; the migration is what fails.
    sql: {
      ledger: 'plg_omadia_agent_facilitator_migrations',
      schema: 'plg_omadia_agent_facilitator',
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async () => undefined,
      runMigrations: async () => {
        throw new Error('lock timeout');
      },
    },
  });
  const handle = await activate(ctx);
  assert.equal(handle.info.available, false);
  assert.match(handle.info.unavailableReason ?? '', /lock timeout/);
});

test('without a database the tools still exist and say that the engine is not available', async () => {
  const { ctx, tools } = bareContext();
  const handle = await activate(ctx);
  assert.ok(tools.includes('facilitation_start'));
  const { buildTools } = await import('../src/tools/index.js');
  const start = buildTools(handle.engine).find((t) => t.spec.name === 'facilitation_start');
  const answer = await start?.handler(
    { goal: 'g', definitionOfDone: 'd' },
    { agentSlug: 'mira', channelType: 'teams', conversationId: 'c1', callerPrincipalId: 'user:anna' },
  );
  assert.match(answer ?? '', /^Not available: facilitation is not set up completely/);
  const noContext = await start?.handler({ goal: 'g', definitionOfDone: 'd' });
  assert.match(noContext ?? '', /a facilitation is never guessed/);
});

test('the operator API is mounted and the facilitations view is in the navigation with English and German labels', async () => {
  const { ctx, routes, ui, nav } = bareContext();
  await activate(ctx);
  assert.deepEqual(routes, ['/api/v1/facilitation']);
  assert.deepEqual(nav, [{ navId: 'facilitations', pluginUi: true, order: 40, label: { en: 'Facilitations', de: 'Moderationen' } }]);
  assert.equal((ui[0] as { path: string }).path, '/ui/');
});
