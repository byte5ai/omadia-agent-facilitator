// The known electorate (spec 5.5; #2061, criteria 35 and 44).
//
// "Everybody has contributed" and "nobody objected" are statements about a
// list of people. The engine makes them only about a list it knows to be
// complete and current. Where that list comes from is fixed at start:
//
//   platform_roster  the channel listed every member at start. Before every
//                    automatic completeness or consent decision the member
//                    list is asked for again with `fresh: true` (no cache).
//                    Anything but `complete` means no automatic decision:
//                    the group is told once, and the engine tries again with
//                    the next contribution or reminder. A `complete` answer
//                    brings the participants up to date (a join or leave the
//                    channel's events missed is found here).
//   declared_list    the channel could not list every member at start. The
//                    list is what the initiator named, plus the people a
//                    participant named who confirmed by writing, plus
//                    whoever posts here. Nobody is removed by others. The
//                    list is complete by its own rules once every named
//                    person has been matched; nothing is asked of the channel.
//
// The final consent of a closing (spec 5.2, closing procedure part 3) needs a
// verified electorate as well: `finalConsentElectorate` says whether it is
// verified now, when to ask again (hourly) or that it can no longer be (24 h
// after the window ended: "participants could not be verified"). The closing
// procedure (#2064) calls it; a consent step decided at the facilitation's
// deadline cannot wait past it and fails at once instead.

import { HOUR_MS } from '../clock.js';
import * as store from '../db/store.js';
import { principalKey, rosterStatusOf } from '../kernel.js';
import type { ConversationRoster, RosterParticipant, RosterStatus } from '../kernel.js';
import type { ElectorateSource, Participant } from '../model.js';
import { texts } from '../texts/index.js';
import type { Work } from './core.js';
import { Refusal } from './core.js';
import { isBot } from './membership.js';
import { isPlaceholderName, nameOrPlaceholder } from './names.js';
import { everybodyKnown, expectedNames, sameName } from './roll.js';
import { stepElectorate, verifySessionElectorate } from './sessionElectorate.js';

/** The final consent asks again at this interval ... */
export const FINAL_ELECTORATE_RETRY_MS = HOUR_MS;
/** ... for at most this long after its window ended. */
export const FINAL_ELECTORATE_MAX_MS = 24 * HOUR_MS;

/** Why the electorate is not verified. */
export type UnverifiedReason = RosterStatus | 'names_pending' | 'undeclared';

export type ElectorateCheck = { verified: true } | { verified: false; reason: Exclude<UnverifiedReason, 'complete'> };

/** The source a new facilitation fixes: the member list counts only if the
 *  channel said it is complete and it lists at least one person. */
export function electorateSourceAtStart(status: RosterStatus, humans: number): ElectorateSource {
  return status === 'complete' && humans > 0 ? 'platform_roster' : 'declared_list';
}

const humansOf = (members: readonly RosterParticipant[]): RosterParticipant[] =>
  members.filter((m) => m.isBot !== true && !isBot({ kind: m.userRef.kind, id: m.userRef.id, ...(m.isBot !== undefined ? { isBot: m.isBot } : {}) }));

/** One fresh question per unit of work: a decision that looks twice gets the
 *  same answer, and the channel is not asked twice in one transaction. */
const asked = new WeakMap<object, { check: Promise<ElectorateCheck>; notice: boolean }>();

/**
 * Is the list of participants complete and current, so that the engine may
 * decide automatically? With the platform roster this asks the channel now.
 * `notice: false` keeps the group from being told (a decision that is only
 * looked at, not taken).
 */
export function verifyElectorate(w: Work, opts: { notice?: boolean } = {}): Promise<ElectorateCheck> {
  const notice = opts.notice !== false;
  const cached = asked.get(w.tx);
  // A quiet answer is reused only by another quiet check: a check that may
  // tell the group asks again, so that the notice is not lost.
  if (cached && (cached.notice || !notice)) return cached.check;
  const check = check_(w, notice);
  asked.set(w.tx, { check, notice });
  return check;
}

/**
 * Consent decided at the end of a window ("nobody objected") needs the list
 * the channel can verify, not every waited-for name: a person named but not
 * matched yet, or a list nobody declared, does not hold a window. A roster
 * that is not `complete` does.
 */
export const windowMayPass = (check: ElectorateCheck): boolean => check.verified || check.reason === 'names_pending' || check.reason === 'undeclared';

/** Work that a reminder retries when a decision was held (spec 5.5: "retry at
 *  the next contribution or reminder"). */
export type HeldDecisionRetry = (w: Work) => Promise<void>;
const retries: HeldDecisionRetry[] = [];
export function onHeldDecisionRetry(retry: HeldDecisionRetry): void {
  if (!retries.includes(retry)) retries.push(retry);
}
export async function retryHeldDecisions(w: Work): Promise<void> {
  for (const retry of retries) {
    if (w.f.phase !== 'active' && w.f.phase !== 'configuring') return;
    await retry(w);
  }
}

async function check_(w: Work, notice: boolean): Promise<ElectorateCheck> {
  // A step run inside a session has its session's electorate (5.5).
  const step = await store.openStepOf(w.tx, w.f.id);
  const electorate = step?.electorateSessionId ? await stepElectorate(w.tx, w.f, step) : undefined;
  if (electorate?.session) {
    const checked = await verifySessionElectorate(w, electorate.session);
    if (checked.verified) return checked;
    await unverified(w, checked.reason, notice);
    return { verified: false, reason: checked.reason };
  }
  if (w.f.electorateSource === 'declared_list') {
    if (w.f.settings.openRoster === true) return { verified: false, reason: 'undeclared' };
    return everybodyKnown(w.f) ? { verified: true } : { verified: false, reason: 'names_pending' };
  }
  const roster = await freshRoster(w);
  const humans = humansOf(roster?.participants ?? []);
  // A member list without a single person is no answer either.
  const status: RosterStatus = humans.length === 0 ? 'unknown' : rosterStatusOf(roster);
  if (status !== 'complete') {
    await unverified(w, status, notice);
    return { verified: false, reason: status };
  }
  await syncWithRoster(w, humans);
  if (w.f.settings.electorateUnverifiedSince !== undefined) {
    const { electorateUnverifiedSince: _gone, ...settings } = w.f.settings;
    await w.patch({ settings });
    await w.event('electorate_verified', 'engine', {});
  }
  // Names from the request nobody was matched to are still waited for.
  return everybodyKnown(w.f) ? { verified: true } : { verified: false, reason: 'names_pending' };
}

/**
 * The channel's member list, asked now. This runs inside the facilitation's
 * unit of work: the answer and what is decided on it belong together. The
 * call is bounded, so a slow channel holds the transaction (and its pooled
 * connection) for at most this long; no answer in time is `unknown`.
 */
export const FRESH_ROSTER_TIMEOUT_MS = 5000;

async function freshRoster(w: Work): Promise<ConversationRoster | undefined> {
  const call = w.engine.deps.kernel.rosters()?.getRoster(w.f.channelType, w.f.conversationId, { agentSlug: w.f.facilitatorAgent, fresh: true });
  if (!call) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      w.engine.log(`facilitation ${w.f.id}: fresh member list did not answer within ${String(FRESH_ROSTER_TIMEOUT_MS)} ms`);
      resolve(undefined);
    }, FRESH_ROSTER_TIMEOUT_MS);
  });
  const answer = call.catch((err: unknown) => {
    w.engine.log(`facilitation ${w.f.id}: fresh member list failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function unverified(w: Work, status: RosterStatus, notice: boolean): Promise<void> {
  if (w.f.settings.electorateUnverifiedSince !== undefined) return;
  // A check that may not tell the group leaves the period unopened, so the
  // next check that may tell it still says so once.
  if (!notice) {
    await w.event('electorate_unverified', 'engine', { status, quiet: true });
    return;
  }
  await w.patch({ settings: { ...w.f.settings, electorateUnverifiedSince: w.now.toISOString() } });
  await w.event('electorate_unverified', 'engine', { status });
  w.post({
    purpose: 'electorate_unverified',
    key: `${w.f.id}:${w.now.toISOString()}`,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['configuring', 'active'],
    text: texts(w.f.language).electorateUnverified(),
  });
}

/**
 * Bring the participants up to date with a complete member list: a member who
 * is not on the list joins, a participant who is no longer a member has left.
 * Where the initiator named the participants, the list is theirs: nobody is
 * added from the channel, only a departure is taken over.
 */
async function syncWithRoster(w: Work, humans: readonly RosterParticipant[]): Promise<void> {
  const t = texts(w.f.language);
  const members = new Map(humans.map((m) => [principalKey(m.userRef), m]));
  const participants = await store.listParticipants(w.tx, w.f.id);
  let changed = false;
  if (w.f.settings.participantsNamed !== true) {
    for (const [key, member] of members) {
      const existing = participants.find((p) => p.principalId === key);
      if (existing?.status === 'active') continue;
      const stated = member.userRef.displayName;
      const name = nameOrPlaceholder(stated && !isPlaceholderName(stated, key) ? stated : existing?.displayName, key, w.f.language);
      if (existing) await store.patchParticipant(w.tx, w.f.id, key, { status: 'active', leftAt: null, changedAt: w.now, changedByEvent: 'fresh_roster' });
      else {
        await store.addParticipant(w.tx, {
          facilitationId: w.f.id,
          principalId: key,
          canonicalPrincipal: key,
          displayName: name,
          email: member.userRef.email ?? member.userPrincipalName ?? null,
          source: 'roster',
          joinedAt: w.now,
          changedAt: w.now,
          changedByEvent: 'fresh_roster',
        });
      }
      changed = true;
      await w.event('participant_joined', key, { by: 'fresh_roster' });
      w.post({ purpose: 'joined', key: `fresh:${key}:${w.now.toISOString()}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.joined(name, w.f.goal), mentions: [{ user: key, text: name }] });
    }
  }
  for (const p of participants) {
    if (p.status !== 'active' || members.has(p.principalId)) continue;
    await store.patchParticipant(w.tx, w.f.id, p.principalId, { status: 'left', leftAt: w.now, changedAt: w.now, changedByEvent: 'fresh_roster' });
    changed = true;
    await w.event('participant_left', p.principalId, { by: 'fresh_roster' });
    w.post({ purpose: 'left', key: `fresh:${p.principalId}:${w.now.toISOString()}`, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.left(p.displayName) });
  }
  if (changed) w.bump();
}

/** What the final consent of a closing may do now. */
export type FinalConsentElectorate = { state: 'verified' } | { state: 'retry'; at: Date } | { state: 'unverifiable' };

/**
 * The final consent decision (spec 5.2, closing procedure part 3; criterion
 * 44) needs a verified electorate. With the platform roster it is asked
 * fresh at the end of the window and then hourly, for at most 24 hours; if it
 * never becomes `complete`, the result is `not confirmed` with the reason
 * "participants could not be verified". A declared list is complete by its
 * own rules: a named person who never confirmed is not a participant whose
 * silence could be missing.
 */
export async function finalConsentElectorate(w: Work, windowEndedAt: Date): Promise<FinalConsentElectorate> {
  if (w.f.electorateSource === 'declared_list') return { state: 'verified' };
  const check = await verifyElectorate(w, { notice: false });
  if (check.verified || check.reason === 'names_pending') return { state: 'verified' };
  const giveUpAt = windowEndedAt.getTime() + FINAL_ELECTORATE_MAX_MS;
  if (w.now.getTime() >= giveUpAt) return { state: 'unverifiable' };
  return { state: 'retry', at: new Date(Math.min(w.now.getTime() + FINAL_ELECTORATE_RETRY_MS, giveUpAt)) };
}

/**
 * A participant names a person who is missing from a declared list (spec
 * 5.5). The name is waited for like the ones from the request; the person is
 * added when they write here themselves (their own authenticated message is
 * the confirmation). With the platform roster there is nothing to name: the
 * channel lists everybody who is in the conversation.
 */
export async function nameMissingPerson(w: Work, by: Participant, name: string): Promise<'named' | 'already_listed' | 'already_named'> {
  if (w.f.phase !== 'configuring' && w.f.phase !== 'active') throw new Refusal('not_live', `The facilitation is ${w.f.phase}; the list of participants no longer changes.`);
  if (w.f.electorateSource !== 'declared_list') {
    throw new Refusal('roster_complete', 'The channel lists everybody in this conversation; whoever is here takes part. Nobody needs to be named.');
  }
  const wanted = name.trim();
  if (wanted === '') throw new Refusal('bad_input', "'name' is required.");
  const participants = (await store.listParticipants(w.tx, w.f.id)).filter((p) => p.status === 'active');
  if (participants.some((p) => sameName(p.displayName, wanted))) return 'already_listed';
  if (expectedNames(w.f).some((n) => sameName(n, wanted))) return 'already_named';
  await w.patch({
    settings: {
      ...w.f.settings,
      expected: [...expectedNames(w.f), wanted],
      namedByOthers: [...(w.f.settings.namedByOthers ?? []), wanted],
    },
  });
  w.bump();
  await w.event('participant_named', by.principalId, { name: wanted });
  w.post({
    purpose: 'participant_named',
    key: `${by.principalId}:${wanted}`,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['configuring', 'active'],
    text: texts(w.f.language).participantNamed(wanted, by.displayName),
  });
  return 'named';
}
