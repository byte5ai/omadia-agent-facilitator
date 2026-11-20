// A rule change after a step closed (spec 5.7; #2062, criterion 57).
//
// A closed step is never re-opened. When the group changes how a closed step
// is decided, a new step linked to it repeats it with the new method and
// fresh contributions; the old step and its protocol stay as they were.
// Results derived from the old step (its decision, the decisions of later
// steps, the action items that hang off them) are `pending_repeat` until the
// repeat closes. Then the old decision is `replaced`; what followed from it
// holds again if the outcome is the same, and is `void` otherwise, with the
// owners told. A step that was running when the repeat opened waits and
// resumes after it; if the outcome changed, its contributions no longer fit
// and the people are asked to contribute again.

import { insert } from '../db/sql.js';
import * as store from '../db/store.js';
import type { ActionItem, Decision, MethodId, Step, StepOption } from '../model.js';
import { texts } from '../texts/index.js';
import { cancelOpenRequests, mention } from './contributions.js';
import type { Work } from './core.js';
import { cancelJobs } from './jobs.js';
import { displayNameOf, onAborted } from './lifecycle.js';
import { onStepFinished, openStep } from './process.js';

export interface RepeatRules {
  method: MethodId;
  options: StepOption[];
  methodConfig: Record<string, unknown>;
}

/** Positions from `from` on move one down, to make room at `from`. Done in
 *  two passes so the unique (facilitation, position) never collides. */
async function makeRoom(w: Work, from: number): Promise<void> {
  const OFFSET = 100000;
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET position = position + $3 WHERE facilitation_id = $1 AND position >= $2`, [w.f.id, from, OFFSET]);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET position = position - $2 + 1 WHERE facilitation_id = $1 AND position >= $2`, [w.f.id, OFFSET]);
}

/** Decisions that follow from a step: its own and those of later closed steps. */
async function derivedDecisions(w: Work, old: Step): Promise<Decision[]> {
  const steps = await store.listSteps(w.tx, w.f.id);
  const later = new Set(steps.filter((s) => s.position > old.position && s.status === 'closed').map((s) => s.id));
  return (await store.listDecisions(w.tx, w.f.id)).filter((d) => d.status === 'valid' && d.stepId !== null && (d.stepId === old.id || later.has(d.stepId)));
}

/** The latest repeat of a step (following repeats of repeats), or the step. */
export function latestRepeatOf(steps: readonly Step[], step: Step): Step {
  let current = step;
  for (;;) {
    const next = steps.filter((s) => s.repeatsStepId === current.id).sort((a, b) => b.position - a.position)[0];
    if (!next) return current;
    current = next;
  }
}

/** Repeat a closed step with new rules: a linked new step, opened now. */
export async function repeatStep(w: Work, old: Step, rules: RepeatRules): Promise<Step> {
  const t = texts(w.f.language);
  const steps = await store.listSteps(w.tx, w.f.id);
  const running = steps.find((s) => s.status === 'open');
  const firstPending = steps.filter((s) => s.status === 'pending').sort((a, b) => a.position - b.position)[0];
  const at = running?.position ?? firstPending?.position ?? Math.max(0, ...steps.map((s) => s.position)) + 1;
  // The running step waits; what was said in it stays.
  if (running) {
    await store.patchStep(w.tx, running.id, { status: 'pending' });
    await cancelJobs(w, ['timebox_end', 'consent_window', 'runoff_deadline']);
    await cancelOpenRequests(w, running.id);
    await w.event('step_paused', 'engine', { stepId: running.id, for: old.id });
  }
  await makeRoom(w, at);
  const repeat = await insert<Step>(w.tx, 'plg_omadia_agent_facilitator_steps', {
    facilitationId: w.f.id,
    position: at,
    kind: old.kind,
    title: t.repeatTitle(old.title),
    timeboxMinutes: old.timeboxMinutes,
    method: rules.method,
    options: rules.options,
    methodConfig: rules.methodConfig,
    status: 'pending',
    repeatsStepId: old.id,
  });

  // What followed from the old result is pending until the repeat closes.
  const derived = await derivedDecisions(w, old);
  for (const d of derived) await w.tx.query(`UPDATE plg_omadia_agent_facilitator_decisions SET status = 'pending_repeat' WHERE id = $1`, [d.id]);
  const items = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.decisionId !== null && derived.some((d) => d.id === a.decisionId) && (a.status === 'proposed' || a.status === 'confirmed'));
  for (const item of items) await w.tx.query(`UPDATE plg_omadia_agent_facilitator_action_items SET pending_repeat = true WHERE id = $1`, [item.id]);
  w.bump();
  await w.event('step_repeat_opened', 'engine', { stepId: repeat.id, repeats: old.id, pendingDecisions: derived.map((d) => d.id), pendingItems: items.map((a) => a.number) });
  w.post({ purpose: 'repeat_opened', key: repeat.id, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: t.repeatOpened(old.title) });
  // Whose commitments hang on the old result: owners of its action items,
  // people assigned in a later step, and those who took something on in the
  // step that now waits.
  const assigned = derived.flatMap((d) => (Array.isArray(d.result['assignments']) ? (d.result['assignments'] as { nominee?: string }[]).flatMap((a) => (a.nominee ? [a.nominee] : [])) : []));
  const waiting = running ? (await store.listContributions(w.tx, w.f.id, running.id)).filter((c) => c.status === 'valid').map((c) => c.participantPrincipal) : [];
  const owners = [...new Set([...items.map((a) => a.ownerPrincipal), ...assigned, ...waiting])];
  if (owners.length > 0) {
    const participants = await store.listParticipants(w.tx, w.f.id);
    const people = owners.map((id) => ({ principalId: id, displayName: displayNameOf(participants, id, t.unnamedPerson) }));
    w.post({ purpose: 'pending_repeat', key: repeat.id, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: t.pendingRepeat(t.list(people.map((p) => p.displayName)), old.title), mentions: people.map(mention) });
  }
  return openStep(w, repeat);
}

/** What a decision says, without its counts: the same outcome is the same
 *  winner, the same assignments, or a passed consent. */
const outcomeOf = (d: Decision | undefined): string => {
  if (!d) return '';
  const { winner, assignments, consent } = d.result as { winner?: unknown; assignments?: unknown; consent?: unknown };
  return JSON.stringify(winner ?? assignments ?? consent ?? d.statement);
};

/** The repeat closed: its outcome replaces the old one. */
async function repeatClosed(w: Work, repeat: Step): Promise<void> {
  if (!repeat.repeatsStepId) return;
  const t = texts(w.f.language);
  const old = await store.getStep(w.tx, repeat.repeatsStepId);
  if (!old) return;
  const decisions = await store.listDecisions(w.tx, w.f.id);
  const outcome = decisions.filter((d) => d.stepId === repeat.id).at(-1);
  const before = decisions.filter((d) => d.stepId === old.id && d.status === 'pending_repeat');
  const holds = before.length > 0 && before.every((d) => outcomeOf(d) === outcomeOf(outcome));
  for (const d of before) {
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_decisions SET status = 'replaced', replaced_by = $2 WHERE id = $1`, [d.id, outcome?.id ?? null]);
  }
  // Decisions of later steps that followed from the old result.
  const followed = decisions.filter((d) => d.stepId !== old.id && d.status === 'pending_repeat');
  for (const d of followed) await w.tx.query(`UPDATE plg_omadia_agent_facilitator_decisions SET status = $2 WHERE id = $1`, [d.id, holds ? 'valid' : 'void']);
  const items = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.pendingRepeat);
  const participants = await store.listParticipants(w.tx, w.f.id);
  for (const item of items) await settleItem(w, item, holds, displayNameOf(participants, item.ownerPrincipal, t.unnamedPerson));
  // A step that waited for the repeat: its contributions no longer fit a
  // different outcome.
  if (!holds) {
    const waiting = (await store.listSteps(w.tx, w.f.id)).filter((s) => s.status === 'pending' && s.position > repeat.position && s.openedAt !== null);
    const stale = (await store.listContributions(w.tx, w.f.id)).filter((c) => waiting.some((s) => s.id === c.stepId) && (c.status === 'valid' || c.status === 'unconfirmed'));
    for (const c of stale) await store.patchContribution(w.tx, c.id, { status: 'superseded' });
    if (stale.length > 0) {
      const names = [...new Set(stale.map((c) => c.participantPrincipal))].map((id) => displayNameOf(participants, id, t.unnamedPerson));
      w.post({ purpose: 'act_again', key: `repeat:${repeat.id}`, to: 'group', deliveryClass: 'essential', text: t.actAgain(t.list(names)) });
    }
  }
  w.bump();
  await w.event('step_repeat_closed', 'engine', { stepId: repeat.id, repeats: old.id, holds, replaced: before.map((d) => d.id), voided: holds ? [] : followed.map((d) => d.id) });
  w.post({ purpose: 'repeat_closed', key: repeat.id, to: 'group', deliveryClass: 'essential', text: t.repeatClosed(old.title, holds) });
}

async function settleItem(w: Work, item: ActionItem, holds: boolean, owner: string): Promise<void> {
  if (holds) {
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_action_items SET pending_repeat = false WHERE id = $1`, [item.id]);
    return;
  }
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_action_items SET pending_repeat = false, status = 'void' WHERE id = $1`, [item.id]);
  await w.event('action_item_void', 'engine', { number: item.number });
  w.post({ purpose: 'action_void', key: item.id, to: 'group', deliveryClass: 'essential', text: texts(w.f.language).actionVoid(owner, item.number, item.description), mentions: [{ user: item.ownerPrincipal, text: owner }] });
}

/** Stopped or aborted while a repeat was open: what waited for it does not
 *  hold, and the protocol says so. */
async function abortedDuringRepeat(w: Work): Promise<void> {
  const pending = await w.tx.query(`UPDATE plg_omadia_agent_facilitator_decisions SET status = 'void' WHERE facilitation_id = $1 AND status = 'pending_repeat' RETURNING id`, [w.f.id]);
  const items = await w.tx.query(`UPDATE plg_omadia_agent_facilitator_action_items SET pending_repeat = false, status = 'void' WHERE facilitation_id = $1 AND pending_repeat RETURNING number`, [w.f.id]);
  if (pending.rows.length + items.rows.length > 0) await w.event('repeat_not_closed', 'engine', { decisions: pending.rows.length, items: items.rows.length });
}

export function installRepeats(): void {
  onStepFinished(async (w, step) => {
    if (step.repeatsStepId) await repeatClosed(w, step);
  });
  onAborted(async (w) => abortedDuringRepeat(w));
}
