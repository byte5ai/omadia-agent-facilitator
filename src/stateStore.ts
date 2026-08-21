// Facilitation state (#330 C1). One record per conversation, keyed by the
// channel-native conversation id ALONE — deliberately not by
// (channelType, conversationId): the report channel (config) and the
// conversation's origin channel (event) are different concepts, and keying
// by either conflates them (review M4). In-memory for the MVP — a middleware
// restart loses pending/active markers, which is a documented C1 limitation
// (the ephemeral Conductor run itself is durable; facilitation_status
// degrades to "no local record" honesty, never invention).

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
      ...(existing?.invitedBy ? { invitedBy: existing.invitedBy } : {}),
      ...(existing?.invitedByRef ? { invitedByRef: existing.invitedByRef } : {}),
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.records.set(input.conversationId, record);
    return record;
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
