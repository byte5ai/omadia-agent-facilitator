// Finding a common free time from free/busy (spec 5.11). Pure: intervals in,
// one slot out. The engine never sees what an appointment is, only when
// somebody is busy.

import { DAY_MS, MINUTE_MS } from '../clock.js';

export interface BusyInterval {
  start: string;
  end: string;
}

export interface SlotRequest {
  /** Earliest start and latest end the group agreed on. */
  from: Date;
  to: Date;
  durationMinutes: number;
  timezone: string;
  /** Busy intervals of everybody whose availability is known. */
  busy: readonly BusyInterval[];
  /** Local working hours, [start, end). */
  workingHours?: readonly [number, number];
}

export const GRID_MINUTES = 15;
/** The provider answers windows shorter than this. */
export const MAX_WINDOW_DAYS = 61;

/** Round up to the next quarter hour: free/busy comes on that grid. */
export function alignToGrid(date: Date): Date {
  const grid = GRID_MINUTES * MINUTE_MS;
  return new Date(Math.ceil(date.getTime() / grid) * grid);
}

function localParts(date: Date, timezone: string): { weekday: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** The first slot inside working hours on a weekday at which nobody is busy. */
export function findSlot(request: SlotRequest): { start: Date; end: Date } | undefined {
  const [open, close] = request.workingHours ?? [9, 17];
  const duration = request.durationMinutes * MINUTE_MS;
  const busy = request.busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const last = Math.min(request.to.getTime(), request.from.getTime() + MAX_WINDOW_DAYS * DAY_MS) - duration;
  for (let start = alignToGrid(request.from).getTime(); start <= last; start += GRID_MINUTES * MINUTE_MS) {
    const end = start + duration;
    const first = localParts(new Date(start), request.timezone);
    const final = localParts(new Date(end), request.timezone);
    if (first.weekday === 'Sat' || first.weekday === 'Sun') continue;
    if (first.hour < open) continue;
    // The meeting has to end inside the same working day.
    const endMinutes = final.hour * 60 + final.minute;
    if (final.weekday !== first.weekday || endMinutes > close * 60) continue;
    if (busy.some(([s, e]) => s < end && e > start)) continue;
    return { start: new Date(start), end: new Date(end) };
  }
  return undefined;
}
