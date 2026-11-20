// Counting and the evaluation table (spec 5.5). Pure functions over ballots:
// no clock, no database, no model. The engine feeds them from its tables and
// acts on what they return.

import type { CloseRule, MethodId, StepOption } from '../model.js';
import type { Ballot } from './ballot.js';

export interface CastBallot {
  principal: string;
  ballot: Ballot;
}

export interface Tally {
  /** Points or votes per option key, every option present. */
  scores: Record<string, number>;
  /** Option keys with the highest score; empty when nobody scored. */
  leaders: string[];
  /** Ballots that scored (abstentions excluded). */
  votes: number;
  abstentions: number;
}

export const DEFAULT_POINTS: readonly number[] = [3, 2, 1];

/** Count ranked, single-choice and approval ballots. */
export function tally(method: MethodId, options: readonly StepOption[], ballots: readonly CastBallot[], points: readonly number[] = DEFAULT_POINTS): Tally {
  const scores: Record<string, number> = Object.fromEntries(options.map((o) => [o.key, 0]));
  let votes = 0;
  let abstentions = 0;
  const add = (key: string, amount: number): void => {
    // A ballot from an earlier round may name an option that is no longer up.
    if (key in scores) scores[key] = (scores[key] ?? 0) + amount;
  };
  for (const { ballot } of ballots) {
    if (ballot.type === 'abstention') {
      abstentions += 1;
      continue;
    }
    if (method === 'ranked' && ballot.type === 'ranked') {
      // Missing ranks score nothing; ranks beyond the points list score 0.
      ballot.ranking.forEach((key, index) => add(key, points[index] ?? 0));
      votes += 1;
    } else if (method === 'single' && ballot.type === 'single') {
      add(ballot.choice, 1);
      votes += 1;
    } else if (method === 'approval' && ballot.type === 'approval') {
      for (const key of ballot.choices) add(key, 1);
      votes += 1;
    }
  }
  const top = Math.max(0, ...Object.values(scores));
  const leaders = top > 0 ? options.filter((o) => scores[o.key] === top).map((o) => o.key) : [];
  return { scores, leaders, votes, abstentions };
}

export interface AssignmentEvent {
  principal: string;
  nominations: { item: string; nominee: string }[];
  declines: string[];
  /** Items the principal confirmed for themselves in their own message. */
  confirms: string[];
}

export interface ItemAssignment {
  item: string;
  /** Who is named for the item right now. */
  nominee?: string;
  /** The nominee said yes in their own message. */
  confirmed: boolean;
}

/**
 * Replay nominations, confirmations and declines in order.
 *
 * A name binds only when that person confirmed it themselves: naming yourself
 * is nomination and confirmation in one. A confirmed item is taken; a later
 * nomination of somebody else does not displace it. A decline by the named
 * person reopens the item.
 */
export function assignmentState(items: readonly StepOption[], events: readonly AssignmentEvent[]): ItemAssignment[] {
  const state = new Map<string, ItemAssignment>(items.map((o) => [o.key, { item: o.key, confirmed: false }]));
  const set = (item: string, value: ItemAssignment): void => {
    if (state.has(item)) state.set(item, value);
  };
  for (const event of events) {
    for (const { item, nominee } of event.nominations) {
      const current = state.get(item);
      if (!current || current.confirmed) continue;
      set(item, { item, nominee, confirmed: nominee === event.principal });
    }
    for (const item of event.confirms) {
      const current = state.get(item);
      if (current && !current.confirmed && current.nominee === event.principal) set(item, { item, nominee: event.principal, confirmed: true });
    }
    for (const item of event.declines) {
      const current = state.get(item);
      if (current && current.nominee === event.principal) set(item, { item, confirmed: false });
    }
  }
  return items.map((o) => state.get(o.key) ?? { item: o.key, confirmed: false });
}

export type Evaluation =
  /** The close rule has not fired; `provisional` is what status shows. */
  | { state: 'waiting'; missing: string[]; provisional?: Tally }
  /** A change proposal is open: nothing concludes before it is decided. */
  | { state: 'blocked_by_proposal'; provisional?: Tally }
  | { state: 'clear'; winner: string; tally: Tally }
  | { state: 'tie'; tied: string[]; tally: Tally }
  | { state: 'consent_passed' }
  | { state: 'objection'; objections: { principal: string; reason: string }[] }
  | { state: 'assignment_done'; assignments: ItemAssignment[] }
  | { state: 'assignment_open'; assignments: ItemAssignment[]; openItems: string[]; unconfirmed: string[] };

export interface EvaluationInput {
  method: MethodId;
  /** The options of the current round (the tied ones in a runoff). */
  options: readonly StepOption[];
  points?: readonly number[];
  /** The latest valid ballot of each participant in the current round. */
  ballots: readonly CastBallot[];
  /** Assignment only: nominations, confirmations and declines in order. */
  assignmentEvents?: readonly AssignmentEvent[];
  /** "Every participant" means every active participant. */
  activeParticipants: readonly string[];
  closeRule: CloseRule;
  /** The deadline (of the facilitation or of the runoff round) has passed. */
  deadlineReached: boolean;
  /** Consent only: the step's consent window has ended. `undefined`: the
   *  step has no window (opened before windows existed); then it is decided
   *  when everybody answered, as before. */
  windowEnded?: boolean;
  hasOpenProposal: boolean;
}

function provisionalOf(input: EvaluationInput): Tally | undefined {
  return input.method === 'ranked' || input.method === 'single' || input.method === 'approval'
    ? tally(input.method, input.options, input.ballots, input.points)
    : undefined;
}

/** One row of the evaluation table. */
export function evaluate(input: EvaluationInput): Evaluation {
  const provisional = provisionalOf(input);
  const withProvisional = provisional ? { provisional } : {};

  // A pending change proposal always takes precedence.
  if (input.hasOpenProposal) return { state: 'blocked_by_proposal', ...withProvisional };

  if (input.method === 'assignment') {
    const assignments = assignmentState(input.options, input.assignmentEvents ?? []);
    const openItems = assignments.filter((a) => !a.nominee).map((a) => a.item);
    const unconfirmed = assignments.filter((a) => a.nominee && !a.confirmed).map((a) => a.item);
    return openItems.length === 0 && unconfirmed.length === 0
      ? { state: 'assignment_done', assignments }
      : { state: 'assignment_open', assignments, openItems, unconfirmed };
  }

  const contributed = new Set(input.ballots.map((b) => b.principal));
  const missing = input.activeParticipants.filter((p) => !contributed.has(p));
  const everybody = input.closeRule === 'all_contributed' && missing.length === 0 && input.activeParticipants.length > 0;
  // Participation complete is not result valid: first the close rule, then
  // the result. Consent follows the group-consent procedure (spec 5.7): it
  // is decided when its window ends, never because everybody agreed early.
  const fires = input.deadlineReached || (input.method === 'consent' && input.windowEnded !== undefined ? input.windowEnded : everybody);
  if (!fires) return { state: 'waiting', missing, ...withProvisional };

  if (input.method === 'consent') {
    const objections = input.ballots.flatMap((b) =>
      b.ballot.type === 'consent' && !b.ballot.consent ? [{ principal: b.principal, reason: b.ballot.reason }] : [],
    );
    // Passes when no objection stands.
    return objections.length > 0 ? { state: 'objection', objections } : { state: 'consent_passed' };
  }

  const counted = tally(input.method, input.options, input.ballots, input.points);
  const [winner, ...others] = counted.leaders;
  if (winner !== undefined && others.length === 0) return { state: 'clear', winner, tally: counted };
  // Nobody scored (only abstentions, or no ballot at the deadline): every
  // option is level.
  return { state: 'tie', tied: counted.leaders.length > 0 ? counted.leaders : input.options.map((o) => o.key), tally: counted };
}
