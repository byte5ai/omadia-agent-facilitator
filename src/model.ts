// The engine's vocabulary. Row shapes mirror migrations/0001 with camelCase
// keys; `db/sql.ts` does the mapping.

export type Phase = 'configuring' | 'active' | 'concluding' | 'closed' | 'aborted';
export const LIVE_PHASES: readonly Phase[] = ['configuring', 'active', 'concluding'];
export const TERMINAL_PHASES: readonly Phase[] = ['closed', 'aborted'];

export type CloseRule = 'all_contributed' | 'at_deadline';
export type FormatId = 'decision' | 'prioritisation' | 'assignment' | 'ideas' | 'retrospective' | 'alignment' | 'custom';
export type StepKind = 'open' | 'collect' | 'discuss' | 'cluster' | 'prioritise' | 'decide' | 'assign' | 'close';
export type StepStatus = 'pending' | 'open' | 'closed';
export type MethodId = 'ranked' | 'single' | 'approval' | 'consent' | 'assignment';
export type ContributionKind =
  | 'idea'
  | 'position'
  | 'concern'
  | 'question'
  | 'proposal'
  | 'vote'
  | 'confirmation'
  | 'objection'
  | 'abstention'
  | 'commitment';
export type ContributionStatus = 'valid' | 'unconfirmed' | 'ambiguous' | 'superseded' | 'withdrawn';
export type ContributionSource = 'message' | 'card' | 'speech';
export type DeliveryClass = 'essential' | 'droppable';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dropped' | 'failed';
export type JobStatus = 'pending' | 'done' | 'cancelled' | 'failed';
export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn';
export type AckKind = 'contribution' | 'nomination' | 'action_item';
export type AckStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';
export type ActionItemStatus = 'proposed' | 'confirmed' | 'done' | 'declined';
export type SessionKind = 'async' | 'live';
export type Modality = 'chat' | 'online' | 'hybrid';
export type MediaConsent = 'not_needed' | 'pending' | 'granted' | 'refused' | 'withdrawn';
export type SessionStatus = 'scheduled' | 'running' | 'ended' | 'cancelled';
export type StakeholderRole = 'receives_protocol' | 'invited_to_followups';

export interface StepOption {
  /** Short handle a ballot can use ('A', 'B', ...). */
  key: string;
  label: string;
}

export interface ReminderPolicy {
  offsetsHours: number[];
}

export interface FollowupPolicy {
  /** Owners are reminded of their action items before the due date. */
  actionItems: boolean;
  leadHours: number;
  /** ISO time at which the status of the action items is posted to the group. */
  statusAt?: string;
}

export interface FacilitationSettings {
  changeWindowHours: number;
  runoffWindowHours: number;
  confirmWindowMinutes: number;
  /** The facilitator's display name, as it introduced itself at start. */
  facilitatorName?: string;
  /** The channel could not list every member: whoever writes joins. */
  openRoster?: boolean;
}

export interface Facilitation {
  id: string;
  facilitatorAgent: string;
  channelType: string;
  conversationId: string;
  tenantId: string | null;
  initiatorPrincipal: string;
  initiatorParticipant: string | null;
  goal: string;
  format: FormatId;
  phase: Phase;
  stateVersion: number;
  language: 'de' | 'en';
  deadline: Date | null;
  timezone: string;
  closeRule: CloseRule;
  reminderPolicy: ReminderPolicy;
  followupPolicy: FollowupPolicy;
  settings: FacilitationSettings;
  inboundCursor: string | null;
  messagesSent: number;
  quotaNoticeSent: boolean;
  result: Record<string, unknown> | null;
  followupState: 'none' | 'active' | 'ended';
  followupEndsAt: Date | null;
  createdAt: Date;
  activatedAt: Date | null;
  concludedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  purgeAfter: Date | null;
}

export interface Session {
  id: string;
  facilitationId: string;
  kind: SessionKind;
  title: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  meetingRef: string | null;
  modality: Modality;
  capabilitySnapshot: Record<string, unknown> | null;
  mediaConsent: MediaConsent;
  status: SessionStatus;
  agendaSentAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export interface Stakeholder {
  id: string;
  facilitationId: string;
  principal: string | null;
  address: string | null;
  displayName: string | null;
  role: StakeholderRole;
  addedBy: string;
  confirmed: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface Step {
  id: string;
  facilitationId: string;
  position: number;
  kind: StepKind;
  title: string;
  timeboxMinutes: number | null;
  method: MethodId | null;
  options: StepOption[];
  methodConfig: Record<string, unknown>;
  status: StepStatus;
  round: number;
  roundOptions: StepOption[] | null;
  roundDeadline: Date | null;
  openedAt: Date | null;
  timeboxEndsAt: Date | null;
  closedAt: Date | null;
}

export interface Participant {
  facilitationId: string;
  principalId: string;
  canonicalPrincipal: string | null;
  displayName: string;
  email: string | null;
  source: 'roster' | 'joined';
  status: 'active' | 'left';
  joinedAt: Date;
  leftAt: Date | null;
  changedAt: Date;
  changedByEvent: string | null;
}

export interface DodVersion {
  id: string;
  facilitationId: string;
  version: number;
  text: string;
  criteria: DodCriteria | null;
  proposedBy: string;
  proposalMessageId: string | null;
  consentState: 'initial' | 'proposed' | 'accepted' | 'rejected';
  effectiveAt: Date | null;
  createdAt: Date;
}

/** Machine-checkable definition of done. Absent criteria mean free text. */
export type DodCriteria =
  | { type: 'decisions_reached' }
  | { type: 'all_steps_closed' }
  | { type: 'action_items_confirmed'; min: number };

export interface Contribution {
  id: string;
  facilitationId: string;
  stepId: string;
  round: number;
  participantPrincipal: string;
  kind: ContributionKind;
  payload: Record<string, unknown>;
  source: ContributionSource;
  sourceMessageId: string | null;
  sourceRevision: number | null;
  sourceEventId: string | null;
  sourceOccurredAt: Date | null;
  status: ContributionStatus;
  interpreted: boolean;
  recordedAt: Date;
}

export interface Cluster {
  id: string;
  facilitationId: string;
  stepId: string;
  label: string;
  memberContributionIds: string[];
  proposedByFacilitator: boolean;
  confirmed: boolean;
  createdAt: Date;
}

export interface Decision {
  id: string;
  facilitationId: string;
  stepId: string | null;
  statement: string;
  method: string;
  result: Record<string, unknown>;
  rationale: string | null;
  decidedAt: Date;
}

export interface ActionItem {
  id: string;
  facilitationId: string;
  decisionId: string | null;
  number: number;
  description: string;
  ownerPrincipal: string;
  ownerConfirmed: boolean;
  dueDate: Date;
  status: ActionItemStatus;
  remindersSent: number;
  createdAt: Date;
  confirmedAt: Date | null;
  doneAt: Date | null;
}

export interface ProtocolEvent {
  id: string;
  facilitationId: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxPayload {
  text: string;
  mentions?: { user: string; text: string }[];
  /** A card the channel renders (a live poll); answers come back as card_answer events. */
  card?: { cardId: string; kind: 'poll'; title: string; options: StepOption[]; multiple?: boolean };
}

export interface OutboxRow {
  id: string;
  seq: string;
  facilitationId: string;
  idempotencyKey: string;
  purpose: string;
  targetKind: 'group' | 'direct';
  targetPrincipal: string | null;
  payload: OutboxPayload;
  deliveryClass: DeliveryClass;
  requiredPhases: Phase[] | null;
  requiredStateVersion: number | null;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  owner: string;
  lastError: string | null;
  dropReason: string | null;
  channelMessageId: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface InboundRow {
  facilitationId: string;
  eventId: string;
  messageId: string;
  revision: number;
  kind: string;
  authorPrincipal: string;
  outcome: string;
  processedAt: Date;
}

export interface Job {
  id: string;
  facilitationId: string;
  kind: string;
  dedupeKey: string;
  dueAt: Date;
  payload: Record<string, unknown>;
  status: JobStatus;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ProposalObjection {
  principal: string;
  reason: string;
  messageId: string;
}

export interface Proposal {
  id: string;
  facilitationId: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  proposedBy: string;
  proposalMessageId: string | null;
  announceMessageId: string | null;
  status: ProposalStatus;
  windowEndsAt: Date;
  consents: string[];
  objections: ProposalObjection[];
  openedAt: Date;
  decidedAt: Date | null;
}

export interface Ack {
  id: string;
  facilitationId: string;
  principal: string;
  kind: AckKind;
  refId: string;
  detail: Record<string, unknown>;
  promptMessageId: string | null;
  status: AckStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByMessageId: string | null;
}

export interface AccessAudit {
  id: string;
  facilitationId: string;
  action: 'content_read' | 'terminate';
  actor: string;
  reason: string;
  occurredAt: Date;
}
