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
import * as store from '../db/store.js';
import { poolTransaction } from '../db/tx.js';
import type { RosterParticipant } from '../kernel.js';
import { toOptions } from '../methods/ballot.js';
import type { CloseRule, DodCriteria, Facilitation, FormatId, MethodId, Participant, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
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
  facilitatorName?: string;
  /** The decision the facilitation is about, when it is one vote. */
  decision?: DecisionSetup;
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

/** The agenda a setup asks for. */
export function agendaFor(input: Pick<ConfigureInput, 'goal' | 'decision'>, config: { rankedPoints: readonly number[] }): NewStep[] {
  const d = input.decision;
  if (!d) return [{ kind: 'collect', title: input.goal }];
  if (d.method !== 'consent' && d.options.length < (d.method === 'assignment' ? 1 : 2)) {
    throw new Refusal('bad_options', d.method === 'assignment' ? 'Name at least one item to assign.' : 'A vote needs at least two options.');
  }
  return [
    {
      kind: d.method === 'assignment' ? 'assign' : 'decide',
      title: input.goal,
      method: d.method,
      options: toOptions(d.options),
      methodConfig: {
        ...(d.method === 'ranked' ? { points: d.points ?? [...config.rankedPoints] } : {}),
        ...(d.method === 'consent' ? { statement: d.statement ?? input.goal } : {}),
      },
    },
  ];
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

const OWN_IDENTITY_REQUIRED =
  'This facilitator has no identity of its own on this channel. A facilitator never speaks through another bot, so it cannot start a facilitation here. An operator has to give it its own channel identity first.';

function matchesCaller(member: RosterParticipant, caller: string): boolean {
  const { id, email } = member.userRef;
  return caller === id || caller === `user:${id}` || (email !== undefined && caller.toLowerCase() === email.toLowerCase());
}

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
      await store.replaceSteps(w.tx, existing.id, agendaFor(input, config));
      await w.event('reconfigured', 'facilitator', { goal: input.goal });
      return w.patch({
        goal: input.goal,
        ...(input.format ? { format: input.format } : {}),
        ...(deadline ? { deadline } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.closeRule ? { closeRule: input.closeRule } : {}),
        ...(input.reminderOffsetsHours ? { reminderPolicy: { offsetsHours: [...input.reminderOffsetsHours].sort((a, b) => b - a) } } : {}),
        ...(input.facilitatorName ? { settings: { ...existing.settings, facilitatorName: input.facilitatorName } } : {}),
      });
    });
    return { facilitation, created: false, participants: await store.listParticipants(pool, existing.id), notes };
  }

  const messages = kernel.messages();
  if (!messages) {
    throw new Refusal(
      'no_message_service',
      'This kernel does not deliver the messages of a conversation to the facilitation engine (conversationMessages). Without them contributions cannot be recorded, so nothing is started.',
    );
  }

  const readiness = kernel.readiness();
  if (readiness) {
    const report = await readiness.check(input);
    if (!report.ready) {
      const missing = report.missing.map((m) => `${m.code}: ${m.message}`);
      throw new Refusal(
        report.missing.some((m) => m.code === 'no_identity') ? 'no_identity' : 'not_ready',
        `I cannot facilitate here yet. Missing: ${missing.length > 0 ? missing.join('; ') : 'the channel reports it is not ready'}. Nothing was started.`,
      );
    }
  } else {
    notes.push('The channel could not confirm that I can read every message here (no readiness check available).');
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

  const agenda = agendaFor(input, config);
  try {
    return await poolTransaction(pool, async (tx) => {
      const facilitation = await store.createFacilitation(tx, {
        facilitatorAgent: input.agentSlug,
        channelType: input.channelType,
        conversationId: input.conversationId,
        initiatorPrincipal: input.callerPrincipalId,
        initiatorParticipant: initiator?.userRef.id ?? null,
        goal: input.goal,
        format: input.format ?? 'custom',
        language: input.language ?? config.language,
        timezone: input.timezone ?? config.timezone,
        closeRule: input.closeRule ?? 'all_contributed',
        reminderPolicy: { offsetsHours: [...(input.reminderOffsetsHours ?? config.reminderOffsetsHours)].sort((a, b) => b - a) },
        followupPolicy: { actionItems: false, leadHours: config.actionReminderLeadHours },
        settings: {
          changeWindowHours: config.changeWindowHours,
          runoffWindowHours: config.runoffWindowHours,
          confirmWindowMinutes: config.confirmWindowMinutes,
          ...(input.facilitatorName ? { facilitatorName: input.facilitatorName } : {}),
          ...(openRoster ? { openRoster: true } : {}),
        },
        deadline: deadline ?? null,
        createdAt: now,
      });
      await store.addDodVersion(tx, {
        facilitationId: facilitation.id,
        text: input.definitionOfDone,
        criteria: input.dodCriteria ?? (input.decision ? { type: 'decisions_reached' } : null),
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
          principalId: member.userRef.id,
          displayName: member.userRef.displayName ?? member.userRef.id,
          email: member.userRef.email ?? member.userPrincipalName ?? null,
          source: 'roster',
          joinedAt: now,
          changedAt: now,
        });
        if (added) participants.push(added);
      }
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
    if (err instanceof Error && err.message.includes('facilitations_one_active_per_conversation')) {
      throw new Refusal('already_active', 'This conversation already has a facilitation.');
    }
    throw err;
  }
}

export function displayNameOf(participants: readonly Participant[], principalId: string | null, fallback: string): string {
  return participants.find((p) => p.principalId === principalId)?.displayName ?? fallback;
}

export const facilitatorName = (f: Facilitation): string => f.settings.facilitatorName ?? f.facilitatorAgent;

/** configuring -> active: open the first step and post the handshake. */
export async function openFacilitation(engine: EngineCore, facilitationId: string): Promise<Facilitation> {
  return engine.work(facilitationId, async (w) => {
    if (w.f.phase !== 'configuring') throw new Refusal('not_configuring', `The facilitation is ${w.f.phase}; only one that is being set up can be opened.`);
    const participants = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
    const dod = await store.currentDod(w.tx, w.f.id);
    const first = (await store.listSteps(w.tx, w.f.id))[0];
    const opened = first ? await store.patchStep(w.tx, first.id, { status: 'open', openedAt: w.now }) : undefined;
    const f = await w.patch({ phase: 'active', activatedAt: w.now });
    const t = texts(f.language);
    w.post({
      purpose: 'handshake',
      key: 'opening',
      to: 'group',
      deliveryClass: 'essential',
      text: t.handshake({
        facilitator: facilitatorName(f),
        initiator: displayNameOf(participants, f.initiatorParticipant, f.initiatorPrincipal),
        goal: f.goal,
        definitionOfDone: dod?.text ?? '',
        participants: participants.map((p) => p.displayName),
        ...(f.deadline ? { deadline: formatWhen(f.deadline, f.timezone, f.language) } : {}),
        rules: rulesOf(f, opened),
      }),
    });
    await w.event('opened', 'facilitator', { participants: participants.length });
    return f;
  });
}

/** What ends with a facilitation, in the same transaction as the phase change. */
export async function releaseOnEnd(w: Work, retentionDays: number): Promise<void> {
  await w.tx.query(`UPDATE facilitation_jobs SET status = 'cancelled', finished_at = $2 WHERE facilitation_id = $1 AND status = 'pending'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE facilitation_acks SET status = 'cancelled', resolved_at = $2 WHERE facilitation_id = $1 AND status = 'pending'`, [w.f.id, w.now]);
  await w.tx.query(`UPDATE facilitation_proposals SET status = 'withdrawn', decided_at = $2 WHERE facilitation_id = $1 AND status = 'open'`, [w.f.id, w.now]);
  await w.patch({ purgeAfter: new Date(w.now.getTime() + retentionDays * DAY_MS) });
}

export interface AbortInput {
  reason: string;
  actor: string;
  /** The text for the group; defaults to the generic abort report. */
  groupText?: string;
}

/** End without a result, with an honest report to the group. Idempotent. */
export async function abortFacilitation(engine: EngineCore, facilitationId: string, input: AbortInput): Promise<Facilitation> {
  const ended = await engine.work(facilitationId, async (w) => {
    if (w.f.phase === 'closed' || w.f.phase === 'aborted') return w.f;
    const t = texts(w.f.language);
    await w.patch({ phase: 'aborted', closedAt: w.now, closeReason: input.reason });
    await releaseOnEnd(w, engine.config.retentionDays);
    w.post({ purpose: 'abort', key: 'report', to: 'group', deliveryClass: 'essential', text: input.groupText ?? t.aborted(input.reason) });
    await w.event('aborted', input.actor, { reason: input.reason });
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
    `SELECT 1 FROM facilitation_outbox WHERE facilitation_id = $1 AND delivery_class = 'essential' AND status IN ('pending', 'sending') LIMIT 1`,
    [f.id],
  );
  if (undelivered.rows.length > 0) return;
  try {
    await engine.deps.kernel.messages()?.unsubscribe({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId });
  } catch (err) {
    engine.log(`facilitation ${f.id}: unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
