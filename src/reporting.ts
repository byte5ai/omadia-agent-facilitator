// Report delivery (#330 C1): final result / failure — and interim status when
// configured — to the initiator Principal via the kernel's targetedSend
// service (role fan-out to all current holders, notification semantics).
// Every non-delivery is surfaced in the returned summary and NOTHING throws
// out of here (review H1): a channel error becomes { sent: false, summary }.

import type { FacilitatorConfig } from './config.js';
import type { TargetedSendService } from './services.js';

export type ReportKind = 'final' | 'interim';

export interface ReportResult {
  sent: boolean;
  /** Honest, user-facing one-liner about what happened (incl. degradations). */
  summary: string;
}

export async function sendReport(
  deps: { targetedSend?: TargetedSendService; config: FacilitatorConfig; log: (msg: string) => void },
  kind: ReportKind,
  text: string,
): Promise<ReportResult> {
  const { config } = deps;
  const de = config.language === 'de';
  const target = `role:${config.initiatorRoleKey}`;

  if (kind === 'interim' && config.reportingMode !== 'interim') {
    return {
      sent: false,
      summary: de
        ? 'Interim-Reports sind deaktiviert (reporting_mode=result-only).'
        : 'Interim reports are disabled (reporting_mode=result-only).',
    };
  }
  if (!deps.targetedSend) {
    return {
      sent: false,
      summary: de
        ? `Report NICHT zugestellt: der Kernel stellt keinen targetedSend-Service bereit (Kernel < #330 B1?). Zieladresse wäre ${target} gewesen.`
        : `Report NOT delivered: the kernel does not publish a targetedSend service (kernel < #330 B1?). The target would have been ${target}.`,
    };
  }

  let result;
  try {
    result = await deps.targetedSend.sendToPrincipal({
      channelType: config.reportChannelType,
      principal: target,
      message: { text },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`report delivery threw: ${message}`);
    return {
      sent: false,
      summary: de
        ? `Report NICHT zugestellt (${target}): Zustellfehler — ${message}`
        : `Report NOT delivered (${target}): delivery error — ${message}`,
    };
  }

  const delivered = result.deliveries.filter((d) => d.outcome.outcome === 'delivered').length;
  const failed = result.deliveries.length - delivered;
  for (const diagnostic of result.diagnostics) {
    deps.log(`report diagnostic [${diagnostic.code}]: ${diagnostic.message}`);
  }

  const partial = result.resolution.kind === 'role' && result.resolution.partial;
  const parts: string[] = [];
  if (delivered > 0) {
    const failedSuffix = failed > 0 ? (de ? `, ${String(failed)} nicht erreichbar` : `, ${String(failed)} unreachable`) : '';
    parts.push(
      de
        ? `Report an ${target} zugestellt (${String(delivered)} Empfänger${failedSuffix}).`
        : `Report delivered to ${target} (${String(delivered)} recipient(s)${failedSuffix}).`,
    );
  } else {
    parts.push(de ? `Report an ${target} NICHT zugestellt.` : `Report NOT delivered to ${target}.`);
  }
  if (partial) {
    parts.push(
      de
        ? 'Achtung: Die Holder-Liste der Rolle war unvollständig (partial) — weitere Holder könnten existieren.'
        : 'Note: the role holder list was partial — more holders may exist.',
    );
  }
  if (delivered === 0 && result.diagnostics.length > 0) {
    parts.push(
      de
        ? `Grund: ${result.diagnostics.map((d) => d.code).join(', ')}.`
        : `Reason: ${result.diagnostics.map((d) => d.code).join(', ')}.`,
    );
  }
  return { sent: delivered > 0, summary: parts.join(' ') };
}
