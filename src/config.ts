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
  /** The window of a proposal put while a live session runs (spec 5.7:
   *  shorter for a live session, default 5 minutes). */
  readonly liveConfirmWindowMinutes: number;
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
  liveConfirmWindowMinutes: 5,
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

/** The grace must leave room under the horizon, or no due date could ever
 *  be agreed: otherwise both fall back to their defaults. */
function followupWindow(grace: number, horizon: number, invalid: (key: string, value: unknown, fallback: unknown) => void): { followupGraceDays: number; followupHorizonDays: number } {
  if (grace < horizon) return { followupGraceDays: grace, followupHorizonDays: horizon };
  invalid('followup_grace_days', grace, CONFIG_DEFAULTS.followupGraceDays);
  return { followupGraceDays: CONFIG_DEFAULTS.followupGraceDays, followupHorizonDays: CONFIG_DEFAULTS.followupHorizonDays };
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
  'live_confirm_window_minutes',
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
    liveConfirmWindowMinutes: positive('live_confirm_window_minutes', CONFIG_DEFAULTS.liveConfirmWindowMinutes),
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
    ...followupWindow(positive('followup_grace_days', CONFIG_DEFAULTS.followupGraceDays), positive('followup_horizon_days', CONFIG_DEFAULTS.followupHorizonDays, { integer: true }), invalid),
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

// ---------------------------------------------------------------------------
// Per-facilitator defaults (spec 2043 §5.6, §7; byte5ai/omadia#2066)
// ---------------------------------------------------------------------------

/** Decision methods a facilitator may name as its default for a vote. */
export const DEFAULT_DECISION_METHODS = ['ranked', 'single', 'approval', 'consent'] as const;
export type DefaultDecisionMethod = (typeof DEFAULT_DECISION_METHODS)[number];

/** Methods a facilitator may name as its default for a prioritisation. */
export const DEFAULT_PRIORITISATION_METHODS = ['ranked', 'approval'] as const;
export type DefaultPrioritisationMethod = (typeof DEFAULT_PRIORITISATION_METHODS)[number];

/** The keys of the archetype's `agent_settings` (manifest.yaml) the engine reads. */
export const FACILITATOR_SETTING_KEYS = ['default_decision_method', 'default_prioritisation_method', 'ranked_points', 'reminder_offsets_hours'] as const;

/** At most this many entries in a list setting; the kernel enforces the same. */
const MAX_LIST_ITEMS = 10;

/** The instance configuration with one facilitator's own defaults applied. */
export interface FacilitatorConfig extends EngineConfig {
  /** Method of a deciding step whose template names a vote, and of a vote
   *  that names options without a method. Absent: the template's method. */
  readonly defaultDecisionMethod?: DefaultDecisionMethod;
  /** Method of a prioritising step. Absent: the template's method. */
  readonly defaultPrioritisationMethod?: DefaultPrioritisationMethod;
}

const isRecord = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw);

/** A list of positive numbers, as the kernel stores it (or as a '24, 2' text). */
function readNumberList(raw: unknown): number[] | undefined {
  if (typeof raw === 'string') return parseNumberList(raw);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LIST_ITEMS) return undefined;
  return raw.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ? [...(raw as number[])] : undefined;
}

/**
 * The defaults the operator set for ONE facilitator (the kernel's archetype
 * agent settings, `AgentProfile.archetypeSettings`) over the instance
 * settings. Pure. A setting that is absent leaves the instance value; one
 * that is not valid is ignored and logged, so a bad value never takes a
 * facilitation down. A kernel without agent settings passes `undefined`.
 */
export function facilitatorConfig(base: EngineConfig, settings: unknown, log: (msg: string) => void = () => {}): FacilitatorConfig {
  if (!isRecord(settings)) return base;
  const ignored = (key: string, value: unknown): void => {
    log(`facilitator setting '${key}' = ${JSON.stringify(value)} is not valid — the instance setting applies`);
  };
  const out: { -readonly [K in keyof FacilitatorConfig]?: FacilitatorConfig[K] } = {};

  const decision = settings['default_decision_method'];
  if (decision !== undefined && decision !== null) {
    if (typeof decision === 'string' && (DEFAULT_DECISION_METHODS as readonly string[]).includes(decision)) out.defaultDecisionMethod = decision as DefaultDecisionMethod;
    else ignored('default_decision_method', decision);
  }
  const prioritisation = settings['default_prioritisation_method'];
  if (prioritisation !== undefined && prioritisation !== null) {
    if (typeof prioritisation === 'string' && (DEFAULT_PRIORITISATION_METHODS as readonly string[]).includes(prioritisation)) {
      out.defaultPrioritisationMethod = prioritisation as DefaultPrioritisationMethod;
    } else ignored('default_prioritisation_method', prioritisation);
  }
  const points = settings['ranked_points'];
  if (points !== undefined && points !== null) {
    const parsed = readNumberList(points);
    if (parsed) out.rankedPoints = parsed;
    else ignored('ranked_points', points);
  }
  const offsets = settings['reminder_offsets_hours'];
  if (offsets !== undefined && offsets !== null) {
    const parsed = readNumberList(offsets);
    // Descending, like the instance setting: "first reminder" is the furthest.
    if (parsed) out.reminderOffsetsHours = [...parsed].sort((a, b) => b - a);
    else ignored('reminder_offsets_hours', offsets);
  }
  return { ...base, ...out };
}

/** The settings of a kernel profile, read without trusting its type: a kernel
 *  older than the agent-settings contract has no such field. */
export function profileSettings(profile: unknown): unknown {
  return isRecord(profile) ? profile['archetypeSettings'] : undefined;
}
