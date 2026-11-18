// Time-based work is a row in plg_omadia_agent_facilitator_jobs. Scheduling is idempotent by
// key; the scheduler (scheduler.ts) runs what is due under a lease.

import { insertIfAbsent } from '../db/sql.js';
import type { Job } from '../model.js';
import type { Work } from './core.js';

export async function scheduleJob(w: Work, kind: string, key: string, dueAt: Date, payload: Record<string, unknown> = {}): Promise<void> {
  await insertIfAbsent<Job>(
    w.tx,
    'plg_omadia_agent_facilitator_jobs',
    { facilitationId: w.f.id, kind, dedupeKey: `${w.f.id}:${kind}:${key}`, dueAt, payload, createdAt: w.now },
    '(dedupe_key)',
  );
}

export async function cancelJobs(w: Work, kinds: readonly string[]): Promise<void> {
  await w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $3
      WHERE facilitation_id = $1 AND status = 'pending' AND kind = ANY($2::text[])`,
    [w.f.id, `{${kinds.join(',')}}`, w.now],
  );
}
