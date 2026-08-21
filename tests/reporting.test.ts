import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { CONFIG_DEFAULTS } from '../src/config.js';
import { sendReport } from '../src/reporting.js';
import type { TargetedSendService } from '../src/services.js';

function service(result: Awaited<ReturnType<TargetedSendService['sendToPrincipal']>>): {
  targetedSend: TargetedSendService;
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    targetedSend: {
      sendToPrincipal: async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
        return result;
      },
    },
  };
}

describe('sendReport', () => {
  it('addresses the initiator role on the configured channel', async () => {
    const { targetedSend, requests } = service({
      resolution: { kind: 'role', holders: ['a@co.com'], partial: false },
      deliveries: [{ principalId: 'a@co.com', outcome: { outcome: 'delivered' } }],
      diagnostics: [],
    });
    const result = await sendReport({ targetedSend, config: CONFIG_DEFAULTS, log: () => undefined }, 'final', 'done');

    assert.equal(result.sent, true);
    assert.deepEqual(requests[0], {
      channelType: 'teams',
      principal: 'role:facilitation-initiator',
      message: { text: 'done' },
    });
  });

  it('surfaces partial holder lists and undelivered outcomes honestly', async () => {
    const { targetedSend } = service({
      resolution: { kind: 'role', holders: ['a@co.com'], partial: true },
      deliveries: [{ principalId: 'a@co.com', outcome: { outcome: 'unreachable', code: 'no_binding', message: 'x' } }],
      diagnostics: [{ code: 'role_resolution_partial', message: 'partial' }],
    });
    const result = await sendReport({ targetedSend, config: CONFIG_DEFAULTS, log: () => undefined }, 'final', 't');

    assert.equal(result.sent, false);
    assert.ok(result.summary.includes('NICHT zugestellt'));
    assert.ok(result.summary.includes('partial'));
  });

  it('a throwing delivery service becomes { sent: false } — never a throw out of the tool', async () => {
    const targetedSend: TargetedSendService = {
      sendToPrincipal: async () => {
        throw new Error('BF token expired');
      },
    };
    const result = await sendReport({ targetedSend, config: CONFIG_DEFAULTS, log: () => undefined }, 'final', 't');
    assert.equal(result.sent, false);
    assert.ok(result.summary.includes('BF token expired'));
  });

  it('gates interim on reporting_mode and degrades without the service', async () => {
    const gated = await sendReport({ targetedSend: undefined, config: CONFIG_DEFAULTS, log: () => undefined }, 'interim', 't');
    assert.equal(gated.sent, false);
    assert.ok(gated.summary.includes('deaktiviert'));

    const missing = await sendReport({ targetedSend: undefined, config: CONFIG_DEFAULTS, log: () => undefined }, 'final', 't');
    assert.equal(missing.sent, false);
    assert.ok(missing.summary.includes('targetedSend'));
  });
});
