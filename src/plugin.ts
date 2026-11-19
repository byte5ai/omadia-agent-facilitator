/**
 * omadia Facilitator — the facilitation engine for native facilitators
 * (epic byte5ai/omadia#2043).
 *
 * The kernel owns the facilitator as a kind of agent: identity, neutrality
 * block, its own channel identity, the stored inbound messages and the model
 * turn. This plugin owns everything a facilitation is made of.
 *
 * Every kernel service is resolved lazily, the database included. Without it
 * the engine cannot keep state: it says why, starts nothing, and keeps looking
 * until the pool is there.
 */

import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';
import type { PluginContext } from '@omadia/plugin-api';

import { systemClock } from './clock.js';
import { CONFIG_KEYS, OBSOLETE_CONFIG_KEYS, isKernelKey, parseConfig } from './config.js';
import { lockLog } from './db/tx.js';
import type { EngineConfig } from './config.js';
import { ARCHETYPE_PROCESSES_SERVICE_NAME } from './engine/endOfService.js';
import type { ArchetypeProcessesService } from './engine/endOfService.js';
import { FacilitationEngine } from './engine/engine.js';
import { OPERATOR_API_PREFIX, router as operatorRouter } from './http/operatorApi.js';
import { KERNEL_SERVICE_NAMES, createKernel, resolveService } from './kernel.js';
import { buildTools } from './tools/index.js';

export const PLUGIN_ID = '@omadia/agent-facilitator' as const;
export const ENGINE_VERSION = '1.2.0' as const;
/** `facilitationEngine@1` without the version suffix: the registry key. */
export const ENGINE_SERVICE_NAME = FACILITATION_ENGINE_CAPABILITY.split('@')[0] ?? 'facilitationEngine';

/** What the kernel sees behind `facilitationEngine`. */
export interface FacilitationEngineInfo {
  readonly pluginId: string;
  readonly version: string;
  /** False while the engine has no database and can start nothing. Read it
   *  when you need it: it changes when the database appears. */
  readonly available: boolean;
  /** Operator-readable reason when `available` is false. */
  readonly unavailableReason?: string;
}

export interface FacilitatorHandle {
  readonly config: EngineConfig;
  readonly info: FacilitationEngineInfo;
  readonly engine: FacilitationEngine;
  /** Look for the database again and start the engine when it is there. */
  ensureUp(): Promise<boolean>;
  close(): Promise<void>;
}

const TICK_INTERVAL_MS = 30_000;
const TICK_TIMEOUT_MS = 120_000;
/** How often an engine without a database looks for it again. */
export const RETRY_INTERVAL_MS = 3_000;

/** Labels of the navigation entry; the host resolves the locale. */
export const NAV_LABEL = { en: 'Facilitations', de: 'Moderationen' } as const;

export const NO_DATABASE_REASON =
  'The facilitation engine has no database: grant this plugin its SQL permission and run the middleware with Postgres.';

/** The kernel's setting for how the Privacy Shield treats what this plugin's
 *  tools answer. Operator-owned; the manifest recommends 'bypass' and says why. */
const PRIVACY_MODE_KEY = '_privacy_mode';

/**
 * What the privacy mode in force means for a facilitator, for the log.
 *
 * The engine's tools answer its own facilitator: what was recorded, what was
 * refused and why, what to say next. Under 'guarded' the kernel replaces every
 * such answer by an identity-free digest, and the facilitator would tell the
 * group that something happened without knowing whether it did. So the engine
 * needs 'bypass' for its own tools. It is never assumed silently: the mode in
 * force is stated at every activation, and anything else is a warning.
 */
export function privacyNote(mode: unknown): string {
  if (mode === 'bypass') {
    return "privacy: mode 'bypass' is set for this plugin, as the manifest recommends: the facilitator reads what the engine's tools answer (state, refusals, names of the participants of the conversation it moderates). Tool inputs are restored by the kernel either way.";
  }
  const stated = typeof mode === 'string' && mode !== '' ? `'${mode}'` : "not set, which means 'guarded'";
  return `privacy: WARNING: the privacy mode of this plugin is ${stated}. Under 'guarded' a facilitator cannot read what its tools answer (what was recorded, what was refused and why) and will moderate blind. Set the plugin's privacy mode to 'bypass' (see the recommendation in its settings), or 'per_tool' with every facilitation_* tool listed.`;
}

/**
 * A version change of the installed plugin. The kernel would otherwise carry
 * the configuration over key by key, including the settings of 0.7.x that
 * nothing reads any more.
 *
 * Dropped: the 0.7.x keys. Kept: every setting 1.0.x reads, the kernel's own
 * keys (the privacy mode is the operator's decision, not the plugin's), and
 * keys the engine does not know (said in the log, not deleted). Idempotent.
 */
export async function onMigrate(ctx: { fromVersion: string; toVersion: string; previousConfig: Record<string, unknown>; log?: (msg: string) => void }): Promise<{ newConfig: Record<string, unknown> }> {
  const log = (msg: string): void => ctx.log?.(`migrate ${ctx.fromVersion} -> ${ctx.toVersion}: ${msg}`);
  const obsolete = new Set<string>(OBSOLETE_CONFIG_KEYS);
  const known = new Set<string>(CONFIG_KEYS);
  const entries = Object.entries(ctx.previousConfig);
  const dropped = entries.filter(([key]) => obsolete.has(key)).map(([key]) => key);
  const unknown = entries.filter(([key]) => !obsolete.has(key) && !known.has(key) && !isKernelKey(key)).map(([key]) => key);
  if (dropped.length > 0) log(`dropped settings of 0.7.x that nothing reads any more: ${dropped.join(', ')}`);
  if (unknown.length > 0) log(`kept settings the engine does not read: ${unknown.join(', ')}`);
  if (ctx.previousConfig[PRIVACY_MODE_KEY] !== undefined) {
    log(`the operator's ${PRIVACY_MODE_KEY} '${String(ctx.previousConfig[PRIVACY_MODE_KEY])}' is carried over unchanged. ${privacyNote(ctx.previousConfig[PRIVACY_MODE_KEY])}`);
  }
  return { newConfig: Object.fromEntries(entries.filter(([key]) => !obsolete.has(key))) };
}

export async function activate(ctx: PluginContext): Promise<FacilitatorHandle> {
  const log = (msg: string): void => ctx.log(msg);
  log('activating facilitation engine');
  lockLog.write = log;
  log(privacyNote(ctx.config.get<unknown>(PRIVACY_MODE_KEY)));
  const stale = OBSOLETE_CONFIG_KEYS.filter((key) => ctx.config.get<unknown>(key) !== undefined);
  if (stale.length > 0) log(`config: settings of 0.7.x are still stored and ignored: ${stale.join(', ')}`);
  const pluginId = ctx.agentId || PLUGIN_ID;
  const config = parseConfig(<T,>(key: string) => ctx.config.get<T>(key), log);
  const kernel = createKernel(ctx.services);
  const disposers: Array<() => void> = [];

  for (const name of KERNEL_SERVICE_NAMES) {
    if (resolveService(ctx.services, name) === undefined) {
      log(`kernel service '${name}' is not published (yet) — the matching feature degrades until it appears`);
    }
  }

  const engine = new FacilitationEngine({ kernel, config, clock: systemClock, log });

  // Whether the engine is up is not decided once. The pool may be published
  // after this plugin activated (a provider that activates later, a grant
  // that arrives later): the engine looks again until it is there, and then
  // resumes what was running.
  let unavailableReason: string | undefined = NO_DATABASE_REASON;
  let closed = false;
  let rising: Promise<boolean> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const rise = async (): Promise<boolean> => {
    let reason: string | undefined;
    if (!ctx.sql || !kernel.pool()) {
      reason = NO_DATABASE_REASON;
    } else {
      // The kernel applies `permissions.sql.migrations` before activate(); the
      // call here is the same idempotent pass and covers a pool that was not
      // there at that moment.
      try {
        const report = await ctx.sql.runMigrations();
        if (report.applied.length > 0) log(`applied migrations: ${report.applied.join(', ')}`);
      } catch (err) {
        reason = `The facilitation tables could not be migrated: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (reason !== undefined) {
      if (reason !== unavailableReason || retryTimer === undefined) log(reason);
      unavailableReason = reason;
      return false;
    }
    unavailableReason = undefined;
    log('the facilitation engine is available');
    try {
      await engine.start();
    } catch (err) {
      log(`engine start failed, catching up on the next tick: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  };

  /** Bring the engine up if it is not. One attempt at a time. */
  const ensureUp = (): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    if (unavailableReason === undefined) return Promise.resolve(true);
    rising ??= rise().finally(() => {
      rising = undefined;
    });
    return rising;
  };

  const scheduleRetry = (): void => {
    if (closed || unavailableReason === undefined) return;
    retryTimer = setTimeout(() => {
      void ensureUp()
        .catch((err: unknown) => {
          log(`bringing the engine up failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        })
        .then(scheduleRetry);
    }, RETRY_INTERVAL_MS);
    retryTimer.unref?.();
  };

  const info: FacilitationEngineInfo = {
    pluginId,
    version: ENGINE_VERSION,
    get available() {
      return unavailableReason === undefined;
    },
    get unavailableReason() {
      return unavailableReason;
    },
  };
  disposers.push(ctx.services.provide(ENGINE_SERVICE_NAME, info));

  // End of service (plugin-api 1.61.0): before the kernel disables or deletes
  // a facilitator, or removes this plugin, it asks here to end that agent's
  // facilitations with their reports. A kernel that never asks ignores it.
  const processes: ArchetypeProcessesService = { endProcessesOfAgent: (request) => engine.endProcessesOfAgent(request) };
  disposers.push(ctx.services.provide(ARCHETYPE_PROCESSES_SERVICE_NAME, processes));

  // The tools are registered even without a database: a facilitator then
  // answers "not available, and why" instead of having no tools at all. A
  // tool call is also a moment to look for the database again.
  engine.setReadiness(ensureUp);
  for (const tool of buildTools(engine)) disposers.push(ctx.tools.register(tool.spec, tool.handler));
  // Operator API, behind the kernel's session gate.
  disposers.push(
    ctx.routes.register(
      OPERATOR_API_PREFIX,
      operatorRouter(engine, async (cookie) => (await ctx.operatorAuth?.sessionPrincipal?.(cookie))?.email),
      { auth: 'session', body: 'json' },
    ),
  );

  // The facilitations view: the bundle in ui/ is served by the host at
  // /p/<plugin id>/ui/; this makes it findable.
  disposers.push(ctx.uiRoutes.register({ routeId: 'facilitations', path: '/ui/', title: 'Facilitations', description: 'Which facilitator runs which facilitation, its phase and counts.', order: 40 }));
  disposers.push(ctx.uiRoutes.registerNav({ navId: 'facilitations', pluginUi: true, order: 40, label: NAV_LABEL }));

  // The scheduler: reminders, deadlines, windows, delivery retries. The
  // interval bounds how late a reminder can be; leases keep replicas apart.
  // Registered whether or not the engine is up: a tick brings it up.
  disposers.push(
    ctx.jobs.register({ name: 'facilitation-tick', schedule: { intervalMs: TICK_INTERVAL_MS }, timeoutMs: TICK_TIMEOUT_MS, overlap: 'skip' }, async () => {
      if (await ensureUp()) await engine.tick();
    }),
  );

  await ensureUp();
  scheduleRetry();

  return {
    config,
    info,
    engine,
    ensureUp,
    async close() {
      log('deactivating facilitation engine');
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
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
