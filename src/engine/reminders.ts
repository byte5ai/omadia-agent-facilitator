// When the engine reminds (D16).
//
// Reminders are offsets before the deadline. The group may ask for its own
// (minutes); otherwise they follow from the time that is left, so that none
// is announced that lies in the past or cannot matter any more.

import { HOUR_MS, MINUTE_MS } from '../clock.js';
import type { Facilitation } from '../model.js';
import { Refusal } from './core.js';

/** A configured offset is used when it leaves at least this share of the
 *  time before it. */
const USABLE_SHARE = 0.8;
/** Closer to the deadline than this, no reminder is derived. */
const MIN_LEAD_MS = 10 * MINUTE_MS;
/** With no configured offset that fits: one reminder in the last quarter. */
const LAST_SHARE = 0.25;
const MIN_OFFSET_MINUTES = 2;

/** The default offsets (hours before the deadline, latest last) for a
 *  deadline that is `remainingMs` away. */
export function reminderOffsetsFor(remainingMs: number, configuredHours: readonly number[]): number[] {
  const fit = configuredHours.filter((h) => h > 0 && h * HOUR_MS <= remainingMs * USABLE_SHARE).sort((a, b) => b - a);
  if (fit.length > 0) return fit;
  if (remainingMs < MIN_LEAD_MS) return [];
  return [Math.max(MIN_OFFSET_MINUTES, Math.round((remainingMs * LAST_SHARE) / MINUTE_MS)) / 60];
}

/** Offsets somebody asked for, in minutes before the deadline. An empty list
 *  means no reminders. One that cannot happen is refused, not dropped. */
export function askedOffsets(raw: unknown, deadline: Date | null | undefined, now: Date): number[] {
  if (!Array.isArray(raw) || raw.some((m) => typeof m !== 'number' || !Number.isFinite(m))) {
    throw new Refusal('bad_reminder', "'reminderMinutesBefore' must be a list of numbers: minutes before the deadline, an empty list for no reminders.");
  }
  const minutes = [...new Set(raw as number[])].sort((a, b) => b - a);
  if (minutes.length === 0) return [];
  if (!deadline) throw new Refusal('bad_reminder', 'Reminders are sent before a deadline, and there is none. Set a deadline with them. Nothing was changed.');
  const remaining = Math.floor((deadline.getTime() - now.getTime()) / MINUTE_MS);
  const impossible = minutes.filter((m) => m <= 0 || m >= remaining);
  if (impossible.length > 0) {
    throw new Refusal(
      'bad_reminder',
      `A reminder must lie between now and the deadline, which is ${String(remaining)} minutes away: ${impossible.map(String).join(', ')} minutes before it does not. Nothing was changed.`,
    );
  }
  return minutes.map((m) => m / 60);
}

/** The offsets whose reminder is still ahead. */
export function upcomingOffsets(f: Pick<Facilitation, 'deadline' | 'reminderPolicy'>, now: Date): number[] {
  const deadline = f.deadline;
  if (!deadline) return [];
  return f.reminderPolicy.offsetsHours.filter((h) => deadline.getTime() - h * HOUR_MS > now.getTime()).sort((a, b) => b - a);
}
