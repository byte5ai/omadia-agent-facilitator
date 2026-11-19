// Question cards (1.1.0): a step is put to the group as a card where the
// channel declares the kind of question, and in the chat otherwise.
//
// A card is another way to say the same thing as a chat ballot. Both stay
// valid in one step and the newest answer of a person wins (spec B 5.3). What
// counts is decided here and nowhere else:
//
//   - the engine keeps every card it sent (`cards` table) and checks each
//     answer against it: the card, its proposal and version, the question,
//     its kind, its options. Everything in an answer except its author came
//     back through a client and may be forged; what does not fit is dropped
//     and put on record;
//   - an answer counts at once only when the platform verified who gave it.
//     One it did not verify is recorded as unconfirmed and its owner is asked
//     to confirm in the group, like a ballot read from free text;
//   - when a step is over its card is updated to the result; a new version of
//     the question (a runoff, a method changed by consent) is a new card and
//     the old one is marked as replaced.
//
// Nothing here is required of the kernel: without `capabilities` or without
// the kind, no card is posted and the chat ballots work as before.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import type { CardAnswerValue, CardOption, CardQuestion, CardQuestionKind, CardSendMembers, CardSupport, QuestionCard, TypedCardAnswer } from '../cards/types.js';
import { CARD_ID_PATTERN } from '../cards/types.js';
import * as store from '../db/store.js';
import { principalKey } from '../kernel.js';
import type { Ballot } from '../methods/ballot.js';
import type { CardRow, Facilitation, MethodId, Participant, Step } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { recordContribution } from './contributions.js';
import type { EngineCore, Work } from './core.js';
import { recordBallot, roundOptions, withoutTakenItems } from './decide.js';
import type { InboundHandler, InboundResult } from './inbound.js';
import { rulesOf } from './lifecycle.js';

/** The one question of a card that puts a step to the vote. */
export const VOTE_QUESTION = 'vote';
/** The one question of a card that collects ideas. */
export const IDEA_QUESTION = 'idea';
/** Abstaining on a choice card. Never an option key (those are A, B, ...). */
export const ABSTAIN = 'abstain';
const IDEA_MAX_LENGTH = 2000;
const REASON_MAX_LENGTH = 1000;
/** Above this a fixed list of candidates is too long for a card. */
const MAX_CANDIDATES = 25;

const KIND_OF_METHOD: Record<MethodId, CardQuestionKind> = { ranked: 'ranking', single: 'single_choice', approval: 'multiple_choice', consent: 'consent', assignment: 'assignment' };

/** What the channel of a facilitation declares about cards, if anything. */
export function cardSupport(engine: EngineCore, channelType: string): CardSupport | undefined {
  const service = engine.deps.kernel.conversationSend() as (CardSendMembers & object) | undefined;
  try {
    const card = typeof service?.capabilities === 'function' ? service.capabilities(channelType)?.card : undefined;
    return card && Array.isArray(card.kinds) && card.maxQuestions >= 1 ? card : undefined;
  } catch {
    return undefined;
  }
}

const pointsOf = (step: Step): number[] => (Array.isArray(step.methodConfig['points']) ? (step.methodConfig['points'] as number[]) : []);

/** A participant as a candidate on a card: the channel's own id of the person. */
const candidateId = (p: Participant): string => p.principalId.replace(/^user:/, '');

/** The question that puts a step to the vote, or undefined when a card cannot
 *  carry it (too many items, people a card cannot list). */
function voteQuestions(f: Facilitation, step: Step, participants: readonly Participant[], support: CardSupport): CardQuestion[] | undefined {
  if (!step.method || !support.kinds.includes(KIND_OF_METHOD[step.method])) return undefined;
  const t = texts(f.language);
  const options: CardOption[] = roundOptions(step).map((o) => ({ id: o.key, label: o.label }));
  const abstain: CardOption = { id: ABSTAIN, label: t.words.abstention };
  const base = { id: VOTE_QUESTION, required: true };
  switch (step.method) {
    case 'ranked': {
      const points = pointsOf(step);
      const ranks = Math.min(options.length, points.length > 0 ? points.length : options.length);
      return [{ ...base, kind: 'ranking', label: t.card.rank, options, ranks, rankLabels: Array.from({ length: ranks }, (_v, i) => t.card.rankLabel(i + 1, points[i])) }];
    }
    case 'single':
      return [{ ...base, kind: 'single_choice', label: t.card.single, options: [...options, abstain] }];
    case 'approval':
      return [{ ...base, kind: 'multiple_choice', label: t.card.approval, options: [...options, abstain], min: 1 }];
    case 'consent':
      return [{ ...base, kind: 'consent', label: String(step.methodConfig['statement'] ?? step.title), agreeLabel: t.words.consent, objectLabel: t.words.objection, reasonRequiredOnObject: true }];
    case 'assignment': {
      if (options.length === 0 || options.length > support.maxQuestions) return undefined;
      const people = participants.filter((p) => p.status === 'active');
      const listable = people.length > 0 && people.length <= MAX_CANDIDATES && people.every((p) => CARD_ID_PATTERN.test(candidateId(p)));
      const candidates = listable ? people.map((p) => ({ id: candidateId(p), label: p.displayName })) : ('conversation_members' as const);
      // One question per item; nobody has to answer all of them.
      return options.map((o) => ({ id: o.id, kind: 'assignment' as const, label: o.label, candidates, allowVolunteer: true, required: false }));
    }
  }
}

const cardIdOf = (step: Step, version: number): string => `${step.id}-v${String(version)}`;

async function nextVersion(w: Work, stepId: string): Promise<number> {
  const of = (await store.listCards(w.tx, w.f.id)).filter((c) => c.stepId === stepId);
  return of.reduce((max, c) => Math.max(max, c.proposalVersion), 0) + 1;
}

async function postCard(w: Work, step: Step, purpose: CardRow['purpose'], questions: CardQuestion[], fallbackText: string): Promise<void> {
  const t = texts(w.f.language);
  const version = await nextVersion(w, step.id);
  const closesAt = step.roundDeadline ?? w.f.deadline;
  const card: QuestionCard = {
    cardId: cardIdOf(step, version),
    proposalId: step.id,
    proposalVersion: version,
    title: step.title,
    intro: t.card.chatToo,
    questions,
    ...(closesAt ? { closesAt: closesAt.toISOString() } : {}),
    changeable: true,
    locale: w.f.language,
  };
  await store.addCard(w.tx, { cardId: card.cardId, facilitationId: w.f.id, stepId: step.id, round: step.round, purpose, proposalId: step.id, proposalVersion: version, card, createdAt: w.now });
  w.post({
    purpose: 'card',
    key: card.cardId,
    to: 'group',
    deliveryClass: 'essential',
    requiredPhases: ['active'],
    text: `${step.title}\n${t.card.chatToo}`,
    card,
    cardFallbackText: fallbackText,
    link: { kind: 'card', id: card.cardId },
  });
  await w.event('card_posted', 'engine', { cardId: card.cardId, stepId: step.id, round: step.round, version, purpose, kinds: questions.map((q) => q.kind) });
}

/** What closes with a card: the lines it shows instead of its inputs. */
async function closeCards(w: Work, cards: readonly CardRow[], state: 'closed' | 'superseded', lines: readonly string[]): Promise<void> {
  const support = cardSupport(w.engine, w.f.channelType);
  for (const card of cards) {
    if (card.state !== 'open') continue;
    await store.patchCard(w.tx, card.cardId, { state, closedAt: w.now });
    await w.event('card_closed', 'engine', { cardId: card.cardId, state });
    if (!support?.update) continue;
    // The update follows the card's own post through the outbox, in order.
    w.post({
      purpose: 'card_update',
      key: `${card.cardId}:${state}`,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      text: lines.join('\n'),
      cardUpdate: { cardId: card.cardId, update: { state: 'closed', title: card.card.title, resultLines: [...lines], closedAt: w.now.toISOString() } },
    });
  }
}

const openCardsOf = async (w: Work, stepId?: string): Promise<CardRow[]> =>
  (await store.listCards(w.tx, w.f.id)).filter((c) => c.state === 'open' && (stepId === undefined || c.stepId === stepId));

/**
 * Put a deciding step to the group as a card. False when it stays a chat
 * ballot (no cards here, not this kind, too much for a card). A card that is
 * already open for the step is replaced: this is a new version of the question.
 */
export async function postStepCard(w: Work, step: Step): Promise<boolean> {
  const t = texts(w.f.language);
  await closeCards(w, await openCardsOf(w, step.id), 'superseded', [t.card.superseded]);
  const support = cardSupport(w.engine, w.f.channelType);
  if (!support || !step.method) return false;
  const questions = voteQuestions(w.f, step, await store.listParticipants(w.tx, w.f.id), support);
  if (!questions) return false;
  await postCard(w, step, 'vote', questions, [step.title, ...rulesOf(w.f, step)].join('\n'));
  return true;
}

/** A collecting step: ideas can be sent through a text field as well. */
export async function postIdeaCard(w: Work, step: Step): Promise<void> {
  if (step.kind !== 'collect' || step.method !== null) return;
  const support = cardSupport(w.engine, w.f.channelType);
  if (!support?.kinds.includes('text')) return;
  const t = texts(w.f.language);
  await postCard(w, step, 'ideas', [{ id: IDEA_QUESTION, kind: 'text', label: t.card.idea, multiline: true, maxLength: IDEA_MAX_LENGTH, mode: 'append', required: true }], step.title);
}

/** A step is over: its card shows what came of it. */
export async function closeStepCards(w: Work, step: Step): Promise<void> {
  const cards = await openCardsOf(w, step.id);
  if (cards.length === 0) return;
  const t = texts(w.f.language);
  const decisions = (await store.listDecisions(w.tx, w.f.id)).filter((d) => d.stepId === step.id).map((d) => d.statement);
  await closeCards(w, cards, 'closed', decisions.length > 0 ? decisions : [t.card.closed(formatWhen(w.now, w.f.timezone, w.f.language))]);
}

/** The facilitation ended: no card stays open. */
export async function closeAllCards(w: Work): Promise<void> {
  const t = texts(w.f.language);
  await closeCards(w, await openCardsOf(w), 'closed', [t.card.closed(formatWhen(w.now, w.f.timezone, w.f.language))]);
}

// ── answers ─────────────────────────────────────────────────────────────────

const isText = (v: unknown): v is string => typeof v === 'string';
const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** One answer against the question it claims to answer. */
function fits(question: CardQuestion, answer: CardAnswerValue): boolean {
  if (answer.kind !== question.kind) return false;
  const ids = 'options' in question ? question.options.map((o) => o.id) : [];
  switch (answer.kind) {
    case 'single_choice':
      return isText(answer.optionId) && ids.includes(answer.optionId);
    case 'multiple_choice': {
      const chosen = answer.optionIds;
      if (!Array.isArray(chosen) || !chosen.every(isText) || !distinct(chosen) || !chosen.every((id) => ids.includes(id))) return false;
      const q = question as Extract<CardQuestion, { kind: 'multiple_choice' }>;
      return chosen.length >= (q.min ?? 0) && chosen.length <= (q.max ?? ids.length);
    }
    case 'ranking': {
      const ranking = answer.ranking;
      const q = question as Extract<CardQuestion, { kind: 'ranking' }>;
      return Array.isArray(ranking) && ranking.length >= 1 && ranking.length <= (q.ranks ?? ids.length) && ranking.every(isText) && distinct(ranking) && ranking.every((id) => ids.includes(id));
    }
    case 'consent': {
      if (answer.decision === 'agree') return true;
      if (answer.decision !== 'object') return false;
      const q = question as Extract<CardQuestion, { kind: 'consent' }>;
      const reason = isText(answer.reason) ? answer.reason.trim() : '';
      return reason.length <= REASON_MAX_LENGTH && (q.reasonRequiredOnObject !== true || reason !== '');
    }
    case 'assignment': {
      const q = question as Extract<CardQuestion, { kind: 'assignment' }>;
      if (answer.assignee === 'self') return q.allowVolunteer !== false;
      const assignee = answer.assignee as { id?: unknown } | null;
      if (assignee === null || typeof assignee !== 'object' || !isText(assignee.id) || assignee.id === '') return false;
      return q.candidates === 'conversation_members' || q.candidates.some((c) => c.id === assignee.id);
    }
    case 'text': {
      const q = question as Extract<CardQuestion, { kind: 'text' }>;
      return isText(answer.text) && answer.text.trim() !== '' && answer.text.length <= (q.maxLength ?? Number.MAX_SAFE_INTEGER);
    }
    case 'number': {
      const q = question as Extract<CardQuestion, { kind: 'number' }>;
      return typeof answer.value === 'number' && Number.isFinite(answer.value) && answer.value >= (q.min ?? -Infinity) && answer.value <= (q.max ?? Infinity);
    }
    case 'date':
      return isText(answer.value) && /^\d{4}-\d{2}-\d{2}$/.test(answer.value) && !Number.isNaN(Date.parse(answer.value));
    default:
      return false;
  }
}

/** The answers of a submission, checked against the card that was sent.
 *  Undefined when anything does not fit: nothing of a forged or broken
 *  submission is used. */
export function checkedAnswers(card: QuestionCard, answers: readonly CardAnswerValue[] | undefined): Map<string, CardAnswerValue> | undefined {
  if (!Array.isArray(answers) || answers.length === 0) return undefined;
  const byQuestion = new Map<string, CardAnswerValue>();
  for (const answer of answers as readonly CardAnswerValue[]) {
    if (answer === null || typeof answer !== 'object' || !isText(answer.questionId) || byQuestion.has(answer.questionId)) return undefined;
    const question = card.questions.find((q) => q.id === answer.questionId);
    if (!question || !fits(question, answer)) return undefined;
    byQuestion.set(answer.questionId, answer);
  }
  if (card.questions.some((q) => q.required !== false && !byQuestion.has(q.id))) return undefined;
  return byQuestion;
}

/** The ballot a checked submission of a vote card stands for. */
function ballotOf(step: Step, answers: Map<string, CardAnswerValue>, author: Participant, participants: readonly Participant[]): Ballot | undefined {
  if (step.method === 'assignment') {
    const active = participants.filter((p) => p.status === 'active');
    const nominations: { item: string; nominee: string }[] = [];
    for (const [item, answer] of answers) {
      if (answer.kind !== 'assignment') return undefined;
      const nominee = answer.assignee === 'self' ? author.principalId : principalKey({ id: answer.assignee.id });
      // Only somebody who takes part can be named.
      if (!active.some((p) => p.principalId === nominee)) return undefined;
      nominations.push({ item, nominee });
    }
    return nominations.length > 0 ? { type: 'assignment', nominations, declines: [] } : undefined;
  }
  const answer = answers.get(VOTE_QUESTION);
  switch (answer?.kind) {
    case 'ranking':
      return { type: 'ranked', ranking: [...answer.ranking] };
    case 'single_choice':
      return answer.optionId === ABSTAIN ? { type: 'abstention' } : { type: 'single', choice: answer.optionId };
    case 'multiple_choice': {
      const chosen = [...answer.optionIds];
      if (!chosen.includes(ABSTAIN)) return { type: 'approval', choices: chosen };
      // Abstaining and choosing at once says nothing.
      return chosen.length === 1 ? { type: 'abstention' } : undefined;
    }
    case 'consent':
      return answer.decision === 'agree' ? { type: 'consent', consent: true } : { type: 'consent', consent: false, reason: (answer.reason ?? '').trim() };
    default:
      return undefined;
  }
}

export type CardAnswerReader = (w: Work, input: { card: CardRow; answers: Map<string, CardAnswerValue>; record: ConversationMessageRecord; author: Participant; verified: boolean }) => Promise<InboundResult>;
const readers = new Map<CardRow['purpose'], CardAnswerReader>();
/** Who reads the checked answers of a card of one purpose. */
export function registerCardReader(purpose: CardRow['purpose'], reader: CardAnswerReader): void {
  readers.set(purpose, reader);
}

/**
 * A submitted card. Poll answers of the older form (no typed answers) are
 * not for this handler.
 */
export const cardAnswers: InboundHandler = async ({ w, record, author }) => {
  const submitted = record.cardAnswer as TypedCardAnswer | undefined;
  if (record.kind !== 'card_answer' || !submitted || submitted.answers === undefined) return undefined;
  const card = await store.getCard(w.tx, String(submitted.cardId));
  // A card of another facilitation is not looked at any further.
  if (!card || card.facilitationId !== w.f.id) return { outcome: 'card_answer_foreign' };
  if (!author) return { outcome: 'card_answer_not_participant' };
  if (card.state !== 'open' || (w.f.phase !== 'active' && w.f.phase !== 'configuring')) return { outcome: 'card_answer_closed' };
  // An answer to another proposal or version never counts.
  if (submitted.proposalId !== card.proposalId || submitted.proposalVersion !== card.proposalVersion) return { outcome: 'card_answer_stale' };
  const answers = checkedAnswers(card.card, submitted.answers);
  if (!answers) {
    await w.event('card_answer_refused', principalKey(record.author), { cardId: card.cardId, reason: 'does not fit the card that was sent' });
    return { outcome: 'card_answer_invalid' };
  }
  const reader = readers.get(card.purpose);
  if (!reader) return { outcome: 'card_answer_ignored' };
  // Counted at once only when the platform said who answered.
  return reader(w, { card, answers, record, author, verified: submitted.answererVerified === true });
};

/** Every answer to one card carries the card's message id: key it by person
 *  (and by event, where each submission is a contribution of its own). */
const ownRecord = (record: ConversationMessageRecord, perEvent: boolean): ConversationMessageRecord => ({
  ...record,
  messageId: `${record.messageId}#${principalKey(record.author)}${perEvent ? `#${record.eventId}` : ''}`,
});

const readVote: CardAnswerReader = async (w, { card, answers, record, author, verified }) => {
  const step = await store.openStepOf(w.tx, w.f.id);
  if (w.f.phase !== 'active' || !step || step.id !== card.stepId || step.round !== card.round) return { outcome: 'card_answer_stale' };
  const parsed = ballotOf(step, answers, author, await store.listParticipants(w.tx, w.f.id));
  if (!parsed) return { outcome: 'card_answer_invalid' };
  const ballot = await withoutTakenItems(w, step, author, parsed, record.eventId);
  if (!ballot) return { outcome: 'ballot_item_taken' };
  await recordBallot(w, { record: ownRecord(record, ballot.type === 'assignment'), author, step, ballot, interpreted: !verified, source: 'card' });
  return { outcome: 'card_answer' };
};

const readIdea: CardAnswerReader = async (w, { card, answers, record, author, verified }) => {
  const step = await store.openStepOf(w.tx, w.f.id);
  const answer = answers.get(IDEA_QUESTION);
  if (w.f.phase !== 'active' || !step || step.id !== card.stepId || answer?.kind !== 'text') return { outcome: 'card_answer_stale' };
  const text = answer.text.trim();
  await recordContribution(w, { record: ownRecord(record, true), author, step, kind: 'idea', payload: { text }, summary: text, interpreted: !verified, source: 'card' });
  return { outcome: 'card_answer' };
};

export function installCardReaders(): void {
  registerCardReader('vote', readVote);
  registerCardReader('ideas', readIdea);
}
