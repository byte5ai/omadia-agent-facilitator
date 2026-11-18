// Times for humans (0.7.1). Field report 2026-11-18: the handshake showed the
// workflow lifetime as a UTC ISO string and the chat-side agent read
// "13:00Z" as 13:00 local time. Every timestamp the tools print keeps its
// ISO form (unambiguous, machine-readable) and gains the local reading in
// the configured timezone.

/** "Fr., 20.11.2026, 14:00 Uhr (Europe/Berlin)" / "Fri, 20/11/2026, 14:00 (Europe/Berlin)". */
export function formatLocalTime(iso: string, timezone: string, de: boolean): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const text = new Intl.DateTimeFormat(de ? 'de-DE' : 'en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
  return de ? `${text} Uhr (${timezone})` : `${text} (${timezone})`;
}

/** The ISO value followed by its local reading; the bare value when it does not parse. */
export function withLocalTime(iso: string, timezone: string, de: boolean): string {
  const local = formatLocalTime(iso, timezone, de);
  return local ? `${iso} = ${local}` : iso;
}
