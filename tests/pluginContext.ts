// A plugin context over the fake kernel, for tests of activation: the
// services are looked up by name on every call, and a test decides when the
// database is there.

import type { PluginContext } from '@omadia/plugin-api';

import { KERNEL_SERVICE_NAMES } from '../src/kernel.js';
import type { Kernel } from '../src/kernel.js';
import type { FakeKernel } from './fakeKernel.js';
import type { TestDb } from './pg.js';

// Same order as KERNEL_SERVICE_NAMES.
const ACCESSORS: readonly (keyof Kernel)[] = ['pool', 'messages', 'agentTurn', 'conversationSend', 'targetedSend', 'readiness', 'sessionCapabilities', 'conversationEvents', 'rosters', 'followup'];

export interface KernelContext {
  ctx: PluginContext;
  logs: string[];
  provided: Map<string, unknown>;
  /** The registered jobs by name; call one to run a pass. */
  jobs: Map<string, () => Promise<void>>;
}

export function kernelContext(kernel: FakeKernel, db: TestDb): KernelContext {
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
    sql: {
      ledger: 'plg_omadia_agent_facilitator_migrations',
      // As the kernel does: no pool, no migrations.
      runMigrations: async () => {
        if (!kernel.kernel().pool()) throw new Error("no 'graphPool' is registered");
        return db.runMigrations();
      },
    },
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
