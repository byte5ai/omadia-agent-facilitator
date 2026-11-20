// Lifecycle of a facilitation (spec 5.2):
//
//   invited -> configuring -> active -> concluding -> closed -> following_up -> ended
//                                    \-> aborted (stop, deadline without result, error)
//
// `invited` is not stored: before somebody asks the facilitator to start there
// is nothing to keep. `following_up` and `ended` follow from the follow-up of
// the action items after the close (`lifecycleOf`). The conversation always
// comes from the kernel's tool call context, never from a tool argument.
//
// Each transition has its execution scope at the kernel (scopes.ts): the
// start request opens `configuring` and takes the conversation's reservation,
// the handshake opens `active`, every ending its own `closing`.

import { randomUUID } from 'node:crypto';

import type { ChannelReadinessReport } from '@omadia/plugin-api';

import { DAY_MS, MINUTE_MS } from '../clock.js';
import { facilitatorConfig, isValidTimezone, profileSettings } from '../config.js';
import type { FacilitatorConfig } from '../config.js';
import { missingServices, rosterStatusOf } from '../kernel.js';
import type { Queryable } from '../db/pool.js';
import { insertIfAbsent } from '../db/sql.js';
import * as store from '../db/store.js';
import { toOptions } from '../methods/ballot.js';
import { electorateSourceAtStart } from './electorate.js';
import { FORMATS } from './formats.js';
import { lifetimeEnd } from './lifetime.js';
import { isPlaceholderName, nameOrPlaceholder } from './names.js';
import { askedOffsets, reminderOffsetsFor } from './reminders.js';
import { buildRoll, effectiveCloseRule, expectedNames } from './roll.js';
import type { Roll } from './roll.js';
import type { CloseRule, DodCriteria, ElectorateSource, Facilitation, FormatId, MethodId, Participant, Step } from '../model.js';
import { texts } from '../texts/index.js';
import type { EngineCore, Work } from './core.js';
import { Refusal } from './core.js';
import { refusalText } from './refusals.js';
import { endScope, ensureScope, stoppedByOperator, syncScopes } from './scopes.js';

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
  /** The caller's name, when the kernel states it. */
  callerDisplayName?: string | undefined;
  /** The participants the request named. They are the list then. */
  participants?: string[];
  goal: string;
  /** Absent: the agreed one is kept, or a default from the goal is used. */
  definitionOfDone?: string;
  dodCriteria?: DodCriteria;
  format?: FormatId;
  deadline?: string;
  timezone?: string;
  language?: 'de' | 'en';
  closeRule?: CloseRule;
  reminderOffsetsHours?: number[];
  /** Reminders the request asked for: minutes before the deadline, an empty
   *  list for none. Validated here, against the deadline. */
  reminderMinutesBefore?: unknown;
  /** The decision the facilitation is about, when it is one vote. */
  decision?: DecisionSetup;
  /** Options the request named without a method: they become a vote with
   *  the facilitator's default decision method, when it has one. */
  undecidedOptions?: string[];
  /** An agenda of its own instead of the format's template. */
  agenda?: AgendaStepInput[];
  /** Action items are followed up after the close. */
  followUp?: boolean;
  /** The request asks that the closing protocol also goes out by mail. */
  protocolByMail?: boolean;
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

/** Templates whose steps before the vote only find what is voted on. With the
 *  vote already complete there is nothing for them to do. */
const VOTE_ONLY_FORMATS: ReadonlySet<FormatId> = new Set<FormatId>(['decision', 'prioritisation', 'assignment']);

/** A vote the group can cast at once: the method and what to choose from. */
const isCompleteVote = (d: DecisionSetup | undefined): d is DecisionSetup =>
  d !== undefined && (d.method === 'consent' || d.options.length >= (d.method === 'assignment' ? 1 : 2));

/** The agenda a setup asks for: its own steps, the template of its format,
 *  or one single step.
 *
 *  A request that is just a vote gets the shortest process: one deciding
 *  step, whatever template was named with it. Which one it is does not depend
 *  on a model's choice of format. More steps around a complete vote need an
 *  agenda of their own. */
export function agendaFor(
  input: Pick<ConfigureInput, 'goal' | 'decision' | 'format' | 'agenda' | 'language'>,
  config: Pick<FacilitatorConfig, 'rankedPoints' | 'language' | 'defaultDecisionMethod' | 'defaultPrioritisationMethod'>,
): NewStep[] {
  const language = input.language ?? config.language;
  if (input.agenda && input.agenda.length > 0) {
    return input.agenda.map((s) => ({
      ...(s.decision ? decidingStep(s.title, s.decision, config, s.kind) : { kind: s.kind, title: s.title }),
      ...(s.timeboxMinutes ? { timeboxMinutes: s.timeboxMinutes } : {}),
    }));
  }
  const justAVote = isCompleteVote(input.decision) && (!input.format || VOTE_ONLY_FORMATS.has(input.format));
  if (input.format && input.format !== 'custom' && !justAVote) {
    let applied = false;
    return FORMATS[input.format].map((template) => {
      const title = template.title[language];
      if (!template.method) return { kind: template.kind, title, ...(template.timeboxMinutes ? { timeboxMinutes: template.timeboxMinutes } : {}) };
      // The decision named at set-up belongs to the first deciding step; a
      // deciding step without options gets them during the facilitation.
      const fromSetup = !applied && input.decision ? input.decision : undefined;
      applied = true;
      return decidingStep(fromSetup ? input.goal : title, fromSetup ?? { method: templateMethod(template.kind, template.method, config), options: [] }, config, template.kind);
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

/** The method of a template's deciding step: the facilitator's default for
 *  its kind, else the template's. A consent step stays consent: it is what
 *  its format is about (alignment), not a choice between options. */
function templateMethod(
  kind: NewStep['kind'],
  method: MethodId,
  config: Pick<FacilitatorConfig, 'defaultDecisionMethod' | 'defaultPrioritisationMethod'>,
): MethodId {
  if (method === 'consent' || method === 'assignment') return method;
  if (kind === 'decide') return config.defaultDecisionMethod ?? method;
  if (kind === 'prioritise') return config.defaultPrioritisationMethod ?? method;
  return method;
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
  return step.method === 'assignment' ? [line] : [line, t.rules.common(effectiveCloseRule(f))];
}

export interface ConfigureResult {
  facilitation: Facilitation;
  created: boolean;
  participants: Participant[];
  /** Named in the request, matched to nobody yet. */
  expected: string[];
  /** Things the facilitator has to tell the group (degradations). */
  notes: string[];
  /** The definition of done the engine wrote because none was given. */
  defaultedDod?: string;
}

const profileLanguage = (language: string | undefined): 'de' | 'en' | undefined => {
  const base = language?.toLowerCase().split('-')[0];
  return base === 'de' || base === 'en' ? base : undefined;
};

export type ConfiguredHook = (engine: EngineCore, facilitation: Facilitation) => Promise<void>;
const configured: ConfiguredHook[] = [];
/** Runs once a facilitation was created, outside any transaction. */
export function onConfigured(hook: ConfiguredHook): void {
  if (!configured.includes(hook)) configured.push(hook);
}

export type StartCheck = (engine: EngineCore, facilitatorAgent: string, language: 'de' | 'en') => Promise<void>;
const startChecks: StartCheck[] = [];
/** What must hold before a new facilitation is created (quotas). */
export function registerStartCheck(check: StartCheck): void {
  if (!startChecks.includes(check)) startChecks.push(check);
}

/** A definition of done that is met as soon as everybody has contributed. */
export const DONE_WHEN_ALL =
  /(?<!\p{L})(alle|jede[rs]?|everyone|everybody|all)(?!\p{L})[^.!?\n]{0,40}?(?<!\p{L})(abgestimmt|beigetragen|gewählt|geantwortet|voted|contributed|answered)(?!\p{L})/iu;

const REPAIRABLE = new Set(['consent_missing', 'package_outdated']);
const READINESS_UNVERIFIED = 'The channel could not confirm that I can read every message here (no readiness check available).';

const OWN_IDENTITY_REQUIRED =
  'This facilitator has no identity of its own on this channel. A facilitator never speaks through another bot, so it cannot start a facilitation here. An operator has to give it its own channel identity first.';

const PARTICIPANTS_UNKNOWN =
  "The channel cannot list who is in this conversation, so I cannot tell when everybody has voted. Either name the participants (argument 'participants': the names from the request; the person who asked always takes part), then it closes when all of them have voted. Or set a deadline and leave closeRule out, then it is evaluated at the deadline; the definition of done must then not say that it is done when everybody has voted. Nothing was created.";

/** Who takes part, from the channel's member list and the request. */
async function rollFor(engine: EngineCore, input: ConfigureInput): Promise<Roll & { source: ElectorateSource }> {
  // Read as the facilitator: its own bot is the one that is in the conversation.
  // Fresh: the source of the electorate is fixed on this answer (spec 5.5).
  const roster = await engine.deps.kernel.rosters()?.getRoster(input.channelType, input.conversationId, { agentSlug: input.agentSlug, fresh: true });
  const members = (roster?.participants ?? []).filter((p) => p.isBot !== true);
  const statedName = input.callerDisplayName && !isPlaceholderName(input.callerDisplayName, input.callerPrincipalId) ? input.callerDisplayName : undefined;
  const source = electorateSourceAtStart(rosterStatusOf(roster), members.length);
  return {
    ...buildRoll({
      members,
      // A member list without a single person is no answer either.
      complete: source === 'platform_roster',
      initiator: { principalId: input.callerPrincipalId, displayName: statedName },
      named: input.participants,
    }),
    source,
  };
}

/**
 * "Everybody has voted" needs a list. Without one a vote is evaluated at its
 * deadline, and with neither there is nothing that would ever close it: that
 * is refused. Undefined: nothing forces a rule.
 */
function closeRuleFor(c: { votes: boolean; open: boolean; asked: CloseRule | undefined; hasDeadline: boolean; definitionOfDone: string | undefined }): CloseRule | undefined {
  if (!c.votes || !c.open) return c.asked;
  if (c.asked === 'all_contributed' || !c.hasDeadline || (c.definitionOfDone !== undefined && DONE_WHEN_ALL.test(c.definitionOfDone))) {
    throw new Refusal('participants_unknown', PARTICIPANTS_UNKNOWN);
  }
  return 'at_deadline';
}

async function storeRoll(tx: Queryable, facilitationId: string, roll: Roll, language: 'de' | 'en', now: Date): Promise<Participant[]> {
  const participants: Participant[] = [];
  for (const person of roll.people) {
    const added = await store.addParticipant(tx, {
      facilitationId,
      principalId: person.principalId,
      canonicalPrincipal: person.principalId,
      displayName: nameOrPlaceholder(person.displayName, person.principalId, language),
      email: person.email,
      source: person.source,
      joinedAt: now,
      changedAt: now,
    });
    if (added) participants.push(added);
  }
  return participants;
}

/** Create a facilitation in `configuring`, or adjust the one being set up. */
export async function configureFacilitation(engine: EngineCore, request: ConfigureInput): Promise<ConfigureResult> {
  const db = engine.db();
  const now = engine.now();
  const { kernel } = engine.deps;
  const notes: string[] = [];
  // Name, language and the facilitator's own defaults come from the kernel's
  // record of the facilitator, not from the model. Its defaults sit over the
  // instance settings; what it does not set, the instance decides.
  const profile = await kernel.agentTurn()?.getProfile(request.agentSlug);
  const config = facilitatorConfig(engine.deps.config, profileSettings(profile), (m) => engine.log(`${request.agentSlug}: ${m}`));
  const input: ConfigureInput =
    !request.decision && config.defaultDecisionMethod && request.undecidedOptions && request.undecidedOptions.length > 0
      ? { ...request, decision: { method: config.defaultDecisionMethod, options: request.undecidedOptions } }
      : request;

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

  // Mail goes through the follow-up integration. Without one nothing is
  // promised: the facilitator is told to say so.
  const mailAsked = input.protocolByMail === true;
  const protocolMail = mailAsked && kernel.followup() !== undefined;
  if (mailAsked && !protocolMail) notes.push('Sending the protocol by mail is not available on this instance (no mail integration is installed). The protocol goes to the participants privately, or into this group where that is not possible.');

  const existing = await store.findLiveByConversation(db, input.channelType, input.conversationId);
  // Reminders somebody asked for are kept as asked; the others follow from
  // the time to the deadline, so that none is announced that cannot happen.
  const askedHours =
    input.reminderMinutesBefore !== undefined ? askedOffsets(input.reminderMinutesBefore, deadline ?? existing?.deadline, now) : input.reminderOffsetsHours ? [...input.reminderOffsetsHours].sort((a, b) => b - a) : undefined;
  const derivedHours = deadline ? reminderOffsetsFor(deadline.getTime() - now.getTime(), config.reminderOffsetsHours) : undefined;
  // The handshake states both the definition of done and when the engine
  // evaluates. The two must not say opposite things.
  if ((input.closeRule ?? existing?.closeRule) === 'at_deadline' && input.definitionOfDone !== undefined && DONE_WHEN_ALL.test(input.definitionOfDone)) {
    throw new Refusal(
      'close_rule_contradiction',
      "The definition of done says it is done when everybody has contributed, but closeRule 'at_deadline' keeps it open until the deadline even then. Use closeRule 'all_contributed' (the default: it closes when everybody has contributed, at the latest at the deadline), or reword the definition of done. Nothing was created or changed.",
    );
  }
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
    const roll = input.participants && input.participants.length > 0 ? await rollFor(engine, input) : undefined;
    const facilitation = await engine.work(existing.id, async (w) => {
      const dod = await store.currentDod(w.tx, existing.id);
      // A call that names no definition of done keeps the one that is there.
      const dodText = input.definitionOfDone ?? dod?.text ?? '';
      if (dod && (dod.text !== dodText || JSON.stringify(dod.criteria) !== JSON.stringify(input.dodCriteria ?? null))) {
        await store.patchDodVersion(w.tx, dod.id, { text: dodText, criteria: input.dodCriteria ?? null });
      }
      const agenda = agendaFor(input, config);
      // A list of participants that is named now replaces the one from the
      // first call; nothing was recorded for anybody yet.
      const settings = { ...existing.settings };
      if (roll) {
        await w.tx.query('DELETE FROM plg_omadia_agent_facilitator_participants WHERE facilitation_id = $1', [existing.id]);
        await storeRoll(w.tx, existing.id, roll, input.language ?? existing.language, now);
        delete settings.openRoster;
        delete settings.expected;
        Object.assign(settings, { participantsNamed: true }, roll.expected.length > 0 ? { expected: roll.expected } : {});
      }
      const forced = closeRuleFor({
        votes: agenda.some((s) => s.method !== undefined && s.method !== null),
        open: settings.openRoster === true,
        asked: input.closeRule,
        hasDeadline: (deadline ?? existing.deadline) !== null && (deadline ?? existing.deadline) !== undefined,
        definitionOfDone: input.definitionOfDone,
      });
      await store.replaceSteps(w.tx, existing.id, agenda);
      if (dod && !input.dodCriteria) await store.patchDodVersion(w.tx, dod.id, { text: dodText, criteria: criteriaFor(agenda) });
      await w.event('reconfigured', 'facilitator', { goal: input.goal });
      return w.patch({
        goal: input.goal,
        ...(input.format ? { format: input.format } : {}),
        ...(deadline ? { deadline } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.language ? { language: input.language } : {}),
        // The rule that only the missing list had forced goes with it.
        ...(forced ? { closeRule: forced } : roll && existing.settings.openRoster === true ? { closeRule: 'all_contributed' as const } : {}),
        ...(roll ? { settings } : {}),
        ...(askedHours ? { reminderPolicy: { offsetsHours: askedHours, asked: true } } : derivedHours && existing.reminderPolicy.asked !== true ? { reminderPolicy: { offsetsHours: derivedHours, baseHours: [...config.reminderOffsetsHours] } } : {}),
        ...(input.followUp !== undefined || statusAt || input.protocolByMail !== undefined
          ? { followupPolicy: { ...existing.followupPolicy, ...(input.followUp !== undefined ? { actionItems: input.followUp } : {}), ...(statusAt ? { statusAt: statusAt.toISOString() } : {}), ...(input.protocolByMail !== undefined ? { protocolMail } : {}) } }
          : {}),
      });
    });
    return { facilitation, created: false, participants: await store.listParticipants(db, existing.id), expected: [...expectedNames(facilitation)], notes };
  }

  for (const check of startChecks) await check(engine, input.agentSlug, input.language ?? profileLanguage(profile?.language) ?? config.language);

  // Without execution scopes nothing a facilitation does would be authorized:
  // nothing starts, rather than something that half works.
  const missing = missingServices(kernel);
  const messages = kernel.messages();
  const execution = kernel.execution();
  const sends = kernel.conversationSend();
  if (missing.length > 0 || !messages || !execution || !sends) {
    throw new Refusal(
      'instance_too_old',
      `A facilitation cannot run on this instance: it does not offer what a facilitation is authorized and bounded by (missing: ${missing.join(', ')}). Nothing was started. An operator has to update omadia, or finish its setup (a database is needed).`,
    );
  }

  const roll = await rollFor(engine, input);
  const openRoster = roll.open;
  if (openRoster) notes.push('The channel could not list every member of this conversation; whoever writes here counts as a participant.');

  const language = input.language ?? profileLanguage(profile?.language) ?? config.language;
  const agenda = agendaFor({ ...input, language }, config);
  // A setup is stored with what is known. Without a definition of done the
  // engine writes the plain one that follows from the goal; the group sees it
  // in the handshake and can change it like any other.
  const defaultedDod = input.definitionOfDone === undefined ? texts(language).defaultDod(input.goal, agenda.some((s) => s.method !== undefined && s.method !== null)) : undefined;
  const definitionOfDone = input.definitionOfDone ?? defaultedDod ?? input.goal;
  // "Everybody has voted" needs a list. Without one a vote is evaluated at
  // its deadline; with neither there is nothing that would ever close it.
  const votes = agenda.some((s) => s.method !== undefined && s.method !== null);
  const closeRule = closeRuleFor({ votes, open: openRoster, asked: input.closeRule, hasDeadline: deadline !== undefined, definitionOfDone: input.definitionOfDone }) ?? 'all_contributed';
  if (votes && openRoster) {
    notes.push('I cannot see who belongs to this conversation, so the vote is evaluated at the deadline, not when everybody has voted. To close as soon as everybody has voted, start again with the participants named.');
  }

  // The id is fixed before anything is stored: the kernel's scope, the
  // reservation of the conversation and the subscription all name it.
  const facilitationId = randomUUID();
  const process = { agentSlug: input.agentSlug, channelType: input.channelType, conversationId: input.conversationId, processId: facilitationId };
  const draft = {
    id: facilitationId,
    facilitatorAgent: input.agentSlug,
    channelType: input.channelType,
    conversationId: input.conversationId,
    createdAt: now,
    phase: 'configuring',
    followupState: 'none',
    followupPolicy: { actionItems: false, leadHours: 0 },
    deadline: null,
    followupEndsAt: null,
  } as unknown as Facilitation;

  // The `configuring` scope takes the conversation's reservation. Another
  // facilitation or an agent discussion that holds it is the kernel's answer.
  const scope = await ensureScope(engine, draft, 'configuring');
  if (!scope.ok) {
    if (scope.code === 'conversation_busy') throw new Refusal('conversation_taken', `This conversation is already in use (${scope.message}). One facilitation or discussion per conversation at a time. Nothing was started.`);
    throw new Refusal(scope.code, `${refusalText(scope.code, scope.message)} Nothing was started.`);
  }
  /** Nothing was created: give back what was taken for it. */
  const giveBack = async (reason: string): Promise<void> => {
    try {
      await endScope(engine, scope.scope, reason);
      await execution.releaseConversation({ processId: facilitationId, channelType: input.channelType, conversationId: input.conversationId, reason });
      await db.query('DELETE FROM plg_omadia_agent_facilitator_scopes WHERE facilitation_id = $1', [facilitationId]);
    } catch (err) {
      engine.log(`facilitation ${facilitationId}: giving back its scope failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Readiness of the facilitator's identity in this conversation: a checked
  // action under the scope. Consent that only needs renewing is repaired
  // once; anything else is said exactly and nothing starts.
  const authorization = { scopeId: scope.scope.scopeId, processId: facilitationId, phase: 'configuring' as const };
  const check = async (): Promise<ChannelReadinessReport | { refused: string }> => {
    const outcome = await sends.checkReadiness({ ...input, authorization });
    if (outcome.outcome === 'checked') return outcome.report;
    // A host without a readiness check: said as unverified, not as ready.
    if (outcome.code === 'channel_error') return { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [], verified: false };
    return { refused: refusalText(outcome.executionCode ?? outcome.code, outcome.message) };
  };
  let report = await check();
  const repair = kernel.readiness();
  if (!('refused' in report) && !report.ready && repair?.repairConsent && report.missing.some((m) => REPAIRABLE.has(m.code))) {
    const repaired = await repair.repairConsent(input);
    if (repaired.outcome !== 'failed') report = await check();
  }
  if ('refused' in report) {
    await giveBack('readiness check refused');
    throw new Refusal('not_ready', `${report.refused} Nothing was started.`);
  }
  if (!report.ready) {
    await giveBack('not ready');
    const lacking = report.missing.map((m) => `${m.code}: ${m.message}`);
    throw new Refusal(
      report.missing.some((m) => m.code === 'no_identity') ? 'no_identity' : 'not_ready',
      `I cannot facilitate here yet. Missing: ${lacking.length > 0 ? lacking.join('; ') : 'the channel reports it is not ready'}. Nothing was started.`,
    );
  }
  if (report.verified === false) notes.push(READINESS_UNVERIFIED);

  // Every message of the conversation, for this facilitation alone: what an
  // earlier facilitation received here is not this one's to read.
  const subscription = await messages.subscribe(process, { mode: 'all' });
  if (subscription.outcome === 'refused') {
    await giveBack('subscription refused');
    throw new Refusal(subscription.code, subscription.code === 'no_identity' ? OWN_IDENTITY_REQUIRED : `I cannot read this conversation: ${subscription.message}. Nothing was started.`);
  }

  try {
    const result = await db.transaction(async (tx) => {
      const facilitation = await store.createFacilitation(tx, {
        id: facilitationId,
        facilitatorAgent: input.agentSlug,
        channelType: input.channelType,
        conversationId: input.conversationId,
        initiatorPrincipal: input.callerPrincipalId,
        initiatorParticipant: input.callerPrincipalId,
        goal: input.goal,
        format: input.format ?? 'custom',
        language,
        timezone: input.timezone ?? config.timezone,
        closeRule,
        electorateSource: roll.source,
        reminderPolicy: askedHours
          ? { offsetsHours: askedHours, asked: true }
          : { offsetsHours: derivedHours ?? [...config.reminderOffsetsHours].sort((a, b) => b - a), baseHours: [...config.reminderOffsetsHours] },
        followupPolicy: { actionItems: input.followUp === true, leadHours: config.actionReminderLeadHours, ...(statusAt ? { statusAt: statusAt.toISOString() } : {}), ...(protocolMail ? { protocolMail: true } : {}) },
        settings: {
          changeWindowHours: config.changeWindowHours,
          runoffWindowHours: config.runoffWindowHours,
          confirmWindowMinutes: config.confirmWindowMinutes,
          rankedPoints: [...config.rankedPoints],
          ...(config.defaultDecisionMethod ? { defaultDecisionMethod: config.defaultDecisionMethod } : {}),
          scoped: true,
          readMode: 'all',
          ...(profile?.displayName ? { facilitatorName: profile.displayName } : {}),
          ...(input.callerDisplayName && !isPlaceholderName(input.callerDisplayName, input.callerPrincipalId) ? { initiatorName: input.callerDisplayName } : {}),
          ...(openRoster ? { openRoster: true } : {}),
          ...(roll.named ? { participantsNamed: true } : {}),
          ...(roll.expected.length > 0 ? { expected: roll.expected } : {}),
        },
        deadline: deadline ?? null,
        createdAt: now,
      });
      await store.addDodVersion(tx, {
        facilitationId: facilitation.id,
        text: definitionOfDone,
        criteria: input.dodCriteria ?? criteriaFor(agenda),
        proposedBy: input.callerPrincipalId,
        consentState: 'initial',
        effectiveAt: now,
        createdAt: now,
      });
      await store.replaceSteps(tx, facilitation.id, agenda);
      const participants = await storeRoll(tx, facilitation.id, roll, language, now);
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
      // Setting up is bounded by the `configuring` scope: when it runs out,
      // the facilitation ends with a short note (a minute before, so that
      // the note is still drawn from a scope that is open).
      await insertIfAbsent(
        tx,
        'plg_omadia_agent_facilitator_jobs',
        { facilitationId: facilitation.id, kind: 'configuring_end', dedupeKey: `${facilitation.id}:configuring_end`, dueAt: new Date(scope.scope.deadline.getTime() - MINUTE_MS), payload: {}, createdAt: now },
        '(dedupe_key)',
      );
      await store.appendEvent(tx, {
        facilitationId: facilitation.id,
        kind: 'configured',
        actor: 'facilitator',
        occurredAt: now,
        payload: { goal: input.goal, initiator: input.callerPrincipalId, participants: participants.length },
      });
      return { facilitation, created: true, participants, expected: roll.expected, notes, ...(defaultedDod !== undefined ? { defaultedDod } : {}) };
    });
    // What needs the kernel (the session's capabilities, the people of the
    // scope) is fetched now, outside any transaction.
    for (const hook of configured) await hook(engine, result.facilitation);
    await syncScopes(engine, facilitationId);
    return result;
  } catch (err) {
    await giveBack('not created');
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
  // The `active` scope is opened before the handshake is written: the kernel
  // ends `configuring` with it, and a refusal (an operator stopped the
  // facilitator) is the answer instead of a handshake that cannot go out.
  const before = await store.getFacilitation(engine.db(), facilitationId);
  if (before?.phase === 'configuring') {
    // Opening a scope is not an action the kernel's stop refuses; the
    // handshake is. Asked first, so that nothing is opened that cannot be said.
    const stop = await stoppedByOperator(engine, before);
    if (stop.stopped) throw new Refusal('kill_switch', `${refusalText('kill_switch', stop.message)} The facilitation was not opened.`);
    const scope = await ensureScope(engine, { ...before, phase: 'active' }, 'active');
    if (!scope.ok) throw new Refusal(scope.code, `${refusalText(scope.code, scope.message)} The facilitation was not opened.`);
  }
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
    // Set up in time: the bound of the set-up no longer applies.
    await w.tx.query(`DELETE FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND status = 'pending' AND kind = 'configuring_end'`, [w.f.id]);
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

/** What every ending without a result also does. */
export async function runAbortHooks(w: Work, report: string): Promise<void> {
  for (const hook of onAbort) await hook(w, report);
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

/** A facilitation ended: its conversation is given back and its scopes are
 *  ended as their work is done. Called outside the lock. Idempotent. */
export async function releaseConversation(engine: EngineCore, f: Facilitation): Promise<void> {
  try {
    await syncScopes(engine, f.id);
  } catch (err) {
    engine.log(`facilitation ${f.id}: giving back its conversation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
