// Facilitation state (#330 C1). One record per conversation, keyed by the
// channel-native conversation id ALONE — deliberately not by
// (channelType, conversationId): the report channel (config) and the
// conversation's origin channel (event) are different concepts, and keying
// by either conflates them (review M4). The map itself is in-memory; since
// 0.6.0 it is a CACHE of durable kernel state: goal/DoD/conversationId live
// in the ephemeral run's context (payload), phase/progress/nudge accounting
// in the kernel's per-run state blob (persistence.ts), and rehydrate.ts
// rebuilds the records lazily after a restart. Records restored that way are
// create-only — whatever the live event stream produced in this process wins.

export type FacilitationPhase = 'pending' | 'active' | 'stopped';

export interface FacilitationRecord {
  conversationId: string;
  /** The conversation's origin channel type, when the event carried one. */
  channelType?: string;
  phase: FacilitationPhase;
  goal?: string;
  definitionOfDone?: string;
  runId?: string;
  workflowSlug?: string;
  /** ISO — when the ephemeral workflow's TTL disposes of the scaffold. */
  expiresAt?: string;
  /** Who invited the Facilitator (from the bot_added event), when known. */
  invitedBy?: string;
  /** Channel-native ref of the inviter (AAD id for Teams) — the roster-match
   *  key for resolving the email-keyed initiator role holder (#330 C2b). */
  invitedByRef?: { id: string; displayName?: string };
  /** The per-conversation initiator role this facilitation reports to. */
  roleKey?: string;
  /** #330 C3 — the group-side moderation records its state here; the hourly
   *  assess tick reads it (the tick turn shares no session with the group). */
  progress?: { dodMet: boolean; summary: string; updatedAt: string };
  /** #330 C3 — nudge accounting for the per-facilitation cap. */
  nudgesSent?: number;
  /** #330 round 3 — set when the record came from `bot_present` (bot was
   *  already a member, nobody re-invited it): binding happens lazily in
   *  facilitation_start instead of eagerly on the event. */
  bindPending?: boolean;
  /** The deadline the initiator stated (ISO with offset), when one was
   *  passed to facilitation_start — distinct from the workflow TTL. */
  deadline?: string;
  /** Rebuilt from durable kernel state after a restart (run listing and/or
   *  attachment listing). Attachment-only records carry no goal/DoD — status
   *  output says so instead of inventing them. */
  restored?: boolean;
  /** Restored from a run started before 0.6.0 that carries no
   *  conversationId and has no attachment: keyed `run:<runId>`, the real
   *  conversation is unknown, so nothing may be posted into it. */
  conversationUnknown?: boolean;
  createdAt: string;
  updatedAt: string;
}

export class FacilitationStateStore {
  private readonly records = new Map<string, FacilitationRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  markPending(input: {
    conversationId: string;
    channelType?: string;
    invitedBy?: string;
    invitedByRef?: { id: string; displayName?: string };
    /** #330 round 3 — record came from a `bot_present` eligibility signal:
     *  no binding exists yet, facilitation_start performs it lazily. */
    bindPending?: boolean;
  }): FacilitationRecord {
    const iso = this.now().toISOString();
    const existing = this.records.get(input.conversationId);
    // An active facilitation is never downgraded by a repeated invite event.
    if (existing && existing.phase === 'active') return existing;
    const record: FacilitationRecord = {
      conversationId: input.conversationId,
      ...(input.channelType ? { channelType: input.channelType } : {}),
      phase: 'pending',
      ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}),
      ...(input.invitedByRef ? { invitedByRef: input.invitedByRef } : {}),
      ...(input.bindPending ? { bindPending: true } : {}),
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.records.set(input.conversationId, record);
    return record;
  }

  markActive(input: {
    conversationId: string;
    goal: string;
    definitionOfDone: string;
    runId: string;
    workflowSlug: string;
    expiresAt: string;
    roleKey?: string;
    deadline?: string;
  }): FacilitationRecord {
    const iso = this.now().toISOString();
    const existing = this.records.get(input.conversationId);
    const record: FacilitationRecord = {
      conversationId: input.conversationId,
      ...(existing?.channelType ? { channelType: existing.channelType } : {}),
      phase: 'active',
      goal: input.goal,
      definitionOfDone: input.definitionOfDone,
      runId: input.runId,
      workflowSlug: input.workflowSlug,
      expiresAt: input.expiresAt,
      ...(input.roleKey ? { roleKey: input.roleKey } : {}),
      ...(input.deadline ? { deadline: input.deadline } : {}),
      ...(existing?.invitedBy ? { invitedBy: existing.invitedBy } : {}),
      ...(existing?.invitedByRef ? { invitedByRef: existing.invitedByRef } : {}),
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.records.set(input.conversationId, record);
    return record;
  }

  /** Restart rehydration (rehydrate.ts). Create-only, with ONE exception: a
   *  live record that is merely an eligibility marker (pending, no runId) is
   *  UPGRADED by a durable run. On a cold boot conversationEvents is
   *  published before this plugin activates, so the first group message
   *  after a restart (bot_present) creates such a marker BEFORE the lazy
   *  hydration runs — skipping the durable run then would drop an active
   *  facilitation and let facilitation_start create a second run. Durable
   *  fields win; the live invite context (invitedBy/Ref, channelType) stays.
   *  Any other live record (active, or carrying a runId) always wins.
   *  'stopped' comes from the persisted run state — a stopped facilitation
   *  whose run could not be cancelled must not resume after a restart. */
  restore(input: {
    conversationId: string;
    channelType?: string;
    phase: FacilitationPhase;
    runId?: string;
    workflowSlug?: string;
    roleKey?: string;
    expiresAt?: string;
    goal?: string;
    definitionOfDone?: string;
    deadline?: string;
    progress?: { dodMet: boolean; summary: string; updatedAt: string };
    nudgesSent?: number;
    conversationUnknown?: boolean;
  }): FacilitationRecord | undefined {
    const existing = this.records.get(input.conversationId);
    const upgradable =
      existing !== undefined &&
      existing.phase === 'pending' &&
      !existing.runId &&
      (input.runId !== undefined || input.phase !== 'pending');
    if (existing && !upgradable) return undefined;
    const iso = this.now().toISOString();
    const channelType = existing?.channelType ?? input.channelType;
    const record: FacilitationRecord = {
      conversationId: input.conversationId,
      ...(channelType ? { channelType } : {}),
      ...(existing?.invitedBy ? { invitedBy: existing.invitedBy } : {}),
      ...(existing?.invitedByRef ? { invitedByRef: existing.invitedByRef } : {}),
      phase: input.phase,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.definitionOfDone ? { definitionOfDone: input.definitionOfDone } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.workflowSlug ? { workflowSlug: input.workflowSlug } : {}),
      ...(input.roleKey ? { roleKey: input.roleKey } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.deadline ? { deadline: input.deadline } : {}),
      ...(input.progress ? { progress: { ...input.progress } } : {}),
      ...(input.nudgesSent !== undefined ? { nudgesSent: input.nudgesSent } : {}),
      ...(input.conversationUnknown ? { conversationUnknown: true } : {}),
      restored: true,
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.records.set(input.conversationId, record);
    return record;
  }

  /** Fill gaps of a RESTORED record from a second durable source (the
   *  attachment listing adds channelType/roleKey to a run-sourced record).
   *  Never overwrites a present field and never touches a live record. */
  mergeRestored(conversationId: string, input: { channelType?: string; roleKey?: string }): FacilitationRecord | undefined {
    const record = this.records.get(conversationId);
    if (!record || !record.restored) return undefined;
    const channelType = record.channelType ?? input.channelType;
    const roleKey = record.roleKey ?? input.roleKey;
    if (channelType === record.channelType && roleKey === record.roleKey) return record;
    const next: FacilitationRecord = {
      ...record,
      ...(channelType ? { channelType } : {}),
      ...(roleKey ? { roleKey } : {}),
    };
    this.records.set(conversationId, next);
    return next;
  }

  recordProgress(conversationId: string, progress: { dodMet: boolean; summary: string }): FacilitationRecord | undefined {
    const record = this.records.get(conversationId);
    if (!record) return undefined;
    const next: FacilitationRecord = {
      ...record,
      progress: { ...progress, updatedAt: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    };
    this.records.set(conversationId, next);
    return next;
  }

  /** Reserve a nudge slot BEFORE delivery — closes the check-then-act window
   *  between the concurrent group and tick sessions. Returns the reserved
   *  count, or undefined when no record exists or the cap is exhausted. */
  reserveNudge(conversationId: string, cap: number): number | undefined {
    const record = this.records.get(conversationId);
    if (!record) return undefined;
    const current = record.nudgesSent ?? 0;
    if (current >= cap) return undefined;
    const nudgesSent = current + 1;
    this.records.set(conversationId, { ...record, nudgesSent, updatedAt: this.now().toISOString() });
    return nudgesSent;
  }

  /** Roll a reservation back after a failed delivery — failures don't burn the cap. */
  releaseNudge(conversationId: string): void {
    const record = this.records.get(conversationId);
    if (!record) return;
    const nudgesSent = Math.max(0, (record.nudgesSent ?? 0) - 1);
    this.records.set(conversationId, { ...record, nudgesSent, updatedAt: this.now().toISOString() });
  }

  markStopped(conversationId: string): FacilitationRecord | undefined {
    const record = this.records.get(conversationId);
    if (!record) return undefined;
    const next: FacilitationRecord = { ...record, phase: 'stopped', updatedAt: this.now().toISOString() };
    this.records.set(conversationId, next);
    return next;
  }

  get(conversationId: string): FacilitationRecord | undefined {
    return this.records.get(conversationId);
  }

  getByRunId(runId: string): FacilitationRecord | undefined {
    for (const record of this.records.values()) {
      if (record.runId === runId) return record;
    }
    return undefined;
  }

  listActive(): FacilitationRecord[] {
    return [...this.records.values()].filter((record) => record.phase === 'active');
  }

  /** The single most recently updated record — the fallback when a tool call
   *  carries no conversationId (the model rarely knows it). Cross-conversation
   *  by construction: documented C1 limitation, one facilitation at a time. */
  latest(): FacilitationRecord | undefined {
    let best: FacilitationRecord | undefined;
    for (const record of this.records.values()) {
      if (!best || record.updatedAt > best.updatedAt) best = record;
    }
    return best;
  }
}
