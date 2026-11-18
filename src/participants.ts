// Who is in the conversation and who still owes a contribution (0.7.0).
// Field report 2026-11-17: the facilitator only knew point totals, so "who
// has not voted yet" was guessed — wrongly, twice, with two participants
// sharing a first name. The roster comes live from the kernel (never
// persisted: names stay out of the run state), the contributors from
// facilitation_progress. A name that does not map to exactly ONE roster
// entry is reported as unmatched instead of being guessed.

import type { ConversationRostersService } from './services.js';

export interface ParticipantOverview {
  participants: string[];
  contributed: string[];
  pending: string[];
  /** Recorded contributor names that fit no roster entry, or more than one. */
  unmatched: string[];
  /** The kernel flagged the roster as incomplete — `pending` may miss people. */
  partial: boolean;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Index of the single roster entry `name` refers to: full-name equality
 *  first, then a name token (first or last name) that is unique in the roster. */
function matchParticipant(name: string, roster: readonly string[]): number | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;
  const exact = roster.findIndex((entry) => normalize(entry) === wanted);
  if (exact >= 0) return exact;
  const hits = roster
    .map((entry, index) => ({ index, tokens: normalize(entry).split(' ') }))
    .filter((entry) => entry.tokens.includes(wanted));
  return hits.length === 1 ? hits[0]!.index : undefined;
}

export function buildParticipantOverview(
  roster: { participants: readonly string[]; partial: boolean },
  contributors: readonly string[],
): ParticipantOverview {
  const matched = new Set<number>();
  const unmatched: string[] = [];
  for (const name of contributors) {
    const index = matchParticipant(name, roster.participants);
    if (index === undefined) unmatched.push(name);
    else matched.add(index);
  }
  return {
    participants: [...roster.participants],
    contributed: roster.participants.filter((_, index) => matched.has(index)),
    pending: roster.participants.filter((_, index) => !matched.has(index)),
    unmatched,
    partial: roster.partial,
  };
}

/** Human (non-bot) display names of the conversation, or undefined when the
 *  kernel has no roster service / no roster / the lookup failed. */
export async function loadHumanRoster(
  rosters: ConversationRostersService | undefined,
  channelType: string | undefined,
  conversationId: string,
  log: (msg: string) => void,
): Promise<{ participants: string[]; partial: boolean } | undefined> {
  if (!rosters || !channelType) return undefined;
  try {
    const roster = await rosters.getRoster(channelType, conversationId);
    if (!roster) return undefined;
    const participants = roster.participants
      .filter((p) => p.isBot !== true)
      .map((p) => p.userRef.displayName?.trim() ?? '')
      .filter((name) => name.length > 0);
    return { participants, partial: roster.partial };
  } catch (err) {
    log(`roster lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function describeParticipants(overview: ParticipantOverview, de: boolean): string[] {
  const list = (names: readonly string[]): string => (names.length > 0 ? names.join(', ') : '–');
  const lines = [
    de
      ? `Teilnehmende (${String(overview.participants.length)}${overview.partial ? ', Liste unvollständig' : ''}): ${list(overview.participants)}`
      : `Participants (${String(overview.participants.length)}${overview.partial ? ', list incomplete' : ''}): ${list(overview.participants)}`,
    de ? `Beitrag erfasst: ${list(overview.contributed)}` : `Contribution recorded: ${list(overview.contributed)}`,
    de ? `Ausstehend: ${list(overview.pending)}` : `Pending: ${list(overview.pending)}`,
  ];
  if (overview.unmatched.length > 0) {
    lines.push(
      de
        ? `Nicht eindeutig zuordenbar (bitte mit vollem Namen aus der Teilnehmerliste protokollieren): ${list(overview.unmatched)}`
        : `Not uniquely matched (record them with the full name from the participant list): ${list(overview.unmatched)}`,
    );
  }
  return lines;
}
