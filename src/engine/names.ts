// People are named by their name (first live run).
//
// The engine keys people by the kernel's principal id. That id is for the
// engine, never for a chat: every outgoing text passes through here and goes
// out with the name the facilitation knows for the id, or with a neutral word
// when it knows none.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Facilitation, Participant } from '../model.js';
import { de } from '../texts/de.js';
import { en } from '../texts/en.js';
import { texts } from '../texts/index.js';
import { PRINCIPAL_ID } from './guard.js';

const GUID_PRINCIPALS = new RegExp(PRINCIPAL_ID.source, 'gi');

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A stored display name that is no name: the placeholder, or an id that a
 *  channel gave in place of one. */
export function isPlaceholderName(name: string, principalId: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === '' || name === en.unnamedPerson || name === de.unnamedPerson || lower === principalId.toLowerCase()) return true;
  // The channel's own id of the person (a GUID, "29:1abc..."). A first name
  // that happens to be the whole id is a name.
  return `user:${lower}` === principalId.toLowerCase() && /[\d:]/.test(lower);
}

/** The name to store for somebody: what the channel stated, unless that is
 *  only their id again. */
export function nameOrPlaceholder(stated: string | null | undefined, principalId: string, language: Facilitation['language']): string {
  return stated && !isPlaceholderName(stated, principalId) ? stated.trim() : texts(language).unnamedPerson;
}

/** The name the facilitation knows for a principal, if it knows a real one. */
export function knownName(participants: readonly Participant[], principalId: string | null | undefined): string | undefined {
  if (!principalId) return undefined;
  const found = participants.find((p) => p.principalId === principalId || p.canonicalPrincipal === principalId);
  return found && !isPlaceholderName(found.displayName, found.principalId) ? found.displayName : undefined;
}

/** The name of the person who started a facilitation, once anybody stated it. */
export function initiatorName(f: Facilitation, participants: readonly Participant[]): string | undefined {
  return knownName(participants, f.initiatorParticipant) ?? knownName(participants, f.initiatorPrincipal) ?? f.settings.initiatorName;
}

/** Replace every principal id in a text by the person's name. */
export async function namePrincipals(q: Queryable, f: Facilitation, text: string): Promise<string> {
  if (!/user:/i.test(text)) return text;
  const t = texts(f.language);
  const participants = await store.listParticipants(q, f.id);
  const known = new Map<string, string | undefined>();
  for (const p of participants) known.set(p.principalId, knownName(participants, p.principalId));
  if (!known.has(f.initiatorPrincipal)) known.set(f.initiatorPrincipal, initiatorName(f, participants));
  let out = text;
  // Longest first: one id may be the beginning of another.
  for (const id of [...known.keys()].sort((a, b) => b.length - a.length)) {
    if (!id.toLowerCase().startsWith('user:')) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(id)}(?![\\p{L}\\p{N}_-])`, 'giu'), known.get(id) ?? t.someone);
  }
  return out.replace(GUID_PRINCIPALS, t.someone);
}
