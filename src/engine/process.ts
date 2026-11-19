// The moderation process (spec 5.4): an agenda of steps with timeboxes, what
// the engine keeps deterministic about them, and how one step leads to the
// next. The model moderates inside a step; the engine opens and closes steps,
// keeps time, knows who has not spoken yet, and never closes anything
// silently.

import { MINUTE_MS } from '../clock.js';
import { insert, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Cluster, Contribution, Facilitation, Participant, Proposal, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { recordContribution, writtenAfterStart } from './contributions.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { advance, castBallots, conclude, setAfterStepDecided } from './decide.js';
import { PRIORITY, isNo, isYes, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { cancelJobs, scheduleJob } from './jobs.js';
import { announceStepOpened, announceVote, facilitatorName, rulesOf, setStepOpener } from './lifecycle.js';
import { agree, decideProposal, isAgreement, openProposal, registerProposalKind } from './proposals.js';
import { closingSummary } from './protocol.js';
import { registerJobHandler } from './scheduler.js';
import { effectiveCloseRule, expectedNames } from './roll.js';
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
  const instruction = needsOptions(opened)
    ? t.needOptions(step.title)
    : [t.stepInstruction[step.kind], ...(opened.method === null && (step.kind === 'collect' || step.kind === 'discuss') ? [t.moveOnHint[step.kind]] : []), ...rulesOf(w.f, opened)].filter((l) => l !== '').join(' ');
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
export type StepFinishedHook = (w: Work, step: Step) => Promise<void>;
const stepFinished: StepFinishedHook[] = [];
/** A step is over, decided or closed (its card shows the result). */
export function onStepFinished(hook: StepFinishedHook): void {
  if (!stepFinished.includes(hook)) stepFinished.push(hook);
}

export async function afterStepClosed(w: Work, step: Step, ctx: { atDeadline: boolean }): Promise<void> {
  for (const hook of stepFinished) await hook(w, step);
  if (w.f.phase !== 'active') return;
  if (await dodMet(w)) {
    // Steps that only wrap up are not run after the result is in.
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_steps SET status = 'closed', closed_at = $2 WHERE facilitation_id = $1 AND status <> 'closed'`, [w.f.id, w.now]);
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
  w.post({ purpose: 'silent_invite_group', key: step.id, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: [t.silentInviteGroup(step.title), ...(step.method === null && ENDED_BY_THE_GROUP.has(step.kind) ? [t.afterInviteHint()] : [])].join(' ') });
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
      await insert<Cluster>(w.tx, 'plg_omadia_agent_facilitator_clusters', {
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

/** The word that moves a collecting step on, as its announcement says. */
const MOVE_ON = /^(next|weiter|move on|next step|n[aä]chster schritt)$/u;

/**
 * A message that is about the process, not a point to collect: it asks for
 * the vote, to move on or to skip, or it speaks to the facilitator. Such a
 * message is conversation and belongs to the facilitator's turn. A point that
 * happens to match costs its author one confirmation; a request that is
 * swallowed as a point costs the group its way forward.
 */
const ABOUT_PROCESS =
  /(?<!\p{L})(abstimm\p{L}*|abstimmung|vote|voting|n[aä]chste[rnms]? (schritt|punkt)|next (step|item|point)|weitergehen|weitermachen|move on|[uü]berspring\p{L}*|skip|facilitator|moderator\p{L}*|moderation)(?!\p{L})/iu;

function addressesProcess(text: string, facilitator: string): boolean {
  if (text.endsWith('?') || /^@\S+/u.test(text)) return true;
  if (ABOUT_PROCESS.test(text)) return true;
  const name = facilitator.trim().toLowerCase();
  return name !== '' && text.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(name);
}

/**
 * In a collecting step the announced format is "one point per message": a
 * participant's own message is their contribution, recorded at once and
 * without a model. "next" proposes to close the step (the group consents as
 * for every close). A question, a message addressed to the facilitator or one
 * about the process is conversation and goes to the facilitator's turn.
 */
/** Steps the group ends itself, with the announced word. */
const ENDED_BY_THE_GROUP = new Set<Step['kind']>(['collect', 'discuss']);

/**
 * "next" in a collecting or discussing step: the group wants to move on. The
 * engine reads the word itself and proposes to close the step; the group
 * consents as for every close.
 */
const movingOn: InboundHandler = async ({ w, record, author, command }) => {
  if (w.f.phase !== 'active' || !author || record.kind !== 'created') return undefined;
  if (record.quoted === true || record.forwarded === true || !MOVE_ON.test(command)) return undefined;
  if (!(await writtenAfterStart(w, record))) return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) return undefined;
  if (isChoiceVote(step)) {
    // In a vote the word asks to close it now: a change of its rule, which
    // the group decides.
    if ((await castBallots(w, step)).length === 0) return voteOpenHint(w, step, record.eventId, 'no_votes');
    if (await store.openProposal(w.tx, w.f.id)) {
      w.post({ purpose: 'proposal_busy', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).proposalBusy() });
      return { outcome: 'move_on_busy' };
    }
    // Whoever asks to close agrees to closing.
    await agree(w, await proposeVoteClose(w, step, author.principalId, record.messageId), author);
    return { outcome: 'move_on' };
  }
  if (step.method !== null || !ENDED_BY_THE_GROUP.has(step.kind)) return undefined;
  if (await store.openProposal(w.tx, w.f.id)) {
    w.post({ purpose: 'proposal_busy', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: texts(w.f.language).proposalBusy() });
    return { outcome: 'move_on_busy' };
  }
  await openProposal(w, { kind: 'step_close', summary: step.title, payload: { stepId: step.id }, proposedBy: author.principalId, proposalMessageId: record.messageId, windowMinutes: w.f.settings.confirmWindowMinutes });
  return { outcome: 'move_on' };
};

/**
 * In a collecting step the announced format is "one point per message": a
 * participant's own message is their contribution, recorded at once and
 * without a model. A question, a message addressed to the facilitator or one
 * about the process is conversation and goes to the facilitator's turn.
 */
const collecting: InboundHandler = async ({ w, record, author, command, retired }) => {
  if (w.f.phase !== 'active' || !author) return undefined;
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  if (record.quoted === true || record.forwarded === true) return undefined;
  if (!(await writtenAfterStart(w, record))) return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || step.kind !== 'collect' || step.method !== null) return undefined;
  const text = (record.text ?? '').trim();
  if (text === '') return undefined;
  // A bare yes or no answers something; it is not a point to collect.
  if (isYes(command) || isNo(command)) return undefined;
  if (addressesProcess(text, facilitatorName(w.f))) return undefined;
  await recordContribution(w, { record, author, step, kind: 'idea', payload: { text }, summary: text, interpreted: false, replaces: retired !== undefined });
  return { outcome: 'collected' };
};

/** Methods whose ballot is a choice between announced options. Consent and
 *  assignment are answered in free words, which the facilitator reads. */
const CHOICE_METHODS = new Set<NonNullable<Step['method']>>(['ranked', 'single', 'approval']);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words of somebody who wants something about the vote itself: its rules,
 *  its deadline, its options, its result. */
const ABOUT_THE_VOTE =
  /(?<!\p{L})(deadline|frist|verl[aä]nger\p{L}*|extend\p{L}*|propos\p{L}*|vorschlag\p{L}*|schlage|[aä]nder\p{L}*|change\p{L}*|regel\p{L}*|rules?|option\p{L}*|erinner\p{L}*|remind\p{L}*|ergebnis\p{L}*|results?|punkte?|points?|stimm\p{L}*)(?!\p{L})/iu;

/** The message names an option (by its label, or by its key as a word of its
 *  own) or abstains: it may be a ballot the engine could not read. */
function looksLikeBallot(text: string, step: Step, abstention: string): boolean {
  const options = step.roundOptions ?? step.options;
  const lower = text.toLowerCase();
  if (lower.includes(abstention.toLowerCase()) || /(?<!\p{L})(abstain|enthalt\p{L}*)(?!\p{L})/iu.test(text)) return true;
  return options.some((o) => lower.includes(o.label.toLowerCase()) || new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(o.key)}(?![\\p{L}\\p{N}])`, 'u').test(text));
}

export const isChoiceVote = (step: Step): step is Step & { method: NonNullable<Step['method']> } =>
  step.method !== null && CHOICE_METHODS.has(step.method) && (step.roundOptions ?? step.options).length > 0;

/** When the open vote closes, in the words of the group. */
export function voteClosesLine(f: Facilitation, step: Step): string {
  const t = texts(f.language);
  const until = step.roundDeadline ?? f.deadline;
  const when = until ? formatWhen(until, f.timezone, f.language) : undefined;
  return t.voteCloses(effectiveCloseRule(f), when);
}

/** Put "close the vote now" to the group. */
export async function proposeVoteClose(w: Work, step: Step, proposedBy: string, proposalMessageId?: string): Promise<Proposal> {
  const cast = (await castBallots(w, step)).length;
  const of = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active').length + expectedNames(w.f).length;
  return openProposal(w, {
    kind: 'vote_close',
    summary: step.title,
    payload: { stepId: step.id, round: step.round, cast, of },
    proposedBy,
    ...(proposalMessageId !== undefined ? { proposalMessageId } : {}),
    windowMinutes: w.f.settings.confirmWindowMinutes,
  });
}

/**
 * A process word in a vote that cannot do anything right now ("next" before
 * anybody voted, an agreement with nothing open to agree to): answered with
 * when the vote closes and how the group can close it earlier. Once per step
 * and reason; never dropped without an answer the first time.
 */
async function voteOpenHint(w: Work, step: Step, eventId: string, reason: 'no_votes' | 'nothing_open'): Promise<{ outcome: string }> {
  const t = texts(w.f.language);
  const said = Array.isArray(step.methodConfig['voteHints']) ? (step.methodConfig['voteHints'] as string[]) : [];
  const key = `${String(step.round)}:${reason}`;
  if (!said.includes(key)) {
    await store.patchStep(w.tx, step.id, { methodConfig: { ...step.methodConfig, voteHints: [...said, key] } });
    const lines = [voteClosesLine(w.f, step), reason === 'no_votes' ? t.voteCloseNeedsVotes() : t.voteCloseHow()];
    w.post({ purpose: 'vote_open_hint', key: eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: lines.join(' ') });
  }
  return { outcome: 'vote_open_hint' };
}

/**
 * In a vote between announced options the facilitator stays quiet (D19).
 *
 * Ballots and commands were read before this handler, without a model. What
 * is left is conversation among the group: it gets a model turn only when it
 * is meant for the facilitator (a question, its name, something about the
 * process) or may be a ballot in other words. Everything else is on record
 * and not answered: a facilitator that comments on small talk during a vote
 * is noise.
 */
const quietInAVote: InboundHandler = async ({ w, record, author, command }) => {
  if (w.f.phase !== 'active' || !author) return undefined;
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || !isChoiceVote(step)) return undefined;
  const text = (record.text ?? '').trim();
  if (text === '') return undefined;
  // An agreement that reached this handler agrees to nothing that is open
  // (proposals and confirmations were read before). It is about the process.
  if (record.kind === 'created' && record.quoted !== true && record.forwarded !== true && isAgreement(command)) return voteOpenHint(w, step, record.eventId, 'nothing_open');
  if (addressesProcess(text, facilitatorName(w.f)) || ABOUT_THE_VOTE.test(text) || looksLikeBallot(text, step, texts(w.f.language).words.abstention)) return undefined;
  return { outcome: 'not_addressed' };
};

export function installProcess(): void {
  registerInboundHandler(movingOn, PRIORITY.process);
  registerInboundHandler(collecting, PRIORITY.process);
  registerInboundHandler(quietInAVote, PRIORITY.quiet);
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

  // Closing a vote before its rule fires changes that rule for this vote:
  // the group consents, and then the votes cast are counted. A tie goes to a
  // runoff; the deadline has not passed.
  registerProposalKind('vote_close', {
    describe: (w, p) => texts(w.f.language).proposalKinds.vote_close(p.summary, Number(p.payload['cast'] ?? 0), Number(p.payload['of'] ?? 0)),
    accept: async (w, p) => {
      const step = await store.getStep(w.tx, String(p.payload['stepId']));
      if (step?.status !== 'open' || step.round !== Number(p.payload['round'])) return;
      await w.event('vote_closed_early', 'group', { stepId: step.id, round: step.round });
      await advance(w, 'group');
    },
  });

  registerProposalKind('clusters', {
    describe: (w, p) => texts(w.f.language).proposalKinds.clusters((p.payload['lines'] as string[]) ?? []),
    accept: async (w, p) => {
      for (const id of (p.payload['clusterIds'] as string[]) ?? []) await update(w.tx, 'plg_omadia_agent_facilitator_clusters', { id }, { confirmed: true });
      await w.event('clusters_confirmed', 'group', { lines: p.payload['lines'] });
    },
    // A cluster the group did not confirm is not part of the record.
    reject: async (w, p) => {
      for (const id of (p.payload['clusterIds'] as string[]) ?? []) await w.tx.query('DELETE FROM plg_omadia_agent_facilitator_clusters WHERE id = $1 AND confirmed = false', [id]);
    },
  });

  registerProposalKind('summary', {
    describe: (w, p) => texts(w.f.language).proposalKinds.summary(p.summary),
    accept: async (w, p) => w.event('summary_confirmed', 'group', { text: p.summary, stepId: p.payload['stepId'] }),
  });

  registerProposalKind('decision', {
    describe: (w, p) => texts(w.f.language).proposalKinds.decision(p.summary),
    accept: async (w, p) => {
      await insert(w.tx, 'plg_omadia_agent_facilitator_decisions', {
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
