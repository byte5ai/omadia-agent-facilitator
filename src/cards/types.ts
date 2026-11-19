// Question cards: the shapes of the kernel contract (#2089), declared here
// structurally.
//
// The engine runs on kernels that do not have cards yet (compat.core starts
// at plugin-api 1.55.0), so it does not import these from '@omadia/plugin-api'
// and feature-detects every member at run time. They mirror
// `questionCard.ts` of the kernel; when a name changes there, it changes here.

export type CardQuestionKind = 'single_choice' | 'multiple_choice' | 'ranking' | 'consent' | 'assignment' | 'text' | 'number' | 'date';

/** Ids of cards, questions and options: what the kernel accepts. */
export const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CardOption {
  id: string;
  label: string;
}

interface CardQuestionBase {
  id: string;
  label: string;
  help?: string;
  /** Default `true`. */
  required?: boolean;
}

/**
 * The engine's own note on a text question that stands in for a number or a
 * date field the channel does not have: what the typed answer has to be. Kept
 * with the stored card and never sent to the channel.
 */
export type ExpectedAnswer = { kind: 'number'; min?: number; max?: number } | { kind: 'date' };

export type CardQuestion = CardQuestionBase &
  (
    | { kind: 'single_choice'; options: readonly CardOption[] }
    | { kind: 'multiple_choice'; options: readonly CardOption[]; min?: number; max?: number }
    | { kind: 'ranking'; options: readonly CardOption[]; ranks?: number; rankLabels?: readonly string[] }
    | { kind: 'consent'; agreeLabel?: string; objectLabel?: string; reasonRequiredOnObject?: boolean }
    | { kind: 'assignment'; candidates: 'conversation_members' | readonly CardOption[]; allowVolunteer?: boolean }
    | { kind: 'text'; multiline?: boolean; maxLength?: number; mode?: 'replace' | 'append'; expects?: ExpectedAnswer }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'date' }
  );

export interface QuestionCard {
  cardId: string;
  proposalId?: string;
  proposalVersion?: number;
  title: string;
  intro?: string;
  questions: readonly CardQuestion[];
  closesAt?: string;
  changeable?: boolean;
  locale?: string;
}

/** What a channel declares about question cards. */
export interface CardSupport {
  kinds: readonly CardQuestionKind[];
  maxQuestions: number;
  update: boolean;
}

export type CardAnswerValue = { questionId: string } & (
  | { kind: 'single_choice'; optionId: string }
  | { kind: 'multiple_choice'; optionIds: readonly string[] }
  | { kind: 'ranking'; ranking: readonly string[] }
  | { kind: 'consent'; decision: 'agree' | 'object'; reason?: string }
  | { kind: 'assignment'; assignee: 'self' | { kind: string; id: string; displayName?: string } }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: string }
);

export type CardUpdate = { state: 'closed'; title: string; resultLines: readonly string[]; closedAt: string } | { state: 'open'; card: QuestionCard };

export type CardUpdateOutcome = { outcome: 'updated' } | { outcome: 'unreachable'; code: string; message: string };

/** The members of 'conversationSend' a kernel with cards has in addition. */
export interface CardSendMembers {
  capabilities?(channelType: string): { card?: CardSupport } | undefined;
  updateCard?(request: { agentSlug: string; channelType: string; conversationId: string; cardMessageId: string; update: CardUpdate }): Promise<CardUpdateOutcome>;
}

/** What a `card_answer` event of a question card carries beside its value. */
export interface TypedCardAnswer {
  cardId: string;
  value: unknown;
  answererVerified?: boolean;
  proposalId?: string;
  proposalVersion?: number;
  answers?: readonly CardAnswerValue[];
}
