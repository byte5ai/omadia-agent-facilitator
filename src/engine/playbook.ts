// The moderation playbook: fixed core behaviour of every facilitator,
// shipped with the engine and given to each turn. The operator's persona tunes
// the tone; it cannot replace these techniques.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, '..', '..', 'skills'), join(here, '..', 'skills'), join(process.cwd(), 'skills')];
}

/** The playbook text; empty when the file is not shipped (never throws). */
export function playbook(): string {
  if (cached !== undefined) return cached;
  for (const dir of candidates()) {
    try {
      cached = readFileSync(join(dir, 'facilitator-playbook.md'), 'utf8').trim();
      return cached;
    } catch {
      // Try the next place.
    }
  }
  cached = '';
  return cached;
}
