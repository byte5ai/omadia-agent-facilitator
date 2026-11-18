// Formats as agenda templates (spec 5.4). Each is an editable agenda, not a
// fixed script: the facilitator proposes it, the group confirms or adjusts.

import type { FormatId, MethodId, StepKind } from '../model.js';

export interface TemplateStep {
  kind: StepKind;
  title: { en: string; de: string };
  timeboxMinutes?: number;
  method?: MethodId;
}

const step = (kind: StepKind, en: string, de: string, extra: Partial<TemplateStep> = {}): TemplateStep => ({ kind, title: { en, de }, ...extra });

export const FORMATS: Record<Exclude<FormatId, 'custom'>, readonly TemplateStep[]> = {
  decision: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'Collect options and positions', 'Optionen und Positionen sammeln'),
    step('discuss', 'Discuss', 'Diskutieren'),
    step('decide', 'Decide', 'Entscheiden', { method: 'ranked' }),
    step('close', 'Close', 'Abschluss'),
  ],
  prioritisation: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'Collect items', 'Themen sammeln'),
    step('cluster', 'Cluster', 'Clustern'),
    step('prioritise', 'Prioritise', 'Priorisieren', { method: 'ranked' }),
    step('close', 'Close', 'Abschluss'),
  ],
  assignment: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'List the items', 'Aufgaben auflisten'),
    step('assign', 'Assign', 'Zuweisen', { method: 'assignment' }),
    step('close', 'Close', 'Abschluss'),
  ],
  ideas: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'Collect ideas', 'Ideen sammeln'),
    step('cluster', 'Cluster', 'Clustern'),
    step('prioritise', 'Prioritise', 'Priorisieren', { method: 'approval' }),
    step('assign', 'Assign next steps', 'Nächste Schritte zuweisen'),
    step('close', 'Close', 'Abschluss'),
  ],
  retrospective: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'What went well, what did not', 'Was gut lief und was nicht'),
    step('cluster', 'Cluster', 'Clustern'),
    step('discuss', 'Discuss', 'Diskutieren'),
    step('decide', 'Decide actions', 'Maßnahmen beschließen'),
    step('assign', 'Assign owners', 'Verantwortliche zuweisen'),
    step('close', 'Close', 'Abschluss'),
  ],
  alignment: [
    step('open', 'Opening', 'Eröffnung'),
    step('collect', 'Collect positions and concerns', 'Positionen und Bedenken sammeln'),
    step('discuss', 'Discuss', 'Diskutieren'),
    step('decide', 'Confirm by consent', 'Im Konsent bestätigen', { method: 'consent' }),
    step('close', 'Close', 'Abschluss'),
  ],
};

export const FORMAT_IDS: readonly FormatId[] = ['decision', 'prioritisation', 'assignment', 'ideas', 'retrospective', 'alignment', 'custom'];
export const STEP_KINDS: readonly StepKind[] = ['open', 'collect', 'discuss', 'cluster', 'prioritise', 'decide', 'assign', 'close'];
