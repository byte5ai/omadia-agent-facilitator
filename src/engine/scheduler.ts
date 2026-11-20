// The scheduler (spec 5.6): time runs from the facilitation's deadline, not
// from a round count.
//
// The kernel calls `tick()` on an interval (`ctx.jobs`). A tick leases the
// jobs that are due, so two replicas never run the same one, and runs each
// under its facilitation's lock: the job looks at the state as it is at that
// moment, never at what was true when it was scheduled. Time comes from the
// engine's clock, which a test moves by hand.

import { HOUR_MS, MINUTE_MS } from '../clock.js';
import { rows, update } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Job, Participant } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { advance, castBallots, evaluateStep } from './decide.js';
import { scheduleJob } from './jobs.js';
import { abortInWork } from './lifecycle.js';
import { recordRefusal } from './refusals.js';
import { stoppedByOperator } from './scopes.js';
import { participationOf } from './status.js';
import { retryHeldDecisions } from './electorate.js';
import { expectedNames, listKnown } from './roll.js';

export const LEASE_MS = 2 * MINUTE_MS;
export const MAX_JOB_ATTEMPTS = 5;
/** How late a reminder may be and still be sent. */
export const REMINDER_GRACE_MS = 15 * MINUTE_MS;
const BATCH = 50;

export type JobHandler = (w: Work, job: Job, prepared: unknown) => Promise<void>;
/** What a job needs from the kernel, fetched BEFORE its unit of work: no
 *  kernel call happens inside a transaction. */
export type JobPreparation = (engine: EngineCore, job: Job) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();
const preparations = new Map<string, JobPreparation>();

export function registerJobHandler(kind: string, handler: JobHandler, prepare?: JobPreparation): void {
  handlers.set(kind, handler);
  if (prepare) preparations.set(kind, prepare);
}

/** Lease the jobs that are due. `SKIP LOCKED` keeps replicas out of each
 *  other's way; an expired lease (a replica that died mid-job) is taken over. */
export function leaseDueJobs(engine: EngineCore, now: Date): Promise<Job[]> {
  return rows<Job>(
    engine.db(),
    `UPDATE plg_omadia_agent_facilitator_jobs SET lease_owner = $1, lease_until = $2
      WHERE id IN (
        SELECT id FROM plg_omadia_agent_facilitator_jobs
         WHERE status = 'pending' AND due_at <= $3 AND (lease_until IS NULL OR lease_until < $3)
         ORDER BY due_at, seq
         LIMIT ${String(BATCH)}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [engine.instanceId, new Date(now.getTime() + LEASE_MS), now],
  ).then((leased) => [...leased].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || Number(a.seq) - Number(b.seq)));
}

/** A job that talks to an integration. It runs OUTSIDE the facilitation's
 *  lock and takes the lock itself only for short units of work before and
 *  after the call; it marks itself done. */
export type ExternalJob = (engine: EngineCore, job: Job) => Promise<void>;
const external = new Map<string, ExternalJob>();

export function registerExternalJob(kind: string, run: ExternalJob): void {
  external.set(kind, run);
}

async function runJob(engine: EngineCore, job: Job): Promise<void> {
  await engine.deps.hooks?.beforeJob?.(job);
  // An operator's stop holds the scheduler too: the job stays due and runs
  // when the stop is lifted. It is not a failed attempt.
  try {
    const f = await store.getFacilitation(engine.db(), job.facilitationId);
    const check = f ? await stoppedByOperator(engine, f) : { stopped: false as const };
    if (check.stopped) {
      await update(engine.db(), 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { leaseOwner: null, leaseUntil: null });
      await recordRefusal(engine, job.facilitationId, { code: 'kill_switch', message: check.message, what: 'the scheduler' });
      return;
    }
  } catch (err) {
    engine.log(`facilitation ${job.facilitationId}: asking whether it is stopped failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const outside = external.get(job.kind);
  if (outside) {
    try {
      await outside(engine, job);
    } catch (err) {
      await jobFailed(engine, job, err);
    }
    return;
  }
  try {
    const prepared = await preparations.get(job.kind)?.(engine, job);
    await engine.work(job.facilitationId, async (w) => {
      // Under the lock: is it still mine to run? It may have been cancelled
      // by the vote that just concluded the facilitation.
      const current = (await rows<Job>(w.tx, 'SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE id = $1 FOR UPDATE', [job.id]))[0];
      if (!current || current.status !== 'pending' || current.leaseOwner !== engine.instanceId) return;
      const handler = handlers.get(current.kind);
      if (!handler) throw new Error(`no handler for job kind '${current.kind}'`);
      await handler(w, current, prepared);
      await update(w.tx, 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { status: 'done', finishedAt: w.now, leaseOwner: null, leaseUntil: null });
    });
  } catch (err) {
    await jobFailed(engine, job, err);
  }
}

/** A failed job is retried on the next tick. When the budget is spent the
 *  facilitation does not end silently: the group gets an abort report. */
async function jobFailed(engine: EngineCore, job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = job.attempts + 1;
  engine.log(`facilitation ${job.facilitationId}: job ${job.kind} failed (attempt ${String(attempts)}): ${message}`);
  if (attempts < MAX_JOB_ATTEMPTS) {
    await update(engine.db(), 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { attempts, lastError: message, leaseOwner: null, leaseUntil: null });
    return;
  }
  await update(engine.db(), 'plg_omadia_agent_facilitator_jobs', { id: job.id }, { status: 'failed', attempts, lastError: message, finishedAt: engine.now(), leaseOwner: null, leaseUntil: null });
  try {
    await engine.work(job.facilitationId, async (w) => {
      if (w.f.phase !== 'active' && w.f.phase !== 'configuring') return;
      await abortInWork(w, { reason: texts(w.f.language).abortJobFailed(), actor: 'engine', detail: { job: job.kind, error: message } });
    });
  } catch (abortErr) {
    engine.log(`facilitation ${job.facilitationId}: abort after failed job did not go through: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
  }
}

/** Essential messages waiting for another attempt. */
async function retryDeliveries(engine: EngineCore, now: Date): Promise<void> {
  const due = await engine.db().query<{ facilitation_id: string }>(
    `SELECT DISTINCT facilitation_id FROM plg_omadia_agent_facilitator_outbox
      WHERE status = 'sending' OR (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))`,
    [now],
  );
  for (const row of due.rows) {
    try {
      await engine.flush(row.facilitation_id);
    } catch (err) {
      engine.log(`facilitation ${row.facilitation_id}: delivery retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** One pass: due jobs, then deliveries that wait for a retry. */
export async function tick(engine: EngineCore): Promise<{ jobs: number }> {
  const now = engine.now();
  const jobs = await leaseDueJobs(engine, now);
  for (const job of jobs) await runJob(engine, job);
  await retryDeliveries(engine, now);
  return { jobs: jobs.length };
}

// ── what the engine schedules ───────────────────────────────────────────────

/** Reminders and the close, from the deadline. Idempotent; called when a
 *  facilitation opens and when its deadline changes. */
export async function scheduleDeadlineJobs(w: Work): Promise<void> {
  await w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2
      WHERE facilitation_id = $1 AND status = 'pending' AND kind IN ('reminder', 'deadline')`,
    [w.f.id, w.now],
  );
  const deadline = w.f.deadline;
  if (!deadline) return;
  const stamp = deadline.toISOString();
  for (const hours of w.f.reminderPolicy.offsetsHours) {
    const at = new Date(deadline.getTime() - hours * HOUR_MS);
    // A reminder whose time has already passed is not sent late.
    if (at.getTime() > w.now.getTime()) await scheduleJob(w, 'reminder', `${stamp}:${String(hours)}`, at, { hoursBefore: hours });
  }
  await scheduleJob(w, 'deadline', stamp, deadline, {});
  // A deadline beyond the maximum duration takes the lifetime with it.
  await w.tx.query(
    `UPDATE plg_omadia_agent_facilitator_jobs SET due_at = greatest(due_at, $2::timestamptz + interval '1 hour')
      WHERE facilitation_id = $1 AND kind = 'lifetime' AND status = 'pending'`,
    [w.f.id, deadline],
  );
}

/** Who a reminder is for, by what the open step is waiting for. */
async function waitingFor(w: Work): Promise<{ open: number; people: Participant[] }> {
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) return { open: 0, people: [] };
  const active = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  if (step.method === 'assignment') {
    const outcome = await evaluateStep(w, step, false);
    if (outcome.state !== 'assignment_open') return { open: 0, people: [] };
    const nominees = new Set(outcome.assignments.filter((a) => a.nominee && !a.confirmed).map((a) => a.nominee));
    return { open: outcome.openItems.length + outcome.unconfirmed.length, people: active.filter((p) => nominees.has(p.principalId)) };
  }
  if (step.method) {
    const cast = new Set((await castBallots(w, step)).map((b) => b.principal));
    const people = active.filter((p) => !cast.has(p.principalId));
    return { open: people.length + expectedNames(w.f).length, people };
  }
  const { missing } = await participationOf(w.tx, w.f);
  return { open: missing.length, people: missing };
}

/** A reminder goes out only if the facilitation is active and a step waits
 *  for contributions. Neutral in the group; the people it concerns privately. */
const reminder: JobHandler = async (w, job) => {
  if (w.f.phase !== 'active') return;
  // After downtime a reminder may come up long past its time, together with
  // the next one and the deadline. A reminder that is late says nothing
  // useful, and one after the deadline is wrong: it is skipped, on record.
  const lateMs = w.now.getTime() - job.dueAt.getTime();
  if (lateMs > REMINDER_GRACE_MS || (w.f.deadline !== null && w.now.getTime() >= w.f.deadline.getTime())) {
    await w.event('reminder_skipped', 'engine', { hoursBefore: job.payload['hoursBefore'], lateMinutes: Math.round(lateMs / MINUTE_MS) });
    return;
  }
  // A decision held for want of a verified list is tried again first (spec
  // 5.5): if it is taken now, nothing is waiting any more.
  if (w.f.settings.electorateUnverifiedSince !== undefined) {
    await retryHeldDecisions(w);
    if (w.f.phase !== 'active') return;
  }
  const { open, people } = await waitingFor(w);
  const t = texts(w.f.language);
  const deadline = w.f.deadline ? formatWhen(w.f.deadline, w.f.timezone, w.f.language) : undefined;
  // Without a list nobody can be counted as missing, and somebody who has
  // not written yet may well be: the group is reminded, without a number.
  const unknown = !listKnown(w.f) && (await store.openStepOf(w.tx, w.f.id)) !== undefined;
  if (open === 0 && !unknown) {
    // Nothing is sent, and that is on record: a reminder never ends silently.
    await w.event('reminder_skipped', 'engine', { hoursBefore: job.payload['hoursBefore'], reason: 'nobody_waiting' });
    return;
  }
  w.post({ purpose: 'reminder', key: job.id, to: 'group', deliveryClass: 'droppable', requiredPhases: ['active'], text: unknown ? t.reminderGroupOpen(deadline) : t.reminderGroup(open, deadline) });
  for (const person of people) {
    w.post({
      purpose: 'reminder_direct',
      key: `${job.id}:${person.principalId}`,
      to: { principalId: person.principalId },
      deliveryClass: 'droppable',
      requiredPhases: ['active'],
      text: t.reminderDirect(person.displayName, w.f.goal, deadline),
    });
  }
  await w.event('reminder', 'engine', { open: unknown ? null : open, direct: people.length, hoursBefore: job.payload['hoursBefore'] });
};

/** At the deadline the engine closes with the state at that moment. */
const deadline: JobHandler = async (w) => {
  if (w.f.phase === 'configuring') {
    await abortInWork(w, { reason: texts(w.f.language).abortNothing(), actor: 'engine' });
    return;
  }
  for (const hook of beforeDeadline) await hook(w);
  await advance(w, 'deadline');
};

const beforeDeadline: Array<(w: Work) => Promise<void>> = [];
/** Work that must be settled before the deadline evaluates (an open proposal). */
export function onBeforeDeadline(hook: (w: Work) => Promise<void>): void {
  if (!beforeDeadline.includes(hook)) beforeDeadline.push(hook);
}

/** The runoff window ended. */
const runoffDeadline: JobHandler = async (w, job) => {
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step || step.id !== job.payload['stepId'] || step.round < 2) return;
  await advance(w, 'deadline');
};

export function installScheduler(): void {
  registerJobHandler('reminder', reminder);
  registerJobHandler('deadline', deadline);
  registerJobHandler('runoff_deadline', runoffDeadline);
}
