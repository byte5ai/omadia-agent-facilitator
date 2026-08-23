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
