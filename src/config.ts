// Setup-field parsing. Every field is declared with its default in
// manifest.yaml; this module is the one place raw values are validated and
// defaulted. A bad value falls back to the default and is logged, so a typo in
// the operator UI never takes the engine down.

export type EngineLanguage = 'de' | 'en';

/** Limits of one facilitator that differ from the instance's defaults. */
export interface FacilitatorLimits {
  active?: number;
  startsPerHour?: number;
  messages?: number;
}

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
  /** How long before a meeting its agenda is sent. */
  readonly sessionAgendaLeadMinutes: number;
  /** Processing a call's speech needs a yes from every participant. */
  readonly mediaConsentExplicit: boolean;
  /** How long the scoped grant lasts after the close when no action items are followed up. */
  readonly followupGrantDays: number;
  /** The consent window of a final summary that needs confirmation, from its
   *  confirmed delivery (spec 5.2): default 24 h, never more than 72 h. */
  readonly finalConfirmWindowHours: number;
  /** Follow-up ends this long after the last due date (spec 5.2). */
  readonly followupGraceDays: number;
  /** No follow-up runs longer than this after `closed`; later due dates are
   *  refused when agreed (spec 5.2, 5.8). */
  readonly followupHorizonDays: number;
  /** Per facilitator (agent slug): its own limits (spec 5.10). */
  readonly facilitatorLimits: Readonly<Record<string, FacilitatorLimits>>;
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
  sessionAgendaLeadMinutes: 60,
  mediaConsentExplicit: false,
  followupGrantDays: 14,
  finalConfirmWindowHours: 24,
  followupGraceDays: 7,
  followupHorizonDays: 90,
  facilitatorLimits: {},
};

const LIMIT_KEYS: Readonly<Record<string, keyof FacilitatorLimits>> = { active: 'active', starts: 'startsPerHour', messages: 'messages' };

/**
 * 'mira: active=5, starts=10; rita: messages=200' -> per facilitator. Each
 * entry is `<agent slug>: <key>=<positive integer>, ...` with the keys
 * `active`, `starts` (per hour) and `messages` (per facilitation). Undefined
 * when any part does not read.
 */
export function parseFacilitatorLimits(raw: string): Record<string, FacilitatorLimits> | undefined {
  const out: Record<string, FacilitatorLimits> = {};
  for (const entry of raw.split(';').map((e) => e.trim()).filter((e) => e !== '')) {
    const match = /^([a-z0-9][a-z0-9_-]*)\s*:\s*(.+)$/i.exec(entry);
    if (!match?.[1] || !match[2]) return undefined;
    const limits: FacilitatorLimits = {};
    for (const pair of match[2].split(',').map((p) => p.trim()).filter((p) => p !== '')) {
      const kv = /^([a-z]+)\s*=\s*(\d+)$/i.exec(pair);
      const key = kv?.[1] ? LIMIT_KEYS[kv[1].toLowerCase()] : undefined;
      const value = kv?.[2] ? Number(kv[2]) : NaN;
      if (!key || !Number.isInteger(value) || value <= 0) return undefined;
      limits[key] = value;
    }
    out[match[1]] = limits;
  }
  return out;
}

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

/** Every setting 1.0.x reads. The manifest declares exactly these fields and
 *  the README documents each. */
export const CONFIG_KEYS = [
  'language',
  'timezone',
  'reminder_offsets_hours',
  'change_window_hours',
  'runoff_window_hours',
  'confirm_window_minutes',
  'ranked_points',
  'action_reminder_lead_hours',
  'retention_days',
  'max_lifetime_days',
  'max_active_per_facilitator',
  'max_active_instance',
  'starts_per_hour_per_facilitator',
  'max_messages_per_facilitation',
  'session_agenda_lead_minutes',
  'media_consent_explicit',
  'followup_grant_days',
  'protocol_mail_enabled',
  'final_confirm_window_hours',
  'followup_grace_days',
  'followup_horizon_days',
  'facilitator_limits',
] as const;

/** Settings of 0.7.x (the Conductor-based facilitator). Nothing in the engine
 *  reads them; an upgrade drops them. */
export const OBSOLETE_CONFIG_KEYS = ['facilitator_agent_slug', 'initiator_role_key', 'reporting_mode', 'moderation_style', 'auto_setup', 'disclose_report_target'] as const;

/** Keys the kernel keeps in a plugin's configuration for itself start with an
 *  underscore (`_privacy_mode`, `_privacy_bypass_scopes`). */
export const isKernelKey = (key: string): boolean => key.startsWith('_');

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
    sessionAgendaLeadMinutes: positive('session_agenda_lead_minutes', CONFIG_DEFAULTS.sessionAgendaLeadMinutes),
    followupGrantDays: positive('followup_grant_days', CONFIG_DEFAULTS.followupGrantDays),
    // At most 72 hours (spec 5.2): a larger value is capped, not refused.
    finalConfirmWindowHours: Math.min(positive('final_confirm_window_hours', CONFIG_DEFAULTS.finalConfirmWindowHours), 72),
    followupGraceDays: positive('followup_grace_days', CONFIG_DEFAULTS.followupGraceDays),
    followupHorizonDays: positive('followup_horizon_days', CONFIG_DEFAULTS.followupHorizonDays, { integer: true }),
    facilitatorLimits: (() => {
      const raw = read<unknown>('facilitator_limits');
      if (raw === undefined || raw === null || String(raw).trim() === '') return CONFIG_DEFAULTS.facilitatorLimits;
      const parsed = parseFacilitatorLimits(String(raw));
      if (!parsed) {
        invalid('facilitator_limits', raw, CONFIG_DEFAULTS.facilitatorLimits);
        return CONFIG_DEFAULTS.facilitatorLimits;
      }
      return parsed;
    })(),
    mediaConsentExplicit: read<unknown>('media_consent_explicit') === true || read<unknown>('media_consent_explicit') === 'true',
  };
}
