// Lifecycle of a facilitation (spec 5.2):
//
//   configuring -> active -> concluding -> closed
//                         \-> aborted (stop, deadline without result, error)
//
// `invited` is not stored: before somebody asks the facilitator to start there
// is nothing to keep. The conversation always comes from the kernel's tool
// call context, never from a tool argument.

import { DAY_MS } from '../clock.js';
import { isValidTimezone } from '../config.js';
import { insertIfAbsent } from '../db/sql.js';
import * as store from '../db/store.js';
import { poolTransaction } from '../db/tx.js';
import { principalKey } from '../kernel.js';
import type { RosterParticipant } from '../kernel.js';
import { toOptions } from '../methods/ballot.js';
import { FORMATS } from './formats.js';
import { lifetimeEnd } from './lifetime.js';
import type { CloseRule, DodCriteria, Facilitation, FormatId, MethodId, Participant, Step } from '../model.js';
import { texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';

// ISO 8601 date-time WITH an explicit offset or Z. A bare local time is
// ambiguous (whose timezone?) and refused rather than guessed.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(raw: string): Date | undefined {
  const trimmed = raw.trim();
  if (!ISO_WITH_OFFSET.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

export interface ConversationRef {
  agentSlug: string;
  channelType: string;
  conversationId: string;
}

export interface ConfigureInput extends ConversationRef {
  /** Kernel-stated principal of the person the turn answers. */
  callerPrincipalId: string;
  goal: string;
  definitionOfDone: string;
  dodCriteria?: DodCriteria;
  format?: FormatId;
  deadline?: string;
  timezone?: string;
  language?: 'de' | 'en';
  closeRule?: CloseRule;
  reminderOffsetsHours?: number[];
  /** The decision the facilitation is about, when it is one vote. */
  decision?: DecisionSetup;
  /** An agenda of its own instead of the format's template. */
  agenda?: AgendaStepInput[];
  /** Action items are followed up after the close. */
  followUp?: boolean;
  /** ISO time at which the status of the action items is posted. */
  followUpStatusAt?: string;
}

export interface DecisionSetup {
  method: MethodId;
  /** Option labels (or the items to assign); keys A, B, ... are assigned. */
  options: string[];
  points?: number[];
  /** Consent: the proposal put to the group. */
  statement?: string;
}

type NewStep = Parameters<typeof store.replaceSteps>[2][number];

function decidingStep(title: string, d: DecisionSetup, config: { rankedPoints: readonly number[] }, kind?: NewStep['kind']): NewStep {
  if (d.method !== 'consent' && d.options.length > 0 && d.options.length < (d.method === 'assignment' ? 1 : 2)) {
    throw new Refusal('bad_options', 'A vote needs at least two options.');
  }
  return {
    kind: kind ?? (d.method === 'assignment' ? 'assign' : 'decide'),
    title,
    method: d.method,
    options: toOptions(d.options),
    methodConfig: {
      ...(d.method === 'ranked' ? { points: d.points ?? [...config.rankedPoints] } : {}),
      ...(d.method === 'consent' ? { statement: d.statement ?? title } : {}),
    },
  };
}

/** One step of an agenda the facilitator wrote itself. */
export interface AgendaStepInput {
  kind: NewStep['kind'];
  title: string;
  timeboxMinutes?: number;
  decision?: DecisionSetup;
}

/** The agenda a setup asks for: its own steps, the template of its format,
 *  or one single step. */
export function agendaFor(
  input: Pick<ConfigureInput, 'goal' | 'decision' | 'format' | 'agenda' | 'language'>,
  config: { rankedPoints: readonly number[]; language: 'de' | 'en' },
): NewStep[] {
  const language = input.language ?? config.language;
  if (input.agenda && input.agenda.length > 0) {
    return input.agenda.map((s) => ({
      ...(s.decision ? decidingStep(s.title, s.decision, config, s.kind) : { kind: s.kind, title: s.title }),
      ...(s.timeboxMinutes ? { timeboxMinutes: s.timeboxMinutes } : {}),
    }));
  }
  if (input.format && input.format !== 'custom') {
    let applied = false;
    return FORMATS[input.format].map((template) => {
      const title = template.title[language];
      if (!template.method) return { kind: template.kind, title, ...(template.timeboxMinutes ? { timeboxMinutes: template.timeboxMinutes } : {}) };
      // The decision named at set-up belongs to the first deciding step; a
      // deciding step without options gets them during the facilitation.
      const fromSetup = !applied && input.decision ? input.decision : undefined;
      applied = true;
      return decidingStep(fromSetup ? input.goal : title, fromSetup ?? { method: template.method, options: [] }, config, template.kind);
    });
  }
  const d = input.decision;
  // No format and no vote: one open discussion, moderated turn by turn.
  if (!d) return [{ kind: 'discuss', title: input.goal }];
  if (d.method !== 'consent' && d.options.length < (d.method === 'assignment' ? 1 : 2)) {
    throw new Refusal('bad_options', d.method === 'assignment' ? 'Name at least one item to assign.' : 'A vote needs at least two options.');
  }
  return [decidingStep(input.goal, d, config)];
}

/** The definition of done an agenda implies when the set-up names none. */
function criteriaFor(agenda: readonly NewStep[]): DodCriteria | null {
  const lastDeciding = agenda.map((s) => s.method !== undefined && s.method !== null).lastIndexOf(true);
  if (lastDeciding === -1) return agenda.some((s) => s.kind === 'close') ? { type: 'all_steps_closed' } : null;
  return agenda.slice(lastDeciding + 1).every((s) => s.kind === 'close') ? { type: 'decisions_reached' } : { type: 'all_steps_closed' };
}

/** How to contribute to a step, as the handshake announces it. */
export function rulesOf(f: Facilitation, step: Step | undefined): string[] {
  if (!step?.method) return [];
  const t = texts(f.language);
  const options = t.options(step.roundOptions ?? step.options);
  const points = Array.isArray(step.methodConfig['points']) ? (step.methodConfig['points'] as number[]) : [];
  const line = {
    ranked: () => t.rules.ranked(options, points),
    single: () => t.rules.single(options),
    approval: () => t.rules.approval(options),
    consent: () => t.rules.consent(String(step.methodConfig['statement'] ?? step.title)),
    assignment: () => t.rules.assignment(options),
  }[step.method]();
  return step.method === 'assignment' ? [line] : [line, t.rules.common(f.closeRule)];
}

export interface ConfigureResult {
  facilitation: Facilitation;
  created: boolean;
  participants: Participant[];
  /** Things the facilitator has to tell the group (degradations). */
  notes: string[];
}

const profileLanguage = (language: string | undefined): 'de' | 'en' | undefined => {
  const base = language?.toLowerCase().split('-')[0];
  return base === 'de' || base === 'en' ? base : undefined;
};

export type StartCheck = (engine: EngineCore, facilitatorAgent: string, language: 'de' | 'en') => Promise<void>;
const startChecks: StartCheck[] = [];
/** What must hold before a new facilitation is created (quotas). */
export function registerStartCheck(check: StartCheck): void {
  if (!startChecks.includes(check)) startChecks.push(check);
}

const REPAIRABLE = new Set(['consent_missing', 'package_outdated']);
const READINESS_UNVERIFIED = 'The channel could not confirm that I can read every message here (no readiness check available).';

const OWN_IDENTITY_REQUIRED =
  'This facilitator has no identity of its own on this channel. A facilitator never speaks through another bot, so it cannot start a facilitation here. An operator has to give it its own channel identity first.';

const matchesCaller = (member: RosterParticipant, caller: string): boolean => principalKey(member.userRef) === caller;

/** Create a facilitation in `configuring`, or adjust the one being set up. */
export async function configureFacilitation(engine: EngineCore, input: ConfigureInput): Promise<ConfigureResult> {
  const pool = engine.pool();
  const now = engine.now();
  const { kernel, config } = engine.deps;
  const notes: string[] = [];

  let deadline: Date | undefined;
  if (input.deadline !== undefined) {
    deadline = parseInstant(input.deadline);
    if (!deadline) throw new Refusal('bad_deadline', 'The deadline must be an ISO 8601 date-time with an offset, e.g. 2026-11-21T17:00:00+01:00.');
    if (deadline.getTime() <= now.getTime()) throw new Refusal('bad_deadline', 'The deadline is in the past.');
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new Refusal('bad_timezone', `'${input.timezone}' is not an IANA timezone.`);
  }

  let statusAt: Date | undefined;
  if (input.followUpStatusAt !== undefined) {
    statusAt = parseInstant(input.followUpStatusAt);
    if (!statusAt) throw new Refusal('bad_input', 'followUpStatusAt must be an ISO 8601 date-time with an offset.');
  }

  const existing = await store.findLiveByConversation(pool, input.channelType, input.conversationId);
  if (existing && existing.facilitatorAgent !== input.agentSlug) {
    throw new Refusal('conversation_taken', 'Another facilitator already facilitates this conversation. One facilitation per conversation at a time.');
  }
  if (existing && existing.phase !== 'configuring') {
    throw new Refusal(
      'already_active',
      'This conversation already has a running facilitation. Its goal, definition of done and method change only through a proposal the group consents to.',
    );
  }

  if (existing) {
    const facilitation = await engine.work(existing.id, async (w) => {
      const dod = await store.currentDod(w.tx, existing.id);
      if (dod && (dod.text !== input.definitionOfDone || JSON.stringify(dod.criteria) !== JSON.stringify(input.dodCriteria ?? null))) {
        await store.patchDodVersion(w.tx, dod.id, { text: input.definitionOfDone, criteria: input.dodCriteria ?? null });
      }
      const agenda = agendaFor(input, config);
      await store.replaceSteps(w.tx, existing.id, agenda);
      if (dod && !input.dodCriteria) await store.patchDodVersion(w.tx, dod.id, { text: input.definitionOfDone, criteria: criteriaFor(agenda) });
      await w.event('reconfigured', 'facilitator', { goal: input.goal });
      return w.patch({
        goal: input.goal,
        ...(input.format ? { format: input.format } : {}),
        ...(deadline ? { deadline } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.closeRule ? { closeRule: input.closeRule } : {}),
        ...(input.reminderOffsetsHours ? { reminderPolicy: { offsetsHours: [...input.reminderOffsetsHours].sort((a, b) => b - a) } } : {}),
        ...(input.followUp !== undefined || statusAt
          ? { followupPolicy: { ...existing.followupPolicy, ...(input.followUp !== undefined ? { actionItems: input.followUp } : {}), ...(statusAt ? { statusAt: statusAt.toISOString() } : {}) } }
          : {}),
      });
    });
    return { facilitation, created: false, participants: await store.listParticipants(pool, existing.id), notes };
  }

  // Name and language come from the kernel's record of the facilitator, not
  // from the model.
  const profile = await kernel.agentTurn()?.getProfile?.(input.agentSlug);
  for (const check of startChecks) await check(engine, input.agentSlug, input.language ?? profileLanguage(profile?.language) ?? config.language);

  const messages = kernel.messages();
  if (!messages) {
    throw new Refusal(
      'no_message_service',
      'This kernel does not deliver the messages of a conversation to the facilitation engine (conversationMessages). Without them contributions cannot be recorded, so nothing is started.',
    );
  }

  const readiness = kernel.readiness();
  if (readiness) {
    let report = await readiness.check(input);
    // Consent that only needs renewing is repaired once; anything else is
    // said exactly and nothing starts.
    if (!report.ready && readiness.repairConsent && report.missing.some((m) => REPAIRABLE.has(m.code))) {
      const repair = await readiness.repairConsent(input);
      if (repair.outcome !== 'failed') report = await readiness.check(input);
    }
    if (!report.ready) {
      const missing = report.missing.map((m) => `${m.code}: ${m.message}`);
      throw new Refusal(
        report.missing.some((m) => m.code === 'no_identity') ? 'no_identity' : 'not_ready',
        `I cannot facilitate here yet. Missing: ${missing.length > 0 ? missing.join('; ') : 'the channel reports it is not ready'}. Nothing was started.`,
      );
    }
    if (report.verified === false) notes.push(READINESS_UNVERIFIED);
  } else {
    notes.push(READINESS_UNVERIFIED);
  }

  const subscription = await messages.subscribe(input);
  if (subscription.outcome === 'refused') {
    throw new Refusal(subscription.code, subscription.code === 'no_identity' ? OWN_IDENTITY_REQUIRED : `I cannot read this conversation: ${subscription.message}. Nothing was started.`);
  }

  const roster = await kernel.rosters()?.getRoster(input.channelType, input.conversationId);
  const members = (roster?.participants ?? []).filter((p) => p.isBot !== true);
  const openRoster = !roster || roster.partial;
  if (openRoster) notes.push('The channel could not list every member of this conversation; whoever writes here counts as a participant.');
  const initiator = members.find((m) => matchesCaller(m, input.callerPrincipalId));

  const language = input.language ?? profileLanguage(profile?.language) ?? config.language;
  const agenda = agendaFor({ ...input, language }, config);
  try {
    return await poolTransaction(pool, async (tx) => {
      const facilitation = await store.createFacilitation(tx, {
        facilitatorAgent: input.agentSlug,
        channelType: input.channelType,
        conversationId: input.conversationId,
        initiatorPrincipal: input.callerPrincipalId,
        initiatorParticipant: initiator ? principalKey(initiator.userRef) : null,
        goal: input.goal,
        format: input.format ?? 'custom',
        language,
        timezone: input.timezone ?? config.timezone,
        closeRule: input.closeRule ?? 'all_contributed',
        reminderPolicy: { offsetsHours: [...(input.reminderOffsetsHours ?? config.reminderOffsetsHours)].sort((a, b) => b - a) },
        followupPolicy: { actionItems: input.followUp === true, leadHours: config.actionReminderLeadHours, ...(statusAt ? { statusAt: statusAt.toISOString() } : {}) },
        settings: {
          changeWindowHours: config.changeWindowHours,
          runoffWindowHours: config.runoffWindowHours,
          confirmWindowMinutes: config.confirmWindowMinutes,
          ...(profile?.displayName ? { facilitatorName: profile.displayName } : {}),
          ...(openRoster ? { openRoster: true } : {}),
        },
        deadline: deadline ?? null,
        createdAt: now,
      });
      await store.addDodVersion(tx, {
        facilitationId: facilitation.id,
        text: input.definitionOfDone,
        criteria: input.dodCriteria ?? criteriaFor(agenda),
        proposedBy: input.callerPrincipalId,
        consentState: 'initial',
        effectiveAt: now,
        createdAt: now,
      });
      await store.replaceSteps(tx, facilitation.id, agenda);
      const participants: Participant[] = [];
      for (const member of members) {
        const added = await store.addParticipant(tx, {
          facilitationId: facilitation.id,
          principalId: principalKey(member.userRef),
          canonicalPrincipal: principalKey(member.userRef),
          displayName: member.userRef.displayName ?? member.userRef.id,
          email: member.userRef.email ?? member.userPrincipalName ?? null,
          source: 'roster',
          joinedAt: now,
          changedAt: now,
        });
        if (added) participants.push(added);
      }
      // No facilitation stays open forever.
      await insertIfAbsent(
        tx,
        'plg_omadia_agent_facilitator_jobs',
        {
          facilitationId: facilitation.id,
          kind: 'lifetime',
          dedupeKey: `${facilitation.id}:lifetime`,
          dueAt: lifetimeEnd(now, deadline ?? null, config.maxLifetimeDays),
          payload: {},
          createdAt: now,
        },
        '(dedupe_key)',
      );
      await store.appendEvent(tx, {
        facilitationId: facilitation.id,
        kind: 'configured',
        actor: 'facilitator',
        occurredAt: now,
        payload: { goal: input.goal, initiator: input.callerPrincipalId, participants: participants.length },
      });
      return { facilitation, created: true, participants, notes };
    });
  } catch (err) {
    // Nothing was created: do not keep reading a conversation we do not moderate.
    if (!(await store.findLiveByConversation(pool, input.channelType, input.conversationId))) await messages.unsubscribe(input);
    if (err instanceof Error && err.message.includes('one_active_per_conversation')) {
      throw new Refusal('already_active', 'This conversation already has a facilitation.');
    }
    throw err;
  }
}

export function displayNameOf(participants: readonly Participant[], principalId: string | null, fallback: string): string {
  return participants.find((p) => p.principalId === principalId)?.displayName ?? fallback;
}

export const facilitatorName = (f: Facilitation): string => f.settings.facilitatorName ?? f.facilitatorAgent;

let openFirstStep: (w: Work, step: Step) => Promise<unknown> = async (w, step) => {
  await store.patchStep(w.tx, step.id, { status: 'open', openedAt: w.now });
};
/** How a step of an agenda is opened (process.ts announces it and keeps its timebox). */
export function setStepOpener(opener: (w: Work, step: Step) => Promise<unknown>): void {
  openFirstStep = opener;
}

let handshake: (w: Work, onlyStep: Step | undefined) => Promise<string> = async (w) => w.f.goal;
/** Who writes the opening handshake (transparency.ts). */
export function setHandshake(builder: (w: Work, onlyStep: Step | undefined) => Promise<string>): void {
  handshake = builder;
}

export type StepHook = (w: Work, step: Step) => Promise<void>;
const voteOpened: StepHook[] = [];
const stepOpened: StepHook[] = [];
/** A vote was put to the group (a poll card can go with it). */
export function onVoteOpened(hook: StepHook): void {
  if (!voteOpened.includes(hook)) voteOpened.push(hook);
}
/** A step opened (a time check can be scheduled for it). */
export function onStepOpened(hook: StepHook): void {
  if (!stepOpened.includes(hook)) stepOpened.push(hook);
}
export async function announceVote(w: Work, step: Step): Promise<void> {
  if (step.method === null || (step.method !== 'consent' && step.options.length === 0)) return;
  for (const hook of voteOpened) await hook(w, step);
}
export async function announceStepOpened(w: Work, step: Step): Promise<void> {
  for (const hook of stepOpened) await hook(w, step);
}

const onOpen: Array<(w: Work) => Promise<void>> = [];
/** Work that starts with the facilitation (its reminders and its deadline). */
export function onOpened(hook: (w: Work) => Promise<void>): void {
  if (!onOpen.includes(hook)) onOpen.push(hook);
}

/** configuring -> active: open the first step and post the handshake. */
export async function openFacilitation(engine: EngineCore, facilitationId: string): Promise<Facilitation> {
  return engine.work(facilitationId, async (w) => {
    if (w.f.phase !== 'configuring') throw new Refusal('not_configuring', `The facilitation is ${w.f.phase}; only one that is being set up can be opened.`);
    const participants = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
    const steps = await store.listSteps(w.tx, w.f.id);
    const first = steps[0];
    // One step: the handshake carries its rules. An agenda: the handshake
    // lists it, the opening step is the handshake itself, the next one opens.
    const single = steps.length === 1;
    const opened = single && first ? await store.patchStep(w.tx, first.id, { status: 'open', openedAt: w.now }) : undefined;
    if (!single && first?.kind === 'open') await store.patchStep(w.tx, first.id, { status: 'closed', openedAt: w.now, closedAt: w.now });
    const f = await w.patch({ phase: 'active', activatedAt: w.now });
    w.post({ purpose: 'handshake', key: 'opening', to: 'group', deliveryClass: 'essential', text: await handshake(w, single ? opened : undefined) });
    await w.event('opened', 'facilitator', { participants: participants.length });
    for (const hook of onOpen) await hook(w);
    if (opened) await announceVote(w, opened);
    if (!single) {
      const next = (await store.listSteps(w.tx, w.f.id)).find((s) => s.status === 'pending');
      if (next) await openFirstStep(w, next);
    }
    return f;
  });
}

/** What ends with a facilitation, in the same transaction as the phase change. */
export async function releaseOnEnd(w: Work, retentionDays: number): Promise<void> {
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_acks SET status = 'cancelled', resolved_at = $2 WHERE facilitation_id = $1 AND status = 'pending'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE plg_omadia_agent_facilitator_proposals SET status = 'withdrawn', decided_at = $2 WHERE facilitation_id = $1 AND status = 'open'`, [w.f.id, w.now]);
  await w.patch({ purgeAfter: new Date(w.now.getTime() + retentionDays * DAY_MS) });
}

export interface AbortInput {
  reason: string;
  actor: string;
  /** The text for the group; defaults to the generic abort report. */
  groupText?: string;
  /** Extra detail for the protocol. */
  detail?: Record<string, unknown>;
}

const onAbort: Array<(w: Work, report: string) => Promise<void>> = [];
/** What an abort also does (the report to the initiator). */
export function onAborted(hook: (w: Work, report: string) => Promise<void>): void {
  if (!onAbort.includes(hook)) onAbort.push(hook);
}

/** End without a result inside a unit of work: an honest report to the group.
 *  Idempotent. Nothing ends silently, so every way out goes through here. */
export async function abortInWork(w: Work, input: AbortInput): Promise<void> {
  if (w.f.phase === 'closed' || w.f.phase === 'aborted') return;
  const text = input.groupText ?? texts(w.f.language).aborted(input.reason);
  await w.patch({ phase: 'aborted', closedAt: w.now, closeReason: input.reason });
  await releaseOnEnd(w, w.config.retentionDays);
  w.post({ purpose: 'abort', key: 'report', to: 'group', deliveryClass: 'essential', text });
  await w.event('aborted', input.actor, { reason: input.reason, ...(input.detail ?? {}) });
  for (const hook of onAbort) await hook(w, text);
}

/** End without a result. */
export async function abortFacilitation(engine: EngineCore, facilitationId: string, input: AbortInput): Promise<Facilitation> {
  const ended = await engine.work(facilitationId, async (w) => {
    await abortInWork(w, input);
    return w.f;
  });
  await releaseConversation(engine, ended);
  return ended;
}

/** Stop reading a conversation once nothing of the facilitation needs it. */
export async function releaseConversation(engine: EngineCore, f: Facilitation): Promise<void> {
  if (f.followupState === 'active') return;
  // Posting as the facilitator rides on the subscription: keep it until the
  // report is out.
  const undelivered = await engine.pool().query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND delivery_class = 'essential' AND status IN ('pending', 'sending') LIMIT 1`,
    [f.id],
  );
  if (undelivered.rows.length > 0) return;
  try {
    await engine.deps.kernel.messages()?.unsubscribe({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId });
  } catch (err) {
    engine.log(`facilitation ${f.id}: unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
