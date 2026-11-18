// From ballots to decisions (spec 5.5): record a ballot, evaluate the open
// step after every change, and move on by the evaluation table.
//
// Counting is `methods/evaluate.ts`; this module only loads the ballots from
// the tables, asks it, and acts: decision, runoff, objection, conclusion.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { HOUR_MS } from '../clock.js';
import type { PoolClientLike } from '../db/pool.js';
import { insert, rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import { parseBallot, summariseBallot } from '../methods/ballot.js';
import type { Ballot, Person } from '../methods/ballot.js';
import { DEFAULT_POINTS, evaluate } from '../methods/evaluate.js';
import type { AssignmentEvent, CastBallot, Evaluation, ItemAssignment } from '../methods/evaluate.js';
import type { Ack, Contribution, ContributionKind, Decision, OutboxRow, Participant, Step, StepOption } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { askClarification, cancelOpenRequests, writtenAfterStart, confirmContribution, declineContribution, mention, recordContribution } from './contributions.js';
import type { EngineCore, Work } from './core.js';
import { PRIORITY, ackResolvers, registerAfterInbound, registerInboundHandler } from './inbound.js';
import type { InboundHandler } from './inbound.js';
import { cancelJobs, scheduleJob } from './jobs.js';
import { abortInWork, announceVote, displayNameOf, releaseConversation, releaseOnEnd, runAbortHooks } from './lifecycle.js';
import { onMembershipChange } from './membership.js';
import { closingSummary } from './protocol.js';

export const roundOptions = (step: Step): StepOption[] => step.roundOptions ?? step.options;
const pointsOf = (step: Step): readonly number[] => {
  const points = step.methodConfig['points'];
  return Array.isArray(points) && points.every((p) => typeof p === 'number') ? (points as number[]) : DEFAULT_POINTS;
};
const people = (participants: readonly Participant[]): Person[] => participants.map((p) => ({ id: p.principalId, name: p.displayName }));
const ballotOf = (c: Contribution): Ballot | undefined => c.payload['ballot'] as Ballot | undefined;
const optionLabel = (options: readonly StepOption[], key: string): string => options.find((o) => o.key === key)?.label ?? key;

function kindOf(ballot: Ballot, author: string): ContributionKind {
  switch (ballot.type) {
    case 'abstention':
      return 'abstention';
    case 'consent':
      return ballot.consent ? 'confirmation' : 'objection';
    case 'assignment':
      return ballot.nominations.length > 0 && ballot.nominations.every((n) => n.nominee === author) ? 'commitment' : 'proposal';
    default:
      return 'vote';
  }
}

/** The latest valid ballot of each participant in the step's current round. */
export async function castBallots(w: Pick<Work, 'tx' | 'f'>, step: Step): Promise<CastBallot[]> {
  const valid = (await store.listContributions(w.tx, w.f.id, step.id)).filter((c) => c.status === 'valid' && c.round === step.round);
  const latest = new Map<string, Ballot>();
  for (const c of valid) {
    const ballot = ballotOf(c);
    if (ballot) latest.set(c.participantPrincipal, ballot);
  }
  return [...latest].map(([principal, ballot]) => ({ principal, ballot }));
}

/** Nominations, confirmations and declines of an assignment step, in order. */
export async function assignmentEvents(w: Pick<Work, 'tx' | 'f'>, step: Step): Promise<AssignmentEvent[]> {
  const valid = (await store.listContributions(w.tx, w.f.id, step.id)).filter((c) => c.status === 'valid');
  return valid.map((c) => {
    const ballot = ballotOf(c);
    const confirms = c.payload['confirmItems'];
    return {
      principal: c.participantPrincipal,
      nominations: ballot?.type === 'assignment' ? ballot.nominations : [],
      declines: ballot?.type === 'assignment' ? ballot.declines : [],
      confirms: Array.isArray(confirms) ? (confirms as string[]) : [],
    };
  });
}

export async function evaluateStep(w: Pick<Work, 'tx' | 'f' | 'now'>, step: Step, deadlineReached: boolean): Promise<Evaluation> {
  if (!step.method) throw new Error('evaluateStep on a step without a method');
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  return evaluate({
    method: step.method,
    options: roundOptions(step),
    points: pointsOf(step),
    ballots: await castBallots(w, step),
    assignmentEvents: step.method === 'assignment' ? await assignmentEvents(w, step) : [],
    activeParticipants: active.map((p) => p.principalId),
    closeRule: w.f.closeRule,
    deadlineReached,
    hasOpenProposal: (await store.openProposal(w.tx, w.f.id)) !== undefined,
  });
}

// ── recording ───────────────────────────────────────────────────────────────

export interface BallotInput {
  record: ConversationMessageRecord;
  author: Participant;
  step: Step;
  ballot: Ballot;
  interpreted: boolean;
  replaces?: boolean;
  source?: 'message' | 'card';
}

/** One ballot counts per person and round. A ballot replaces the ones that
 *  were recorded up to `asOf` (for a confirmed reading: up to the moment the
 *  confirmation was asked for). If the person has voted again since, that
 *  newer ballot stands and `keepId` is the one that is retired. */
async function supersedeOlderBallots(w: Work, step: Step, principal: string, keepId: string, asOf?: Date): Promise<'kept' | 'retired'> {
  const others = (await store.listContributions(w.tx, w.f.id, step.id)).filter(
    (c) => c.id !== keepId && c.participantPrincipal === principal && c.round === step.round && c.status === 'valid' && ballotOf(c) !== undefined,
  );
  const newer = asOf ? others.filter((c) => c.recordedAt.getTime() > asOf.getTime()) : [];
  if (newer.length > 0) {
    await store.patchContribution(w.tx, keepId, { status: 'superseded' });
    return 'retired';
  }
  for (const c of others) await store.patchContribution(w.tx, c.id, { status: 'superseded' });
  return 'kept';
}

async function promptNominees(w: Work, input: BallotInput, contribution: Contribution, participants: readonly Participant[]): Promise<void> {
  if (input.ballot.type !== 'assignment') return;
  const t = texts(w.f.language);
  const options = roundOptions(input.step);
  // Saying something about an item yourself settles what waited for you there.
  const own = [...input.ballot.nominations.filter((n) => n.nominee === input.author.principalId).map((n) => n.item), ...input.ballot.declines];
  for (const ack of await store.pendingAcks(w.tx, w.f.id, input.author.principalId)) {
    if (ack.kind === 'nomination' && own.includes(String(ack.detail['item']))) {
      await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: 'cancelled', resolvedAt: w.now });
    }
  }
  for (const nomination of input.ballot.nominations) {
    if (nomination.nominee === input.author.principalId) continue;
    const nominee = participants.find((p) => p.principalId === nomination.nominee);
    if (!nominee) continue;
    const item = optionLabel(options, nomination.item);
    const ack = await insert<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', {
      facilitationId: w.f.id,
      principal: nominee.principalId,
      kind: 'nomination',
      refId: contribution.id,
      detail: { item: nomination.item, summary: item },
      createdAt: w.now,
    });
    w.post({
      purpose: 'nomination',
      key: ack.id,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['active'],
      text: t.nominated(nominee.displayName, input.author.displayName, item),
      mentions: [mention(nominee)],
      link: { kind: 'ack', id: ack.id },
    });
  }
}

/** Record a ballot from a kernel record. A ballot in the announced format
 *  counts at once; one read from free text waits for its author. */
export async function recordBallot(w: Work, input: BallotInput): Promise<Contribution> {
  const t = texts(w.f.language);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const summary = summariseBallot(input.ballot, roundOptions(input.step), people(participants), t.words);
  const hadOlder =
    input.ballot.type !== 'assignment' &&
    (await store.listContributions(w.tx, w.f.id, input.step.id)).some(
      (c) => c.participantPrincipal === input.author.principalId && c.round === input.step.round && c.status === 'valid' && ballotOf(c) !== undefined,
    );
  const contribution = await recordContribution(w, {
    record: input.record,
    author: input.author,
    step: input.step,
    kind: kindOf(input.ballot, input.author.principalId),
    payload: { ballot: input.ballot },
    summary,
    interpreted: input.interpreted,
    replaces: input.replaces === true || hadOlder,
    ...(input.source ? { source: input.source } : {}),
  });
  if (!input.interpreted) await countBallot(w, input, contribution, participants);
  return contribution;
}

/** What happens once a ballot counts (at once, or when its author confirmed).
 *  `requestedAt` is set for a confirmed reading: when the confirmation was
 *  asked for. */
async function countBallot(w: Work, input: BallotInput, contribution: Contribution, participants: readonly Participant[], requestedAt?: Date): Promise<void> {
  if (input.ballot.type === 'assignment') {
    await promptNominees(w, input, contribution, participants);
    return;
  }
  await supersedeOlderBallots(w, input.step, input.author.principalId, contribution.id, requestedAt);
  // A vote cast directly settles what was waiting for this person's "yes".
  if (!requestedAt) await cancelOpenRequests(w, input.step.id, input.author.principalId);
}

// ── moving on ───────────────────────────────────────────────────────────────

export type Trigger = 'contribution' | 'deadline';

async function decide(w: Work, step: Step, statement: string, result: Record<string, unknown>): Promise<Decision> {
  const decision = await insert<Decision>(w.tx, 'plg_omadia_agent_facilitator_decisions', {
    facilitationId: w.f.id,
    stepId: step.id,
    statement,
    method: step.method ?? 'none',
    result,
    decidedAt: w.now,
  });
  await store.patchStep(w.tx, step.id, { status: 'closed', closedAt: w.now });
  await cancelJobs(w, ['runoff_deadline', 'timebox_end']);
  await w.event('decided', 'engine', { stepId: step.id, statement, result });
  w.bump();
  return decision;
}

export type StepClosedHook = (w: Work, step: Step, ctx: { atDeadline: boolean }) => Promise<void>;
let afterStepDecided: StepClosedHook = async (w, _step, ctx) => {
  // Without an agenda (process.ts replaces this) a decided step is the end.
  await conclude(w, ctx);
};

/** What follows a decided step: the next step of the agenda, or the end. */
export function setAfterStepDecided(hook: StepClosedHook): void {
  afterStepDecided = hook;
}

/** The definition of done is met: reminders stop in this transaction and the
 *  result goes to the group. */
export async function conclude(w: Work, ctx: { atDeadline: boolean }): Promise<void> {
  if (w.f.phase !== 'active') return;
  const t = texts(w.f.language);
  const decisions = await store.listDecisions(w.tx, w.f.id);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const active = participants.filter((p) => p.status === 'active');
  // "N of M contributed" at a deadline is about what was decided: who voted
  // in the last deciding step, not who said anything earlier.
  const decided = [...(await store.listSteps(w.tx, w.f.id))].reverse().find((s) => s.method !== null);
  const contributed = new Set(
    (await store.listContributions(w.tx, w.f.id))
      .filter((c) => c.status === 'valid' && (!decided || (c.stepId === decided.id && c.round === decided.round)))
      .map((c) => c.participantPrincipal),
  );
  const summary = await closingSummary(w);
  const text = t.result({
    goal: w.f.goal,
    decisions: decisions.map((d) => d.statement),
    actions: summary.actions,
    open: summary.open,
    ...(ctx.atDeadline ? { atDeadline: { contributed: active.filter((p) => contributed.has(p.principalId)).length, of: active.length } } : {}),
  });
  await w.patch({ phase: 'concluding', concludedAt: w.now, result: { text, decisions: decisions.map((d) => d.statement), atDeadline: ctx.atDeadline } });
  // Nothing time-based survives the conclusion: no reminder after completion.
  // Only the maximum duration stays, so a result that cannot be posted does
  // not keep the facilitation open forever.
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending' AND kind <> 'lifetime'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_acks SET status = 'cancelled', resolved_at = $2 WHERE facilitation_id = $1 AND status = 'pending'`, [w.f.id, w.now]);
  w.post({ purpose: 'result', key: 'group', to: 'group', deliveryClass: 'essential', text });
  await w.event('concluded', 'engine', { atDeadline: ctx.atDeadline });
}

export type AfterClose = (w: Work) => Promise<void>;
const afterClose: AfterClose[] = [];
/** Work that starts when a facilitation closed with a result (the report to
 *  the initiator, the follow-up of action items). */
export function onClosed(hook: AfterClose): void {
  if (!afterClose.includes(hook)) afterClose.push(hook);
}

/** concluding -> closed once the group has its result. Runs after every
 *  delivery, under the lock. */
export async function closeWhenResultDelivered(engine: EngineCore, client: PoolClientLike, facilitationId: string): Promise<void> {
  const f = await store.getFacilitation(client, facilitationId);
  if (!f) return;
  if (f.phase === 'concluding') {
    const results = await rows<OutboxRow>(client, `SELECT * FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'result' ORDER BY seq`, [f.id]);
    const sent = results.some((r) => r.status === 'sent');
    const gaveUp = results.find((r) => r.status === 'failed' || r.status === 'dropped');
    if (!sent && gaveUp) {
      await endUndelivered(engine, client, f.id, gaveUp.lastError ?? gaveUp.dropReason ?? 'unknown');
      return;
    }
    if (!sent) return;
    await engine.deps.hooks?.beforeClose?.();
    await engine.workOn(client, f.id, async (w) => {
      await w.patch({ phase: 'closed', closedAt: w.now, closeReason: 'result' });
      await releaseOnEnd(w, engine.config.retentionDays);
      await w.event('closed', 'engine', {});
      for (const hook of afterClose) await hook(w);
    });
  }
}

/**
 * The result exists but could not be posted, finally. The facilitation does
 * not stay `concluding`: it ends, with a record of why, a retention date, and
 * the result kept for the operator and for the initiator's report.
 */
export async function endUndelivered(engine: EngineCore, client: PoolClientLike, facilitationId: string, error: string): Promise<void> {
  await engine.workOn(client, facilitationId, async (w) => {
    if (w.f.phase !== 'concluding') return;
    const t = texts(w.f.language);
    const reason = t.abortResultUndelivered(error);
    await w.patch({ phase: 'aborted', closedAt: w.now, closeReason: reason });
    await releaseOnEnd(w, engine.config.retentionDays);
    await w.event('result_undelivered', 'engine', { error, result: w.f.result });
    engine.log(`facilitation ${w.f.id}: ${reason}; ended without the group having its result`);
    await runAbortHooks(w, t.resultUndeliveredReport(String(w.f.result?.['text'] ?? '')));
  });
}

/** After the lock is released: stop reading a conversation whose facilitation
 *  has ended. Runs outside the lock because it queries the pool and calls the
 *  kernel. */
export async function releaseWhenEnded(engine: EngineCore, facilitationId: string): Promise<void> {
  const f = await store.getFacilitation(engine.pool(), facilitationId);
  if (f && (f.phase === 'closed' || f.phase === 'aborted')) await releaseConversation(engine, f);
}

const abort = (w: Work, reason: string): Promise<void> => abortInWork(w, { reason, actor: 'engine' });

function scoreLine(options: readonly StepOption[], scores: Record<string, number>): string {
  return options.map((o) => `${o.label} ${String(scores[o.key] ?? 0)}`).join(', ');
}

/** Evaluate the open step and act on the outcome. */
export async function advance(w: Work, trigger: Trigger): Promise<Evaluation | undefined> {
  if (w.f.phase !== 'active') return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step?.method) {
    if (trigger === 'deadline') await abort(w, texts(w.f.language).abortNothing());
    return undefined;
  }
  const t = texts(w.f.language);
  const options = roundOptions(step);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const deadlineReached = trigger === 'deadline';
  const outcome = await evaluateStep(w, step, deadlineReached);
  const cast = new Set((await castBallots(w, step)).map((b) => b.principal));
  const votesMissing = deadlineReached && participants.some((p) => p.status === 'active' && !cast.has(p.principalId));
  const name = (id: string | undefined): string => displayNameOf(participants, id ?? null, texts(w.f.language).unnamedPerson);

  switch (outcome.state) {
    case 'waiting':
    case 'blocked_by_proposal':
      return outcome;

    case 'clear': {
      const statement = t.decided.winner(step.title, optionLabel(options, outcome.winner), scoreLine(options, outcome.tally.scores));
      await decide(w, step, statement, { winner: outcome.winner, scores: outcome.tally.scores, round: step.round });
      await afterStepDecided(w, step, { atDeadline: votesMissing });
      return outcome;
    }

    case 'tie': {
      const tied = outcome.tied.map((k) => optionLabel(options, k));
      if (deadlineReached) {
        // Nobody scored at all: that is not a tie between the options. (In a
        // runoff the tie of the round before still stands and is named.)
        if (outcome.tally.votes === 0 && step.round === 1) await abort(w, outcome.tally.abstentions > 0 ? t.abortOnlyAbstentions() : t.abortNoVotes());
        else await abort(w, t.abortTie(t.list(tied)));
        return outcome;
      }
      // Runoff among the tied options, same method; it ends at the earlier of
      // the deadline and the runoff window, and a second runoff does not
      // extend the first.
      const windowEnd = new Date(w.now.getTime() + w.f.settings.runoffWindowHours * HOUR_MS);
      const until = step.roundDeadline ?? (w.f.deadline && w.f.deadline < windowEnd ? w.f.deadline : windowEnd);
      const next = step.round + 1;
      await store.patchStep(w.tx, step.id, { round: next, roundOptions: options.filter((o) => outcome.tied.includes(o.key)), roundDeadline: until });
      await scheduleJob(w, 'runoff_deadline', step.id, until, { stepId: step.id });
      // A new round: readings of the old one that still wait for a "yes" are void.
      await cancelOpenRequests(w, step.id);
      w.bump();
      await w.event('runoff', 'engine', { stepId: step.id, round: next, tied: outcome.tied, until: until.toISOString() });
      w.post({ purpose: 'runoff', key: `${step.id}:${String(next)}`, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: t.runoff(t.list(tied), formatWhen(until, w.f.timezone, w.f.language)) });
      const runoffStep = await store.getStep(w.tx, step.id);
      if (runoffStep) await announceVote(w, runoffStep);
      return outcome;
    }

    case 'consent_passed': {
      await decide(w, step, t.decided.consent(String(step.methodConfig['statement'] ?? step.title)), { consent: true, round: step.round });
      await afterStepDecided(w, step, { atDeadline: votesMissing });
      return outcome;
    }

    case 'objection': {
      const lines = outcome.objections.map((o) => `${name(o.principal)}: ${o.reason}`);
      if (deadlineReached) {
        await abort(w, t.abortObjection(lines.join('; ')));
        return outcome;
      }
      // Said once per state of the objections, not after every message.
      const signature = JSON.stringify([step.round, outcome.objections]);
      if (step.methodConfig['objectionAnnounced'] !== signature) {
        await store.patchStep(w.tx, step.id, { methodConfig: { ...step.methodConfig, objectionAnnounced: signature } });
        w.post({ purpose: 'objection', key: `${step.id}:${String(w.now.getTime())}`, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: t.objectionStands(lines) });
      }
      return outcome;
    }

    case 'assignment_done': {
      const pairs = outcome.assignments.map((a) => `${optionLabel(options, a.item)}: ${name(a.nominee)}`).join('; ');
      await decide(w, step, t.decided.assignment(step.title, pairs), { assignments: outcome.assignments });
      await afterStepDecided(w, step, { atDeadline: false });
      return outcome;
    }

    case 'assignment_open': {
      if (deadlineReached) {
        const open = [...outcome.openItems, ...outcome.unconfirmed].map((k) => optionLabel(options, k));
        await abort(w, t.abortOpenItems(t.list(open)));
      }
      return outcome;
    }
  }
}

/** Put an amended proposal to the group after an objection: a new round. */
export async function putAgain(w: Work, statement: string): Promise<void> {
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || step.method !== 'consent') throw new Error('no consent step is open');
  await store.patchStep(w.tx, step.id, { round: step.round + 1, methodConfig: { ...step.methodConfig, statement } });
  w.bump();
  await w.event('proposal_amended', 'facilitator', { stepId: step.id, round: step.round + 1, statement });
  w.post({ purpose: 'put_again', key: `${step.id}:${String(step.round + 1)}`, to: 'group', deliveryClass: 'essential', requiredPhases: ['active'], text: texts(w.f.language).putAgain(statement) });
}

// ── inbound ─────────────────────────────────────────────────────────────────

/** A message that is a ballot in the announced format, from first to last character. */
const ballots: InboundHandler = async ({ w, record, author, retired }) => {
  if (w.f.phase !== 'active' || !author) return undefined;
  if (record.kind !== 'created' && record.kind !== 'edited') return undefined;
  // A quoted or forwarded ballot is not the sender's ballot.
  if (record.quoted === true || record.forwarded === true) return undefined;
  if (!(await writtenAfterStart(w, record))) return undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step?.method) return undefined;
  const participants = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  const parsed = parseBallot({
    method: step.method,
    options: roundOptions(step),
    text: record.text ?? '',
    author: { id: author.principalId, name: author.displayName },
    people: people(participants),
  });
  if (parsed.kind === 'not_a_ballot') {
    // An option that is no longer up in the runoff deserves an answer.
    const outside = step.roundOptions && parseBallot({ method: step.method, options: step.options, text: record.text ?? '' }).kind === 'ballot';
    if (!outside) return undefined;
    const t = texts(w.f.language);
    await askClarification(w, { record, author, step, question: t.notInRunoff('', t.list(roundOptions(step).map((o) => o.label))).replace(/^, /, '') });
    return { outcome: 'ballot_not_in_runoff' };
  }
  if (parsed.kind === 'invalid') {
    // Refused with a hint; one question per message, and it does not count.
    await askClarification(w, { record, author, step, question: texts(w.f.language).hint[parsed.problem](parsed.detail) });
    return { outcome: `ballot_${parsed.problem}` };
  }
  const ballot = await withoutTakenItems(w, step, author, parsed.ballot, record.eventId);
  if (!ballot) return { outcome: 'ballot_item_taken' };
  await recordBallot(w, { record, author, step, ballot, interpreted: false, replaces: retired !== undefined });
  return { outcome: 'ballot' };
};

/** An item one person confirmed is taken: naming somebody else for it is
 *  answered, not recorded. Undefined when nothing of the ballot is left. */
export async function withoutTakenItems(w: Work, step: Step, author: Participant, ballot: Ballot, key: string): Promise<Ballot | undefined> {
  if (ballot.type !== 'assignment' || step.method !== 'assignment') return ballot;
  const t = texts(w.f.language);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const current = (await evaluateStep(w, step, false)) as Extract<Evaluation, { assignments: ItemAssignment[] }>;
  const free = ballot.nominations.filter((n) => {
    const holder = current.assignments.find((a) => a.item === n.item);
    if (!holder?.confirmed || holder.nominee === n.nominee) return true;
    w.post({
      purpose: 'item_taken',
      key: `${key}:${n.item}`,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: t.itemTaken(author.displayName, optionLabel(roundOptions(step), n.item), displayNameOf(participants, holder.nominee ?? null, t.unnamedPerson)),
    });
    return false;
  });
  if (free.length === 0 && ballot.declines.length === 0) return undefined;
  return { ...ballot, nominations: free };
}

export function installDecisionMethods(): void {
  registerInboundHandler(ballots, PRIORITY.ballots);
  registerAfterInbound(async (w) => {
    await advance(w, 'contribution');
  });
  onMembershipChange(async (w) => {
    await advance(w, 'contribution');
  });

  // A ballot read from free text counts once its author confirmed it.
  ackResolvers['contribution'] = async (w, ack, author, record, confirmed) => {
    if (!confirmed) {
      await declineContribution(w, ack, author, record.messageId);
      return;
    }
    // A reading from an earlier round, or of a step that has closed, can no
    // longer be confirmed into the count.
    const waiting = await store.getContribution(w.tx, ack.refId);
    const waitingStep = waiting ? await store.getStep(w.tx, waiting.stepId) : undefined;
    if (waiting && waitingStep && ballotOf(waiting) !== undefined && (waitingStep.status !== 'open' || waiting.round !== waitingStep.round)) {
      await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: 'cancelled', resolvedAt: w.now, resolvedByMessageId: record.messageId });
      await store.patchContribution(w.tx, waiting.id, { status: 'superseded' });
      w.bump();
      return;
    }
    const contribution = await confirmContribution(w, ack, author, record.messageId);
    const ballot = contribution ? ballotOf(contribution) : undefined;
    if (!contribution || !ballot || !waitingStep) return;
    await countBallot(w, { record, author, step: waitingStep, ballot, interpreted: false }, contribution, await store.listParticipants(w.tx, w.f.id), ack.createdAt);
  };

  // The named person says yes or no in their own message.
  ackResolvers['nomination'] = async (w, ack, author, record, confirmed) => {
    const t = texts(w.f.language);
    const item = String(ack.detail['item']);
    const step = await store.openStepOf(w.tx, w.f.id);
    await update(w.tx, 'plg_omadia_agent_facilitator_acks', { id: ack.id }, { status: confirmed ? 'confirmed' : 'declined', resolvedAt: w.now, resolvedByMessageId: record.messageId });
    if (!step || step.method !== 'assignment') return;
    const label = optionLabel(roundOptions(step), item);
    await recordContribution(w, {
      record,
      author,
      step,
      kind: confirmed ? 'confirmation' : 'objection',
      payload: confirmed ? { confirmItems: [item] } : { ballot: { type: 'assignment', nominations: [], declines: [item] } },
      summary: confirmed ? label : `${label}: ${t.words.declined}`,
      interpreted: false,
      quiet: true,
    });
    w.post({
      purpose: confirmed ? 'nomination_accepted' : 'nomination_declined',
      key: ack.id,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: confirmed ? t.nominationAccepted(author.displayName, label) : t.nominationDeclined(author.displayName, label),
    });
  };

}
