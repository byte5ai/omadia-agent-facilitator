// What an engine test needs: a database, the fake kernel, a clock to move by
// hand, an engine, and the tools as the kernel would call them.

import { CONFIG_DEFAULTS } from '../src/config.js';
import type { EngineConfig } from '../src/config.js';
import * as store from '../src/db/store.js';
import type { EngineHooks } from '../src/engine/core.js';
import { FacilitationEngine } from '../src/engine/engine.js';
import type { Facilitation } from '../src/model.js';
import { buildTools } from '../src/tools/index.js';
import { FakeKernel, fakeClock } from './fakeKernel.js';
import type { FakeClock, FakeUser } from './fakeKernel.js';
import { openTestDb } from './pg.js';
import type { TestDb } from './pg.js';

export const ANNA: FakeUser = { id: 'anna', displayName: 'Anna', email: 'anna@example.com' };
export const BERT: FakeUser = { id: 'bert', displayName: 'Bert', email: 'bert@example.com' };
export const CARA: FakeUser = { id: 'cara', displayName: 'Cara', email: 'cara@example.com' };
export const DAVE: FakeUser = { id: 'dave', displayName: 'Dave', email: 'dave@example.com' };
export const FOUR = [ANNA, BERT, CARA, DAVE];

/** Words of the machinery that no tool result may contain. */
export const INTERNALS = /\b(engine|kernel|outbox|plugin)\b/i;

export interface Harness {
  db: TestDb;
  kernel: FakeKernel;
  clock: FakeClock;
  engine: FacilitationEngine;
  logs: string[];
  hooks: EngineHooks;
  /** Call a tool the way the kernel does during a turn in `conversationId`. */
  tool(name: string, args: Record<string, unknown>, at: { agent?: string; conversation: string; caller?: string }): Promise<string>;
  /** Wait until everything in flight has settled. */
  settle(): Promise<void>;
  /** One scheduler pass at the current time of the clock. */
  tick(): Promise<void>;
  /** A second replica on the same kernel and database. */
  replica(): FacilitationEngine;
  /** A middleware restart: a new engine on the same kernel and database. */
  restart(): Promise<void>;
  facilitation(conversationId: string): Promise<Facilitation>;
  close(): Promise<void>;
}

export async function createHarness(opts: { config?: Partial<EngineConfig>; start?: string; poolMax?: number } = {}): Promise<Harness> {
  const db = await openTestDb(opts.poolMax);
  const clock = fakeClock(opts.start);
  const kernel = new FakeKernel(db.pool, clock);
  const logs: string[] = [];
  const hooks: EngineHooks = {};
  const config = { ...CONFIG_DEFAULTS, language: 'en' as const, ...(opts.config ?? {}) };
  let generation = 0;
  const build = (): FacilitationEngine => {
    generation += 1;
    return new FacilitationEngine({ kernel: kernel.kernel(), config, clock, log: (m) => logs.push(m), instanceId: `engine-${String(generation)}`, hooks });
  };
  const h: Harness = {
    db,
    kernel,
    clock,
    engine: build(),
    logs,
    hooks,
    async tool(name, args, at) {
      const def = buildTools(h.engine).find((t) => t.spec.name === name);
      if (!def) throw new Error(`no tool ${name}`);
      clock.advance(kernel.tickMs);
      const answer = await def.handler(args, kernel.context(at.agent ?? 'mira', at.conversation, at.caller ?? 'anna'));
      await h.settle();
      // A model may repeat a tool result to the group word for word: no
      // result speaks of the machinery.
      const internal = INTERNALS.exec(answer);
      if (internal) throw new Error(`the result of ${name} speaks of internals ("${internal[0]}"): ${answer}`);
      return answer;
    },
    async settle() {
      await h.engine.idle();
    },
    async tick() {
      await h.engine.tick();
      await h.settle();
    },
    replica() {
      return build();
    },
    async restart() {
      await h.engine.stop();
      h.engine = build();
      await h.engine.start();
      await h.settle();
    },
    async facilitation(conversationId) {
      const result = await db.pool.query<{ id: string }>('SELECT id FROM plg_omadia_agent_facilitator_facilitations WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [conversationId]);
      const f = result.rows[0] ? await store.getFacilitation(db.pool, result.rows[0].id) : undefined;
      if (!f) throw new Error(`no facilitation in ${conversationId}`);
      return f;
    },
    async close() {
      await h.engine.stop();
      await db.close();
    },
  };
  await h.engine.start();
  return h;
}

/** Set up and open a facilitation the short way. */
export async function startActive(h: Harness, conversation: string, extra: Record<string, unknown> = {}, agent = 'mira'): Promise<Facilitation> {
  const started = await h.tool('facilitation_start', { goal: 'Pick a venue', definitionOfDone: 'A venue is chosen', ...extra }, { agent, conversation });
  if (!started.startsWith('Facilitation created')) throw new Error(started);
  const opened = await h.tool('facilitation_open', {}, { agent, conversation });
  if (!opened.startsWith('Opened')) throw new Error(opened);
  return h.facilitation(conversation);
}
