// Queries of the facilitation tables. Plain functions over a `Queryable`, so
// the same code runs on the db, on a locked connection and inside a
// transaction. Nothing here decides anything; it reads and writes rows.

import type {
  Ack,
  ActionItem,
  Cluster,
  Contribution,
  Decision,
  DodVersion,
  Facilitation,
  InboundRow,
  Participant,
  Phase,
  Proposal,
  ProtocolEvent,
  Session,
  Stakeholder,
  Step, CardRow } from '../model.js';
import type { Queryable } from './pool.js';
import { insert, insertIfAbsent, one, rows, update } from './sql.js';

// ── facilitations ───────────────────────────────────────────────────────────

export type NewFacilitation = Pick<
  Facilitation,
  | 'facilitatorAgent'
  | 'channelType'
  | 'conversationId'
  | 'initiatorPrincipal'
  | 'goal'
  | 'format'
  | 'language'
  | 'timezone'
  | 'closeRule'
  | 'reminderPolicy'
  | 'followupPolicy'
  | 'settings'
  | 'createdAt'
> &
  Partial<Pick<Facilitation, 'id' | 'tenantId' | 'deadline' | 'initiatorParticipant' | 'electorateSource'>>;

export const createFacilitation = (q: Queryable, values: NewFacilitation): Promise<Facilitation> =>
  insert<Facilitation>(q, 'plg_omadia_agent_facilitator_facilitations', { ...values });

export const getFacilitation = (q: Queryable, id: string): Promise<Facilitation | undefined> =>
  one<Facilitation>(q, 'SELECT * FROM plg_omadia_agent_facilitator_facilitations WHERE id = $1', [id]);

/** The one facilitation of a conversation that is configuring, active or
 *  concluding: its home conversation, or a linked session conversation of
 *  one of its sessions that is not over (spec 5.3). */
export const findLiveByConversation = (
  q: Queryable,
  channelType: string,
  conversationId: string,
): Promise<Facilitation | undefined> =>
  one<Facilitation>(
    q,
    `SELECT f.* FROM plg_omadia_agent_facilitator_facilitations f
      WHERE f.channel_type = $1 AND f.phase IN ('configuring', 'active', 'concluding')
        AND (f.conversation_id = $2
             OR EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_sessions s
                         WHERE s.facilitation_id = f.id AND s.conversation_id = $2 AND s.status IN ('scheduled', 'live', 'confirming')))
      ORDER BY (f.conversation_id = $2) DESC LIMIT 1`,
    [channelType, conversationId],
  );

/** Where an inbound message of a conversation belongs: the live facilitation,
 *  otherwise the most recent closed one whose follow-up still runs. */
export async function findRoutableByConversation(
  q: Queryable,
  channelType: string,
  conversationId: string,
): Promise<Facilitation | undefined> {
  const live = await findLiveByConversation(q, channelType, conversationId);
  if (live) return live;
  return one<Facilitation>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_facilitations
      WHERE channel_type = $1 AND conversation_id = $2 AND followup_state = 'active'
      ORDER BY closed_at DESC NULLS LAST LIMIT 1`,
    [channelType, conversationId],
  );
}

/** Every facilitation that still receives messages: live, or in follow-up. */
export const listSubscribed = (q: Queryable): Promise<Facilitation[]> =>
  rows<Facilitation>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_facilitations
      WHERE phase IN ('configuring', 'active', 'concluding') OR followup_state = 'active'
      ORDER BY created_at`,
  );

export const patchFacilitation = (
  q: Queryable,
  id: string,
  patch: Partial<Facilitation>,
): Promise<Facilitation | undefined> => update<Facilitation>(q, 'plg_omadia_agent_facilitator_facilitations', { id }, { ...patch });

/** Bump `state_version`; every contribution, phase and rule change does. */
export async function bumpStateVersion(q: Queryable, id: string): Promise<number> {
  const row = await one<{ stateVersion: number }>(
    q,
    'UPDATE plg_omadia_agent_facilitator_facilitations SET state_version = state_version + 1 WHERE id = $1 RETURNING state_version',
    [id],
  );
  if (!row) throw new Error(`facilitation ${id} does not exist`);
  return row.stateVersion;
}

export async function countByPhase(
  q: Queryable,
  phases: readonly Phase[],
  facilitatorAgent?: string,
): Promise<number> {
  const row = await one<{ n: string }>(
    q,
    `SELECT count(*) AS n FROM plg_omadia_agent_facilitator_facilitations
      WHERE phase = ANY($1::text[]) AND ($2::text IS NULL OR facilitator_agent = $2)`,
    [`{${phases.join(',')}}`, facilitatorAgent ?? null],
  );
  return Number(row?.n ?? 0);
}

export async function countStartsSince(q: Queryable, facilitatorAgent: string, since: Date): Promise<number> {
  const row = await one<{ n: string }>(
    q,
    'SELECT count(*) AS n FROM plg_omadia_agent_facilitator_facilitations WHERE facilitator_agent = $1 AND created_at > $2',
    [facilitatorAgent, since],
  );
  return Number(row?.n ?? 0);
}

// ── participants ────────────────────────────────────────────────────────────

export const listParticipants = (q: Queryable, facilitationId: string): Promise<Participant[]> =>
  rows<Participant>(
    q,
    'SELECT * FROM plg_omadia_agent_facilitator_participants WHERE facilitation_id = $1 ORDER BY joined_at, display_name',
    [facilitationId],
  );

export const getParticipant = (
  q: Queryable,
  facilitationId: string,
  principalId: string,
): Promise<Participant | undefined> =>
  one<Participant>(q, 'SELECT * FROM plg_omadia_agent_facilitator_participants WHERE facilitation_id = $1 AND principal_id = $2', [
    facilitationId,
    principalId,
  ]);

export const addParticipant = (
  q: Queryable,
  values: Pick<Participant, 'facilitationId' | 'principalId' | 'displayName' | 'source' | 'joinedAt' | 'changedAt'> &
    Partial<Pick<Participant, 'canonicalPrincipal' | 'email' | 'changedByEvent'>>,
): Promise<Participant | undefined> =>
  insertIfAbsent<Participant>(q, 'plg_omadia_agent_facilitator_participants', { ...values }, '(facilitation_id, principal_id)');

export const patchParticipant = (
  q: Queryable,
  facilitationId: string,
  principalId: string,
  patch: Partial<Participant>,
): Promise<Participant | undefined> =>
  update<Participant>(q, 'plg_omadia_agent_facilitator_participants', { facilitationId, principalId }, { ...patch });

// ── steps ───────────────────────────────────────────────────────────────────

export const listSteps = (q: Queryable, facilitationId: string): Promise<Step[]> =>
  rows<Step>(q, 'SELECT * FROM plg_omadia_agent_facilitator_steps WHERE facilitation_id = $1 ORDER BY position', [facilitationId]);

export const getStep = (q: Queryable, id: string): Promise<Step | undefined> =>
  one<Step>(q, 'SELECT * FROM plg_omadia_agent_facilitator_steps WHERE id = $1', [id]);

export const openStepOf = (q: Queryable, facilitationId: string): Promise<Step | undefined> =>
  one<Step>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_steps WHERE facilitation_id = $1 AND status = 'open' ORDER BY position LIMIT 1`,
    [facilitationId],
  );

export const addStep = (
  q: Queryable,
  values: Pick<Step, 'facilitationId' | 'position' | 'kind' | 'title'> &
    Partial<Pick<Step, 'timeboxMinutes' | 'method' | 'options' | 'methodConfig'>>,
): Promise<Step> => insert<Step>(q, 'plg_omadia_agent_facilitator_steps', { ...values });

export const patchStep = (q: Queryable, id: string, patch: Partial<Step>): Promise<Step | undefined> =>
  update<Step>(q, 'plg_omadia_agent_facilitator_steps', { id }, { ...patch });

export async function replaceSteps(
  q: Queryable,
  facilitationId: string,
  steps: ReadonlyArray<Omit<Parameters<typeof addStep>[1], 'facilitationId' | 'position'>>,
): Promise<Step[]> {
  await q.query('DELETE FROM plg_omadia_agent_facilitator_steps WHERE facilitation_id = $1', [facilitationId]);
  const created: Step[] = [];
  for (const [index, step] of steps.entries()) {
    created.push(await addStep(q, { ...step, facilitationId, position: index + 1 }));
  }
  return created;
}

// ── definition of done ──────────────────────────────────────────────────────

export const listDodVersions = (q: Queryable, facilitationId: string): Promise<DodVersion[]> =>
  rows<DodVersion>(q, 'SELECT * FROM plg_omadia_agent_facilitator_dod_versions WHERE facilitation_id = $1 ORDER BY version', [
    facilitationId,
  ]);

/** The version in force: the newest one that is initial or accepted. */
export const currentDod = (q: Queryable, facilitationId: string): Promise<DodVersion | undefined> =>
  one<DodVersion>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_dod_versions
      WHERE facilitation_id = $1 AND consent_state IN ('initial', 'accepted')
      ORDER BY version DESC LIMIT 1`,
    [facilitationId],
  );

export async function addDodVersion(
  q: Queryable,
  values: Pick<DodVersion, 'facilitationId' | 'text' | 'proposedBy' | 'consentState' | 'createdAt'> &
    Partial<Pick<DodVersion, 'criteria' | 'proposalMessageId' | 'effectiveAt'>>,
): Promise<DodVersion> {
  const next = await one<{ v: number }>(
    q,
    'SELECT coalesce(max(version), 0) + 1 AS v FROM plg_omadia_agent_facilitator_dod_versions WHERE facilitation_id = $1',
    [values.facilitationId],
  );
  return insert<DodVersion>(q, 'plg_omadia_agent_facilitator_dod_versions', { ...values, version: next?.v ?? 1 });
}

export const patchDodVersion = (q: Queryable, id: string, patch: Partial<DodVersion>): Promise<DodVersion | undefined> =>
  update<DodVersion>(q, 'plg_omadia_agent_facilitator_dod_versions', { id }, { ...patch });

// ── contributions ───────────────────────────────────────────────────────────

export const addContribution = (
  q: Queryable,
  values: Omit<Contribution, 'id' | 'sourceMessageId' | 'sourceRevision' | 'sourceEventId' | 'sourceOccurredAt' | 'interpreted' | 'partIndex'> &
    Partial<Pick<Contribution, 'sourceMessageId' | 'sourceRevision' | 'sourceEventId' | 'sourceOccurredAt' | 'interpreted' | 'partIndex'>>,
): Promise<Contribution> => insert<Contribution>(q, 'plg_omadia_agent_facilitator_contributions', { ...values });

export const listContributions = (q: Queryable, facilitationId: string, stepId?: string): Promise<Contribution[]> =>
  rows<Contribution>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_contributions
      WHERE facilitation_id = $1 AND ($2::uuid IS NULL OR step_id = $2)
      ORDER BY recorded_at, source_message_id, part_index, id`,
    [facilitationId, stepId ?? null],
  );

export const getContribution = (q: Queryable, id: string): Promise<Contribution | undefined> =>
  one<Contribution>(q, 'SELECT * FROM plg_omadia_agent_facilitator_contributions WHERE id = $1', [id]);

/** The first live part a message carries (most messages carry one). */
export const findLiveBySourceMessage = async (
  q: Queryable,
  facilitationId: string,
  messageId: string,
): Promise<Contribution | undefined> => (await listLiveBySourceMessage(q, facilitationId, messageId))[0];

/** Every live part a message carries, in part order. */
export const listLiveBySourceMessage = (q: Queryable, facilitationId: string, messageId: string): Promise<Contribution[]> =>
  rows<Contribution>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_contributions
      WHERE facilitation_id = $1 AND source_message_id = $2 AND status IN ('valid', 'unconfirmed', 'ambiguous', 'pending_import')
      ORDER BY part_index`,
    [facilitationId, messageId],
  );

export const patchContribution = (
  q: Queryable,
  id: string,
  patch: Partial<Contribution>,
): Promise<Contribution | undefined> => update<Contribution>(q, 'plg_omadia_agent_facilitator_contributions', { id }, { ...patch });

// ── protocol ────────────────────────────────────────────────────────────────

export const appendEvent = (
  q: Queryable,
  values: Pick<ProtocolEvent, 'facilitationId' | 'kind' | 'actor' | 'occurredAt'> & { payload?: Record<string, unknown> },
): Promise<ProtocolEvent> => insert<ProtocolEvent>(q, 'plg_omadia_agent_facilitator_events', { payload: {}, ...values });

export const listEvents = (q: Queryable, facilitationId: string, kinds?: readonly string[]): Promise<ProtocolEvent[]> =>
  rows<ProtocolEvent>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_events
      WHERE facilitation_id = $1 AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
      ORDER BY id`,
    [facilitationId, kinds ? `{${kinds.join(',')}}` : null],
  );

// ── inbound ledger ──────────────────────────────────────────────────────────

/** How often a message that fails to process is tried before it is given up. */
export const MAX_INBOUND_ATTEMPTS = 3;

/** Claim an event for processing. Undefined when it was processed before, or
 *  given up. An event that failed earlier is claimed again for its retry. */
export async function claimInbound(q: Queryable, values: InboundRow): Promise<InboundRow | undefined> {
  const fresh = await insertIfAbsent<InboundRow>(q, 'plg_omadia_agent_facilitator_inbound', { ...values }, '(facilitation_id, event_id)');
  if (fresh) return fresh;
  return one<InboundRow>(
    q,
    `UPDATE plg_omadia_agent_facilitator_inbound SET outcome = 'processing', processed_at = $3
      WHERE facilitation_id = $1 AND event_id = $2 AND outcome = 'failed'
      RETURNING *`,
    [values.facilitationId, values.eventId, values.processedAt],
  );
}

export const setInboundOutcome = (q: Queryable, facilitationId: string, eventId: string, outcome: string): Promise<unknown> =>
  update<InboundRow>(q, 'plg_omadia_agent_facilitator_inbound', { facilitationId, eventId }, { outcome });

/** When a message was first written, as the engine saw it arrive. An edit
 *  carries the time of the edit; the message is as old as its creation.
 *  Undefined when the engine never saw the message being created. */
export async function writtenAt(q: Queryable, facilitationId: string, messageId: string): Promise<Date | undefined> {
  const row = await one<{ occurredAt: Date }>(
    q,
    `SELECT occurred_at FROM plg_omadia_agent_facilitator_inbound
      WHERE facilitation_id = $1 AND message_id = $2 AND kind = 'created'
      ORDER BY seq LIMIT 1`,
    [facilitationId, messageId],
  );
  return row?.occurredAt;
}

/** Write down that an event could not be processed. Returns the attempts so
 *  far and whether it is given up now. */
export async function recordInboundFailure(q: Queryable, values: InboundRow, error: string): Promise<{ attempts: number; gaveUp: boolean }> {
  const row = await one<{ attempts: number; outcome: string }>(
    q,
    `INSERT INTO plg_omadia_agent_facilitator_inbound
       (facilitation_id, event_id, message_id, revision, kind, author_principal, occurred_at, outcome, attempts, last_error, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN 1 >= $10 THEN 'gave_up' ELSE 'failed' END, 1, $8, $9)
     ON CONFLICT (facilitation_id, event_id) DO UPDATE
       SET attempts = plg_omadia_agent_facilitator_inbound.attempts + 1,
           last_error = EXCLUDED.last_error,
           processed_at = EXCLUDED.processed_at,
           outcome = CASE WHEN plg_omadia_agent_facilitator_inbound.attempts + 1 >= $10 THEN 'gave_up' ELSE 'failed' END
       WHERE plg_omadia_agent_facilitator_inbound.outcome IN ('failed', 'processing')
     RETURNING attempts, outcome`,
    [values.facilitationId, values.eventId, values.messageId, values.revision, values.kind, values.authorPrincipal, values.occurredAt, error.slice(0, 500), values.processedAt, MAX_INBOUND_ATTEMPTS],
  );
  return { attempts: row?.attempts ?? 0, gaveUp: row?.outcome === 'gave_up' };
}

/**
 * Move the replay cursor to an event that was dealt with. It moves only over
 * contiguous successes: never while an earlier event still waits for its
 * retry, and never backwards (a redelivered old event leaves it alone).
 */
export const advanceCursor = (q: Queryable, facilitationId: string, eventId: string): Promise<unknown> =>
  q.query(
    `UPDATE plg_omadia_agent_facilitator_facilitations f SET inbound_cursor = $2
      WHERE f.id = $1
        AND NOT EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_inbound i WHERE i.facilitation_id = $1 AND i.outcome = 'failed')
        AND coalesce((SELECT seq FROM plg_omadia_agent_facilitator_inbound i WHERE i.facilitation_id = $1 AND i.event_id = f.inbound_cursor), 0)
            <= coalesce((SELECT seq FROM plg_omadia_agent_facilitator_inbound i WHERE i.facilitation_id = $1 AND i.event_id = $2), 0)`,
    [facilitationId, eventId],
  );

// ── the rest: plain rows ────────────────────────────────────────────────────

export const listSessions = (q: Queryable, facilitationId: string): Promise<Session[]> =>
  rows<Session>(q, 'SELECT * FROM plg_omadia_agent_facilitator_sessions WHERE facilitation_id = $1 ORDER BY created_at, id', [
    facilitationId,
  ]);

export const listStakeholders = (q: Queryable, facilitationId: string): Promise<Stakeholder[]> =>
  rows<Stakeholder>(q, 'SELECT * FROM plg_omadia_agent_facilitator_stakeholders WHERE facilitation_id = $1 ORDER BY created_at, id', [
    facilitationId,
  ]);

export const listClusters = (q: Queryable, facilitationId: string): Promise<Cluster[]> =>
  rows<Cluster>(q, 'SELECT * FROM plg_omadia_agent_facilitator_clusters WHERE facilitation_id = $1 ORDER BY seq', [
    facilitationId,
  ]);

export const listDecisions = (q: Queryable, facilitationId: string): Promise<Decision[]> =>
  rows<Decision>(q, 'SELECT * FROM plg_omadia_agent_facilitator_decisions WHERE facilitation_id = $1 ORDER BY decided_at, id', [
    facilitationId,
  ]);

export const listActionItems = (q: Queryable, facilitationId: string): Promise<ActionItem[]> =>
  rows<ActionItem>(q, 'SELECT * FROM plg_omadia_agent_facilitator_action_items WHERE facilitation_id = $1 ORDER BY number', [
    facilitationId,
  ]);

export const openProposal = (q: Queryable, facilitationId: string): Promise<Proposal | undefined> =>
  one<Proposal>(q, `SELECT * FROM plg_omadia_agent_facilitator_proposals WHERE facilitation_id = $1 AND status = 'open'`, [
    facilitationId,
  ]);

export const listProposals = (q: Queryable, facilitationId: string): Promise<Proposal[]> =>
  rows<Proposal>(q, 'SELECT * FROM plg_omadia_agent_facilitator_proposals WHERE facilitation_id = $1 ORDER BY opened_at, id', [
    facilitationId,
  ]);

export const pendingAcks = (q: Queryable, facilitationId: string, principal?: string): Promise<Ack[]> =>
  rows<Ack>(
    q,
    `SELECT * FROM plg_omadia_agent_facilitator_acks
      WHERE facilitation_id = $1 AND status = 'pending' AND ($2::text IS NULL OR principal = $2)
      ORDER BY created_at, id`,
    [facilitationId, principal ?? null],
  );

// ── question cards ──────────────────────────────────────────────────────────

export const addCard = (q: Queryable, values: Omit<CardRow, 'state' | 'messageId' | 'closedAt'>): Promise<CardRow> =>
  insert<CardRow>(q, 'plg_omadia_agent_facilitator_cards', { ...values, card: JSON.stringify(values.card) });

export const getCard = (q: Queryable, cardId: string): Promise<CardRow | undefined> =>
  one<CardRow>(q, 'SELECT * FROM plg_omadia_agent_facilitator_cards WHERE card_id = $1', [cardId]);

export const listCards = (q: Queryable, facilitationId: string): Promise<CardRow[]> =>
  rows<CardRow>(q, 'SELECT * FROM plg_omadia_agent_facilitator_cards WHERE facilitation_id = $1 ORDER BY created_at, proposal_version', [facilitationId]);

export const patchCard = (q: Queryable, cardId: string, patch: Partial<Pick<CardRow, 'state' | 'messageId' | 'closedAt'>>): Promise<CardRow | undefined> =>
  update<CardRow>(q, 'plg_omadia_agent_facilitator_cards', { cardId }, { ...patch });
