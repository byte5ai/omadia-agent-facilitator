// Status on request (spec 5.7). Computed from the tables every time; the model
// never counts and never works out who is missing.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import { evaluate } from '../methods/evaluate.js';
import type { CastBallot, Tally } from '../methods/evaluate.js';
import type { Ballot } from '../methods/ballot.js';
import type { Contribution, Facilitation, Participant, Step } from '../model.js';
import { lifecycleOf } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { listClosings, markOf, resultStatusWords } from './resultStatus.js';
import { effectiveCloseRule, expectedKeys, expectedNames } from './roll.js';

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
    activeParticipants: [...participation.active.map((p) => p.principalId), ...expectedKeys(f)],
    closeRule: effectiveCloseRule(f),
    deadlineReached: false,
    hasOpenProposal,
  });
  if (outcome.state === 'waiting' || outcome.state === 'blocked_by_proposal') return outcome.provisional ? { tally: outcome.provisional, provisional: true } : undefined;
  if (outcome.state === 'clear' || outcome.state === 'tie') return { tally: outcome.tally, provisional: false };
  return undefined;
}

/** The status once a facilitation has ended: what it reached, who took part
 *  in reaching it, and the action items with their owners. */
async function statusAfterClose(q: Queryable, f: Facilitation): Promise<string> {
  const t = texts(f.language);
  const participants = await store.listParticipants(q, f.id);
  const name = (principal: string): string => participants.find((p) => p.principalId === principal)?.displayName ?? principal;
  // Everybody whose contribution counted, over all steps: the step that was
  // open when it ended is not what the question is about any more.
  const counted = new Set((await store.listContributions(q, f.id)).filter((c) => c.status === 'valid').map((c) => c.participantPrincipal));
  // A nomination nobody accepted is no action item but an open point (criterion 37).
  const all = await store.listActionItems(q, f.id);
  const items = all.filter((a) => a.status === 'confirmed' || a.status === 'done');
  const notAccepted = all.filter((a) => a.status === 'proposed').map((a) => t.notAccepted(a.number, a.description, name(a.ownerPrincipal)));
  // Taking on an action item is a contribution as well.
  for (const item of items) if (item.status === 'confirmed' || item.status === 'done') counted.add(item.ownerPrincipal);
  const decisions = Array.isArray(f.result?.['decisions']) ? (f.result['decisions'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  const closing = (await listClosings(q, f.id)).find((c) => c.kind === (f.phase === 'aborted' ? 'abort' : 'result'));
  const mark = closing ? markOf(closing) : undefined;
  return t.statusAfterClose({
    phase: t.phase[lifecycleOf(f)],
    ...(mark ? { resultStatus: resultStatusWords(f.language, mark) } : closing?.requiresConfirmation ? { resultStatus: t.resultStatus.awaiting } : {}),
    goal: f.goal,
    ...(f.phase === 'aborted' && f.closeReason ? { reason: f.closeReason } : {}),
    decisions,
    contributed: participants.filter((p) => counted.has(p.principalId)).map((p) => p.displayName),
    actions: items.map((a) => t.actionLine(a.number, a.description, name(a.ownerPrincipal), formatWhen(a.dueDate, f.timezone, f.language), t.actionStatusWords[a.status])),
    open: items.filter((a) => a.status === 'confirmed').length,
    notAccepted,
    ...(f.followupState === 'active' && f.followupEndsAt ? { until: formatWhen(f.followupEndsAt, f.timezone, f.language) } : {}),
  });
}

/** Who asks: the group gets counts and never the names of who is missing;
 *  a home participant asking privately gets the names (spec 5.7, crit. 16). */
export type StatusAudience = 'group' | 'private';

export async function statusText(q: Queryable, f: Facilitation, audience: StatusAudience = 'group'): Promise<string> {
  // After `concluding` nothing is open any more: the result and its status.
  if (f.phase === 'closed' || f.phase === 'aborted' || f.phase === 'concluding') return statusAfterClose(q, f);
  const t = texts(f.language);
  const participation = await participationOf(q, f);
  const dod = await store.currentDod(q, f.id);
  const proposal = await store.openProposal(q, f.id);
  const steps = await store.listSteps(q, f.id);
  const step = participation.step;
  const counted = tallyOf(f, participation, proposal !== undefined);
  const options = step ? (step.roundOptions ?? step.options) : [];
  return t.status({
    phase: t.phase[lifecycleOf(f)],
    goal: f.goal,
    ...(step && steps.length > 1 ? { step: `${String(step.position)}/${String(steps.length)} ${step.title}` } : {}),
    dodVersion: dod?.version ?? 1,
    definitionOfDone: dod?.text ?? '',
    // The named people nobody was matched to are still to come.
    ...(audience === 'private'
      ? { contributed: participation.contributed.map((p) => p.displayName), missing: [...participation.missing.map((p) => p.displayName), ...(step ? expectedNames(f) : [])] }
      : { contributed: participation.contributed.length, missing: participation.missing.length + (step ? expectedNames(f).length : 0) }),
    ...(step?.method && options.length > 0 ? { options: t.options(options) } : {}),
    ...(counted && counted.tally.votes + counted.tally.abstentions > 0
      ? { tally: options.map((o) => `${o.label} ${String(counted.tally.scores[o.key] ?? 0)}`).join(', ') }
      : {}),
    provisional: counted?.provisional ?? false,
    ...(proposal ? { proposal: `${proposal.summary} (${formatWhen(proposal.windowEndsAt, f.timezone, f.language)})` } : {}),
    ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
  });
}
