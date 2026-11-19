// Who takes part, and whether the engine knows it (D15).
//
// "Everybody has contributed" is a statement about a list. The engine makes
// it only about a list it knows to be complete: the members the channel
// listed, or the participants named in the request. Where the channel cannot
// list the members and nobody named them, there is no "everybody": a vote is
// evaluated at its deadline and a proposal waits for its window.

import type { RosterParticipant } from '../kernel.js';
import { principalKey } from '../kernel.js';
import type { CloseRule, Facilitation } from '../model.js';
import { isPlaceholderName } from './names.js';

type Settings = Pick<Facilitation, 'settings'>;

/** Names from the request that no person could be matched to yet. */
export const expectedNames = (f: Settings): readonly string[] => f.settings.expected ?? [];

/** The channel listed the members, or the request named the participants. */
export const listKnown = (f: Settings): boolean => f.settings.openRoster !== true;

/** Every participant is a known person: "everybody" can be checked. */
export const everybodyKnown = (f: Settings): boolean => listKnown(f) && expectedNames(f).length === 0;

/** The close rule the engine applies. Without a known list a vote never
 *  closes because "everybody" voted, whatever was stored. */
export const effectiveCloseRule = (f: Pick<Facilitation, 'settings' | 'closeRule'>): CloseRule => (listKnown(f) ? f.closeRule : 'at_deadline');

/** Keys that stand in the list of participants for the named people nobody
 *  was matched to: they are waited for like anybody else. */
export const expectedKeys = (f: Settings): string[] => expectedNames(f).map((name) => `named:${name}`);

const tokens = (name: string): string[] =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '');

/** "Marcel Wege" is "Marcel Wege - byte5", and "marcel" is "Marcel Wege":
 *  every word of the shorter name occurs in the longer one. */
export function sameName(a: string, b: string): boolean {
  const [x, y] = [tokens(a), tokens(b)];
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((t) => long.includes(t));
}

export interface Person {
  principalId: string;
  /** Undefined: nobody stated a name for this person yet. */
  displayName: string | undefined;
  email: string | null;
  source: 'roster' | 'joined';
}

export interface Roll {
  people: Person[];
  /** Named in the request, matched to nobody. */
  expected: string[];
  /** Whoever writes joins: the list is not known. */
  open: boolean;
  /** The request named the participants. */
  named: boolean;
}

const personOf = (member: RosterParticipant): Person => {
  const principalId = principalKey(member.userRef);
  const stated = member.userRef.displayName;
  return {
    principalId,
    displayName: stated && !isPlaceholderName(stated, principalId) ? stated.trim() : undefined,
    email: member.userRef.email ?? member.userPrincipalName ?? null,
    source: 'roster',
  };
};

/**
 * The participants of a new facilitation.
 *
 * The initiator always takes part. Participants named in the request are the
 * list: each is matched to exactly one listed member (or to the initiator),
 * and a name that matches nobody, or more than one person, is kept as named
 * until that person writes. Without names the listed members take part; where
 * the channel lists none, the list is open.
 */
export function buildRoll(input: {
  members: readonly RosterParticipant[];
  /** The channel listed every member. */
  complete: boolean;
  initiator: { principalId: string; displayName: string | undefined };
  named: readonly string[] | undefined;
}): Roll {
  const listed = input.members.map(personOf);
  const own = listed.find((p) => p.principalId === input.initiator.principalId);
  const initiator: Person = own ?? { principalId: input.initiator.principalId, displayName: input.initiator.displayName, email: null, source: 'joined' };
  const withInitiator = (people: Person[]): Person[] => (people.some((p) => p.principalId === initiator.principalId) ? people : [initiator, ...people]);

  const names = [...new Set((input.named ?? []).map((n) => n.trim()).filter((n) => n !== ''))];
  if (names.length === 0) return { people: withInitiator(listed), expected: [], open: !input.complete, named: false };

  const candidates = withInitiator(listed);
  const taken: Person[] = [];
  const expected: string[] = [];
  for (const name of names) {
    const matches = candidates.filter((p) => p.displayName !== undefined && sameName(p.displayName, name));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) expected.push(name);
    else if (!taken.includes(match)) taken.push(match);
  }
  return { people: withInitiator(taken), expected, open: false, named: true };
}
