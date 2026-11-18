// The engine never reads the wall clock directly. Deadlines, reminders,
// leases and windows all go through this, so a test moves time by hand.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
