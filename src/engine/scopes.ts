// Execution scopes (spec 2043 §0, kernel #2090).
//
// Everything a facilitation does is drawn from a scope the kernel keeps: a
// model turn, a post, a private message, a card update, a check. A scope has
// a deadline, a budget and the targets it may address, and the kernel refuses
// what is outside of them or stopped by an operator.
//
//   configuring   from the start request to the handshake (the kernel ends it
//                 when `active` opens)
//   active        the moderation, until the facilitation's deadline
//   closing       one per closing event: the result, an abort
//   scheduling    the follow-up meeting the group agreed on
//   follow_up     reminders and status of agreed action items
//
// The kernel is the authority. The engine keeps a row per scope it opened so
// that it knows which scope an action is drawn from, and `syncScopes` brings
// the kernel's scopes in line with the facilitation's state after every unit
// of work: it ends what is over, moves a deadline the group changed, and
// tells the kernel who the people of the facilitation are.

import type {
  ConversationMessageMode,
  ExecutionBudget,
  ExecutionPhase,
  ExecutionPurpose,
  ExecutionRefusalCode,
  ExecutionScope,
  ExecutionScopeKind,
  ExecutionTarget,
  SendAuthorization,
} from '@omadia/plugin-api';

import { DAY_MS, HOUR_MS, MINUTE_MS } from '../clock.js';
import { one, rows } from '../db/sql.js';
import * as store from '../db/store.js';
import type { Facilitation, LifecycleState } from '../model.js';
import { lifecycleOf } from '../model.js';
import type { EngineCore } from './core.js';
import { lifetimeEnd } from './lifetime.js';

export interface ScopeRow {
  id: string;
  facilitationId: string;
  kind: ExecutionScopeKind;
  eventId: string;
  scopeId: string;
  state: 'open' | 'ended';
  deadline: Date;
  peopleKey: string | null;
  openedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export type PersonTarget = Extract<ExecutionTarget, { kind: 'person' }>;

/** A refusal of the execution authorization, or the service is not there. */
export interface ScopeRefusal {
  ok: false;
  code: ExecutionRefusalCode | 'no_service';
  message: string;
}
export type ScopeResult = { ok: true; scope: ScopeRow } | ScopeRefusal;

/**
 * What each scope may spend. Actions are everything that is authorized (a
 * post, a private message, a card update, a check, a turn); model calls are
 * every call of a turn, helpers and guards included. Only the moderation
 * itself runs model turns.
 */
export const SCOPE_BUDGETS: Readonly<Record<ExecutionScopeKind, ExecutionBudget>> = {
  configuring: { actions: 300, modelCalls: 200 },
  active: { actions: 5000, modelCalls: 2000 },
  closing: { actions: 500, modelCalls: 0 },
  scheduling: { actions: 50, modelCalls: 0 },
  follow_up: { actions: 1000, modelCalls: 0 },
};

/** Model calls reserved for one facilitator turn (main model, helpers and
 *  guards). The reservation is a hard cap of the kernel. */
export const TURN_MODEL_CALLS = 8;

/** How long after the agreed time a scope stays open, so that the engine's
 *  own evaluation at that time (the result, a runoff) is still inside it. */
export const SCOPE_MARGIN_MS = HOUR_MS;
/** A closing: delivery, confirmation and dispatch. The kernel's absolute
 *  limit is 30 days after the event. */
export const CLOSING_SCOPE_MS = 29 * DAY_MS;
/** The kernel refuses a deadline that is not in the future. */
const MIN_AHEAD_MS = 5 * MINUTE_MS;
/** No scope lives longer than this (the kernel's limit, with room). */
const MAX_SCOPE_MS = 364 * DAY_MS;

/** The closing event of the regular end and of an end without a result. */
export const CLOSING_RESULT = 'result';
export const CLOSING_ABORT = 'abort';
/** The one follow-up meeting a facilitation can agree on. */
export const SCHEDULING_MEETING = 'followup_meeting';

const TABLE = 'plg_omadia_agent_facilitator_scopes';

export const listScopeRows = (engine: EngineCore, facilitationId: string): Promise<ScopeRow[]> =>
  rows<ScopeRow>(engine.db(), `SELECT * FROM ${TABLE} WHERE facilitation_id = $1 ORDER BY opened_at, kind`, [facilitationId]);

const rowOf = (engine: EngineCore, facilitationId: string, kind: ExecutionScopeKind, eventId: string): Promise<ScopeRow | undefined> =>
  one<ScopeRow>(engine.db(), `SELECT * FROM ${TABLE} WHERE facilitation_id = $1 AND kind = $2 AND event_id = $3`, [facilitationId, kind, eventId]);

async function record(engine: EngineCore, f: Facilitation, scope: ExecutionScope): Promise<ScopeRow> {
  const row = await one<ScopeRow>(
    engine.db(),
    `INSERT INTO ${TABLE} (facilitation_id, kind, event_id, scope_id, state, deadline, opened_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (facilitation_id, kind, event_id)
     DO UPDATE SET scope_id = EXCLUDED.scope_id, state = EXCLUDED.state, deadline = EXCLUDED.deadline, ended_at = EXCLUDED.ended_at, end_reason = EXCLUDED.end_reason
     RETURNING *`,
    [f.id, scope.kind, scope.eventId, scope.id, scope.state, new Date(scope.deadline), new Date(scope.openedAt), scope.endedAt ? new Date(scope.endedAt) : null, scope.endReason ?? null],
  );
  if (!row) throw new Error(`scope ${scope.kind} of facilitation ${f.id} could not be recorded`);
  return row;
}

const homeOf = (f: Facilitation): Extract<ExecutionTarget, { kind: 'conversation' }> => ({ kind: 'conversation', channelType: f.channelType, conversationId: f.conversationId });

/** The linked session conversations of a facilitation (5.3): a scope opened
 *  later (a closing) lists them, so the session protocols reach them. The
 *  kernel adds a conversation to the open scopes when it is linked. */
async function sessionConversationsOf(engine: EngineCore, f: Facilitation): Promise<Extract<ExecutionTarget, { kind: 'conversation' }>[]> {
  const linked = await engine.db().query<{ conversation_id: string }>(
    `SELECT DISTINCT conversation_id FROM plg_omadia_agent_facilitator_sessions WHERE facilitation_id = $1 AND conversation_id IS NOT NULL ORDER BY conversation_id`,
    [f.id],
  );
  return linked.rows.map((r) => ({ kind: 'conversation', channelType: f.channelType, conversationId: r.conversation_id }));
}

/** The deadline the engine wants a scope of this kind to have right now. */
async function wantedDeadline(engine: EngineCore, f: Facilitation, kind: ExecutionScopeKind): Promise<Date | undefined> {
  const now = engine.now().getTime();
  const bounded = (at: number): Date => new Date(Math.min(Math.max(at, now + MIN_AHEAD_MS), now + MAX_SCOPE_MS));
  if (kind === 'configuring') return undefined;
  if (kind === 'closing') return new Date(now + CLOSING_SCOPE_MS);
  if (kind === 'follow_up') return bounded((f.followupEndsAt?.getTime() ?? now) + SCOPE_MARGIN_MS);
  if (kind === 'scheduling') {
    const until = f.followupPolicy.meeting ? Date.parse(f.followupPolicy.meeting.to) : NaN;
    return bounded(Number.isFinite(until) ? until : now + DAY_MS);
  }
  // active: the facilitation's deadline, or a runoff that runs beyond it;
  // without a deadline the facilitation's maximum duration.
  const runoff = await engine.db().query<{ round_deadline: Date | null }>(
    `SELECT round_deadline FROM plg_omadia_agent_facilitator_steps WHERE facilitation_id = $1 AND status = 'open' AND round_deadline IS NOT NULL ORDER BY round_deadline DESC LIMIT 1`,
    [f.id],
  );
  const agreed = Math.max(f.deadline?.getTime() ?? 0, runoff.rows[0]?.round_deadline?.getTime() ?? 0);
  return bounded(agreed > 0 ? agreed + SCOPE_MARGIN_MS : lifetimeEnd(f.createdAt, null, engine.config.maxLifetimeDays).getTime());
}

const unavailable = (): ScopeRefusal => ({ ok: false, code: 'no_service', message: "kernel service 'executionAuthorization' is not available" });

/**
 * The open scope of a kind for a facilitation; opened at the kernel when the
 * engine has none on record. A scope that has ended is not opened again: the
 * kernel would refuse it, and an expired scope never re-opens moderation.
 *
 * Called outside any transaction (it calls the kernel).
 */
export async function ensureScope(engine: EngineCore, f: Facilitation, kind: ExecutionScopeKind, eventId = ''): Promise<ScopeResult> {
  const known = await rowOf(engine, f.id, kind, eventId);
  if (known) return known.state === 'open' ? { ok: true, scope: known } : { ok: false, code: 'scope_ended', message: `the ${kind} scope of this facilitation has ended` };
  return openAtKernel(engine, f, kind, eventId, true);
}

async function openAtKernel(engine: EngineCore, f: Facilitation, kind: ExecutionScopeKind, eventId: string, mayPrepare: boolean): Promise<ScopeResult> {
  const execution = engine.deps.kernel.execution();
  if (!execution) return unavailable();
  const deadline = await wantedDeadline(engine, f, kind);
  const opened = await execution.openScope({
    agentSlug: f.facilitatorAgent,
    processId: f.id,
    kind,
    ...(eventId !== '' ? { eventId } : {}),
    ...(deadline ? { deadline: deadline.toISOString() } : {}),
    budget: SCOPE_BUDGETS[kind],
    ...(kind === 'configuring' ? { home: { channelType: f.channelType, conversationId: f.conversationId } } : { targets: [homeOf(f), ...(await sessionConversationsOf(engine, f))] }),
  });
  if (opened.outcome === 'opened') {
    engine.log(`facilitation ${f.id}: execution scope '${kind}'${eventId ? ` (${eventId})` : ''} opened until ${opened.scope.deadline}`);
    return { ok: true, scope: await record(engine, f, opened.scope) };
  }
  if (opened.code === 'scope_exists') {
    // Opened before and not on record here (a crash between the two).
    const existing = (await execution.listScopes(f.id)).find((s) => s.kind === kind && s.eventId === eventId);
    if (!existing) return { ok: false, code: opened.code, message: opened.message };
    const row = await record(engine, f, existing);
    return row.state === 'open' ? { ok: true, scope: row } : { ok: false, code: 'scope_ended', message: `the ${kind} scope of this facilitation has ended` };
  }
  if (opened.code === 'scope_order' && mayPrepare && kind !== 'configuring') {
    // A facilitation from before execution scopes has none of the scopes the
    // kernel's order asks for. They are opened now, in that order; the ones
    // the facilitation is already past are ended by the next sync.
    const first = await ensureScope(engine, f, 'configuring');
    if (!first.ok && first.code !== 'scope_ended') return first;
    if (kind === 'scheduling' || kind === 'follow_up') {
      const was = await ensureScope(engine, f, 'active');
      if (!was.ok && was.code !== 'scope_ended') return was;
    }
    return openAtKernel(engine, f, kind, eventId, false);
  }
  return { ok: false, code: opened.code, message: opened.message };
}

/** End a scope at the kernel and on record. Idempotent. */
export async function endScope(engine: EngineCore, row: ScopeRow, reason: string): Promise<void> {
  if (row.state !== 'open') return;
  const execution = engine.deps.kernel.execution();
  if (!execution) return;
  await execution.endScope(row.scopeId, reason);
  await engine.db().query(`UPDATE ${TABLE} SET state = 'ended', ended_at = $2, end_reason = $3 WHERE id = $1 AND state = 'open'`, [row.id, engine.now(), reason]);
}

// ── which scope an action is drawn from ────────────────────────────────────

/** Messages that belong to the closing of a facilitation, whatever follows. */
const CLOSING_PURPOSES: ReadonlySet<string> = new Set([
  'result',
  'abort',
  'initiator_report',
  'protocol',
  'protocol_in_group',
  'protocol_sent',
  'protocol_mail_unknown',
  'protocol_mail_unavailable',
  'followup_meeting',
]);

/** The scope an action with this purpose is drawn from, by the state of the
 *  facilitation at the moment it happens. */
export function scopeKeyFor(f: Facilitation, purpose: string, followUpOpen: boolean): { kind: ExecutionScopeKind; eventId: string } {
  if (f.phase === 'configuring') return { kind: 'configuring', eventId: '' };
  if (f.phase === 'active') return { kind: 'active', eventId: '' };
  if ((f.followupState === 'active' || followUpOpen) && f.phase === 'closed' && !CLOSING_PURPOSES.has(purpose)) return { kind: 'follow_up', eventId: '' };
  return { kind: 'closing', eventId: f.phase === 'aborted' ? CLOSING_ABORT : CLOSING_RESULT };
}

const CLOSING_PHASES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(['active', 'concluding', 'closed', 'aborted', 'following_up']);
const SCHEDULING_PHASES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(['active', 'concluding', 'closed', 'following_up']);

/** The phase an action states to the kernel; it has to fit the scope's kind. */
export function phaseFor(f: Facilitation, kind: ExecutionScopeKind): ExecutionPhase {
  if (kind === 'configuring') return 'configuring';
  if (kind === 'active') return 'active';
  if (kind === 'follow_up') return 'following_up';
  const state = lifecycleOf(f);
  // A facilitation whose documents still go out after its end is `closed`.
  return (kind === 'closing' ? CLOSING_PHASES : SCHEDULING_PHASES).has(state) ? (state as ExecutionPhase) : 'closed';
}

const PURPOSES: Readonly<Record<string, ExecutionPurpose>> = {
  handshake: 'handshake',
  reminder: 'reminder',
  reminder_direct: 'reminder',
  action_reminder: 'reminder',
  action_reminder_direct: 'reminder',
  status: 'status',
  action_status: 'status',
  proposal: 'consent',
  proposal_hint: 'consent',
  proposal_objection: 'consent',
  proposal_busy: 'consent',
  protocol: 'protocol_dispatch',
  protocol_in_group: 'protocol_dispatch',
  followup_meeting: 'invitation',
  // Essential in the outbox (it is retried), but for the kernel it stays the
  // moderation it always was.
  card_update: 'moderation',
};

/** What an outgoing message is for, in the kernel's terms. */
export const purposeFor = (purpose: string, essential: boolean): ExecutionPurpose => PURPOSES[purpose] ?? (essential ? 'essential_message' : 'moderation');

/** The `closing` scope of one closing event (a session close: `session:<id>`)
 *  and the authorization fields of an action drawn from it. */
export async function closingScopeAction(engine: EngineCore, f: Facilitation, eventId: string): Promise<{ ok: true; value: ActionScope } | ScopeRefusal> {
  const found = await ensureScope(engine, f, 'closing', eventId);
  if (!found.ok) return found;
  return { ok: true, value: { scope: found.scope, authorization: { scopeId: found.scope.scopeId, processId: f.id, phase: phaseFor(f, 'closing') } } };
}

export interface ActionScope {
  scope: ScopeRow;
  authorization: Omit<SendAuthorization, 'purpose' | 'emission'>;
}

/** The scope and the authorization fields of an action of a facilitation. */
export async function scopeForAction(engine: EngineCore, f: Facilitation, purpose: string): Promise<{ ok: true; value: ActionScope } | ScopeRefusal> {
  const followUpOpen = (await rowOf(engine, f.id, 'follow_up', ''))?.state === 'open';
  const key = scopeKeyFor(f, purpose, followUpOpen);
  const found = await ensureScope(engine, f, key.kind, key.eventId);
  if (!found.ok) return found;
  return { ok: true, value: { scope: found.scope, authorization: { scopeId: found.scope.scopeId, processId: f.id, phase: phaseFor(f, key.kind) } } };
}

// ── the people of a scope ──────────────────────────────────────────────────

/** The platform id the kernel knows a person by: the principal without its
 *  `user:` prefix. Undefined for somebody the channel never named. */
export const platformId = (principal: string): string | undefined => (principal.startsWith('user:') && principal.length > 5 ? principal.slice(5) : undefined);

/**
 * Who a scope may address (spec 2043 §0, "Allowed targets"). `status_only`:
 * the person may ask for the status privately and gets only that.
 */
export async function peopleFor(engine: EngineCore, f: Facilitation, kind: ExecutionScopeKind): Promise<PersonTarget[]> {
  const db = engine.db();
  const active = (await store.listParticipants(db, f.id)).filter((p) => p.status === 'active');
  let unrestricted: (principal: string) => boolean = () => true;
  if (kind === 'configuring') unrestricted = (principal) => principal === f.initiatorPrincipal || principal === f.initiatorParticipant;
  if (kind === 'follow_up') {
    // The owners of the agreed items, also of one that is done by now: the
    // answer to "done" goes to its owner.
    const owners = new Set((await store.listActionItems(db, f.id)).filter((a) => a.status === 'confirmed' || a.status === 'done').map((a) => a.ownerPrincipal));
    unrestricted = (principal) => owners.has(principal);
  }
  const people: PersonTarget[] = [];
  for (const p of active) {
    const principalId = platformId(p.principalId);
    if (principalId === undefined) continue;
    people.push({ kind: 'person', channelType: f.channelType, principalId, ...(unrestricted(p.principalId) ? {} : { restriction: 'status_only' as const }) });
  }
  // Session participants may ask for their sessions' status privately (5.3,
  // criterion 46), and get nothing else.
  if (kind !== 'follow_up') {
    const guests = await db.query<{ principal_id: string }>(
      `SELECT DISTINCT principal_id FROM plg_omadia_agent_facilitator_session_participants WHERE facilitation_id = $1 AND status = 'active'`,
      [f.id],
    );
    for (const g of guests.rows) {
      const principalId = platformId(g.principal_id);
      if (principalId === undefined || people.some((p) => p.principalId === principalId)) continue;
      people.push({ kind: 'person', channelType: f.channelType, principalId, restriction: 'status_only' });
    }
  }
  return people.sort((a, b) => a.principalId.localeCompare(b.principalId));
}

/** Tell the kernel who the people of a scope are, when that changed. */
export async function syncPeople(engine: EngineCore, f: Facilitation, row: ScopeRow): Promise<void> {
  const execution = engine.deps.kernel.execution();
  if (!execution || row.state !== 'open') return;
  const people = await peopleFor(engine, f, row.kind);
  const key = JSON.stringify(people.map((p) => [p.principalId, p.restriction ?? '']));
  if (key === row.peopleKey) return;
  const outcome = await execution.setPeople(row.scopeId, people);
  if (outcome.outcome === 'refused') {
    engine.log(`facilitation ${f.id}: the people of its ${row.kind} scope could not be registered (${outcome.code}: ${outcome.message})`);
    return;
  }
  await engine.db().query(`UPDATE ${TABLE} SET people_key = $2 WHERE id = $1`, [row.id, key]);
}

// ── keeping the kernel's scopes in line with the facilitation ──────────────

/** How the conversation is read in a state (spec 2043 §5.3, §6.2). */
export function wantedMode(f: Facilitation): ConversationMessageMode {
  if (f.phase === 'configuring' || f.phase === 'active' || f.phase === 'concluding') return 'all';
  // In follow-up the mention gate is back on: owners reach the facilitator by
  // mention, by a card button or by a reply to one of its messages.
  return f.followupState === 'active' ? 'addressed' : 'none';
}

const settled = async (engine: EngineCore, facilitationId: string, jobKinds: readonly string[]): Promise<boolean> => {
  const waiting = await engine.db().query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND status IN ('pending', 'sending')
     UNION ALL
     SELECT 1 FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND status = 'pending' AND kind = ANY($2::text[])
     LIMIT 1`,
    [facilitationId, `{${jobKinds.join(',')}}`],
  );
  return waiting.rows.length === 0;
};

/** Why a scope of this kind is over, or undefined while it is still needed. */
async function overBecause(engine: EngineCore, f: Facilitation, row: ScopeRow, onPass: boolean): Promise<string | undefined> {
  const ended = f.phase === 'closed' || f.phase === 'aborted';
  if (row.kind === 'configuring') return f.phase === 'configuring' ? undefined : f.phase === 'aborted' ? 'aborted' : 'opened';
  if (row.kind === 'active') return f.phase === 'active' || f.phase === 'configuring' ? undefined : f.phase;
  if (row.kind === 'follow_up') {
    // Ended on a scheduler pass, not in the moment the last item is reported
    // done: the answer to that report (in the group, or in the owner's
    // private chat) is still drawn from this scope.
    if (f.followupState === 'active' || !onPass) return undefined;
    return (await settled(engine, f.id, [])) ? 'follow-up ended' : undefined;
  }
  if (row.kind === 'scheduling') {
    // Stop or abort: no further free/busy query, no further invitation.
    if (f.phase === 'aborted') return 'aborted';
    if (!ended) return undefined;
    return (await settled(engine, f.id, ['followup_meeting'])) ? 'the invitation is settled' : undefined;
  }
  // closing: as long as its closing event runs (spec 5.2): its parts and
  // limits are kept in the closings table. A closing from before 1.6 has no
  // row: until its documents are out.
  const closing = await one<{ endedAt: Date | null }>(engine.db(), 'SELECT ended_at FROM plg_omadia_agent_facilitator_closings WHERE facilitation_id = $1 AND event_id = $2', [f.id, row.eventId]);
  if (closing) return closing.endedAt !== null && (await settled(engine, f.id, ['protocol_mail', 'followup_meeting'])) ? 'the closing has ended' : undefined;
  if (!ended) return undefined;
  return (await settled(engine, f.id, ['protocol_mail', 'followup_meeting'])) ? 'the closing is delivered' : undefined;
}

/** Give the home conversation back and set how it is read from now on. */
async function syncReading(engine: EngineCore, f: Facilitation): Promise<void> {
  const { kernel } = engine.deps;
  const mode = wantedMode(f);
  if (f.settings.readMode === mode) return;
  const ended = f.phase === 'closed' || f.phase === 'aborted';
  // The reservation is released at `closed` or `aborted`, so that a new
  // facilitation or a discussion can start while documents still go out and
  // while action items are followed up.
  if (ended) await kernel.execution()?.releaseConversation({ processId: f.id, channelType: f.channelType, conversationId: f.conversationId, reason: f.phase });
  const messages = kernel.messages();
  if (messages && (ended || f.settings.readMode !== undefined)) {
    const outcome = await messages.subscribe({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, processId: f.id }, { mode });
    // An ended subscription is as closed as it gets.
    if (outcome.outcome === 'refused' && mode !== 'none') {
      engine.log(`facilitation ${f.id}: the kernel does not change how its conversation is read to '${mode}' (${outcome.code}: ${outcome.message})`);
      return;
    }
  }
  await engine.db().query(
    `UPDATE plg_omadia_agent_facilitator_facilitations SET settings = settings || jsonb_build_object('readMode', $2::text) || $3::jsonb WHERE id = $1`,
    [f.id, mode, JSON.stringify(ended ? { released: true } : {})],
  );
}

/**
 * Bring the kernel's scopes in line with the facilitation: end what is over,
 * open what its state needs, move the deadline of the moderation when the
 * group changed it, register the people, and give the conversation back once
 * the facilitation has ended. Idempotent; called after every unit of work and
 * on every scheduler pass (`onPass`), outside the lock.
 */
export async function syncScopes(engine: EngineCore, facilitationId: string, onPass = false): Promise<void> {
  const execution = engine.deps.kernel.execution();
  if (!execution) return;
  const f = await store.getFacilitation(engine.db(), facilitationId);
  // Nothing is opened for a facilitation that began before execution scopes
  // until it was taken over (subscription.ts).
  if (!f || f.settings.scoped !== true) return;

  if (f.followupState === 'active') await ensureScope(engine, f, 'follow_up');
  if (f.followupPolicy.meeting && f.phase !== 'aborted' && f.phase !== 'configuring') await ensureScope(engine, f, 'scheduling', SCHEDULING_MEETING);

  for (const row of await listScopeRows(engine, f.id)) {
    if (row.state !== 'open') continue;
    const reason = await overBecause(engine, f, row, onPass);
    if (reason !== undefined) {
      await endScope(engine, row, reason);
      continue;
    }
    if (row.kind === 'active' || row.kind === 'follow_up') {
      const wanted = await wantedDeadline(engine, f, row.kind);
      if (wanted && Math.abs(wanted.getTime() - row.deadline.getTime()) > MINUTE_MS) {
        const moved = await execution.extendScope(row.scopeId, { deadline: wanted.toISOString() });
        if (moved.outcome === 'extended') await engine.db().query(`UPDATE ${TABLE} SET deadline = $2 WHERE id = $1`, [row.id, new Date(moved.scope.deadline)]);
        else engine.log(`facilitation ${f.id}: the deadline of its ${row.kind} scope could not be moved to ${wanted.toISOString()} (${moved.code}: ${moved.message})`);
      }
    }
    await syncPeople(engine, f, row);
  }
  await syncReading(engine, f);
}

/** Every facilitation that has an open scope, or whose conversation is still
 *  to be given back. One that fails does not stop the others. */
export async function syncAllScopes(engine: EngineCore): Promise<void> {
  const open = await engine.db().query<{ id: string }>(
    `SELECT f.id FROM plg_omadia_agent_facilitator_facilitations f
      WHERE coalesce((f.settings->>'scoped')::boolean, false)
        AND (EXISTS (SELECT 1 FROM ${TABLE} s WHERE s.facilitation_id = f.id AND s.state = 'open')
             OR (f.phase IN ('closed', 'aborted') AND NOT coalesce((f.settings->>'released')::boolean, false)))
      ORDER BY f.created_at LIMIT 200`,
  );
  for (const row of open.rows) {
    try {
      await syncScopes(engine, row.id, true);
    } catch (err) {
      engine.log(`facilitation ${row.id}: its execution scopes could not be brought up to date: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Has an operator stopped this facilitation? Asked before the scheduler acts
 * for it: a job is an action like any other, and a stopped facilitation does
 * nothing, model-free work included. The check is drawn from the scope of the
 * facilitation's state when one is open; without one there is nothing the
 * kernel could refuse here, and what the job posts is authorized on its own.
 */
export async function stoppedByOperator(engine: EngineCore, f: Facilitation): Promise<{ stopped: false } | { stopped: true; message: string }> {
  const execution = engine.deps.kernel.execution();
  if (!execution || f.settings.scoped !== true) return { stopped: false };
  const open = (await listScopeRows(engine, f.id)).filter((r) => r.state === 'open');
  const key = scopeKeyFor(f, '', open.some((r) => r.kind === 'follow_up'));
  const row = open.find((r) => r.kind === key.kind && r.eventId === key.eventId) ?? open[0];
  if (!row) return { stopped: false };
  const outcome = await execution.authorize({ scopeId: row.scopeId, phase: phaseFor(f, row.kind), purpose: 'other', action: 'check', emission: 'data' });
  return outcome.outcome === 'refused' && outcome.code === 'kill_switch' ? { stopped: true, message: outcome.message } : { stopped: false };
}

// ── refusals, in words ─────────────────────────────────────────────────────

/** Refusals that do not pass on their own: trying again changes nothing. */
const FINAL_REFUSALS: ReadonlySet<string> = new Set(['scope_ended', 'unknown_scope', 'deadline_passed', 'limit_exceeded', 'target_not_allowed', 'phase_mismatch', 'purpose_not_allowed', 'not_permitted', 'unknown_agent', 'invalid_request', 'scope_order', 'scope_exists', 'budget_exhausted']);

export const isFinalRefusal = (code: string | undefined): boolean => code !== undefined && FINAL_REFUSALS.has(code);
