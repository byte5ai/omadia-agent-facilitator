// Status on request (spec 5.7). Computed from the tables every time; the model
// never counts and never works out who is missing.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import { evaluate } from '../methods/evaluate.js';
import type { CastBallot, Tally } from '../methods/evaluate.js';
import type { Ballot } from '../methods/ballot.js';
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
  const all = await store.listParticipants(q, f.id);
  const active = all.filter((p) => p.status === 'active');
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

/** The tally of the open step as it stands, where its method has one. */
export function tallyOf(f: Facilitation, participation: Participation, hasOpenProposal: boolean): { tally: Tally; provisional: boolean } | undefined {
  const step = participation.step;
  if (!step?.method || step.method === 'consent' || step.method === 'assignment') return undefined;
  const latest = new Map<string, Ballot>();
  for (const c of participation.valid) {
    const ballot = c.payload['ballot'] as Ballot | undefined;
    if (ballot) latest.set(c.participantPrincipal, ballot);
  }
  const ballots: CastBallot[] = [...latest].map(([principal, ballot]) => ({ principal, ballot }));
  const points = step.methodConfig['points'];
  const outcome = evaluate({
    method: step.method,
    options: step.roundOptions ?? step.options,
    ...(Array.isArray(points) ? { points: points as number[] } : {}),
    ballots,
    activeParticipants: participation.active.map((p) => p.principalId),
    closeRule: f.closeRule,
    deadlineReached: false,
    hasOpenProposal,
  });
  if (outcome.state === 'waiting' || outcome.state === 'blocked_by_proposal') return outcome.provisional ? { tally: outcome.provisional, provisional: true } : undefined;
  if (outcome.state === 'clear' || outcome.state === 'tie') return { tally: outcome.tally, provisional: false };
  return undefined;
}

export async function statusText(q: Queryable, f: Facilitation): Promise<string> {
  const t = texts(f.language);
  const participation = await participationOf(q, f);
  const dod = await store.currentDod(q, f.id);
  const proposal = await store.openProposal(q, f.id);
  const steps = await store.listSteps(q, f.id);
  const step = participation.step;
  const counted = tallyOf(f, participation, proposal !== undefined);
  const options = step ? (step.roundOptions ?? step.options) : [];
  return t.status({
    phase: t.phase[f.phase],
    goal: f.goal,
    ...(step && steps.length > 1 ? { step: `${String(step.position)}/${String(steps.length)} ${step.title}` } : {}),
    dodVersion: dod?.version ?? 1,
    definitionOfDone: dod?.text ?? '',
    contributed: participation.contributed.map((p) => p.displayName),
    missing: participation.missing.map((p) => p.displayName),
    ...(counted && counted.tally.votes + counted.tally.abstentions > 0
      ? { tally: options.map((o) => `${o.label} ${String(counted.tally.scores[o.key] ?? 0)}`).join(', ') }
      : {}),
    provisional: counted?.provisional ?? false,
    ...(proposal ? { proposal: `${proposal.summary} (${formatWhen(proposal.windowEndsAt, f.timezone, f.language)})` } : {}),
    ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
  });
}
