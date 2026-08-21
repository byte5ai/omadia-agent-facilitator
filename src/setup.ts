// Auto-setup (#330 C2b): at activate time, make sure the top-level
// Facilitator agent exists — created via the kernel's agentProvisioning
// service with the bundled playbook as its persona skill (create-only,
// namespaced under the agent slug; the kernel refuses anything else).
// Honest degradation: no service / kernel not ready → logged, the operator
// path from the README still works.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FacilitatorConfig } from './config.js';
import type { AgentProvisioningService } from './services.js';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** The bundled playbook, frontmatter stripped — what the provisioned agent
 *  gets as persona. Undefined when the file is unreadable (never throws:
 *  auto-setup then provisions without a persona and says so). */
export function loadPlaybookBody(dir: string = SKILLS_DIR): string | undefined {
  try {
    const raw = readFileSync(join(dir, 'facilitator-playbook.md'), 'utf8');
    return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch {
    return undefined;
  }
}

export async function runAutoSetup(deps: {
  agentProvisioning: AgentProvisioningService | undefined;
  config: FacilitatorConfig;
  pluginId: string;
  playbookBody?: string;
  log: (msg: string) => void;
}): Promise<void> {
  if (!deps.config.autoSetup) {
    deps.log('auto_setup disabled — operator manages the agent manually');
    return;
  }
  if (!deps.agentProvisioning) {
    deps.log("kernel service 'agentProvisioning' not published — agent must be created manually (kernel < #330 C2a?)");
    return;
  }
  const slug = deps.config.facilitatorAgentSlug;
  try {
    const result = await deps.agentProvisioning.ensureAgent({
      slug,
      name: 'omadia Facilitator',
      description:
        'Moderiert Gruppen-Konversationen zu einem definierten Ergebnis (announced, transparent). Auto-provisioniert vom Facilitator-Plugin (#330).',
      pluginId: deps.pluginId,
      ...(deps.playbookBody
        ? { personaSkill: { slug: `${slug}-playbook`, name: 'Facilitator Playbook', body: deps.playbookBody } }
        : {}),
    });
    deps.log(
      result.created
        ? `auto-setup: agent '${slug}' provisioned${deps.playbookBody ? ' with persona playbook' : ' (no playbook body found)'}`
        : `auto-setup: agent '${slug}' already exists — left untouched`,
    );
  } catch (err) {
    // Activation must survive a failed auto-setup (10s budget, honest log).
    deps.log(`auto-setup failed (manual setup still possible): ${err instanceof Error ? err.message : String(err)}`);
  }
}
