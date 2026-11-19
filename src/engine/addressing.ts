// How a message addresses the facilitator, as the channel writes it.
//
// A person types "@Mona" and picks the facilitator. What the channel stores
// is not "@Mona ...": Teams puts the mentioned display name into the text,
// without an "@" and as it is written, several words and parentheses
// included ("Mona (Test) erledigt 1"), or wrapped in a tag
// ("<at>Mona (Test)</at> erledigt 1"). A mention can also be shortened to a
// part of the name ("Mona erledigt 1").
//
// Whether a message addresses the facilitator is the kernel's statement
// (`addressedToBot` on the record, or its question to the engine), never a
// guess from the text. This module only takes the name off the start of the
// text, so that what follows can be read as the command it is.

import type { Facilitation } from '../model.js';

/** The names a mention of this facilitator can stand in the text as. */
export function namesOf(f: Pick<Facilitation, 'facilitatorAgent' | 'settings'>): string[] {
  return [f.settings.facilitatorName, f.facilitatorAgent].filter((name): name is string => typeof name === 'string' && name.trim() !== '');
}

const words = (name: string): string[] => name.trim().split(/\s+/u).filter((w) => w !== '');

/** What may stand between a mention and the text it is followed by. */
const AFTER = /^[\s,:;]+/u;
const TAG = /^<at(?:\s[^>]*)?>([^<]*)<\/at>/iu;

/**
 * The spellings of a name a mention can have, longest first: the whole name,
 * and, where the kernel said the message addresses the facilitator, every
 * shorter run of its first words ("Mona (Test)" -> "Mona").
 */
function spellings(names: readonly string[], addressed: boolean): string[] {
  const all = new Set<string>();
  for (const name of names) {
    const parts = words(name);
    // Without the kernel's statement a single word is just a word: a
    // sentence may well start with somebody's first name.
    if (!addressed && parts.length < 2) continue;
    for (let n = parts.length; n >= (addressed ? 1 : parts.length); n -= 1) all.add(parts.slice(0, n).join(' ').toLowerCase());
  }
  return [...all].filter((s) => s !== '').sort((a, b) => b.length - a.length);
}

/** One mention at the start of the text, taken off; undefined: there is none. */
function withoutOneMention(text: string, candidates: readonly string[], addressed: boolean): string | undefined {
  const tag = TAG.exec(text);
  // A mention tag is a mention whoever it names: the channel wrote it.
  if (tag) return text.slice(tag[0].length).replace(AFTER, '');
  const at = text.startsWith('@');
  const body = at ? text.slice(1) : text;
  const lower = body.toLowerCase();
  // The words of the name may be separated by any white space in the text.
  for (const candidate of candidates) {
    const pattern = new RegExp(`^${candidate.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
    const match = pattern.exec(lower);
    if (!match) continue;
    let rest = body.slice(match[0].length);
    // The name the channel shows may carry an addition the kernel's record of
    // the facilitator does not have ("Mona" there, "Mona (Test)" in Teams).
    if (addressed) rest = rest.replace(/^\s*\([^()]{0,40}\)/u, '');
    // A name is a mention only when something follows it, or the message is
    // nothing but the mention.
    if (rest !== '' && !AFTER.test(rest)) continue;
    return rest.replace(AFTER, '');
  }
  // "@token": a mention of somebody, written out by hand or by another channel.
  if (at) {
    const token = /^@\S+\s*/u.exec(text);
    if (token) return text.slice(token[0].length);
  }
  return undefined;
}

/**
 * The text without the mentions it starts with.
 *
 * `addressed`: the kernel stated that the message addresses the facilitator.
 * Only then a part of the name, or a name of one word, counts as a mention;
 * without that statement a whole name of several words has to stand there,
 * so that a sentence that merely starts with a first name is left as it is.
 */
export function withoutMention(text: string, names: readonly string[], addressed: boolean): string {
  const candidates = spellings(names, addressed);
  let rest = text.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = withoutOneMention(rest, candidates, addressed);
    if (next === undefined) break;
    rest = next;
  }
  return rest;
}
