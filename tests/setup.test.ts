import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_DEFAULTS } from '../src/config.js';
import { loadPlaybookBody, runAutoSetup } from '../src/setup.js';
import type { AgentProvisioningService } from '../src/services.js';

describe('loadPlaybookBody', () => {
  it('reads the bundled playbook and strips the frontmatter', () => {
    const body = loadPlaybookBody();
    assert.ok(body);
    assert.ok(!body.startsWith('---'), 'frontmatter must be stripped');
    assert.ok(body.includes('omadia Facilitator'));
  });

  it('returns undefined for an unreadable dir instead of throwing', () => {
    assert.equal(loadPlaybookBody('/nonexistent-dir'), undefined);
  });

  it('strips only a leading frontmatter block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    writeFileSync(join(dir, 'facilitator-playbook.md'), '---\nid: x\n---\n# Rolle\nText');
    assert.equal(loadPlaybookBody(dir), '# Rolle\nText');
  });
});

describe('runAutoSetup', () => {
  function provisioning(): { service: AgentProvisioningService; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      service: {
        ensureAgent: async (input) => {
          calls.push(input as unknown as Record<string, unknown>);
          return { created: true, agentSlug: input.slug };
        },
      },
    };
  }

  it('provisions the agent with the namespaced playbook persona', async () => {
    const { service, calls } = provisioning();
    await runAutoSetup({
      agentProvisioning: service,
      config: CONFIG_DEFAULTS,
      pluginId: '@omadia/agent-facilitator',
      playbookBody: '# Rolle',
      log: () => undefined,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.slug, 'facilitator');
    assert.deepEqual(calls[0]!.personaSkill, { slug: 'facilitator-playbook', name: 'Facilitator Playbook', body: '# Rolle' });
  });

  it('honours auto_setup=false and degrades honestly without the service or on errors', async () => {
    const { service, calls } = provisioning();
    const logs: string[] = [];
    await runAutoSetup({
      agentProvisioning: service,
      config: { ...CONFIG_DEFAULTS, autoSetup: false },
      pluginId: 'p',
      log: (m) => logs.push(m),
    });
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => l.includes('auto_setup disabled')));

    await runAutoSetup({ agentProvisioning: undefined, config: CONFIG_DEFAULTS, pluginId: 'p', log: (m) => logs.push(m) });
    assert.ok(logs.some((l) => l.includes("'agentProvisioning' not published")));

    await runAutoSetup({
      agentProvisioning: {
        ensureAgent: async () => {
          throw new Error('kernel down');
        },
      },
      config: CONFIG_DEFAULTS,
      pluginId: 'p',
      log: (m) => logs.push(m),
    }); // must not throw
    assert.ok(logs.some((l) => l.includes('auto-setup failed')));
  });
});
