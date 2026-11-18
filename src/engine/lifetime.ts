// When a facilitation's maximum duration ends.

import { DAY_MS, HOUR_MS } from '../clock.js';

/** The maximum duration, or shortly after the deadline when that is later. */
export function lifetimeEnd(createdAt: Date, deadline: Date | null, maxLifetimeDays: number): Date {
  const byAge = new Date(createdAt.getTime() + maxLifetimeDays * DAY_MS);
  const afterDeadline = deadline ? new Date(deadline.getTime() + HOUR_MS) : byAge;
  return afterDeadline > byAge ? afterDeadline : byAge;
}
