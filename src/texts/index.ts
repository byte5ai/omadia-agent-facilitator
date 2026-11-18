import { de } from './de.js';
import { en } from './en.js';
import type { Texts } from './en.js';

export type { Texts } from './en.js';

export const texts = (language: 'de' | 'en'): Texts => (language === 'de' ? de : en);

/** "Fri, 20/11/2026, 14:00 (Europe/Berlin)" in the facilitation's language. */
export function formatWhen(date: Date, timezone: string, language: 'de' | 'en'): string {
  const text = new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return language === 'de' ? `${text} Uhr (${timezone})` : `${text} (${timezone})`;
}
