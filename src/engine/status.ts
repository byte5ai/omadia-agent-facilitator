// Status on request (spec 5.7). Computed from the tables every time; the model
// never counts and never works out who is missing.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Contribution, Facilitation, Participant, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';

export interface Participation {
  step: Step | undefined;
  active: Participant[];
  contributed: Participant[];
  missing: Participant[];
  /** Valid contributions of the open step's current round. */
  valid: Contribution[];
}

/** Who has contributed to the open step, and who has not. */
export async function participationOf(q: Queryable, f: Facilitation): Promise<Participation> {
  const active = (await store.listParticipants(q, f.id)).filter((p) => p.status === 'active');
  const all = await store.listParticipants(q, f.id);
  const step = await store.openStepOf(q, f.id);
  if (!step) return { step, active, contributed: [], missing: [], valid: [] };
  const valid = (await store.listContributions(q, f.id, step.id)).filter((c) => c.status === 'valid' && c.round === step.round);
  const done = new Set(valid.map((c) => c.participantPrincipal));
  return {
    step,
    active,
    // A person who left keeps their contribution and is never "missing".
    contributed: all.filter((p) => done.has(p.principalId)),
    missing: active.filter((p) => !done.has(p.principalId)),
    valid,
  };
}

export async function statusText(q: Queryable, f: Facilitation): Promise<string> {
  const t = texts(f.language);
  const participation = await participationOf(q, f);
  const dod = await store.currentDod(q, f.id);
  return t.statusBasics({
    phase: t.phase[f.phase],
    goal: f.goal,
    dodVersion: dod?.version ?? 1,
    contributed: participation.contributed.map((p) => p.displayName),
    missing: participation.missing.map((p) => p.displayName),
    ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
  });
}
