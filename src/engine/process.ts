// The moderation process (spec 5.4): an agenda of steps with timeboxes, what
// the engine keeps deterministic about them, and how one step leads to the
// next. The model moderates inside a step; the engine opens and closes steps,
// keeps time, knows who has not spoken yet, and never closes anything
// silently.

import { MINUTE_MS } from '../clock.js';
import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Cluster, Contribution, Participant, Proposal, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { recordContribution } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { castBallots, conclude, setAfterStepDecided } from './decide.js';
import { PRIORITY, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { cancelJobs, scheduleJob } from './jobs.js';
import { announceStepOpened, announceVote, rulesOf, setStepOpener } from './lifecycle.js';
import { decideProposal, openProposal, registerProposalKind } from './proposals.js';
import { closingSummary } from './protocol.js';
import { registerJobHandler } from './scheduler.js';
import { registerContextSection } from './turn.js';

const isDeciding = (step: Step): boolean => step.method !== null;
const needsOptions = (step: Step): boolean => step.method !== null && step.method !== 'consent' && step.options.length === 0;

async function dodMet(w: Work): Promise<boolean> {
  const dod = await store.currentDod(w.tx, w.f.id);
  const steps = await store.listSteps(w.tx, w.f.id);
  switch (dod?.criteria?.type) {
    case 'decisions_reached':
      return steps.some(isDeciding) && steps.filter(isDeciding).every((s) => s.status === 'closed');
    case 'all_steps_closed':
      return steps.length > 0 && steps.every((s) => s.status === 'closed');
    case 'action_items_confirmed': {
      const confirmed = (await store.listActionItems(w.tx, w.f.id)).filter((a) => a.status === 'confirmed' || a.status === 'done').length;
      return confirmed >= dod.criteria.min && steps.every((s) => s.status === 'closed');
    }
    default:
      // Free text: only the group can say that it is met.
      return false;
  }
}

/** Open a step and say so: what it is for, how to contribute, until when. */
export async function openStep(w: Work, step: Step): Promise<Step> {
  const t = texts(w.f.language);
  const steps = await store.listSteps(w.tx, w.f.id);
  const until = step.timeboxMinutes ? new Date(w.now.getTime() + step.timeboxMinutes * MINUTE_MS) : null;
  const opened = (await store.patchStep(w.tx, step.id, { status: 'open', openedAt: w.now, timeboxEndsAt: until })) ?? step;
  if (until) await scheduleJob(w, 'timebox_end', `${step.id}:${until.toISOString()}`, until, { stepId: step.id });
  w.bump();
  await w.event('step_opened', 'engine', { stepId: step.id, position: step.position, title: step.title, kind: step.kind });

  if (step.kind === 'close') {
    // The binding close: a summary the group confirms before anything closes.
    const summary = t.closeSummary(await closingSummary(w));
    await openProposal(w, { kind: 'close', summary, payload: { stepId: step.id }, proposedBy: 'engine', windowMinutes: w.f.settings.confirmWindowMinutes });
    return opened;
  }
  const instruction = needsOptions(opened) ? t.needOptions(step.title) : [t.stepInstruction[step.kind], ...rulesOf(w.f, opened)].filter((l) => l !== '').join(' ');
  w.post({
    purpose: 'step_opened',
    key: step.id,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['active'],
    text: t.stepOpened(step.position, steps.length, step.title, instruction, until ? formatWhen(until, w.f.timezone, w.f.language) : undefined),
  });
  await announceVote(w, opened);
  await announceStepOpened(w, opened);
  return opened;
}

/** After a step closed: conclude if the definition of done is met, otherwise
 *  open the next step. */
export async function afterStepClosed(w: Work, _step: Step, ctx: { atDeadline: boolean }): Promise<void> {
  if (w.f.phase !== 'active') return;
  if (await dodMet(w)) {
    // Steps that only wrap up are not run after the result is in.
    await w.tx.query(`UPDATE facilitation_steps SET status = 'closed', closed_at = $2 WHERE facilitation_id = $1 AND status <> 'closed'`, [w.f.id, w.now]);
    await conclude(w, ctx);
    return;
  }
  if (ctx.atDeadline) return;
  const next = (await store.listSteps(w.tx, w.f.id)).find((s) => s.status === 'pending');
  if (next) await openStep(w, next);
}

/** Close a step that is not decided by a method. */
export async function closeStep(w: Work, step: Step, actor: string): Promise<void> {
  await store.patchStep(w.tx, step.id, { status: 'closed', closedAt: w.now });
  await cancelJobs(w, ['timebox_end']);
  w.bump();
  await w.event('step_closed', actor, { stepId: step.id, title: step.title });
  if (step.kind !== 'close') w.post({ purpose: 'step_closed', key: step.id, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).stepClosed(step.title) });
  await afterStepClosed(w, step, { atDeadline: false });
}

export async function extendStep(w: Work, step: Step, minutes: number, actor: string): Promise<Date> {
  const t = texts(w.f.language);
  const from = step.timeboxEndsAt && step.timeboxEndsAt > w.now ? step.timeboxEndsAt : w.now;
  const until = new Date(from.getTime() + minutes * MINUTE_MS);
  await store.patchStep(w.tx, step.id, { timeboxEndsAt: until });
  await cancelJobs(w, ['timebox_end']);
  await scheduleJob(w, 'timebox_end', `${step.id}:${until.toISOString()}`, until, { stepId: step.id });
  w.bump();
  await w.event('step_extended', actor, { stepId: step.id, minutes, until: until.toISOString() });
  w.post({ purpose: 'step_extended', key: `${step.id}:${until.toISOString()}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.stepExtended(step.title, minutes, formatWhen(until, w.f.timezone, w.f.language)) });
  return until;
}

// ── participation balance ───────────────────────────────────────────────────

export interface Balance {
  step: Step;
  /** Contributions per active participant in this step, most first. */
  counts: { participant: Participant; count: number }[];
  silent: Participant[];
  /** Silent participants who were already invited in this step. */
  invited: Set<string>;
}

const counts = (c: Contribution): boolean => c.status === 'valid' || c.status === 'unconfirmed';

/** Who has contributed how much to the open step. Computed, never guessed. */
export async function balanceOf(w: Pick<Work, 'tx' | 'f'>, step: Step): Promise<Balance> {
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const contributions = (await store.listContributions(w.tx, w.f.id, step.id)).filter(counts);
  const perPerson = active.map((participant) => ({ participant, count: contributions.filter((c) => c.participantPrincipal === participant.principalId).length }));
  const invited = new Set(
    (await store.listEvents(w.tx, w.f.id, ['silent_invite'])).filter((e) => e.payload['stepId'] === step.id).map((e) => String(e.payload['principal'])),
  );
  return {
    step,
    counts: [...perPerson].sort((a, b) => b.count - a.count),
    silent: perPerson.filter((p) => p.count === 0).map((p) => p.participant),
    invited,
  };
}

/** Invite the people who have not contributed to the step yet: privately,
 *  with a neutral line in the group that names nobody. Returns how many. */
export async function inviteSilentVoices(w: Work, step: Step): Promise<number> {
  const t = texts(w.f.language);
  const balance = await balanceOf(w, step);
  const fresh = balance.silent.filter((p) => !balance.invited.has(p.principalId));
  if (fresh.length === 0) return 0;
  for (const person of fresh) {
    await w.event('silent_invite', 'engine', { stepId: step.id, principal: person.principalId });
    w.post({
      purpose: 'silent_invite',
      key: `${step.id}:${person.principalId}`,
      to: { principalId: person.principalId },
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['active'],
      text: t.silentInviteDirect(person.displayName, step.title),
    });
  }
  w.post({ purpose: 'silent_invite_group', key: step.id, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: t.silentInviteGroup(step.title) });
  return fresh.length;
}

// ── clusters ────────────────────────────────────────────────────────────────

/** The contributions of a step as the facilitator refers to them: numbered. */
export async function numberedContributions(w: Pick<Work, 'tx' | 'f'>, step: Step): Promise<{ number: number; contribution: Contribution }[]> {
  return (await store.listContributions(w.tx, w.f.id, step.id)).filter((c) => c.status === 'valid').map((contribution, i) => ({ number: i + 1, contribution }));
}

export async function proposeClusters(w: Work, step: Step, clusters: { label: string; members: number[] }[], targetStepId: string): Promise<Proposal> {
  const numbered = await numberedContributions(w, step);
  const created: Cluster[] = [];
  for (const cluster of clusters) {
    const members = cluster.members.map((n) => {
      const found = numbered.find((c) => c.number === n);
      if (!found) throw new Refusal('unknown_contribution', `There is no contribution #${String(n)} in "${step.title}".`);
      return found;
    });
    created.push(
      await insert<Cluster>(w.tx, 'facilitation_clusters', {
        facilitationId: w.f.id,
        stepId: targetStepId,
        label: cluster.label,
        memberContributionIds: members.map((m) => m.contribution.id),
        createdAt: w.now,
      }),
    );
  }
  const lines = clusters.map((c) => `${c.label}: ${c.members.map((n) => `#${String(n)}`).join(', ')}`);
  return openProposal(w, {
    kind: 'clusters',
    summary: lines.join('; '),
    payload: { clusterIds: created.map((c) => c.id), lines },
    proposedBy: 'facilitator',
    windowMinutes: w.f.settings.confirmWindowMinutes,
  });
}

// ── timeboxes ───────────────────────────────────────────────────────────────

/** A timebox ended: say where the step stands and let the group decide to
 *  close or extend. No step closes silently. */
async function timeboxEnded(w: Work, stepId: string): Promise<void> {
  const t = texts(w.f.language);
  const step = await store.getStep(w.tx, stepId);
  if (!step || step.status !== 'open' || w.f.phase !== 'active') return;
  if (step.timeboxEndsAt && step.timeboxEndsAt > w.now) return;
  if (isDeciding(step) && !needsOptions(step)) {
    const cast = new Set((await castBallots(w, step)).map((b) => b.principal));
    const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
    w.post({ purpose: 'timebox_over', key: step.id, to: 'group', deliveryClass: 'droppable', requiredPhases: ['active'], text: t.timeboxOverVote(step.title, active.filter((p) => !cast.has(p.principalId)).length) });
    return;
  }
  if (await store.openProposal(w.tx, w.f.id)) {
    // The open proposal is decided first; ask again shortly.
    const retry = new Date(w.now.getTime() + 5 * MINUTE_MS);
    await scheduleJob(w, 'timebox_end', `${step.id}:${retry.toISOString()}`, retry, { stepId: step.id });
    return;
  }
  const balance = await balanceOf(w, step);
  const total = balance.counts.reduce((sum, c) => sum + c.count, 0);
  w.post({ purpose: 'timebox_over', key: `${step.id}:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: t.timeboxOver(step.title, total, balance.counts.filter((c) => c.count > 0).length, balance.counts.length) });
  await openProposal(w, { kind: 'step_close', summary: step.title, payload: { stepId: step.id }, proposedBy: 'engine', windowMinutes: w.f.settings.confirmWindowMinutes });
}

// ── set-up of a deciding step during the facilitation ───────────────────────

export async function setDecision(w: Work, step: Step, patch: Partial<Pick<Step, 'method' | 'options' | 'methodConfig' | 'title'>>): Promise<Step> {
  const ballots = (await store.listContributions(w.tx, w.f.id, step.id)).filter((c) => c.status === 'valid' && c.payload['ballot'] !== undefined);
  if (ballots.length > 0) throw new Refusal('ballots_exist', 'People have already voted in this step. Changing it now needs a proposal the group consents to (facilitation_propose_change).');
  const updated = (await store.patchStep(w.tx, step.id, { ...patch })) ?? step;
  w.bump();
  await w.event('decision_set', 'facilitator', { stepId: step.id, method: updated.method, options: updated.options });
  if (updated.status === 'open') {
    const t = texts(w.f.language);
    w.post({ purpose: 'decision_set', key: `${step.id}:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: [t.decisionSet(updated.title), ...rulesOf(w.f, updated)].join(' ') });
    await announceVote(w, updated);
  }
  return updated;
}

/**
 * In a collecting step the announced format is "one point per message": a
 * participant's own message is their contribution, recorded at once and
 * without a model. A question, or a message addressed to the facilitator, is
 * conversation and goes to the facilitator's turn instead.
 */
const collecting: InboundHandler = async ({ w, record, author, retired }) => {
  if (w.f.phase !== 'active' || !author) return undefined;
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  if (record.quoted === true || record.forwarded === true) return undefined;
  if (!w.f.activatedAt || Date.parse(record.occurredAt) < w.f.activatedAt.getTime()) return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || step.kind !== 'collect' || step.method !== null) return undefined;
  const text = (record.text ?? '').trim();
  if (text === '' || text.endsWith('?') || /^@\S+/u.test(text)) return undefined;
  await recordContribution(w, { record, author, step, kind: 'idea', payload: { text }, summary: text, interpreted: false, replaces: retired !== undefined });
  return { outcome: 'collected' };
};

export function installProcess(): void {
  registerInboundHandler(collecting, PRIORITY.process);
  setAfterStepDecided(afterStepClosed);
  setStepOpener(openStep);
  registerJobHandler('timebox_end', async (w, job) => timeboxEnded(w, String(job.payload['stepId'])));

  registerProposalKind('step_close', {
    describe: (w, p) => texts(w.f.language).proposalKinds.step_close(p.summary),
    accept: async (w, p) => {
      const step = await store.getStep(w.tx, String(p.payload['stepId']));
      if (step?.status === 'open') await closeStep(w, step, 'group');
    },
    extend: async (w, p, minutes) => {
      const step = await store.getStep(w.tx, String(p.payload['stepId']));
      if (step?.status === 'open') await extendStep(w, step, minutes ?? Math.max(5, Math.round((step.timeboxMinutes ?? 20) / 2)), 'group');
    },
  });

  registerProposalKind('clusters', {
    describe: (w, p) => texts(w.f.language).proposalKinds.clusters((p.payload['lines'] as string[]) ?? []),
    accept: async (w, p) => {
      for (const id of (p.payload['clusterIds'] as string[]) ?? []) await update(w.tx, 'facilitation_clusters', { id }, { confirmed: true });
      await w.event('clusters_confirmed', 'group', { lines: p.payload['lines'] });
    },
    // A cluster the group did not confirm is not part of the record.
    reject: async (w, p) => {
      for (const id of (p.payload['clusterIds'] as string[]) ?? []) await w.tx.query('DELETE FROM facilitation_clusters WHERE id = $1 AND confirmed = false', [id]);
    },
  });

  registerProposalKind('summary', {
    describe: (w, p) => texts(w.f.language).proposalKinds.summary(p.summary),
    accept: async (w, p) => w.event('summary_confirmed', 'group', { text: p.summary, stepId: p.payload['stepId'] }),
  });

  registerProposalKind('decision', {
    describe: (w, p) => texts(w.f.language).proposalKinds.decision(p.summary),
    accept: async (w, p) => {
      await insert(w.tx, 'facilitation_decisions', {
        facilitationId: w.f.id,
        stepId: p.payload['stepId'] ?? null,
        statement: p.summary,
        method: 'consent',
        result: { consent: true },
        rationale: p.payload['rationale'] ?? null,
        decidedAt: w.now,
      });
      await w.event('decided', 'group', { statement: p.summary, rationale: p.payload['rationale'] });
    },
  });

  registerProposalKind('close', {
    describe: (w, p) => texts(w.f.language).proposalKinds.close(p.summary),
    accept: async (w, p) => {
      const step = await store.getStep(w.tx, String(p.payload['stepId']));
      if (step?.status === 'open') await closeStep(w, step, 'group');
    },
  });

  // What the facilitator needs to moderate the open step.
  registerContextSection(async (q, f) => {
    const steps = await store.listSteps(q, f.id);
    if (steps.length <= 1) return undefined;
    const open = steps.find((s) => s.status === 'open');
    const lines = ['# Agenda', ...steps.map((s) => `${String(s.position)}. ${s.title} [${s.kind}${s.method ? `, ${s.method}` : ''}] ${s.status}`)];
    if (open) {
      const balance = await balanceOf({ tx: q, f }, open);
      lines.push(
        `Contributions per person in the open step (for balance; never name in the group who has not contributed): ${balance.counts.map((c) => `${c.participant.displayName} ${String(c.count)}`).join(', ')}`,
      );
      if (needsOptions(open)) lines.push('The open step has no options yet: agree them with the group, then call facilitation_set_decision.');
      if (!isDeciding(open) && open.kind !== 'close') lines.push('When the step has served its purpose, call facilitation_step with action "close". The engine first invites whoever has not contributed.');
    }
    const proposal = await store.openProposal(q, f.id);
    if (proposal) lines.push(`Open proposal (${proposal.kind}), decided by the engine at ${proposal.windowEndsAt.toISOString()}: ${proposal.summary}. Moderate objections; do not open another proposal.`);
    return lines.join('\n');
  });
}

export { decideProposal };
