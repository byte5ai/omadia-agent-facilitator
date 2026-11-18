// Ballots in the announced format, parsed without a model (spec 5.5).
//
// The handshake announces how to contribute ("A > C > B"). A message that is
// such a ballot from its first to its last character counts at once. Anything
// else is free text and goes to the facilitator's turn; what is read from it
// counts only after its author confirmed. So this parser is strict on purpose:
// when in doubt it says "not a ballot", never "probably this".

import type { MethodId, StepOption } from '../model.js';

export type Ballot =
  | { type: 'ranked'; ranking: string[] }
  | { type: 'single'; choice: string }
  | { type: 'approval'; choices: string[] }
  | { type: 'consent'; consent: true }
  | { type: 'consent'; consent: false; reason: string }
  | { type: 'assignment'; nominations: { item: string; nominee: string }[]; declines: string[] }
  | { type: 'abstention' };

export type BallotProblem =
  | 'duplicate_option'
  | 'duplicate_rank'
  | 'bad_rank'
  | 'unknown_option'
  | 'too_many_options'
  | 'reason_required'
  | 'unknown_person'
  | 'ambiguous_person';

export type ParseResult =
  | { kind: 'ballot'; ballot: Ballot }
  | { kind: 'invalid'; problem: BallotProblem; detail: string }
  | { kind: 'not_a_ballot' };

export interface Person {
  id: string;
  name: string;
}

export interface ParseInput {
  method: MethodId;
  options: readonly StepOption[];
  text: string;
  /** Who wrote it and who could be named (assignment only). */
  author?: Person;
  people?: readonly Person[];
}

const NOT_A_BALLOT: ParseResult = { kind: 'not_a_ballot' };
const invalid = (problem: BallotProblem, detail: string): ParseResult => ({ kind: 'invalid', problem, detail });

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const PREFIX = /^(?:(?:my |meine )?(?:vote|ballot|stimme|wahl|votum)\s*[:=-]\s*)/i;
const ABSTAIN = /^(?:abstain|abstention|i abstain|enthaltung|ich enthalte mich|enthalte mich)$/;
const CONSENT = /^(?:consent|agreed|agree|i agree|i consent|no objection|no objections|einverstanden|zustimmung|ich stimme zu|konsent|kein einwand|keine einwände|passt|\+1|👍)$/;
// A reason needs a separator, so "ich widerspreche nicht" is not an objection.
const OBJECTION = /^(?:objection|i object|einwand|veto|widerspruch|ich widerspreche)(?:\s*[:,-]\s*(.*))?$/is;
const SELF = /^(?:me|i|myself|ich|mich)$/;

/** Mentions and trailing punctuation are not part of a ballot. */
export function cleanBallotText(text: string): { text: string; prefixed: boolean } {
  let cleaned = text.trim().replace(/^(@\S+\s+)+/u, '');
  const prefixed = PREFIX.test(cleaned);
  cleaned = cleaned.replace(PREFIX, '').trim().replace(/[.!]+$/u, '').trim();
  return { text: cleaned, prefixed };
}

function findOption(options: readonly StepOption[], token: string): StepOption | undefined {
  const wanted = norm(token);
  return options.find((o) => norm(o.key) === wanted) ?? options.find((o) => norm(o.label) === wanted);
}

interface Listed {
  /** Tokens as written, in order. */
  tokens: string[];
  /** Explicit rank per token ("1. A"), when every token carried one. */
  ranks?: number[];
  /** The author used a separator or a prefix: clearly meant as a list. */
  explicit: boolean;
}

/** "A > C > B", "A, C, B", "1. A 2. C", one per line, or bare keys "A C B". */
function splitList(text: string, options: readonly StepOption[]): Listed {
  const hasSeparator = /[>,;\n]/.test(text);
  let parts = text
    .split(/[>,;\n]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  // "1. A 2. C 3. B" on one line.
  if (parts.length === 1 && /^\d+\s*[.):=]/.test(parts[0] ?? '')) {
    const numbered = (parts[0] ?? '').split(/\s+(?=\d+\s*[.):=])/).map((p) => p.trim());
    if (numbered.length > 1) parts = numbered;
  }
  const ranked = parts.map((p) => /^(\d+)\s*[.):=]\s*(.+)$/.exec(p));
  if (parts.length > 0 && ranked.every((m) => m !== null)) {
    return {
      tokens: ranked.map((m) => (m?.[2] ?? '').trim()),
      ranks: ranked.map((m) => Number(m?.[1])),
      explicit: true,
    };
  }
  // Bare keys separated by spaces count only when the whole text is one
  // option or nothing but options.
  if (parts.length === 1 && !findOption(options, parts[0] ?? '')) {
    const words = (parts[0] ?? '').split(/\s+/);
    if (words.length > 1 && words.every((word) => findOption(options, word))) return { tokens: words, explicit: false };
  }
  return { tokens: parts, explicit: hasSeparator };
}

type Resolved = { ok: true; keys: string[] } | { ok: false; result: ParseResult };

/** Resolve a written list to option keys, in the order meant. */
function resolveList(text: string, options: readonly StepOption[], prefixed: boolean): Resolved {
  if (text === '') return { ok: false, result: NOT_A_BALLOT };
  const list = splitList(text, options);
  const matched = list.tokens.map((token) => findOption(options, token));
  const known = matched.filter((m): m is StepOption => m !== undefined);
  if (known.length === 0) return { ok: false, result: NOT_A_BALLOT };
  if (known.length < list.tokens.length) {
    // Some of it names options, some does not. Only a text that was clearly
    // written as a ballot is answered with a hint; a sentence is left alone.
    if (!prefixed && !list.explicit) return { ok: false, result: NOT_A_BALLOT };
    const unknown = list.tokens.filter((_t, i) => matched[i] === undefined);
    if (!prefixed && unknown.some((u) => u.split(/\s+/).length > 3)) return { ok: false, result: NOT_A_BALLOT };
    return { ok: false, result: invalid('unknown_option', unknown.join(', ')) };
  }
  let keys = known.map((o) => o.key);
  if (list.ranks) {
    const ranks = list.ranks;
    if (new Set(ranks).size !== ranks.length) return { ok: false, result: invalid('duplicate_rank', ranks.join(', ')) };
    const sorted = [...ranks].sort((a, b) => a - b);
    if (sorted.some((rank, i) => rank !== i + 1)) return { ok: false, result: invalid('bad_rank', ranks.join(', ')) };
    keys = ranks.map((rank, i) => ({ rank, key: keys[i] ?? '' })).sort((a, b) => a.rank - b.rank).map((r) => r.key);
  }
  return { ok: true, keys };
}

export function resolvePerson(name: string, author: Person | undefined, people: readonly Person[]): Person | BallotProblem {
  const wanted = norm(name.replace(/^@/, ''));
  if (SELF.test(wanted)) return author ?? 'unknown_person';
  const exact = people.filter((p) => norm(p.name) === wanted);
  if (exact.length === 1 && exact[0]) return exact[0];
  const first = people.filter((p) => norm(p.name).split(' ')[0] === wanted);
  if (first.length === 1 && first[0]) return first[0];
  return exact.length > 1 || first.length > 1 ? 'ambiguous_person' : 'unknown_person';
}

const TAKE = /^(?:i(?:'ll| will)? take|i can do|ich übernehme|ich nehme|ich mache)\s+(.+)$/i;
const DECLINE = /^(?:decline|i decline|not me for|ich lehne ab|ablehnen|nicht ich für)\s*[:,-]?\s*(.+)$/i;

function parseAssignment(text: string, input: ParseInput): ParseResult {
  const people = input.people ?? [];
  const lines = text
    .split(/[;\n]+/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return NOT_A_BALLOT;
  const nominations: { item: string; nominee: string }[] = [];
  const declines: string[] = [];
  for (const line of lines) {
    const take = TAKE.exec(line);
    const decline = DECLINE.exec(line);
    const pair = /^(.+?)\s*(?::|->|=>|=|→)\s*(.+)$/.exec(line);
    if (take) {
      const item = findOption(input.options, take[1] ?? '');
      if (!item || !input.author) return NOT_A_BALLOT;
      nominations.push({ item: item.key, nominee: input.author.id });
    } else if (decline) {
      const item = findOption(input.options, decline[1] ?? '');
      if (!item) return NOT_A_BALLOT;
      declines.push(item.key);
    } else if (pair) {
      const item = findOption(input.options, pair[1] ?? '');
      if (!item) return NOT_A_BALLOT;
      const person = resolvePerson(pair[2] ?? '', input.author, people);
      if (typeof person === 'string') return invalid(person, (pair[2] ?? '').trim());
      nominations.push({ item: item.key, nominee: person.id });
    } else {
      return NOT_A_BALLOT;
    }
  }
  if (new Set(nominations.map((n) => n.item)).size !== nominations.length) {
    return invalid('duplicate_option', nominations.map((n) => n.item).join(', '));
  }
  return { kind: 'ballot', ballot: { type: 'assignment', nominations, declines } };
}

/** Read one message as a ballot of the step's method. */
export function parseBallot(input: ParseInput): ParseResult {
  const { text, prefixed } = cleanBallotText(input.text);
  const lowered = norm(text);
  // An empty ballot is not a contribution.
  if (lowered === '') return NOT_A_BALLOT;
  // Every method accepts an explicit abstention.
  if (ABSTAIN.test(lowered)) return { kind: 'ballot', ballot: { type: 'abstention' } };

  switch (input.method) {
    case 'ranked': {
      const list = resolveList(text, input.options, prefixed);
      if (!list.ok) return list.result;
      if (new Set(list.keys).size !== list.keys.length) return invalid('duplicate_option', list.keys.join(' > '));
      return { kind: 'ballot', ballot: { type: 'ranked', ranking: list.keys } };
    }
    case 'single': {
      const list = resolveList(text, input.options, prefixed);
      if (!list.ok) return list.result;
      const distinct = [...new Set(list.keys)];
      if (distinct.length > 1) return invalid('too_many_options', distinct.join(', '));
      return { kind: 'ballot', ballot: { type: 'single', choice: distinct[0] ?? '' } };
    }
    case 'approval': {
      const list = resolveList(text, input.options, prefixed);
      if (!list.ok) return list.result;
      return { kind: 'ballot', ballot: { type: 'approval', choices: [...new Set(list.keys)] } };
    }
    case 'consent': {
      if (CONSENT.test(lowered)) return { kind: 'ballot', ballot: { type: 'consent', consent: true } };
      const objection = OBJECTION.exec(text);
      if (!objection) return NOT_A_BALLOT;
      const reason = (objection[1] ?? '').trim();
      if (reason === '') return invalid('reason_required', '');
      return { kind: 'ballot', ballot: { type: 'consent', consent: false, reason } };
    }
    case 'assignment':
      return parseAssignment(text, input);
  }
}

const label = (options: readonly StepOption[], key: string): string => {
  const option = options.find((o) => o.key === key);
  return option ? `${option.key} (${option.label})` : key;
};

export interface BallotWords {
  abstention: string;
  consent: string;
  objection: string;
  declined: string;
}

const DEFAULT_WORDS: BallotWords = { abstention: 'abstention', consent: 'consent', objection: 'objection', declined: 'declined' };

/** A ballot as its author should read it back. */
export function summariseBallot(
  ballot: Ballot,
  options: readonly StepOption[],
  people: readonly Person[] = [],
  words: BallotWords = DEFAULT_WORDS,
): string {
  const name = (id: string): string => people.find((p) => p.id === id)?.name ?? id;
  switch (ballot.type) {
    case 'ranked':
      return ballot.ranking.map((k) => label(options, k)).join(' > ');
    case 'single':
      return label(options, ballot.choice);
    case 'approval':
      return ballot.choices.map((k) => label(options, k)).join(', ');
    case 'consent':
      return ballot.consent ? words.consent : `${words.objection}: ${ballot.reason}`;
    case 'assignment':
      return [
        ...ballot.nominations.map((n) => `${label(options, n.item)}: ${name(n.nominee)}`),
        ...ballot.declines.map((k) => `${label(options, k)}: ${words.declined}`),
      ].join('; ');
    case 'abstention':
      return words.abstention;
  }
}

/** A, B, ... Z, AA, AB: the keys a ballot uses. */
export function optionKey(index: number): string {
  let n = index;
  let key = '';
  do {
    key = String.fromCharCode(65 + (n % 26)) + key;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return key;
}

export const toOptions = (labels: readonly string[]): StepOption[] => labels.map((l, i) => ({ key: optionKey(i), label: l.trim() }));
