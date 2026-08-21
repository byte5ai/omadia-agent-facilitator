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
