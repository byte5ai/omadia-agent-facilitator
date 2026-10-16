import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { Hydrator, REHYDRATE_RETRY_MS } from '../src/rehydrate.js';
import type { ConversationBindingsService, EphemeralRunsService } from '../src/services.js';
import { FacilitationStateStore } from '../src/stateStore.js';

type OwnRun = Awaited<ReturnType<NonNullable<EphemeralRunsService['listOwnRuns']>>>[number];
type Attachment = Awaited<ReturnType<NonNullable<ConversationBindingsService['listOwnAttachments']>>>[number];

function run(overrides: Partial<OwnRun> & { runId: string }): OwnRun {
  return {
    workflowId: `wf-${overrides.runId}`,
    workflowSlug: `eph-facilitation-${overrides.runId}`,
    patternId: 'facilitation',
    expiresAt: '2026-10-17T00:00:00.000Z',
    payload: {},
    state: null,
    ...overrides,
  };
}

function attachment(overrides: Partial<Attachment> & { conversationId: string }): Attachment {
  return {
    channelType: 'teams',
    workflowId: null,
    roleKey: null,
    state: 'attached',
    expiresAt: new Date('2026-10-17T00:00:00.000Z'),
    activeRunId: null,
    ...overrides,
  };
}

function setup(opts: {
  runs?: () => Promise<OwnRun[]>;
  /** Omitted → bindings published with no attachments; null → not published. */
  attachments?: (() => Promise<Attachment[]>) | null;
  store?: FacilitationStateStore;
  clock?: { t: number };
}) {
  const store = opts.store ?? new FacilitationStateStore();
  const logs: string[] = [];
  let listRunsCalls = 0;
  const runsService: EphemeralRunsService | undefined = opts.runs
    ? {
        createEphemeralRun: async () => {
          throw new Error('unused');
        },
        listOwnRuns: async () => {
          listRunsCalls += 1;
          return opts.runs!();
        },
      }
    : undefined;
  const listAttachments = opts.attachments === undefined ? async (): Promise<Attachment[]> => [] : opts.attachments;
  const bindings = listAttachments
    ? ({ listOwnAttachments: async () => listAttachments() } as unknown as ConversationBindingsService)
    : undefined;
  const hydrator = new Hydrator({
    agentId: '@omadia/agent-facilitator',
    config: { facilitatorAgentSlug: 'facilitator' },
    store,
    getEphemeralRuns: () => runsService,
    getConversationBindings: () => bindings,
    log: (msg) => logs.push(msg),
    ...(opts.clock ? { now: () => opts.clock!.t } : {}),
  });
  return { hydrator, store, logs, listRunsCalls: () => listRunsCalls };
}

describe('Hydrator — sources and merge', () => {
  it('restores goal/DoD/progress/nudges/deadline from the run listing', async () => {
    const { hydrator, store } = setup({
      runs: async () => [
        run({
          runId: 'r1',
          payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1', deadline: '2026-10-16T10:00:00.000Z', initiatorRoleKey: 'facilitation-abc' },
          state: { v: 1, phase: 'active', progress: { dodMet: false, summary: '2/5', updatedAt: '2026-10-15T12:00:00.000Z' }, nudgesSent: 3, channelType: 'teams' },
        }),
      ],
    });
    await hydrator.ensure();
    const record = store.get('grp-1')!;
    assert.equal(record.phase, 'active');
    assert.equal(record.goal, 'G');
    assert.equal(record.definitionOfDone, 'D');
    assert.equal(record.deadline, '2026-10-16T10:00:00.000Z');
    assert.equal(record.progress?.summary, '2/5');
    assert.equal(record.nudgesSent, 3);
    assert.equal(record.roleKey, 'facilitation-abc');
    assert.equal(record.channelType, 'teams');
    assert.equal(record.runId, 'r1');
    assert.equal(hydrator.complete, true);
  });

  it('merges attachments by conversationId and keeps attachment-only rows', async () => {
    const { hydrator, store } = setup({
      runs: async () => [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })],
      attachments: async () => [
        attachment({ conversationId: 'grp-1', roleKey: 'facilitation-1', activeRunId: 'r1' }),
        attachment({ conversationId: 'grp-2', state: 'pending' }),
      ],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-1')?.channelType, 'teams');
    assert.equal(store.get('grp-1')?.roleKey, 'facilitation-1');
    assert.equal(store.get('grp-1')?.goal, 'G');
    assert.equal(store.get('grp-2')?.phase, 'pending');
    assert.equal(store.get('grp-2')?.goal, undefined);
  });

  it('places a legacy run (no payload.conversationId) via its attachment, else keys it run:<id>', async () => {
    const { hydrator, store } = setup({
      runs: async () => [
        run({ runId: 'r-attached', payload: { goal: 'old A', definitionOfDone: 'D' } }),
        run({ runId: 'r-orphan', payload: { goal: 'old B', definitionOfDone: 'D' } }),
      ],
      attachments: async () => [attachment({ conversationId: 'grp-a', activeRunId: 'r-attached' })],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-a')?.goal, 'old A');
    assert.equal(store.get('grp-a')?.conversationUnknown, undefined);
    const orphan = store.get('run:r-orphan');
    assert.equal(orphan?.goal, 'old B');
    assert.equal(orphan?.conversationUnknown, true);
  });

  it('a persisted stop stays stopped; other patterns are ignored', async () => {
    const { hydrator, store } = setup({
      runs: async () => [
        run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' }, state: { v: 1, phase: 'stopped' } }),
        run({ runId: 'r2', patternId: 'something-else', payload: { conversationId: 'grp-2' } }),
      ],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-1')?.phase, 'stopped');
    assert.equal(store.get('grp-2'), undefined);
  });

  it('a live active record (with runId) wins over the durable one', async () => {
    const store = new FacilitationStateStore();
    store.markActive({ conversationId: 'grp-1', goal: 'live', definitionOfDone: 'd', runId: 'r-live', workflowSlug: 'w', expiresAt: 'x' });
    const { hydrator } = setup({
      store,
      runs: async () => [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })],
      attachments: async () => [attachment({ conversationId: 'grp-1', roleKey: 'facilitation-x' })],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-1')?.runId, 'r-live');
    assert.equal(store.get('grp-1')?.goal, 'live');
    assert.equal(store.get('grp-1')?.roleKey, undefined);
  });

  it('cold boot: a live pending marker without runId (bot_present) is upgraded by the durable run', async () => {
    const store = new FacilitationStateStore();
    store.markPending({ conversationId: 'grp-1', channelType: 'teams', invitedBy: 'Owner', bindPending: true });
    store.markPending({ conversationId: 'grp-2', channelType: 'teams', bindPending: true });
    const { hydrator } = setup({
      store,
      runs: async () => [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })],
      // grp-2: attachment-only (run without listOwnRuns source) — same rule.
      attachments: async () => [
        attachment({ conversationId: 'grp-1', roleKey: 'facilitation-x' }),
        attachment({ conversationId: 'grp-2', roleKey: 'facilitation-y', activeRunId: 'r2' }),
      ],
    });
    await hydrator.ensure();
    const one = store.get('grp-1')!;
    assert.equal(one.phase, 'active');
    assert.equal(one.runId, 'r1');
    assert.equal(one.goal, 'G');
    assert.equal(one.roleKey, 'facilitation-x'); // merged from the attachment
    assert.equal(one.invitedBy, 'Owner');
    assert.equal(one.bindPending, undefined);
    const two = store.get('grp-2')!;
    assert.equal(two.phase, 'active');
    assert.equal(two.runId, 'r2');
    assert.equal(two.roleKey, 'facilitation-y');
  });

  it('ignores a malformed state blob instead of trusting it', async () => {
    const { hydrator, store } = setup({
      runs: async () => [
        run({
          runId: 'r1',
          payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' },
          state: { v: 1, phase: 'bogus', nudgesSent: -4, progress: { dodMet: 'yes' } },
        }),
      ],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-1')?.phase, 'active');
    assert.equal(store.get('grp-1')?.nudgesSent, undefined);
    assert.equal(store.get('grp-1')?.progress, undefined);
  });
});

describe('Hydrator — retry semantics', () => {
  it('cold boot: no source yet → not complete, the next call probes again and restores', async () => {
    let published = false;
    const store = new FacilitationStateStore();
    const runsService: EphemeralRunsService = {
      createEphemeralRun: async () => {
        throw new Error('unused');
      },
      listOwnRuns: async () => [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })],
    };
    const hydrator = new Hydrator({
      agentId: 'a',
      config: { facilitatorAgentSlug: 'facilitator' },
      store,
      getEphemeralRuns: () => (published ? runsService : undefined),
      getConversationBindings: () =>
        published ? ({ listOwnAttachments: async () => [] } as unknown as ConversationBindingsService) : undefined,
      log: () => undefined,
    });
    await hydrator.ensure();
    assert.equal(hydrator.complete, false);
    published = true;
    await hydrator.ensure();
    assert.equal(hydrator.complete, true);
    assert.equal(store.get('grp-1')?.goal, 'G');
  });

  it('runs listed but conversationBindings not published → restored, yet not complete (retried after the window)', async () => {
    const clock = { t: 9_000_000 };
    const { hydrator, store, listRunsCalls } = setup({
      clock,
      attachments: null,
      runs: async () => [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })],
    });
    await hydrator.ensure();
    assert.equal(store.get('grp-1')?.goal, 'G');
    assert.equal(hydrator.complete, false);
    await hydrator.ensure();
    assert.equal(listRunsCalls(), 1); // throttled
    clock.t += REHYDRATE_RETRY_MS;
    await hydrator.ensure();
    assert.equal(listRunsCalls(), 2);
  });

  it('a throwing source is retried only after the throttle window', async () => {
    const clock = { t: 1_000_000 };
    let fail = true;
    const { hydrator, store, logs, listRunsCalls } = setup({
      clock,
      runs: async () => {
        if (fail) throw new Error('db down');
        return [run({ runId: 'r1', payload: { goal: 'G', definitionOfDone: 'D', conversationId: 'grp-1' } })];
      },
    });
    await hydrator.ensure();
    assert.equal(hydrator.complete, false);
    assert.ok(logs.some((l) => l.includes('db down')));
    fail = false;
    await hydrator.ensure(); // inside the window → no call
    assert.equal(listRunsCalls(), 1);
    clock.t += REHYDRATE_RETRY_MS;
    await hydrator.ensure();
    assert.equal(listRunsCalls(), 2);
    assert.equal(hydrator.complete, true);
    assert.equal(store.get('grp-1')?.goal, 'G');
  });

  it('concurrent callers share one in-flight pass; complete → no further passes', async () => {
    const { hydrator, listRunsCalls } = setup({ runs: async () => [] });
    await Promise.all([hydrator.ensure(), hydrator.ensure(), hydrator.ensure()]);
    await hydrator.ensure();
    assert.equal(listRunsCalls(), 1);
  });

  it('refreshOnMiss re-reads at most once per window', async () => {
    const clock = { t: 5_000_000 };
    const { hydrator, listRunsCalls } = setup({ clock, runs: async () => [] });
    await hydrator.ensure();
    assert.equal(await hydrator.refreshOnMiss(), true);
    assert.equal(await hydrator.refreshOnMiss(), false);
    assert.equal(listRunsCalls(), 2);
    clock.t += REHYDRATE_RETRY_MS;
    assert.equal(await hydrator.refreshOnMiss(), true);
    assert.equal(listRunsCalls(), 3);
  });
});
