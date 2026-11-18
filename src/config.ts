// Setup-field parsing (#330 C1). All fields are declared with defaults in
// manifest.yaml; this module is the single place raw config values are
// validated and defaulted — everything downstream consumes the typed shape.

export type ReportingMode = 'result-only' | 'interim';
export type FacilitatorLanguage = 'de' | 'en';

export interface FacilitatorConfig {
  facilitatorAgentSlug: string;
  initiatorRoleKey: string;
  reportChannelType: string;
  defaultTtlHours: number;
  reportingMode: ReportingMode;
  moderationStyle: string;
  language: FacilitatorLanguage;
  discloseReportTarget: boolean;
  /** #330 C2b — provision the top-level agent automatically at activate. */
  autoSetup: boolean;
  /** #330 C3 — allow proactive group nudges (operator control over posts). */
  nudgesEnabled: boolean;
  /** 0.7.0 — minimum spacing between two delivered nudges. */
  nudgeMinIntervalHours: number;
  /** 0.7.0 — local hours in which no nudge is posted; undefined = none. */
  nudgeQuietHours: QuietHours | undefined;
  /** IANA zone the quiet hours are read in. */
  timezone: string;
}

/** Hours 0-23; `startHour` inclusive, `endHour` exclusive. A window that
 *  wraps midnight has startHour > endHour (21-8 = 21:00 until 07:59). */
export interface QuietHours {
  startHour: number;
  endHour: number;
}

const QUIET_HOURS_PATTERN = /^(\d{1,2})\s*-\s*(\d{1,2})$/;

/** 'HH-HH' → window; '' / 'off' / 'none' → no quiet hours; anything else is invalid. */
export function parseQuietHours(raw: string): QuietHours | undefined | 'invalid' {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'none') return undefined;
  const match = QUIET_HOURS_PATTERN.exec(value);
  if (!match) return 'invalid';
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour > 23 || endHour > 23 || startHour === endHour) return 'invalid';
  return { startHour, endHour };
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const CONFIG_DEFAULTS: FacilitatorConfig = {
  facilitatorAgentSlug: 'facilitator',
  initiatorRoleKey: 'facilitation-initiator',
  reportChannelType: 'teams',
  defaultTtlHours: 24,
  reportingMode: 'result-only',
  moderationStyle:
    'aktiv strukturierend, aber knapp — eingreifen bei Stillstand, Dominanz einzelner oder Zielabweichung',
  language: 'de',
  discloseReportTarget: true,
  autoSetup: true,
  nudgesEnabled: true,
  nudgeMinIntervalHours: 4,
  nudgeQuietHours: { startHour: 20, endHour: 8 },
  timezone: 'Europe/Berlin',
};

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Parse + validate the plugin's setup fields. Invalid values fall back to
 *  the declared defaults rather than failing activation — a misconfigured
 *  facilitation plugin should degrade loudly (log) but never brick. */
export function parseConfig(
  get: <T = unknown>(key: string) => T | undefined,
  log?: (msg: string) => void,
): FacilitatorConfig {
  const rawTtl = get<unknown>('default_ttl_hours');
  const ttlNumber = typeof rawTtl === 'string' ? Number(rawTtl) : rawTtl;
  const defaultTtlHours =
    typeof ttlNumber === 'number' && Number.isFinite(ttlNumber) && ttlNumber > 0
      ? ttlNumber
      : CONFIG_DEFAULTS.defaultTtlHours;
  if (rawTtl !== undefined && defaultTtlHours !== ttlNumber) {
    log?.(`config: invalid default_ttl_hours '${String(rawTtl)}' — using ${String(CONFIG_DEFAULTS.defaultTtlHours)}`);
  }

  const rawMode = get<unknown>('reporting_mode');
  const reportingMode: ReportingMode = rawMode === 'interim' ? 'interim' : 'result-only';
  if (rawMode !== undefined && rawMode !== 'interim' && rawMode !== 'result-only') {
    log?.(`config: unknown reporting_mode '${String(rawMode)}' — using 'result-only'`);
  }

  const rawLanguage = get<unknown>('language');
  const language: FacilitatorLanguage = rawLanguage === 'en' ? 'en' : 'de';

  const rawDisclose = get<unknown>('disclose_report_target');
  const discloseReportTarget =
    typeof rawDisclose === 'boolean' ? rawDisclose : rawDisclose === 'false' ? false : CONFIG_DEFAULTS.discloseReportTarget;

  const rawAutoSetup = get<unknown>('auto_setup');
  const autoSetup =
    typeof rawAutoSetup === 'boolean' ? rawAutoSetup : rawAutoSetup === 'false' ? false : CONFIG_DEFAULTS.autoSetup;

  const rawNudges = get<unknown>('nudges_enabled');
  const nudgesEnabled =
    typeof rawNudges === 'boolean' ? rawNudges : rawNudges === 'false' ? false : CONFIG_DEFAULTS.nudgesEnabled;

  const rawInterval = get<unknown>('nudge_min_interval_hours');
  const intervalNumber = typeof rawInterval === 'string' ? Number(rawInterval) : rawInterval;
  const nudgeMinIntervalHours =
    typeof intervalNumber === 'number' && Number.isFinite(intervalNumber) && intervalNumber >= 0
      ? intervalNumber
      : CONFIG_DEFAULTS.nudgeMinIntervalHours;
  if (rawInterval !== undefined && nudgeMinIntervalHours !== intervalNumber) {
    log?.(`config: invalid nudge_min_interval_hours '${String(rawInterval)}' — using ${String(CONFIG_DEFAULTS.nudgeMinIntervalHours)}`);
  }

  const rawQuiet = get<unknown>('nudge_quiet_hours');
  let nudgeQuietHours = CONFIG_DEFAULTS.nudgeQuietHours;
  if (typeof rawQuiet === 'string') {
    const parsed = parseQuietHours(rawQuiet);
    if (parsed === 'invalid') {
      log?.(`config: invalid nudge_quiet_hours '${rawQuiet}' (expected 'HH-HH' or 'off') — using the default`);
    } else {
      nudgeQuietHours = parsed;
    }
  }

  const rawTimezone = nonEmptyString(get('timezone'), CONFIG_DEFAULTS.timezone);
  const timezone = isValidTimezone(rawTimezone) ? rawTimezone : CONFIG_DEFAULTS.timezone;
  if (timezone !== rawTimezone) {
    log?.(`config: unknown timezone '${rawTimezone}' — using ${CONFIG_DEFAULTS.timezone}`);
  }

  return {
    facilitatorAgentSlug: nonEmptyString(get('facilitator_agent_slug'), CONFIG_DEFAULTS.facilitatorAgentSlug),
    initiatorRoleKey: nonEmptyString(get('initiator_role_key'), CONFIG_DEFAULTS.initiatorRoleKey),
    reportChannelType: nonEmptyString(get('report_channel_type'), CONFIG_DEFAULTS.reportChannelType),
    defaultTtlHours,
    reportingMode,
    moderationStyle: nonEmptyString(get('moderation_style'), CONFIG_DEFAULTS.moderationStyle),
    language,
    discloseReportTarget,
    autoSetup,
    nudgesEnabled,
    nudgeMinIntervalHours,
    nudgeQuietHours,
    timezone,
  };
}
