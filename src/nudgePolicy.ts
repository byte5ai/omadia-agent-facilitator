// Deterministic nudge discipline (0.7.0). Field report 2026-11-17: the
// hourly assess tick posted twelve reminders into one group chat within a
// day, three of them after midnight and after everyone had voted. Whether a
// nudge is APPROPRIATE is no longer left to the model alone — these gates
// run in the tool, before anything is sent.

import type { FacilitatorConfig, QuietHours } from './config.js';
import { withLocalTime } from './localTime.js';
import type { FacilitationRecord } from './stateStore.js';

const HOUR_MS = 60 * 60 * 1000;
// An actively working group needs no impulse (0.5.1).
export const NUDGE_COOLDOWN_AFTER_PROGRESS_MS = 45 * 60 * 1000;

export type NudgeRefusal =
  | { reason: 'dod_met' }
  | { reason: 'deadline_passed'; deadline: string }
  | { reason: 'progress_fresh' }
  | { reason: 'too_soon'; nextAllowedAt: string; sinceStart: boolean }
  | { reason: 'quiet_hours'; window: QuietHours; timezone: string };

/** The local hour (0-23) of `at` in `timezone`. */
export function localHour(at: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at);
  return Number(hour);
}

export function isQuietHour(hour: number, window: QuietHours): boolean {
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

function ageMs(iso: string, now: Date): number | undefined {
  const age = now.getTime() - new Date(iso).getTime();
  return Number.isFinite(age) && age >= 0 ? age : undefined;
}

/** First gate that refuses the nudge, or undefined when it may go out. */
export function checkNudgePolicy(
  record: FacilitationRecord,
  config: Pick<FacilitatorConfig, 'nudgeMinIntervalHours' | 'nudgeQuietHours' | 'timezone'>,
  now: Date,
): NudgeRefusal | undefined {
  if (record.progress?.dodMet) return { reason: 'dod_met' };
  if (record.deadline) {
    const deadlineMs = Date.parse(record.deadline);
    if (Number.isFinite(deadlineMs) && deadlineMs <= now.getTime()) {
      return { reason: 'deadline_passed', deadline: record.deadline };
    }
  }
  if (record.progress?.updatedAt) {
    const age = ageMs(record.progress.updatedAt, now);
    if (age !== undefined && age < NUDGE_COOLDOWN_AFTER_PROGRESS_MS) return { reason: 'progress_fresh' };
  }
  // The spacing counts from the last nudge, or from the start when none was
  // sent yet (0.7.1: the first assess tick nudged 25 s after the handshake).
  const spacingAnchor = record.lastNudge?.at ?? record.startedAt;
  if (spacingAnchor) {
    const minGapMs = config.nudgeMinIntervalHours * HOUR_MS;
    const age = ageMs(spacingAnchor, now);
    if (age !== undefined && age < minGapMs) {
      return {
        reason: 'too_soon',
        nextAllowedAt: new Date(new Date(spacingAnchor).getTime() + minGapMs).toISOString(),
        sinceStart: record.lastNudge === undefined,
      };
    }
  }
  if (config.nudgeQuietHours && isQuietHour(localHour(now, config.timezone), config.nudgeQuietHours)) {
    return { reason: 'quiet_hours', window: config.nudgeQuietHours, timezone: config.timezone };
  }
  return undefined;
}

export function describeNudgeRefusal(refusal: NudgeRefusal, de: boolean, timezone: string): string {
  switch (refusal.reason) {
    case 'dod_met':
      return de
        ? 'Kein Nudge gesendet: Die Definition of Done ist als erfüllt protokolliert — die Gruppe braucht keine Erinnerung mehr.'
        : 'No nudge sent: the definition of done is recorded as met — the group needs no further reminder.';
    case 'deadline_passed':
      return de
        ? `Kein Nudge gesendet: Die Frist (${withLocalTime(refusal.deadline, timezone, de)}) ist abgelaufen — jetzt zählt das Ergebnis, keine Erinnerung.`
        : `No nudge sent: the deadline (${withLocalTime(refusal.deadline, timezone, de)}) has passed — report the outcome instead of reminding.`;
    case 'progress_fresh':
      return de
        ? 'Kein Nudge gesendet: Die Gruppe arbeitet aktiv (Progress vor weniger als 45 Minuten protokolliert) — ein Impuls würde als zweiter Facilitator wirken.'
        : 'No nudge sent: the group is actively working (progress recorded less than 45 minutes ago) — an impulse would read as a second facilitator.';
    case 'too_soon':
      return de
        ? `Kein Nudge gesendet: ${refusal.sinceStart ? 'Die Facilitation wurde gerade erst gestartet' : 'Der letzte Nudge ist zu frisch'} — der nächste ist frühestens ${withLocalTime(refusal.nextAllowedAt, timezone, de)} möglich.`
        : `No nudge sent: ${refusal.sinceStart ? 'the facilitation has only just started' : 'the last nudge is too recent'} — the next one is possible from ${withLocalTime(refusal.nextAllowedAt, timezone, de)}.`;
    case 'quiet_hours': {
      const window = `${String(refusal.window.startHour)}-${String(refusal.window.endHour)}`;
      return de
        ? `Kein Nudge gesendet: Ruhezeit (${window} Uhr, ${refusal.timezone}) — außerhalb der Ruhezeit erneut versuchen.`
        : `No nudge sent: quiet hours (${window}, ${refusal.timezone}) — retry outside the quiet window.`;
    }
  }
}
