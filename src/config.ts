// Setup-field parsing. Every field is declared with its default in
// manifest.yaml; this module is the one place raw values are validated and
// defaulted. A bad value falls back to the default and is logged, so a typo in
// the operator UI never takes the engine down.

export type EngineLanguage = 'de' | 'en';

export interface EngineConfig {
  readonly language: EngineLanguage;
  readonly timezone: string;
  /** Hours before the deadline at which a reminder goes out, descending. */
  readonly reminderOffsetsHours: readonly number[];
  readonly changeWindowHours: number;
  readonly runoffWindowHours: number;
  readonly confirmWindowMinutes: number;
  /** Points per rank, first rank first. */
  readonly rankedPoints: readonly number[];
  readonly actionReminderLeadHours: number;
  readonly retentionDays: number;
  /** A facilitation that is still open after this many days ends with an abort report. */
  readonly maxLifetimeDays: number;
  readonly maxActivePerFacilitator: number;
  readonly maxActiveInstance: number;
  readonly startsPerHourPerFacilitator: number;
  readonly maxMessagesPerFacilitation: number;
  readonly protocolMailEnabled: boolean;
}

export const CONFIG_DEFAULTS: EngineConfig = {
  language: 'de',
  timezone: 'Europe/Berlin',
  reminderOffsetsHours: [24, 2],
  changeWindowHours: 12,
  runoffWindowHours: 12,
  confirmWindowMinutes: 30,
  rankedPoints: [3, 2, 1],
  actionReminderLeadHours: 24,
  retentionDays: 90,
  maxLifetimeDays: 30,
  maxActivePerFacilitator: 10,
  maxActiveInstance: 50,
  startsPerHourPerFacilitator: 20,
  maxMessagesPerFacilitation: 500,
  protocolMailEnabled: false,
};

export type ConfigReader = <T>(key: string) => T | undefined;

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** '24, 2' -> [24, 2]. Undefined when any entry is not a positive number. */
export function parseNumberList(raw: string): number[] | undefined {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return undefined;
  const values = parts.map(Number);
  return values.every((v) => Number.isFinite(v) && v > 0) ? values : undefined;
}

export function parseConfig(read: ConfigReader, log: (msg: string) => void = () => {}): EngineConfig {
  const invalid = (key: string, value: unknown, fallback: unknown): void => {
    log(`config: '${key}' = ${JSON.stringify(value)} is not valid — using ${JSON.stringify(fallback)}`);
  };

  const positive = (key: string, fallback: number, opts: { integer?: boolean } = {}): number => {
    const raw = read<unknown>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0 || (opts.integer === true && !Number.isInteger(value))) {
      invalid(key, raw, fallback);
      return fallback;
    }
    return value;
  };

  const list = (key: string, fallback: readonly number[]): readonly number[] => {
    const raw = read<unknown>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = parseNumberList(String(raw));
    if (!parsed) {
      invalid(key, raw, fallback);
      return fallback;
    }
    return parsed;
  };

  const rawLanguage = read<unknown>('language');
  let language = CONFIG_DEFAULTS.language;
  if (rawLanguage === 'de' || rawLanguage === 'en') language = rawLanguage;
  else if (rawLanguage !== undefined && rawLanguage !== null && rawLanguage !== '') {
    invalid('language', rawLanguage, language);
  }

  const rawTimezone = read<unknown>('timezone');
  let timezone = CONFIG_DEFAULTS.timezone;
  if (typeof rawTimezone === 'string' && rawTimezone.trim() !== '') {
    if (isValidTimezone(rawTimezone.trim())) timezone = rawTimezone.trim();
    else invalid('timezone', rawTimezone, timezone);
  }

  const rawMail = read<unknown>('protocol_mail_enabled');
  const protocolMailEnabled = rawMail === true || rawMail === 'true';

  return {
    language,
    timezone,
    // Descending, so "first reminder" is the one furthest from the deadline.
    reminderOffsetsHours: [...list('reminder_offsets_hours', CONFIG_DEFAULTS.reminderOffsetsHours)].sort((a, b) => b - a),
    changeWindowHours: positive('change_window_hours', CONFIG_DEFAULTS.changeWindowHours),
    runoffWindowHours: positive('runoff_window_hours', CONFIG_DEFAULTS.runoffWindowHours),
    confirmWindowMinutes: positive('confirm_window_minutes', CONFIG_DEFAULTS.confirmWindowMinutes),
    rankedPoints: list('ranked_points', CONFIG_DEFAULTS.rankedPoints),
    actionReminderLeadHours: positive('action_reminder_lead_hours', CONFIG_DEFAULTS.actionReminderLeadHours),
    retentionDays: positive('retention_days', CONFIG_DEFAULTS.retentionDays, { integer: true }),
    maxLifetimeDays: positive('max_lifetime_days', CONFIG_DEFAULTS.maxLifetimeDays, { integer: true }),
    maxActivePerFacilitator: positive('max_active_per_facilitator', CONFIG_DEFAULTS.maxActivePerFacilitator, { integer: true }),
    maxActiveInstance: positive('max_active_instance', CONFIG_DEFAULTS.maxActiveInstance, { integer: true }),
    startsPerHourPerFacilitator: positive('starts_per_hour_per_facilitator', CONFIG_DEFAULTS.startsPerHourPerFacilitator, { integer: true }),
    maxMessagesPerFacilitation: positive('max_messages_per_facilitation', CONFIG_DEFAULTS.maxMessagesPerFacilitation, { integer: true }),
    protocolMailEnabled,
  };
}
