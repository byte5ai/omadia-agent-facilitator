// A plugin context over the fake kernel, for tests of activation: the
// services are looked up by name on every call, and a test decides when the
// database is there. The database is `ctx.sql`, as the kernel builds it for an
// archetype plugin: the migration runner plus one statement and one
// transaction as the plugin's runtime role. It is fixed for an activation.

import type { PluginContext } from '@omadia/plugin-api';

import { KERNEL_SERVICE_NAMES } from '../src/kernel.js';
import type { Kernel } from '../src/kernel.js';
import type { FakeKernel } from './fakeKernel.js';
import type { TestDb } from './pg.js';

// Same order as KERNEL_SERVICE_NAMES.
const ACCESSORS: readonly (keyof Kernel)[] = ['execution', 'grants', 'messages', 'agentTurn', 'conversationSend', 'legacyMessages', 'readiness', 'sessionCapabilities', 'conversationEvents', 'rosters', 'followup'];

export interface KernelContext {
  ctx: PluginContext;
  logs: string[];
  provided: Map<string, unknown>;
  /** The registered jobs by name; call one to run a pass. */
  jobs: Map<string, () => Promise<void>>;
}

export interface KernelContextOptions {
  /** No grant by the operator: the context has no `sql` at all. */
  granted?: boolean;
  /** A kernel before plugin-api 1.62.0: migrations, but no `query` / `transaction`. */
  oldKernel?: boolean;
  /** Migration passes fail while `failing` is true; a test flips it. */
  migrations?: { failing: boolean };
}

export function kernelContext(kernel: FakeKernel, db: TestDb, opts: KernelContextOptions = {}): KernelContext {
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const jobs = new Map<string, () => Promise<void>>();
  const lookup = <T,>(name: string): T | undefined => {
    const index = KERNEL_SERVICE_NAMES.indexOf(name as (typeof KERNEL_SERVICE_NAMES)[number]);
    const accessor = ACCESSORS[index];
    return accessor ? (kernel.kernel()[accessor]() as T | undefined) : undefined;
  };
  const nothing = (): (() => void) => () => undefined;
  const ctx = {
    agentId: '@omadia/agent-facilitator',
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    config: { get: (key: string) => (key === 'language' ? 'en' : undefined) },
    ...(opts.granted === false
      ? {}
      : {
          sql: {
            ledger: 'plg_omadia_agent_facilitator_migrations',
            ...(opts.oldKernel ? {} : db.sql),
            runMigrations: async () => {
              if (opts.migrations?.failing) throw new Error('lock timeout');
              return db.runMigrations();
            },
          },
        }),
    routes: { register: nothing },
    jobs: {
      register: (spec: { name: string }, run: () => Promise<void>) => {
        jobs.set(spec.name, run);
        return () => jobs.delete(spec.name);
      },
    },
    uiRoutes: { register: nothing, registerNav: nothing },
    tools: { register: nothing },
    services: {
      get: lookup,
      getOptional: lookup,
      has: (name: string) => lookup(name) !== undefined,
      provide: (name: string, impl: unknown) => {
        provided.set(name, impl);
        return () => provided.delete(name);
      },
    },
  } as unknown as PluginContext;
  return { ctx, logs, provided, jobs };
}
