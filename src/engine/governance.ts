// Visibility, retention and quotas (spec 5.8, 5.10).
//
//   Active participants   everything of the facilitation.
//   Participants who left what was recorded while they were members.
//   Other users           nothing.
//   Operator              metadata; contents and protocol only through an
//                         audited access with a stated reason.

import { HOUR_MS } from '../clock.js';
import type { Queryable } from '../db/pool.js';
import { insert, rows } from '../db/sql.js';
import * as store from '../db/store.js';
import type { AccessAudit, Facilitation, Phase } from '../model.js';
import { LIVE_PHASES } from '../model.js';
import { texts } from '../texts/index.js';
import type { EngineCore } from './core.js';
import { Refusal } from './core.js';
import { abortFacilitation, abortInWork, registerStartCheck } from './lifecycle.js';
import { buildProtocol } from './protocol.js';
import { registerJobHandler } from './scheduler.js';

// ── visibility ──────────────────────────────────────────────────────────────

/** The protocol as one person may see it. */
export async function protocolFor(q: Queryable, f: Facilitation, principalId: string): Promise<string> {
  const participant = await store.getParticipant(q, f.id, principalId);
  if (!participant) throw new Refusal('not_visible', texts(f.language).notVisible());
  if (participant.status === 'active') return buildProtocol(q, f);
  // Somebody who left sees what was recorded while they were a member.
  return buildProtocol(q, f, { until: participant.leftAt ?? participant.changedAt });
}

export interface FacilitationMetadata {
  id: string;
  facilitator: string;
  channelType: string;
  conversationId: string;
  phase: Phase;
  format: string;
  language: string;
  counts: { participants: number; activeParticipants: number; contributions: number; decisions: number; actionItems: number; steps: number; messagesSent: number };
  deadline: string | null;
  createdAt: string;
  activatedAt: string | null;
  concludedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  followupState: string;
  purgeAfter: string | null;
}

interface MetadataRow {
  id: string;
  participants: string;
  activeParticipants: string;
  contributions: string;
  decisions: string;
  actionItems: string;
  steps: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What an operator sees without asking: no goal, no contents, no names. */
export async function listMetadata(q: Queryable, filter: { phase?: string; facilitator?: string; id?: string } = {}): Promise<FacilitationMetadata[]> {
  const facilitations = await rows<Facilitation>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_facilitations
      WHERE ($1::text IS NULL OR phase = $1) AND ($2::text IS NULL OR facilitator_agent = $2) AND ($3::uuid IS NULL OR id = $3)
      ORDER BY created_at DESC LIMIT 500`,
    [filter.phase ?? null, filter.facilitator ?? null, filter.id ?? null],
  );
  if (facilitations.length === 0) return [];
  const counts = await rows<MetadataRow>(
    q,
    `SELECT f.id,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_participants p WHERE p.facilitation_id = f.id) AS participants,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_participants p WHERE p.facilitation_id = f.id AND p.status = 'active') AS active_participants,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_contributions c WHERE c.facilitation_id = f.id AND c.status = 'valid') AS contributions,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_decisions d WHERE d.facilitation_id = f.id) AS decisions,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_action_items a WHERE a.facilitation_id = f.id AND a.status <> 'declined') AS action_items,
            (SELECT count(*) FROM plg_omadia_agent_facilitator_steps s WHERE s.facilitation_id = f.id) AS steps
       FROM plg_omadia_agent_facilitator_facilitations f WHERE f.id = ANY($1::uuid[])`,
    [`{${facilitations.map((f) => f.id).join(',')}}`],
  );
  const byId = new Map(counts.map((c) => [c.id, c]));
  return facilitations.map((f) => {
    const c = byId.get(f.id);
    return {
      id: f.id,
      facilitator: f.facilitatorAgent,
      channelType: f.channelType,
      conversationId: f.conversationId,
      phase: f.phase,
      format: f.format,
      language: f.language,
      counts: {
        participants: Number(c?.participants ?? 0),
        activeParticipants: Number(c?.activeParticipants ?? 0),
        contributions: Number(c?.contributions ?? 0),
        decisions: Number(c?.decisions ?? 0),
        actionItems: Number(c?.actionItems ?? 0),
        steps: Number(c?.steps ?? 0),
        messagesSent: f.messagesSent,
      },
      deadline: iso(f.deadline),
      createdAt: f.createdAt.toISOString(),
      activatedAt: iso(f.activatedAt),
      concludedAt: iso(f.concludedAt),
      closedAt: iso(f.closedAt),
      closeReason: f.phase === 'closed' ? f.closeReason : f.closeReason ? 'ended without a result' : null,
      followupState: f.followupState,
      purgeAfter: iso(f.purgeAfter),
    };
  });
}

const MIN_REASON = 10;

function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < MIN_REASON) throw new Refusal('reason_required', `State why you need this, in at least ${String(MIN_REASON)} characters. The reason is recorded.`);
  return trimmed;
}

async function audit(engine: EngineCore, facilitationId: string, action: AccessAudit['action'], actor: string, reason: string): Promise<void> {
  await insert<AccessAudit>(engine.db(), 'plg_omadia_agent_facilitator_access_audit', { facilitationId, action, actor, reason, occurredAt: engine.now() });
}

/** Contents and protocol for an operator: audited, with a stated reason, and
 *  noted in the facilitation's own protocol. */
export async function operatorContent(engine: EngineCore, facilitationId: string, actor: string, reason: string | undefined): Promise<{ protocol: string; goal: string }> {
  const stated = requireReason(reason);
  const f = await store.getFacilitation(engine.db(), facilitationId);
  if (!f) throw new Refusal('not_found', 'No such facilitation.');
  // The audit row is written before anything is returned.
  await audit(engine, f.id, 'content_read', actor, stated);
  await store.appendEvent(engine.db(), { facilitationId: f.id, kind: 'operator_access', actor: 'operator', occurredAt: engine.now(), payload: { reason: stated } });
  return { protocol: await buildProtocol(engine.db(), f), goal: f.goal };
}

/** An operator ends a facilitation: audited, and reported in the group. */
export async function operatorTerminate(engine: EngineCore, facilitationId: string, actor: string, reason: string | undefined): Promise<Facilitation> {
  const stated = requireReason(reason);
  const f = await store.getFacilitation(engine.db(), facilitationId);
  if (!f) throw new Refusal('not_found', 'No such facilitation.');
  if (!LIVE_PHASES.includes(f.phase)) throw new Refusal('not_live', `The facilitation is already ${f.phase}.`);
  await audit(engine, f.id, 'terminate', actor, stated);
  return abortFacilitation(engine, f.id, { reason: texts(f.language).abortOperator(stated), actor: 'operator' });
}

export const listAudit = (q: Queryable, facilitationId: string): Promise<AccessAudit[]> =>
  rows<AccessAudit>(q, 'SELECT * FROM plg_omadia_agent_facilitator_access_audit WHERE facilitation_id = $1 ORDER BY id', [facilitationId]);

// ── quotas ──────────────────────────────────────────────────────────────────

/** May this facilitator start another facilitation? Refuses with the system
 *  notice the facilitator passes on to the conversation. */
export async function checkStartQuota(engine: EngineCore, facilitatorAgent: string, language: 'de' | 'en'): Promise<void> {
  const q = engine.db();
  const { config } = engine;
  const t = texts(language).system;
  if ((await store.countByPhase(q, LIVE_PHASES, facilitatorAgent)) >= config.maxActivePerFacilitator) throw new Refusal('quota_active', t.activeQuota(config.maxActivePerFacilitator));
  if ((await store.countByPhase(q, LIVE_PHASES)) >= config.maxActiveInstance) throw new Refusal('quota_instance', t.instanceQuota(config.maxActiveInstance));
  if ((await store.countStartsSince(q, facilitatorAgent, new Date(engine.now().getTime() - HOUR_MS))) >= config.startsPerHourPerFacilitator) {
    throw new Refusal('quota_starts', t.startQuota(config.startsPerHourPerFacilitator));
  }
}

// ── retention ───────────────────────────────────────────────────────────────

/** Facilitations deleted by one statement, and statements per pass. Each
 *  delete cascades through every table of a facilitation, so it is kept
 *  small: a backlog is worked off over several ticks, not in one transaction. */
export const PURGE_BATCH = 25;
export const PURGE_MAX_BATCHES = 8;

/** Delete what is past its retention, in bounded batches. Records and
 *  protocol go; the result in the chat stays where the channel keeps it. The
 *  access audit stays too. */
export async function purgeExpired(engine: EngineCore, opts: { maxBatches?: number } = {}): Promise<string[]> {
  const purged: string[] = [];
  for (let batch = 0; batch < (opts.maxBatches ?? PURGE_MAX_BATCHES); batch += 1) {
    const deleted = await engine.db().query<{ id: string }>(
      `DELETE FROM plg_omadia_agent_facilitator_facilitations
        WHERE id IN (
          SELECT id FROM plg_omadia_agent_facilitator_facilitations
           WHERE purge_after IS NOT NULL AND purge_after <= $1 AND phase IN ('closed', 'aborted') AND followup_state <> 'active'
           ORDER BY purge_after
           LIMIT ${String(PURGE_BATCH)}
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [engine.now()],
    );
    purged.push(...deleted.rows.map((r) => r.id));
    if (deleted.rows.length < PURGE_BATCH) break;
  }
  for (const id of purged) engine.log(`facilitation ${id}: records deleted after the retention period`);
  return purged;
}

export function installGovernance(): void {
  registerStartCheck(checkStartQuota);
  // No facilitation stays open forever: reaching the maximum duration ends
  // it with an abort report, never silently.
  registerJobHandler('lifetime', async (w) => {
    if (w.f.phase === 'concluding') {
      // The result has not reached the group in all this time: end it with a
      // record instead of waiting forever. (The row is given up; the close
      // check after this unit of work does the rest.)
      await w.tx.query(
        `UPDATE plg_omadia_agent_facilitator_outbox SET status = 'failed', last_error = coalesce(last_error, 'not delivered within the maximum duration')
          WHERE facilitation_id = $1 AND purpose = 'result' AND status IN ('pending', 'sending')`,
        [w.f.id],
      );
      return;
    }
    if (w.f.phase !== 'configuring' && w.f.phase !== 'active') return;
    await abortInWork(w, { reason: texts(w.f.language).abortLifetime(w.config.maxLifetimeDays), actor: 'engine' });
  });
}
