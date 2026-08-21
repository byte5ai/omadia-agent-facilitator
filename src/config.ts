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
  };
}
