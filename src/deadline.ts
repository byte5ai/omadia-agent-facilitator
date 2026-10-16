// Deadline handling for facilitation_start (0.6.0). Field report: a
// facilitation with a stated vote deadline was started with ttlHours=18 and
// the workflow expired 4.5 h BEFORE that deadline. The workflow TTL is now
// derived from the deadline (plus grace for the closing round) whenever one
// is stated, and a kernel clamp is surfaced instead of silently accepted.

const HOUR_MS = 60 * 60 * 1000;
/** Time after the deadline for the closing round + confirmation + report. */
export const DEADLINE_GRACE_HOURS = 2;
/** expiresAt is computed kernel-side a moment after the request — anything
 *  inside this tolerance is not a clamp. */
const CLAMP_TOLERANCE_MS = 60 * 1000;

// ISO 8601 date-time WITH an explicit offset or Z. A bare local time is
// ambiguous (whose timezone?) and refused rather than guessed.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** `value` is the caller's own string (trimmed, validated) — shown and stored
 *  as given so the group sees the deadline in its own timezone; `date` is
 *  only for the TTL math. */
export type DeadlineParse = { ok: true; date: Date; value: string } | { ok: false; reason: 'format' | 'past' };

export function parseDeadline(raw: string, now: Date): DeadlineParse {
  const trimmed = raw.trim();
  if (!ISO_WITH_OFFSET.test(trimmed)) return { ok: false, reason: 'format' };
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return { ok: false, reason: 'format' };
  if (ms <= now.getTime()) return { ok: false, reason: 'past' };
  return { ok: true, date: new Date(ms), value: trimmed };
}

/** The workflow must outlive the deadline: max(requested TTL, deadline + grace). */
export function effectiveTtlHours(input: { ttlHours: number; deadline?: Date; now: Date }): number {
  if (!input.deadline) return input.ttlHours;
  const hoursUntil = (input.deadline.getTime() - input.now.getTime()) / HOUR_MS;
  return Math.max(input.ttlHours, hoursUntil + DEADLINE_GRACE_HOURS);
}

/** True when the kernel granted noticeably less lifetime than requested. */
export function wasClamped(requestedMs: number, expiresAt: string, now: Date): boolean {
  const granted = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(granted)) return false;
  return granted < requestedMs - CLAMP_TOLERANCE_MS;
}
