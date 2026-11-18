// What a facilitator turn may say in the group, checked against the state.
//
// The turn's prompt tells the model the same rules, but a rule a model may
// ignore is not a guarantee. These two are the engine's to keep:
//
//   - nobody is named in the group as not having contributed, and
//   - nothing is called closed while it is open.
//
// Pure functions: the caller supplies the state and decides what goes out
// instead (a neutral line). Deliberately narrow: a sentence is refused only
// when it both names a person who has not contributed and says so, so that
// thanking or addressing somebody by name stays possible.

export interface TurnState {
  /** Display names of the active participants the open step still waits for. */
  missing: readonly string[];
  /** A step that is decided by a vote is open. */
  voteOpen: boolean;
  /** The facilitation is being set up or running. */
  live: boolean;
}

export type TurnVerdict = { ok: true } | { ok: false; reason: 'names_missing' | 'claims_closed' };

const sentences = (text: string): string[] => text.split(/[.!?\n]+/u).map((s) => s.trim()).filter((s) => s !== '');

const NOT_CONTRIBUTED =
  /(noch nicht|nicht (beigetragen|abgestimmt|geantwortet|gewählt)|fehl(t|en)\b|ausstehend|steh(t|en) noch aus|warte[nt]?\s+(noch\s+)?auf|not yet|has\s?n[o'’]t|have\s?n[o'’]t|did\s?n[o'’]t|missing|outstanding|waiting (for|on)|yet to)/iu;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The full name and the first name, as whole words. */
function namePattern(displayName: string): RegExp | undefined {
  const full = displayName.trim();
  if (full === '') return undefined;
  const first = full.split(/\s+/u)[0] ?? '';
  const forms = [...new Set([full, ...(first.length >= 3 ? [first] : [])])].map(escape);
  return new RegExp(`(?<![\\p{L}\\p{N}])(${forms.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

function namesMissing(text: string, missing: readonly string[]): boolean {
  const patterns = missing.map(namePattern).filter((p): p is RegExp => p !== undefined);
  if (patterns.length === 0) return false;
  return sentences(text).some((sentence) => NOT_CONTRIBUTED.test(sentence) && patterns.some((p) => p.test(sentence)));
}

const VOTE_WORDS = '(abstimmung|wahl|umfrage|stichwahl|vote|voting|poll|runoff)';
const FACILITATION_WORDS = '(moderation|facilitation)';
const CLOSED = '(geschlossen|beendet|abgeschlossen|vorbei|closed|finished|over|ended|concluded)';
const STATES = '(ist|sind|is|are|has|have|wurde|wurden|was)';
// Not a claim: a negation, a condition, something that is still to come.
const NOT_A_CLAIM = /(?<![\p{L}])(nicht|kein\p{L}*|not|n[o'’]t|wenn|sobald|falls|bis|erst|wird|werden|if|when|once|until|will|would|should|soll\p{L}*)(?![\p{L}])/iu;

function claimsClosed(text: string, state: TurnState): boolean {
  if (!state.live) return false;
  const subjects = state.voteOpen ? `(${VOTE_WORDS}|${FACILITATION_WORDS})` : FACILITATION_WORDS;
  const claim = new RegExp(`(?<![\\p{L}])${subjects}(?![\\p{L}])[^.!?\\n]{0,60}?(?<![\\p{L}])${STATES}(?![\\p{L}])[^.!?\\n]{0,40}?(?<![\\p{L}])${CLOSED}(?![\\p{L}])`, 'iu');
  return sentences(text).some((sentence) => claim.test(sentence) && !NOT_A_CLAIM.test(sentence));
}

export function checkTurnText(text: string, state: TurnState): TurnVerdict {
  if (namesMissing(text, state.missing)) return { ok: false, reason: 'names_missing' };
  if (claimsClosed(text, state)) return { ok: false, reason: 'claims_closed' };
  return { ok: true };
}
