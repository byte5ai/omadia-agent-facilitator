import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { PluginContext } from '@omadia/plugin-api';

import { activate } from '../src/plugin.js';

function fakeContext(services: Record<string, unknown>): { ctx: PluginContext; logs: string[] } {
  const logs: string[] = [];
  const ctx = {
    agentId: '@omadia/agent-facilitator',
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    },
    config: { get: () => undefined, require: () => undefined },
    secrets: { get: async () => undefined, require: async () => undefined, keys: async () => [] },
    services: { get: <T>(name: string) => services[name] as T | undefined },
  } as unknown as PluginContext;
  return { ctx, logs };
}

describe('activate', () => {
  it('activates with the full service set: 4 tools, membership subscription, clean close', async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const { ctx } = fakeContext({
      conductorEphemeralRuns: { createEphemeralRun: async () => ({}) },
      targetedSend: { sendToPrincipal: async () => ({}) },
      conversationEvents: {
        subscribe: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
      },
    });

    const handle = await activate(ctx);
    assert.deepEqual(
      handle.toolkit.tools.map((t) => t.spec.name).sort(),
      ['facilitation_nudge', 'facilitation_progress', 'facilitation_report', 'facilitation_start', 'facilitation_status', 'facilitation_stop'],
    );
    assert.equal(subscribed, 1);

    await handle.close();
    assert.equal(unsubscribed, 1);
  });

  it('activates degraded with NO services — every gap is logged, nothing throws', async () => {
    const { ctx, logs } = fakeContext({});
    const handle = await activate(ctx);

    assert.equal(handle.toolkit.tools.length, 6);
    for (const name of ['conductorEphemeralRuns', 'targetedSend', 'conversationEvents', 'agentProvisioning', 'conversationBindings', 'conductorRoleAssignments', 'conversationRosters', 'conversationSend']) {
      assert.ok(logs.some((l) => l.includes(name)), `missing degradation log for ${name}`);
    }
    await handle.close();
  });
});

// #330 field report — after a restart the durable side (run, binding, role)
// kept going while the in-memory store was empty; rehydration rebuilds it.
describe('activate — restart rehydration', () => {
  it('restores active facilitations from the kernel attachment listing', async () => {
    const { ctx, logs } = fakeContext({
      conversationBindings: {
        listOwnAttachments: async (input: { agentSlug: string }) =>
          input.agentSlug === 'facilitator'
            ? [
                {
                  channelType: 'teams',
                  conversationId: 'conv-restored',
                  workflowId: 'wf-1',
                  roleKey: 'facilitation-abc',
                  state: 'attached',
                  expiresAt: new Date('2026-08-24T00:00:00.000Z'),
                  activeRunId: 'run-42',
                },
              ]
            : [],
      },
    });
    const handle = await activate(ctx);
    assert.ok(logs.some((l) => l.includes('rehydrated: 1')));

    const status = handle.toolkit.tools.find((t) => t.spec.name === 'facilitation_status')!;
    const out = (await status.handle({ conversationId: 'conv-restored' })) as string;
    assert.ok(out.includes('conv-restored'));
    await handle.close();
  });

  it('a pre-feature kernel (no listOwnAttachments) activates unchanged', async () => {
    const { ctx, logs } = fakeContext({ conversationBindings: {} });
    const handle = await activate(ctx);
    assert.ok(!logs.some((l) => l.includes('rehydrated')));
    await handle.close();
  });
});

// 0.6.0 BOOT-ORDER regression: the kernel activates agent plugins BEFORE it
// publishes conductorEphemeralRuns/conversationBindings. Activate-time
// hydration finds nothing; the first tool call must restore the state.
describe('activate — cold-boot order (services published after activate)', () => {
  it('first facilitation_status restores goal/DoD/progress/nudges from services that appeared later', async () => {
    const services: Record<string, unknown> = {};
    const { ctx, logs } = fakeContext(services);
    const handle = await activate(ctx);
    assert.ok(!logs.some((l) => l.includes('rehydrated')));

    // Boot continues: the Conductor-backed services get published.
    services.conductorEphemeralRuns = {
      createEphemeralRun: async () => {
        throw new Error('unused');
      },
      listOwnRuns: async (input: { agentId: string }) =>
        input.agentId === '@omadia/agent-facilitator'
          ? [
              {
                runId: 'run-42',
                workflowId: 'wf-42',
                workflowSlug: 'eph-facilitation-42',
                patternId: 'facilitation',
                expiresAt: '2026-10-16T12:00:00.000Z',
                payload: { goal: 'Termin finden', definitionOfDone: 'Ein Termin ist bestätigt', conversationId: 'grp-1' },
                state: {
                  v: 1,
                  phase: 'active',
                  progress: { dodMet: false, summary: '4/6 abgestimmt', updatedAt: '2026-10-15T12:00:00.000Z' },
                  nudgesSent: 3,
                },
              },
            ]
          : [],
    };

    const status = handle.toolkit.tools.find((t) => t.spec.name === 'facilitation_status')!;
    const out = (await status.handle({})) as string;
    assert.ok(out.includes('Ziel: Termin finden'), out);
    assert.ok(out.includes('Definition of Done: Ein Termin ist bestätigt'), out);
    assert.ok(out.includes('4/6 abgestimmt'), out);
    assert.ok(out.includes('Nudges: 3/12'), out);
    assert.ok(logs.some((l) => l.includes('rehydrated: 1')));
    await handle.close();
  });

  // conversationEvents IS published before activate: the first group message
  // after a restart (bot_present) creates a pending marker BEFORE any tool
  // call. The durable run must upgrade it, not be skipped by it.
  it('bot_present before hydration does not shadow the durable active run (no second start)', async () => {
    let emit: ((event: unknown) => void) | undefined;
    const services: Record<string, unknown> = {
      conversationEvents: {
        subscribe: (fn: (event: unknown) => void) => {
          emit = fn;
          return () => undefined;
        },
      },
    };
    const { ctx } = fakeContext(services);
    const handle = await activate(ctx);
    emit!({
      kind: 'bot_present',
      channelId: 'teams',
      channelType: 'teams',
      conversationId: 'grp-1',
      conversationType: 'group',
      members: [],
      occurredAt: '2026-10-15T13:00:00.000Z',
    });

    let created = 0;
    services.conductorEphemeralRuns = {
      createEphemeralRun: async () => {
        created += 1;
        return { runId: 'run-2', workflowId: 'wf-2', workflowSlug: 'eph-2', expiresAt: '2026-10-17T00:00:00.000Z' };
      },
      listOwnRuns: async () => [
        {
          runId: 'run-42',
          workflowId: 'wf-42',
          workflowSlug: 'eph-facilitation-42',
          patternId: 'facilitation',
          expiresAt: '2026-10-16T12:00:00.000Z',
          payload: { goal: 'Termin finden', definitionOfDone: 'Ein Termin ist bestätigt', conversationId: 'grp-1' },
          state: { v: 1, phase: 'active', progress: { dodMet: false, summary: '4/6 abgestimmt', updatedAt: '2026-10-15T12:00:00.000Z' } },
        },
      ],
    };
    services.conversationBindings = { listOwnAttachments: async () => [] };

    const tool = (name: string) => handle.toolkit.tools.find((t) => t.spec.name === name)!;
    const status = (await tool('facilitation_status').handle({ conversationId: 'grp-1' })) as string;
    assert.ok(status.includes('Facilitation-Status: active'), status);
    assert.ok(status.includes('Ziel: Termin finden'), status);
    assert.ok(status.includes('Definition of Done: Ein Termin ist bestätigt'), status);
    assert.ok(status.includes('4/6 abgestimmt'), status);

    const start = (await tool('facilitation_start').handle({ goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' })) as string;
    assert.ok(start.includes('bereits eine Facilitation'), start);
    assert.equal(created, 0);
    await handle.close();
  });
});
