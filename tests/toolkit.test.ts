import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { CONFIG_DEFAULTS } from '../src/config.js';
import { buildFacilitationToolkit } from '../src/toolkit.js';
import { FacilitationStateStore } from '../src/stateStore.js';
import { facilitationRoleKey } from '../src/toolkit.js';
import type {
  ConversationBindingsService,
  ConversationRostersService,
  EphemeralRunsService,
  RoleAssignmentsService,
  TargetedSendService,
} from '../src/services.js';

const HOUR_MS = 60 * 60 * 1000;

function harness(opts?: {
  noEphemeralRuns?: boolean;
  createError?: Error;
  reportingMode?: 'result-only' | 'interim';
}): {
  tools: Map<string, (input: unknown) => Promise<string>>;
  store: FacilitationStateStore;
  createCalls: Array<Record<string, unknown>>;
  sendCalls: Array<Record<string, unknown>>;
  roleCalls: string[];
  attachCalls: Array<Record<string, unknown>>;
} {
  const createCalls: Array<Record<string, unknown>> = [];
  const sendCalls: Array<Record<string, unknown>> = [];
  const store = new FacilitationStateStore();

  const ephemeralRuns: EphemeralRunsService = {
    createEphemeralRun: async (input) => {
      createCalls.push(input as unknown as Record<string, unknown>);
      if (opts?.createError) throw opts.createError;
      return { runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'eph-facilitation-ab12cd34', expiresAt: '2026-08-22T10:00:00.000Z' };
    },
  };
  const targetedSend: TargetedSendService = {
    sendToPrincipal: async (request) => {
      sendCalls.push(request as unknown as Record<string, unknown>);
      return {
        resolution: { kind: 'role', holders: ['a@co.com', 'b@co.com'], partial: false },
        deliveries: [
          { principalId: 'a@co.com', outcome: { outcome: 'delivered' } },
          { principalId: 'b@co.com', outcome: { outcome: 'delivered' } },
        ],
        diagnostics: [],
      };
    },
  };
  const roleCalls: string[] = [];
  const attachCalls: Array<Record<string, unknown>> = [];
  const roleAssignments: RoleAssignmentsService = {
    ensureRole: async (input) => {
      roleCalls.push(`ensure:${input.roleKey}`);
    },
    addHolder: async (input) => {
      roleCalls.push(`add:${input.roleKey}:${input.holderId}`);
    },
    removeHolder: async () => undefined,
    holders: async () => [],
  };
  const conversationBindings: ConversationBindingsService = {
    bind: async () => ({ bound: true }),
    unbind: async () => ({ unbound: true }),
    attachWorkflow: async (input) => {
      attachCalls.push(input as unknown as Record<string, unknown>);
      return { attached: true };
    },
    observedInvite: () => undefined,
  };
  const rosters: ConversationRostersService = {
    getRoster: async () => ({
      conversationType: 'group',
      participants: [
        { userRef: { kind: 'teams-aad', id: 'aad-owner', displayName: 'Owner', email: 'Owner@Co.com' }, externalId: '29:owner' },
      ],
      partial: false,
    }),
  };
  const config = { ...CONFIG_DEFAULTS, reportingMode: opts?.reportingMode ?? CONFIG_DEFAULTS.reportingMode };
  const toolkit = buildFacilitationToolkit({
    agentId: '@omadia/agent-facilitator',
    config,
    store,
    getEphemeralRuns: () => (opts?.noEphemeralRuns ? undefined : ephemeralRuns),
    getTargetedSend: () => targetedSend,
    getRoleAssignments: () => roleAssignments,
    getConversationBindings: () => conversationBindings,
    getConversationRosters: () => rosters,
    log: () => undefined,
  });
  const tools = new Map(toolkit.map((t) => [t.spec.name, (input: unknown) => t.handle(input) as Promise<string>]));
  return { tools, store, createCalls, sendCalls, roleCalls, attachCalls };
}

describe('facilitation_start', () => {
  it('creates exactly one ephemeral run with the pattern slots + payload and returns the handshake', async () => {
    const { tools, store, createCalls, roleCalls, attachCalls } = harness();
    store.markPending({ conversationId: 'c1', channelType: 'teams', invitedBy: 'Owner', invitedByRef: { id: 'aad-owner', displayName: 'Owner' } });

    const out = await tools.get('facilitation_start')!({ goal: 'Rollen besetzen', definitionOfDone: 'Jede Rolle hat genau einen bestätigten Namen' });

    assert.equal(createCalls.length, 1);
    const call = createCalls[0]!;
    assert.equal(call.patternId, 'facilitation');
    assert.equal(call.agentId, '@omadia/agent-facilitator');
    const roleKey = facilitationRoleKey('c1');
    assert.deepEqual(call.slots, {
      agents: { facilitator: 'facilitator' },
      roles: { initiator: roleKey },
      channels: { report: 'teams' },
    });
    // C2b - inviter resolved via roster to the email-keyed holder, role provisioned, run attached.
    assert.deepEqual(roleCalls, [`ensure:${roleKey}`, `add:${roleKey}:owner@co.com`]);
    assert.equal(attachCalls.length, 1);
    assert.equal(attachCalls[0]!.roleKey, roleKey);
    assert.equal(attachCalls[0]!.workflowId, 'wf-1');
    assert.deepEqual(call.payload, { goal: 'Rollen besetzen', definitionOfDone: 'Jede Rolle hat genau einen bestätigten Namen' });
    assert.equal(call.ttlMs, 24 * HOUR_MS);

    assert.ok(out.includes('Ziel: Rollen besetzen'));
    assert.ok(out.includes('Definition of Done:'));
    assert.ok(out.includes('2026-08-22T10:00:00.000Z'));
    assert.ok(out.includes(`role:${facilitationRoleKey('c1')}`)); // disclosure default, per-conversation role
    assert.ok(out.includes('/facilitator stop'));
    assert.equal(store.get('c1')?.phase, 'active');
  });

  it('refuses a second start while one facilitation is active', async () => {
    const { tools, createCalls } = harness();
    await tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    const out = await tools.get('facilitation_start')!({ goal: 'g2', definitionOfDone: 'd2', conversationId: 'c1' });
    assert.equal(createCalls.length, 1);
    assert.ok(/bereits eine Facilitation/i.test(out));
  });

  it('refuses empty goal/DoD without touching the kernel', async () => {
    const { tools, createCalls } = harness();
    const out = await tools.get('facilitation_start')!({ goal: '  ', definitionOfDone: '' });
    assert.equal(createCalls.length, 0);
    assert.ok(out.includes('goal und definitionOfDone'));
  });

  it('degrades honestly without the kernel service and maps quota errors', async () => {
    const missing = harness({ noEphemeralRuns: true });
    const out1 = await missing.tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd' });
    assert.ok(out1.includes('conductorEphemeralRuns'));

    const quotaError = Object.assign(new Error('3 concurrent'), { name: 'EphemeralQuotaExceededError' });
    const denied = harness({ createError: quotaError });
    const out2 = await denied.tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    assert.ok(out2.includes('Guardrail'));
  });

  it('refuses without any known target conversation (no pending invite, no conversationId)', async () => {
    const { tools, createCalls } = harness();
    const out = await tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd' });
    assert.equal(createCalls.length, 0);
    assert.ok(out.includes('conversationId'));
  });
});

describe('facilitation_status / facilitation_stop', () => {
  it('status is truthful for unknown and active facilitations', async () => {
    const { tools } = harness();
    const unknown = await tools.get('facilitation_status')!({});
    assert.ok(unknown.includes('Keine Facilitation'));

    await tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    const active = await tools.get('facilitation_status')!({ conversationId: 'c1' });
    assert.ok(active.includes('active'));
    assert.ok(active.includes('role:'));
  });

  it('stop marks stopped and names the honest limitation (run continues to deadline)', async () => {
    const { tools, store } = harness();
    await tools.get('facilitation_start')!({ goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    const out = await tools.get('facilitation_stop')!({ conversationId: 'c1' });
    assert.equal(store.get('c1')?.phase, 'stopped');
    assert.ok(out.includes('Deadline/TTL'));
  });
});

describe('facilitation_report', () => {
  it('delivers a final report to the initiator role', async () => {
    const { tools, sendCalls } = harness();
    const out = await tools.get('facilitation_report')!({ kind: 'final', text: 'Ergebnis: …' });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]!.principal, 'role:facilitation-initiator'); // no active facilitation - config default
    assert.ok(out.includes('zugestellt'));
    assert.ok(out.includes('2'));
  });

  it('gates interim reports on reporting_mode', async () => {
    const gated = harness();
    const out1 = await gated.tools.get('facilitation_report')!({ kind: 'interim', text: 'Stand' });
    assert.equal(gated.sendCalls.length, 0);
    assert.ok(out1.includes('deaktiviert'));

    const open = harness({ reportingMode: 'interim' });
    await open.tools.get('facilitation_report')!({ kind: 'interim', text: 'Stand' });
    assert.equal(open.sendCalls.length, 1);
  });
});
