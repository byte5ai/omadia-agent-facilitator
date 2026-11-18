/**
 * omadia Facilitator — the facilitation engine for native facilitators
 * (epic byte5ai/omadia#2043).
 *
 * The kernel owns the facilitator as a kind of agent: identity, neutrality
 * block, its own channel identity, the stored inbound messages and the model
 * turn. This plugin owns everything a facilitation is made of.
 *
 * Every kernel service is optional and resolved lazily. Without the database
 * grant the engine cannot keep state; it then registers nothing that could
 * start a facilitation and says why.
 */

import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';
import type { PluginContext } from '@omadia/plugin-api';

import { systemClock } from './clock.js';
import { parseConfig } from './config.js';
import type { EngineConfig } from './config.js';
import { FacilitationEngine } from './engine/engine.js';
import { OPERATOR_API_PREFIX, router as operatorRouter } from './http/operatorApi.js';
import { KERNEL_SERVICE_NAMES, createKernel, resolveService } from './kernel.js';
import { buildTools } from './tools/index.js';

export const PLUGIN_ID = '@omadia/agent-facilitator' as const;
export const ENGINE_VERSION = '1.0.0' as const;
/** `facilitationEngine@1` without the version suffix: the registry key. */
export const ENGINE_SERVICE_NAME = FACILITATION_ENGINE_CAPABILITY.split('@')[0] ?? 'facilitationEngine';

/** What the kernel sees behind `facilitationEngine`. */
export interface FacilitationEngineInfo {
  readonly pluginId: string;
  readonly version: string;
  /** False when the engine has no database and can start nothing. */
  readonly available: boolean;
  /** Operator-readable reason when `available` is false. */
  readonly unavailableReason?: string;
}

export interface FacilitatorHandle {
  readonly config: EngineConfig;
  readonly info: FacilitationEngineInfo;
  readonly engine: FacilitationEngine;
  close(): Promise<void>;
}

const TICK_INTERVAL_MS = 30_000;
const TICK_TIMEOUT_MS = 120_000;

export const NO_DATABASE_REASON =
  'The facilitation engine has no database: grant this plugin its SQL permission and run the middleware with Postgres.';

export async function activate(ctx: PluginContext): Promise<FacilitatorHandle> {
  const log = (msg: string): void => ctx.log(msg);
  log('activating facilitation engine');
  const pluginId = ctx.agentId || PLUGIN_ID;
  const config = parseConfig(<T,>(key: string) => ctx.config.get<T>(key), log);
  const kernel = createKernel(ctx.services);
  const disposers: Array<() => void> = [];

  for (const name of KERNEL_SERVICE_NAMES) {
    if (resolveService(ctx.services, name) === undefined) {
      log(`kernel service '${name}' is not published (yet) — the matching feature degrades until it appears`);
    }
  }

  // The kernel applies `permissions.sql.migrations` before activate(); the
  // call here is the same idempotent pass and covers a kernel that leaves it
  // to the plugin. Its absence means: undeclared, not granted, or no database.
  let unavailableReason: string | undefined;
  if (!ctx.sql) {
    unavailableReason = NO_DATABASE_REASON;
  } else {
    try {
      const report = await ctx.sql.runMigrations();
      if (report.applied.length > 0) log(`applied migrations: ${report.applied.join(', ')}`);
    } catch (err) {
      unavailableReason = `The facilitation tables could not be migrated: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (unavailableReason === undefined && !kernel.pool()) unavailableReason = NO_DATABASE_REASON;
  if (unavailableReason !== undefined) log(unavailableReason);

  const info: FacilitationEngineInfo = {
    pluginId,
    version: ENGINE_VERSION,
    available: unavailableReason === undefined,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
  disposers.push(ctx.services.provide(ENGINE_SERVICE_NAME, info));

  // The tools are registered even without a database: a facilitator then
  // answers "not available, and why" instead of having no tools at all.
  const engine = new FacilitationEngine({ kernel, config, clock: systemClock, log });
  for (const tool of buildTools(engine)) disposers.push(ctx.tools.register(tool.spec, tool.handler));
  // Operator API, behind the kernel's session gate.
  disposers.push(
    ctx.routes.register(
      OPERATOR_API_PREFIX,
      operatorRouter(engine, async (cookie) => (await ctx.operatorAuth?.sessionPrincipal?.(cookie))?.email),
      { auth: 'session', body: 'json' },
    ),
  );

  if (info.available) {
    // The scheduler: reminders, deadlines, windows, delivery retries. The
    // interval bounds how late a reminder can be; leases keep replicas apart.
    disposers.push(
      ctx.jobs.register({ name: 'facilitation-tick', schedule: { intervalMs: TICK_INTERVAL_MS }, timeoutMs: TICK_TIMEOUT_MS, overlap: 'skip' }, async () => {
        await engine.tick();
      }),
    );
    try {
      await engine.start();
    } catch (err) {
      log(`engine start failed, catching up lazily: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    config,
    info,
    engine,
    async close() {
      log('deactivating facilitation engine');
      await engine.stop();
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (err) {
          log(`dispose failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

export default { PLUGIN_ID, activate };
