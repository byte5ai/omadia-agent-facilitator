// A fake kernel with a simulated channel, for developing against the
// plugin-api 1.55 contract while the kernel's implementation is being built.
//
// It keeps what the real kernel keeps (subscriptions and stored events), so a
// "restart" in a test is a new engine against the same fake kernel and the
// same database. Authorship is whatever `say()` was called with: the channel
// states it, the engine can only read it.

import { EXECUTION_GRANT_RULES, EXECUTION_SCOPE_PHASES, SESSION_CONVERSATION_TRANSITIONS } from '@omadia/plugin-api';
import type {
  LinkRequest,
  LinkRequestReply,
  SessionConversationState,
  AddressedMessageReply,
  AddressedMessageRequest,
  AuthorizeActionRequest,
  ChannelReadinessReport,
  ChannelReadinessService,
  ConversationMessageMode,
  ConversationMessageRecord,
  ConversationMessagesService,
  ExecutionActionType,
  ExecutionAuthorization,
  ExecutionAuthorizationService,
  ExecutionBudget,
  ExecutionGrantKind,
  ExecutionGrantUse,
  ExecutionGrantsService,
  ExecutionPhase,
  ExecutionPurpose,
  ExecutionRefusal,
  ExecutionRefusalCode,
  ExecutionScopeKind,
  ExecutionTarget,
  FacilitationFollowupService,
  GrantOperation,
  GrantRefusalCode,
  OpenExecutionScopeRequest,
  PrivateMessageReply,
  PrivateMessageRequest,
  ProcessConversationMessageRecord,
  ProcessConversationMessagesService,
  ProcessMessageScope,
  ScopedAgentTurnOutcome,
  ScopedAgentTurnRequest,
  ScopedAgentTurnService,
  ScopedConversationSendRequest,
  ScopedConversationSendService,
  ScopedSendOutcome,
  SendAuthorization,
  SessionCapabilitiesService,
  SessionCapabilitySnapshot,
  SessionEventRecord,
} from '@omadia/plugin-api';

import type { CardAnswerValue, CardSupport, CardUpdate, QuestionCard } from '../src/cards/types.js';
import type { Clock } from '../src/clock.js';
import type { Db } from '../src/db/pool.js';
import type {
  ConversationEventsService,
  ConversationMembershipEvent,
  ConversationRoster,
  ConversationRostersService,
  Kernel,
} from '../src/kernel.js';

export interface FakeUser {
  id: string;
  displayName: string;
  email?: string;
}

export interface FakeClock extends Clock {
  set(date: Date | string): void;
  advance(ms: number): void;
}

export function fakeClock(start: string | Date = '2026-11-18T09:00:00Z'): FakeClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (date) => {
      current = new Date(date);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

export interface Post {
  as: string;
  conversationId: string;
  text: string;
  mentions: { user: string; text: string }[];
  poll?: unknown;
  card?: QuestionCard;
  /** The id answers and updates of the card refer to. */
  cardMessageId?: string;
  messageId: string;
  /** The facilitation the post was authorized for. */
  processId?: string;
}

export interface DirectMessage {
  as: string | undefined;
  principal: string;
  text: string;
  /** The facilitation the message was authorized for. */
  processId?: string;
}

/** An execution scope as the kernel keeps it. */
export interface FakeScope {
  id: string;
  agentSlug: string;
  processId: string;
  kind: ExecutionScopeKind;
  eventId: string;
  state: 'open' | 'ended';
  deadline: string;
  absoluteLimit: string;
  deadlineWait: boolean;
  budget: ExecutionBudget;
  used: ExecutionBudget;
  targets: ExecutionTarget[];
  openedAt: string;
  endedAt?: string;
  endReason?: string;
}

export interface FakeReservation {
  agentSlug: string;
  processId: string;
  channelType: string;
  conversationId: string;
  role: 'home' | 'session';
  reservedAt: string;
  releasedAt?: string;
  /** `session` role: the session state the kernel reads by (#2076). */
  sessionState?: SessionConversationState;
  sessionId?: string;
}

export interface FakeAuthorization {
  id: string;
  scopeId: string;
  processId: string;
  kind: ExecutionScopeKind;
  action: ExecutionActionType;
  purpose: ExecutionPurpose;
  phase: ExecutionPhase;
  modelCalls: number;
  target?: ExecutionTarget;
  emission?: 'prose' | 'template' | 'data';
  settled?: boolean;
}

export interface FakeGrant {
  id: string;
  scopeId: string;
  processId: string;
  kind: ExecutionGrantKind;
  subject: string;
  recipients: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokeReason?: string;
  uses: ExecutionGrantUse[];
}

export interface FakeProcessSubscription extends ProcessMessageScope {
  mode: ConversationMessageMode;
  ended: boolean;
}

/** What a test makes a turn answer: a text, or an outcome of its own. */
export type TurnAnswer = { outcome: 'refused'; code: string; message: string } | { outcome: 'failed'; message: string } | { outcome: 'completed'; text: string };

export interface SayOptions {
  /** The channel states that the message addresses the facilitator, however
   *  the mention stands in the text (Teams: the display name, without "@"). */
  addressed?: boolean;
  replyTo?: string;
  quoted?: boolean;
  forwarded?: boolean;
  at?: string;
}

/** A stand-in for the M365 connector's `facilitation.followup`: it refuses
 *  anybody outside the grant, answers on a quarter-hour grid in UTC, and
 *  never returns anything but busy intervals. */
export class FakeFollowup implements FacilitationFollowupService {
  readonly calls: { method: string; grant: { facilitationId: string; allowed: readonly string[]; grantId?: string }; request: Record<string, unknown> }[] = [];
  /** Busy intervals per address; an address that is absent is "unknown". */
  readonly calendars = new Map<string, { start: string; end: string }[]>();
  readonly mails: { recipients: readonly string[]; subject: string; body: string }[] = [];
  readonly invitations: { attendees: readonly string[]; subject: string; start: string; end: string; body: string; online?: boolean }[] = [];
  configured = true;
  joinLinks = true;
  /** Called at the start of every call (to look at the world at that moment). */
  onCall: (method: string) => void | Promise<void> = () => undefined;
  /** Methods that do their work and then fail to answer: 'throw' or 'hang'. */
  readonly afterEffects = new Map<string, 'throw' | 'hang'>();

  private async finish<T>(method: string, value: T): Promise<T> {
    const effect = this.afterEffects.get(method);
    if (effect === 'throw') throw new Error(`${method}: connection lost after the request was accepted`);
    if (effect === 'hang') return new Promise<T>(() => undefined);
    return value;
  }

  /** The kernel's `grantVerification`, as the connector asks it (M1). */
  verify: ((request: { grantId: string; operation: GrantOperation; recipients: readonly string[] }) => { allowed: true } | { allowed: false; code: string; message: string }) | undefined;
  private operation: GrantOperation = 'send_mail';

  private refuse(grant: { allowed: readonly string[]; grantId?: string }, people: readonly string[]) {
    if (!this.configured) return { outcome: 'refused' as const, code: 'not_configured' as const, message: 'no organiser mailbox is configured' };
    // The kernel's grant first; the recipient list stays the second line.
    if (grant.grantId !== undefined && this.verify) {
      const verdict = this.verify({ grantId: grant.grantId, operation: this.operation, recipients: people });
      if (!verdict.allowed) return { outcome: 'refused' as const, code: 'grant_refused' as const, message: `${verdict.code}: ${verdict.message}` };
    }
    const rejected = people.filter((p) => !grant.allowed.includes(p));
    return rejected.length > 0 ? { outcome: 'refused' as const, code: 'recipient_not_allowed' as const, message: 'outside the grant', rejected } : undefined;
  }

  async freeBusy(grant: { facilitationId: string; allowed: readonly string[]; grantId?: string }, request: { attendees: readonly string[]; from: string; to: string }) {
    this.calls.push({ method: 'freeBusy', grant, request });
    await this.onCall('freeBusy');
    this.operation = 'free_busy';
    const refused = this.refuse(grant, request.attendees);
    if (refused) return refused;
    return {
      outcome: 'ok' as const,
      busy: request.attendees.filter((a) => this.calendars.has(a)).map((attendee) => ({ attendee, intervals: this.calendars.get(attendee) ?? [] })),
    };
  }

  async createInvitation(grant: { facilitationId: string; allowed: readonly string[]; grantId?: string }, request: { attendees: readonly string[]; subject: string; start: string; end: string; body: string; online?: boolean }) {
    this.calls.push({ method: 'createInvitation', grant, request });
    await this.onCall('createInvitation');
    this.operation = 'create_invitation';
    const refused = this.refuse(grant, request.attendees);
    if (refused) return refused;
    this.invitations.push(request);
    return this.finish('createInvitation', { outcome: 'created' as const, eventId: `event-${String(this.invitations.length)}`, ...(request.online && this.joinLinks ? { joinUrl: 'https://teams.example/join/1' } : {}) });
  }

  async sendMail(grant: { facilitationId: string; allowed: readonly string[]; grantId?: string }, request: { recipients: readonly string[]; subject: string; body: string }) {
    this.calls.push({ method: 'sendMail', grant, request });
    await this.onCall('sendMail');
    this.operation = 'send_mail';
    const refused = this.refuse(grant, request.recipients);
    if (refused) return refused;
    this.mails.push(request);
    return this.finish('sendMail', { outcome: 'sent' as const });
  }
}

const scopeKey = (s: { agentSlug: string; channelType: string; conversationId: string }): string =>
  `${s.agentSlug}|${s.channelType}|${s.conversationId}`;

export class FakeKernel {
  /** The channel this simulated transport is. Teams unless a test names
   *  another (Slack, Discord, Telegram: spec 2043 §6.4). */
  readonly channelType: string;
  readonly posts: Post[] = [];
  readonly dms: DirectMessage[] = [];
  readonly turns: ScopedAgentTurnRequest[] = [];
  readonly events: ConversationMessageRecord[] = [];
  readonly subscriptions = new Set<string>();
  /** Agents without an identity of their own on the channel. */
  readonly noIdentity = new Set<string>();
  /** Per agent: the channel types it has an identity of its own on. Absent:
   *  the simulated channel, unless the agent is in {@link noIdentity}. */
  readonly ownIdentities = new Map<string, string[]>();
  /** Per agent: the archetype settings the operator set (`AgentProfile.archetypeSettings`). */
  readonly agentSettings = new Map<string, Record<string, string | readonly number[]>>();
  /** Per `agent|conversation`: what the readiness check reports missing. */
  readonly notReady = new Map<string, { code: string; message: string }[]>();
  /** `agent|conversation` keys whose missing consent a repair fixes; and the repairs asked for. */
  readonly repairable = new Set<string>();
  readonly repairs: string[] = [];
  /** Principals a private message cannot reach, with the channel's code. */
  readonly dmBlocked = new Map<string, string>();
  /** Group sends to fail next, in order: an outcome, or 'throw' / 'lost'
   *  ('lost' delivers but reports failure: a lost confirmation; 'hang' never
   *  answers). */
  readonly sendFaults: Array<'throw' | 'lost' | 'hang' | { code: string; message: string }> = [];
  /** Answers the facilitator's turn; default: says nothing. */
  onTurn: (request: ScopedAgentTurnRequest) => string | TurnAnswer | Promise<string | TurnAnswer> = () => '[silent]';
  private followupService: FacilitationFollowupService | undefined;
  get followup(): FacilitationFollowupService | undefined {
    return this.followupService;
  }
  /** The integration asks this kernel about every grant it is handed. */
  set followup(service: FacilitationFollowupService | undefined) {
    this.followupService = service;
    if (service instanceof FakeFollowup) service.verify = (request) => this.verifyGrant(request);
  }
  snapshots = new Map<string, SessionCapabilitySnapshot>();
  /** Display names and languages the kernel knows of facilitators. */
  readonly names = new Map<string, string>();
  readonly languages = new Map<string, string>();
  /** Services a test wants to be absent. */
  readonly absent = new Set<keyof Kernel>();

  /** How far the clock moves with every channel event. */
  tickMs = 1000;
  private seq = 0;
  private readonly members = new Map<string, FakeUser[]>();
  private readonly partialRosters = new Set<string>();
  /** Conversations the channel cannot list the members of (people still
   *  write there under their names). */
  private readonly noRosters = new Set<string>();
  /** Conversations the instance's default bot is not in. */
  readonly ownBotOnly = new Set<string>();
  /** A kernel that asks the channel as the agent named with a roster call. */
  rosterAsAgent = false;
  /** Every roster call, with the agent it named. */
  readonly rosterAsks: Array<{ conversationId: string; agentSlug?: string; fresh?: boolean }> = [];
  /** What the channel declares about question cards. Undefined: a kernel or a
   *  channel without them (no `capabilities`, no `updateCard`). */
  cardSupport: CardSupport | undefined;
  /** Every card update the engine asked for. */
  readonly cardUpdates: Array<{ as: string; conversationId: string; cardMessageId: string; update: CardUpdate }> = [];
  /** The channel declares cards and still refuses the next ones (too large, ...). */
  refuseCards = 0;
  /** Card updates to refuse next. */
  readonly cardUpdateFaults: Array<{ code: string; message: string }> = [];
  /** A kernel that states the caller's display name with a tool call. */
  statesCallerName = false;
  private readonly listeners = new Map<string, Set<(record: ConversationMessageRecord) => void | Promise<void>>>();
  private readonly membershipListeners = new Set<(event: ConversationMembershipEvent) => void>();
  private readonly capabilityListeners = new Map<string, Set<(s: SessionCapabilitySnapshot) => void | Promise<void>>>();
  private readonly sessionListeners = new Map<string, Set<(e: SessionEventRecord) => void | Promise<void>>>();
  private readonly revisions = new Map<string, number>();
  private readonly originals = new Map<string, ConversationMessageRecord>();

  constructor(
    private readonly database: Db | undefined,
    readonly clock: FakeClock,
    channelType = 'teams',
  ) {
    this.channelType = channelType;
  }

  /** The channel types the agent has an identity of its own on. */
  identityChannels(agentSlug: string): string[] {
    return this.ownIdentities.get(agentSlug) ?? (this.noIdentity.has(agentSlug) ? [] : [this.channelType]);
  }

  /** Has the agent an identity of its own on the simulated channel? */
  hasIdentity(agentSlug: string): boolean {
    return this.identityChannels(agentSlug).includes(this.channelType);
  }

  /** How the channel names a person and a bot. */
  private get userKind(): string {
    return this.channelType === 'teams' ? 'teams-aad' : `${this.channelType}-user`;
  }
  private get botKind(): string {
    return this.channelType === 'teams' ? 'teams-bot' : `${this.channelType}-bot`;
  }

  // ── the simulated channel ────────────────────────────────────────────────

  conversation(id: string, members: FakeUser[], opts: { partialRoster?: boolean; noRoster?: boolean } = {}): string {
    this.members.set(id, [...members]);
    if (opts.partialRoster) this.partialRosters.add(id);
    // Registering a conversation again says what the channel can do now.
    if (opts.noRoster) this.noRosters.add(id);
    else this.noRosters.delete(id);
    return id;
  }

  /** The kernel ends the subscriptions of an agent in a conversation on its
   *  own (their ground is gone). Nothing tells the engine, and a process
   *  subscribes a conversation once: it does not get it back. */
  endSubscription(agentSlug: string, conversationId: string): void {
    for (const sub of this.processSubscriptions) if (sub.agentSlug === agentSlug && sub.conversationId === conversationId) sub.ended = true;
    this.refreshSubscriptions();
  }

  /** Subscribe refusals to answer next, per agent (the kernel will not give
   *  the conversation back). */
  readonly subscribeRefusals = new Map<string, { code: 'unavailable' | 'not_ready' | 'not_present'; message: string }>();
  /** Bot names a message can mention besides the agent's slug. */
  private addressed(text: string | undefined, agentSlug: string): boolean {
    const lower = (text ?? '').toLowerCase();
    return [agentSlug, this.names.get(agentSlug) ?? agentSlug].some((name) => lower.includes(`@${name.toLowerCase()}`));
  }

  private user(conversationId: string, userId: string): FakeUser {
    return this.members.get(conversationId)?.find((m) => m.id === userId) ?? { id: userId, displayName: userId };
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(5, '0')}`;
  }

  private async emit(
    conversationId: string,
    userId: string,
    partial: Pick<ConversationMessageRecord, 'kind' | 'messageId' | 'revision'> & Partial<ConversationMessageRecord>,
    at?: string,
  ): Promise<ConversationMessageRecord> {
    const user = this.user(conversationId, userId);
    // Time passes between any two things people do, so order is never a tie.
    if (!at) this.clock.advance(this.tickMs);
    const when = at ?? this.clock.now().toISOString();
    const base = {
      channelType: this.channelType,
      conversationId,
      // As the kernel does: channel-native id in original case, principal lower-cased.
      author: { kind: this.userKind, id: user.id, displayName: user.displayName, principalId: `user:${user.id.toLowerCase()}` },
      tenantId: 'tenant-1',
      occurredAt: when,
      receivedAt: when,
      ...partial,
    };
    let last: ConversationMessageRecord | undefined;
    // Which process a message goes to is decided before it is stored: a
    // reply to a message, or an answer to a card, that belongs to a process
    // goes to that process alone. Anything else goes to the process that
    // reads everything and, when it addresses the agent, to those that read
    // what is addressed to them.
    const reference = partial.kind === 'card_answer' ? (this.bound.get(partial.cardAnswer?.cardId ?? '') ?? this.bound.get(partial.messageId)) : partial.kind === 'reaction' ? this.bound.get(partial.messageId) : partial.replyToMessageId ? this.bound.get(partial.replyToMessageId) : undefined;
    for (const sub of [...this.processSubscriptions]) {
      if (sub.ended || sub.mode === 'none' || sub.channelType !== this.channelType || sub.conversationId !== conversationId) continue;
      const addressedToBot = partial.addressedToBot === true || this.addressed(partial.text, sub.agentSlug);
      const boundHere = reference !== undefined && this.processSubscriptions.some((other) => other.processId === reference && other.conversationId === conversationId && !other.ended && other.mode !== 'none');
      if (boundHere ? sub.processId !== reference : !(sub.mode === 'all' || addressedToBot)) continue;
      const record: ProcessConversationMessageRecord = { ...base, eventId: this.nextId('evt'), receivedByChannelKey: `28:${sub.agentSlug}`, processId: sub.processId, ...(addressedToBot ? { addressedToBot: true } : {}) };
      this.events.push(record);
      last = record;
      // With `onAddressedMessage` registered, a plain message that addresses
      // the agent is stored for a process that listens for such messages but
      // not pushed: the handler is its live path. Replies and card answers
      // bound to a process are pushed as before, and so is everything where
      // a process of the agent reads every message.
      const viaHandler = addressedToBot && sub.mode === 'addressed' && !boundHere && this.addressedMessages && (this.addressedHandlers.get(sub.agentSlug)?.size ?? 0) > 0 && this.ordinaryTurnRuns(sub.agentSlug, conversationId);
      if (viaHandler) continue;
      for (const listener of [...(this.listeners.get(sub.agentSlug) ?? [])]) await listener(record);
    }
    return last ?? { ...base, eventId: 'not-stored', receivedByChannelKey: '' };
  }

  /** A person writes in the group. Returns the stored record (message id). */
  async say(conversationId: string, userId: string, text: string, opts: SayOptions = {}): Promise<ConversationMessageRecord> {
    const messageId = this.nextId('msg');
    this.revisions.set(messageId, 0);
    const record = await this.emit(
      conversationId,
      userId,
      {
        kind: 'created',
        messageId,
        revision: 0,
        text,
        ...(opts.replyTo ? { replyToMessageId: opts.replyTo } : {}),
        ...(opts.addressed ? { addressedToBot: true } : {}),
        ...(opts.quoted ? { quoted: true } : {}),
        ...(opts.forwarded ? { forwarded: true } : {}),
      },
      opts.at,
    );
    this.originals.set(messageId, record);
    return record;
  }

  async edit(conversationId: string, userId: string, messageId: string, text: string): Promise<ConversationMessageRecord> {
    const revision = (this.revisions.get(messageId) ?? 0) + 1;
    this.revisions.set(messageId, revision);
    return this.emit(conversationId, userId, { kind: 'edited', messageId, revision, text });
  }

  async remove(conversationId: string, userId: string, messageId: string): Promise<ConversationMessageRecord> {
    const revision = (this.revisions.get(messageId) ?? 0) + 1;
    this.revisions.set(messageId, revision);
    return this.emit(conversationId, userId, { kind: 'deleted', messageId, revision });
  }

  async react(conversationId: string, userId: string, messageId: string, name = 'like', removed = false): Promise<ConversationMessageRecord> {
    return this.emit(conversationId, userId, { kind: 'reaction', messageId, revision: 0, reaction: { name, removed } });
  }

  /** The cards the facilitator posted in a conversation, oldest first. */
  cards(conversationId: string): Array<Post & { card: QuestionCard; cardMessageId: string }> {
    return this.posts.filter((p): p is Post & { card: QuestionCard; cardMessageId: string } => p.conversationId === conversationId && p.card !== undefined && p.cardMessageId !== undefined);
  }

  /** A person submits a question card. What the client sends back (card id,
   *  proposal, answers) can be overridden to forge a submission. */
  async submitCard(
    conversationId: string,
    userId: string,
    post: { card: QuestionCard; cardMessageId: string },
    answers: readonly CardAnswerValue[],
    forged: { cardId?: string; proposalId?: string; proposalVersion?: number; verified?: boolean } = {},
  ): Promise<ConversationMessageRecord> {
    return this.emit(conversationId, userId, {
      kind: 'card_answer',
      messageId: post.cardMessageId,
      revision: 0,
      cardAnswer: {
        cardId: forged.cardId ?? post.card.cardId,
        value: { answers },
        answers,
        ...((forged.proposalId ?? post.card.proposalId) !== undefined ? { proposalId: forged.proposalId ?? post.card.proposalId } : {}),
        ...((forged.proposalVersion ?? post.card.proposalVersion) !== undefined ? { proposalVersion: forged.proposalVersion ?? post.card.proposalVersion } : {}),
        answererVerified: forged.verified ?? true,
      },
    } as never);
  }

  async answerCard(conversationId: string, userId: string, cardId: string, value: unknown, messageId = cardId): Promise<ConversationMessageRecord> {
    return this.emit(conversationId, userId, { kind: 'card_answer', messageId, revision: 0, cardAnswer: { cardId, value } });
  }

  join(conversationId: string, user: FakeUser, opts: { missed?: boolean } = {}): void {
    this.members.set(conversationId, [...(this.members.get(conversationId) ?? []), user]);
    // `missed`: the channel's membership event never reached the kernel.
    if (opts.missed !== true) this.emitMembership({ kind: 'members_added', conversationId, members: [{ kind: this.userKind, ...user }] });
  }

  /** Another bot is added to the conversation (a second facilitator, an assistant). */
  joinBot(conversationId: string, id: string, displayName: string): void {
    this.emitMembership({ kind: 'members_added', conversationId, members: [{ kind: this.botKind, id, displayName, isBot: true }] });
  }

  leave(conversationId: string, userId: string): void {
    const user = this.user(conversationId, userId);
    this.members.set(conversationId, (this.members.get(conversationId) ?? []).filter((m) => m.id !== userId));
    this.emitMembership({ kind: 'members_removed', conversationId, members: [{ kind: this.userKind, ...user }] });
  }

  private emitMembership(partial: Pick<ConversationMembershipEvent, 'kind' | 'conversationId' | 'members'>): void {
    const event: ConversationMembershipEvent = { channelId: `${this.channelType}-1`, channelType: this.channelType, occurredAt: this.clock.now().toISOString(), ...partial };
    for (const listener of [...this.membershipListeners]) listener(event);
  }

  async changeCapabilities(agentSlug: string, snapshot: SessionCapabilitySnapshot): Promise<void> {
    this.snapshots.set(`${snapshot.conversationId}|${snapshot.sessionRef ?? ''}`, snapshot);
    for (const listener of [...(this.capabilityListeners.get(agentSlug) ?? [])]) await listener(snapshot);
  }

  /** What a conversation (or a meeting in it) offers. */
  capabilities(conversationId: string, inputs: SessionCapabilitySnapshot['inputs'], outputs: SessionCapabilitySnapshot['outputs'], opts: { sessionRef?: string; modality?: SessionCapabilitySnapshot['modality'] } = {}): SessionCapabilitySnapshot {
    const snapshot: SessionCapabilitySnapshot = {
      channelType: this.channelType,
      conversationId,
      ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : {}),
      modality: opts.modality ?? 'chat',
      inputs,
      outputs,
      capturedAt: this.clock.now().toISOString(),
    };
    this.snapshots.set(`${conversationId}|${opts.sessionRef ?? ''}`, snapshot);
    return snapshot;
  }

  async sessionEvent(agentSlug: string, conversationId: string, sessionRef: string, kind: SessionEventRecord['kind']): Promise<void> {
    const event: SessionEventRecord = { channelType: this.channelType, conversationId, sessionRef, kind, occurredAt: this.clock.now().toISOString() };
    for (const listener of [...(this.sessionListeners.get(agentSlug) ?? [])]) await listener(event);
  }

  /** The tool call context the kernel states for a turn in a conversation. */
  context(agentSlug: string, conversationId: string, callerId: string, inboundEventId?: string) {
    const name = this.statesCallerName ? this.members.get(conversationId)?.find((m) => m.id === callerId)?.displayName : undefined;
    return {
      agentSlug,
      channelType: this.channelType,
      conversationId,
      callerPrincipalId: `user:${callerId.toLowerCase()}`,
      callerUserRef: { kind: this.userKind, id: callerId, ...(name ? { displayName: name } : {}) },
      ...(inboundEventId ? { inboundEventId } : {}),
    };
  }

  groupPosts(conversationId: string, as?: string): Post[] {
    return this.posts.filter((p) => p.conversationId === conversationId && (as === undefined || p.as === as));
  }

  // ── execution scopes, reservations, kill switch (kernel #2090) ───────────

  /** Every scope the engine opened, open and ended. */
  readonly scopes: FakeScope[] = [];
  /** Who holds (or held) a conversation's reservation. */
  readonly reservations: FakeReservation[] = [];
  /** Every action the kernel authorized, in order. */
  readonly authorizations: FakeAuthorization[] = [];
  /** An operator's stop: the whole instance, agents, or single processes. */
  readonly killSwitch = { instance: false, agents: new Set<string>(), processes: new Set<string>() };
  /** Conversations an agent discussion holds. */
  readonly discussions = new Set<string>();
  /** How long a `configuring` scope may last. */
  configuringMaxMs = 72 * 3_600_000;
  /** Model calls a turn makes (main model and one helper). */
  turnModelCalls = 2;
  /** Every refusal the execution authorization gave, in order. */
  readonly refusals: Array<{ code: ExecutionRefusalCode; message: string }> = [];

  private refuse(code: ExecutionRefusalCode, message: string): ExecutionRefusal {
    this.refusals.push({ code, message });
    return { outcome: 'refused', code, message };
  }

  openScopesOf(processId: string): FakeScope[] {
    return this.scopes.filter((s) => s.processId === processId && s.state === 'open');
  }

  scopeOf(processId: string, kind: ExecutionScopeKind, eventId = ''): FakeScope | undefined {
    return this.scopes.find((s) => s.processId === processId && s.kind === kind && s.eventId === eventId);
  }

  private holds(processId: string, conversationId: string): boolean {
    return this.reservations.some((r) => r.processId === processId && r.conversationId === conversationId && r.releasedAt === undefined);
  }

  private sessionReservation(processId: string, conversationId: string): FakeReservation | undefined {
    return this.reservations.filter((r) => r.processId === processId && r.conversationId === conversationId && r.role === 'session').at(-1);
  }

  private held(processId: string, conversationId: string): boolean {
    return this.reservations.some((r) => r.processId === processId && r.conversationId === conversationId);
  }

  private killed(scope: FakeScope): string | undefined {
    if (this.killSwitch.instance) return 'instance';
    if (this.killSwitch.agents.has(scope.agentSlug)) return 'agent';
    return this.killSwitch.processes.has(scope.processId) ? 'process' : undefined;
  }

  /** What follows from a released reservation or an ended scope, as the hub
   *  does it: `all` turns into `addressed`, and a process without an open
   *  scope loses its subscriptions. */
  private accessChanged(): void {
    for (const sub of this.processSubscriptions) {
      if (sub.ended) continue;
      const session = this.sessionReservation(sub.processId, sub.conversationId);
      if (this.openScopesOf(sub.processId).length === 0) sub.ended = true;
      // A session conversation is read as its state allows (#2076).
      else if (session?.releasedAt !== undefined) sub.ended = true;
      else if (session?.sessionState === 'scheduled' && sub.mode === 'all') sub.mode = 'addressed';
      else if (sub.mode === 'all' && !this.holds(sub.processId, sub.conversationId)) sub.mode = 'addressed';
    }
    this.refreshSubscriptions();
  }

  /** The kernel ends an agent's service (disabled, grant revoked): its scopes
   *  end, and with them its subscriptions and grants. */
  endService(agentSlug: string, reason = 'agent_disabled'): void {
    for (const scope of this.scopes) {
      if (scope.agentSlug !== agentSlug || scope.state !== 'open') continue;
      scope.state = 'ended';
      scope.endedAt = this.clock.now().toISOString();
      scope.endReason = reason;
    }
    for (const r of this.reservations) if (r.agentSlug === agentSlug && r.releasedAt === undefined) r.releasedAt = this.clock.now().toISOString();
    this.accessChanged();
  }

  /** A kernel that never heard of a process: what a facilitation from before
   *  execution scopes looks like to it. It reads through a subscription of
   *  the first major instead. */
  forget(processId: string, agentSlug: string, conversationId: string): void {
    const drop = <T extends { processId: string }>(list: T[]): void => {
      for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.processId === processId) list.splice(i, 1);
    };
    drop(this.scopes);
    drop(this.reservations);
    drop(this.processSubscriptions);
    this.refreshSubscriptions();
    this.legacySubscriptions.add(scopeKey({ agentSlug, channelType: this.channelType, conversationId }));
  }

  /** The kernel takes a conversation's reservation away (an operator freed
   *  the conversation). Whoever read everything there reads only what is
   *  addressed to it from now on. Nothing tells the engine. */
  takeReservation(conversationId: string): void {
    for (const r of this.reservations) if (r.conversationId === conversationId && r.releasedAt === undefined) r.releasedAt = this.clock.now().toISOString();
    this.accessChanged();
  }

  private authorizeAction(request: AuthorizeActionRequest): ExecutionAuthorization | ExecutionRefusal {
    const scope = this.scopes.find((s) => s.id === request.scopeId);
    if (!scope) return this.refuse('unknown_scope', 'no such scope');
    if (!EXECUTION_SCOPE_PHASES[scope.kind].includes(request.phase)) return this.refuse('phase_mismatch', `phase '${request.phase}' does not fit a '${scope.kind}' scope`);
    if (this.disabled.has(scope.agentSlug)) return this.refuse('not_permitted', `agent '${scope.agentSlug}' is disabled`);
    if (scope.deadlineWait && !['consent', 'status', 'stop'].includes(request.purpose)) return this.refuse('purpose_not_allowed', 'past its deadline this scope only allows consent answers, status and stop');
    const needsTarget = ['post', 'direct_message', 'card_update', 'delivery'].includes(request.action);
    if (request.target) {
      const wanted = request.target;
      const listed = scope.targets.find((t) =>
        t.kind === wanted.kind && t.channelType === wanted.channelType && (t.kind === 'conversation' ? t.conversationId === (wanted as typeof t).conversationId : t.principalId.toLowerCase() === (wanted as typeof t).principalId.toLowerCase()),
      );
      if (!listed) return this.refuse('target_not_allowed', 'this scope does not list that target');
      if (listed.kind === 'person' && listed.restriction === 'status_only' && request.purpose !== 'status') return this.refuse('target_not_allowed', 'this person may only receive the status');
    } else if (needsTarget) {
      return this.refuse('invalid_request', `a ${request.action} needs a target`);
    }
    const modelCalls = request.modelCalls ?? 0;
    if (request.action === 'model_turn' ? modelCalls < 1 : modelCalls !== 0) return this.refuse('invalid_request', 'a model_turn reserves at least one model call; no other action reserves any');
    if (scope.state !== 'open') return this.refuse('scope_ended', 'this scope has ended');
    if (new Date(scope.deadline).getTime() <= this.clock.now().getTime()) return this.refuse('deadline_passed', `this scope's deadline passed at ${scope.deadline}`);
    const killed = this.killed(scope);
    if (killed) return this.refuse('kill_switch', `stopped by an operator (${killed} kill switch)`);
    if (scope.used.actions + 1 > scope.budget.actions || scope.used.modelCalls + modelCalls > scope.budget.modelCalls) return this.refuse('budget_exhausted', "this scope's budget is used up");
    scope.used = { actions: scope.used.actions + 1, modelCalls: scope.used.modelCalls + modelCalls };
    const authorizationId = this.nextId('auth');
    this.authorizations.push({ id: authorizationId, scopeId: scope.id, processId: scope.processId, kind: scope.kind, action: request.action, purpose: request.purpose, phase: request.phase, modelCalls, ...(request.target ? { target: request.target } : {}), ...(request.emission ? { emission: request.emission } : {}) });
    return { outcome: 'authorized', authorizationId, scopeId: scope.id, remaining: { actions: scope.budget.actions - scope.used.actions, modelCalls: scope.budget.modelCalls - scope.used.modelCalls } };
  }

  /** Agents an operator disabled. */
  readonly disabled = new Set<string>();

  private readonly executionService: ExecutionAuthorizationService = {
    openScope: async (request: OpenExecutionScopeRequest) => {
      if (this.disabled.has(request.agentSlug)) return this.refuse('not_permitted', `agent '${request.agentSlug}' is disabled`);
      const eventId = request.kind === 'closing' || request.kind === 'scheduling' ? (request.eventId ?? '') : '';
      if ((request.kind === 'closing' || request.kind === 'scheduling') && eventId === '') return this.refuse('invalid_request', `a '${request.kind}' scope needs an eventId`);
      const existing = this.scopes.filter((s) => s.processId === request.processId);
      if (existing.some((s) => s.kind === request.kind && s.eventId === eventId)) return this.refuse('scope_exists', 'this scope exists');
      const had = (kind: ExecutionScopeKind): boolean => existing.some((s) => s.kind === kind);
      const order =
        request.kind === 'configuring'
          ? existing.length > 0 ? "'configuring' is the first scope of a process" : undefined
          : request.kind === 'active'
            ? existing.some((s) => s.kind === 'configuring' && s.state === 'open') ? undefined : "'active' opens out of an open 'configuring' scope (the handshake)"
            : request.kind === 'closing'
              ? had('configuring') ? undefined : "a 'closing' scope needs a process that was started"
              : had('active') ? undefined : `'${request.kind}' needs a process that was active`;
      if (order) return this.refuse('scope_order', order);
      const now = this.clock.now().getTime();
      const absoluteLimit = now + (request.kind === 'configuring' ? this.configuringMaxMs : request.kind === 'closing' ? 30 * 86_400_000 : 365 * 86_400_000);
      let deadline = absoluteLimit;
      if (request.deadline === undefined) {
        if (request.kind !== 'configuring') return this.refuse('invalid_request', `a '${request.kind}' scope needs a deadline`);
      } else {
        deadline = Date.parse(request.deadline);
        if (!Number.isFinite(deadline)) return this.refuse('invalid_request', 'deadline is not a time');
        if (deadline <= now) return this.refuse('deadline_passed', 'the deadline is not in the future');
        if (deadline > absoluteLimit) return this.refuse('limit_exceeded', `a '${request.kind}' scope ends at the latest ${new Date(absoluteLimit).toISOString()}`);
      }
      const targets: ExecutionTarget[] = [...(request.targets ?? [])];
      if (request.kind === 'configuring') {
        if (!request.home) return this.refuse('invalid_request', "a 'configuring' scope needs the home conversation");
        const holder = this.reservations.find((r) => r.conversationId === request.home?.conversationId && r.releasedAt === undefined);
        if (this.discussions.has(request.home.conversationId)) return this.refuse('conversation_busy', 'an agent discussion holds this conversation');
        if (holder && holder.processId !== request.processId) return this.refuse('conversation_busy', 'another process holds this conversation');
        if (!holder) this.reservations.push({ agentSlug: request.agentSlug, processId: request.processId, channelType: request.home.channelType, conversationId: request.home.conversationId, role: 'home', reservedAt: this.clock.now().toISOString() });
        targets.unshift({ kind: 'conversation', ...request.home });
      }
      if (request.kind === 'active') {
        for (const s of existing) {
          if (s.kind !== 'configuring' || s.state !== 'open') continue;
          s.state = 'ended';
          s.endedAt = this.clock.now().toISOString();
          s.endReason = 'active opened';
        }
      }
      const scope: FakeScope = {
        id: this.nextId('scope'),
        agentSlug: request.agentSlug,
        processId: request.processId,
        kind: request.kind,
        eventId,
        state: 'open',
        deadline: new Date(deadline).toISOString(),
        absoluteLimit: new Date(absoluteLimit).toISOString(),
        deadlineWait: false,
        budget: { ...request.budget },
        used: { actions: 0, modelCalls: 0 },
        targets,
        openedAt: this.clock.now().toISOString(),
      };
      this.scopes.push(scope);
      return { outcome: 'opened', scope: { ...scope } };
    },
    authorize: async (request) => this.authorizeAction(request),
    settle: async (authorizationId, used) => {
      const authorization = this.authorizations.find((a) => a.id === authorizationId);
      const scope = authorization ? this.scopes.find((s) => s.id === authorization.scopeId) : undefined;
      if (!authorization || !scope || authorization.settled) return;
      authorization.settled = true;
      scope.used = { ...scope.used, modelCalls: scope.used.modelCalls - Math.max(0, authorization.modelCalls - used.modelCalls) };
    },
    setPeople: async (scopeId, people) => {
      const scope = this.scopes.find((s) => s.id === scopeId);
      if (!scope) return this.refuse('unknown_scope', 'no such scope');
      if (scope.state !== 'open') return this.refuse('scope_ended', 'this scope has ended');
      scope.targets = [...scope.targets.filter((t) => t.kind === 'conversation'), ...people];
      return { outcome: 'updated', scope: { ...scope } };
    },
    extendScope: async (scopeId, change) => {
      const scope = this.scopes.find((s) => s.id === scopeId);
      if (!scope) return this.refuse('unknown_scope', 'no such scope');
      if (scope.state !== 'open') return this.refuse('scope_ended', 'this scope has ended');
      const now = this.clock.now().getTime();
      const deadline = Date.parse(change.deadline);
      if (!Number.isFinite(deadline) || deadline <= now) return this.refuse('invalid_request', 'the new deadline is not a time in the future');
      const passed = Date.parse(scope.deadline) <= now;
      const wait = change.deadlineWait === true;
      if (wait && scope.kind !== 'active') return this.refuse('invalid_request', "only an 'active' scope has a deadline wait");
      if ((passed || scope.deadlineWait) && !wait) return this.refuse('deadline_passed', 'the deadline has passed; only a deadline wait can extend this scope');
      if (deadline > Date.parse(scope.absoluteLimit)) return this.refuse('limit_exceeded', `this scope ends at the latest ${scope.absoluteLimit}`);
      scope.deadline = new Date(deadline).toISOString();
      scope.deadlineWait = wait;
      return { outcome: 'extended', scope: { ...scope } };
    },
    endScope: async (scopeId, reason) => {
      const scope = this.scopes.find((s) => s.id === scopeId);
      if (!scope || scope.state !== 'open') return;
      scope.state = 'ended';
      scope.endedAt = this.clock.now().toISOString();
      scope.endReason = reason;
      this.accessChanged();
    },
    listScopes: async (processId) => this.scopes.filter((s) => s.processId === processId).map((s) => ({ ...s })),
    reserveConversation: async (request) => {
      if (this.openScopesOf(request.processId).length === 0) return this.refuse('scope_order', 'this process has no open scope');
      const holder = this.reservations.find((r) => r.conversationId === request.conversationId && r.releasedAt === undefined);
      if (holder && holder.processId === request.processId) return { outcome: 'reserved', reservation: holder };
      // A process takes back its own home conversation without a link.
      if (!request.linkRequestId && this.reservations.some((r) => r.processId === request.processId && r.conversationId === request.conversationId && r.role === 'home')) {
        if (holder || this.discussions.has(request.conversationId)) return this.refuse('conversation_busy', 'another process holds this conversation');
        const back: FakeReservation = { agentSlug: request.agentSlug, processId: request.processId, channelType: request.channelType, conversationId: request.conversationId, role: 'home', reservedAt: this.clock.now().toISOString() };
        this.reservations.push(back);
        return { outcome: 'reserved', reservation: back };
      }
      // #2089: a session conversation is linked on a link request made inside it.
      const link = request.linkRequestId ? this.linkRequests.get(request.linkRequestId) : undefined;
      if (!link || link.used || link.conversationId !== request.conversationId || !link.processIds.includes(request.processId) || Date.parse(link.expiresAt) <= this.clock.now().getTime()) {
        return this.refuse('link_not_authorized', 'a session conversation is linked only on a link request made inside it');
      }
      if (this.discussions.has(request.conversationId)) return this.refuse('conversation_busy', 'an agent discussion holds this conversation');
      if (holder) return this.refuse('conversation_busy', 'another process holds this conversation');
      link.used = true;
      const reservation: FakeReservation = { agentSlug: request.agentSlug, processId: request.processId, channelType: request.channelType, conversationId: request.conversationId, role: 'session', reservedAt: this.clock.now().toISOString(), sessionState: 'scheduled', ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
      this.reservations.push(reservation);
      for (const scope of this.openScopesOf(request.processId)) {
        if ((scope.kind === 'configuring' || scope.kind === 'active') && !scope.targets.some((t) => t.kind === 'conversation' && t.conversationId === request.conversationId)) {
          scope.targets = [...scope.targets, { kind: 'conversation', channelType: request.channelType, conversationId: request.conversationId }];
        }
      }
      this.accessChanged();
      return { outcome: 'reserved', reservation };
    },
    setSessionState: async (request) => {
      const reservation = this.sessionReservation(request.processId, request.conversationId);
      if (!reservation) return this.refuse('unknown_scope', 'this process never linked that conversation');
      const from = reservation.sessionState ?? 'scheduled';
      if (from === request.state) return { outcome: 'updated', reservation };
      if (reservation.releasedAt !== undefined || !SESSION_CONVERSATION_TRANSITIONS[from].includes(request.state)) return this.refuse('session_state', `a session does not go from '${from}' to '${request.state}'`);
      if (request.state === 'live') {
        const missing = this.notReady.get(`${reservation.agentSlug}|${request.conversationId}`) ?? [];
        if (missing.length > 0) return this.refuse('not_ready', missing.map((m) => `${m.code}: ${m.message}`).join('; '));
      }
      reservation.sessionState = request.state;
      if (request.state === 'closed' || request.state === 'cancelled') reservation.releasedAt = this.clock.now().toISOString();
      this.accessChanged();
      return { outcome: 'updated', reservation };
    },
    releaseConversation: async (request) => {
      for (const r of this.reservations) {
        if (r.processId === request.processId && r.conversationId === request.conversationId && r.releasedAt === undefined) r.releasedAt = this.clock.now().toISOString();
      }
      this.accessChanged();
    },
    listReservations: async (processId) => this.reservations.filter((r) => r.processId === processId),
  };

  // ── kernel-issued grants (kernel #2078) ──────────────────────────────────

  readonly grants: FakeGrant[] = [];

  private grantLive(grant: FakeGrant): boolean {
    const scope = this.scopes.find((s) => s.id === grant.scopeId);
    const now = this.clock.now().getTime();
    return grant.revokedAt === undefined && Date.parse(grant.expiresAt) > now && scope?.state === 'open' && Date.parse(scope.deadline) > now;
  }

  private readonly grantsService: ExecutionGrantsService = {
    issueGrant: async (request) => {
      const scope = this.scopes.find((s) => s.id === request.scopeId);
      if (!scope) return this.refuse('unknown_scope', 'no such scope');
      if (scope.state !== 'open') return this.refuse('scope_ended', 'this scope has ended');
      if (EXECUTION_GRANT_RULES[request.kind].scope !== scope.kind) return this.refuse('invalid_request', `a ${request.kind} grant is issued under a '${EXECUTION_GRANT_RULES[request.kind].scope}' scope`);
      if (Date.parse(scope.deadline) <= this.clock.now().getTime()) return this.refuse('deadline_passed', "this scope's deadline has passed");
      const recipients = [...new Set(request.recipients.map((r) => r.trim().toLowerCase()))];
      const subject = request.subject ?? '';
      const live = this.grants.find((g) => g.scopeId === scope.id && g.kind === request.kind && g.subject === subject && this.grantLive(g));
      if (live) {
        live.recipients = recipients;
        return { outcome: 'issued', grant: { ...live, live: true } };
      }
      const limit = request.kind === 'protocol_dispatch' ? Math.min(Date.parse(scope.deadline), this.clock.now().getTime() + 7 * 86_400_000) : Date.parse(scope.deadline);
      const grant: FakeGrant = { id: this.nextId('grant'), scopeId: scope.id, processId: scope.processId, kind: request.kind, subject, recipients, issuedAt: this.clock.now().toISOString(), expiresAt: new Date(limit).toISOString(), uses: [] };
      this.grants.push(grant);
      return { outcome: 'issued', grant: { ...grant, live: true } };
    },
    revokeGrant: async (grantId, reason) => {
      const grant = this.grants.find((g) => g.id === grantId);
      if (!grant || grant.revokedAt !== undefined) return;
      grant.revokedAt = this.clock.now().toISOString();
      grant.revokeReason = reason;
    },
    listGrants: async (processId) => this.grants.filter((g) => g.processId === processId).map((g) => ({ ...g, live: this.grantLive(g) })),
  };

  /** `grantVerification`: what the integration asks before every operation. */
  verifyGrant(request: { grantId: string; operation: GrantOperation; recipients: readonly string[] }): { allowed: true } | { allowed: false; code: string; message: string } {
    const grant = this.grants.find((g) => g.id === request.grantId);
    const answer = ((): { allowed: true } | { allowed: false; code: string; message: string } => {
      if (!grant) return { allowed: false, code: 'unknown_grant', message: 'no such grant' };
      if (grant.revokedAt !== undefined) return { allowed: false, code: 'revoked', message: 'the grant was revoked' };
      const scope = this.scopes.find((s) => s.id === grant.scopeId);
      if (!scope || scope.state !== 'open') return { allowed: false, code: 'scope_ended', message: 'the scope of the grant has ended' };
      if (!this.grantLive(grant)) return { allowed: false, code: 'expired', message: 'the grant has expired' };
      if (this.killed(scope)) return { allowed: false, code: 'kill_switch', message: 'stopped by an operator' };
      if (!EXECUTION_GRANT_RULES[grant.kind].operations.includes(request.operation)) return { allowed: false, code: 'operation_not_covered', message: `a ${grant.kind} grant does not cover ${request.operation}` };
      const outside = request.recipients.map((r) => r.toLowerCase()).filter((r) => !grant.recipients.includes(r));
      return outside.length > 0 ? { allowed: false, code: 'recipient_not_covered', message: `not covered: ${outside.join(', ')}` } : { allowed: true };
    })();
    grant?.uses.push({ operation: request.operation, recipients: [...request.recipients], askedBy: 'followup', allowed: answer.allowed, usedAt: this.clock.now().toISOString(), ...(answer.allowed ? {} : { refusal: answer.code as GrantRefusalCode }) });
    return answer;
  }

  // ── conversationMessages@2: subscriptions bound to a process ─────────────

  /** One subscription per process and conversation. */
  readonly processSubscriptions: FakeProcessSubscription[] = [];
  /** Which process a posted message or card belongs to. */
  private readonly bound = new Map<string, string>();
  private readonly privateHandlers = new Map<string, Set<(request: PrivateMessageRequest) => Promise<PrivateMessageReply>>>();
  /** Subscriptions of the first major (a facilitation from before 1.4.0). */
  readonly legacySubscriptions = new Set<string>();

  /** `subscriptions` lists `agent|channel|conversation` while some process of
   *  the agent receives messages there. */
  private refreshSubscriptions(): void {
    this.subscriptions.clear();
    for (const sub of this.processSubscriptions) {
      if (!sub.ended && sub.mode !== 'none') this.subscriptions.add(scopeKey(sub));
    }
  }

  private subscriptionOf(scope: ProcessMessageScope): FakeProcessSubscription | undefined {
    return this.processSubscriptions.find((s) => s.agentSlug === scope.agentSlug && s.conversationId === scope.conversationId && s.processId === scope.processId);
  }

  /** Does a mention start the facilitator's ordinary turn in this
   *  conversation? As the kernel: not where a process of the agent reads
   *  every message (the engine answers there); otherwise yes, also where a
   *  process hears what is addressed to it. */
  ordinaryTurnRuns(agentSlug: string, conversationId: string): boolean {
    return !this.processSubscriptions.some((s) => s.agentSlug === agentSlug && s.conversationId === conversationId && !s.ended && s.mode === 'all');
  }

  /** The mode a process reads a conversation in; undefined: not (any more). */
  modeOf(processId: string, conversationId: string): ConversationMessageMode | undefined {
    const sub = this.processSubscriptions.find((s) => s.processId === processId && s.conversationId === conversationId);
    return sub && !sub.ended ? sub.mode : undefined;
  }

  private readonly messagesService: ProcessConversationMessagesService = {
    subscribe: async (scope, options) => {
      if (!this.hasIdentity(scope.agentSlug)) return { outcome: 'refused', code: 'no_identity', message: `agent '${scope.agentSlug}' has no identity on ${scope.channelType}` };
      const existing = this.subscriptionOf(scope);
      if (existing?.ended) return { outcome: 'refused', code: 'ended', message: "this process's subscription for the conversation has ended" };
      const refusal = this.subscribeRefusals.get(scope.agentSlug);
      // A new subscription, and (kernel K6.4) one that is turned up to every
      // message: the kernel asks the channel's readiness for both, and the
      // refused subscription keeps its mode.
      if (refusal && (!existing || (options.mode === 'all' && existing.mode !== 'all'))) return { outcome: 'refused', ...refusal };
      if (!this.members.has(scope.conversationId)) return { outcome: 'refused', code: 'not_present', message: 'the bot was never observed in this conversation' };
      if (this.openScopesOf(scope.processId).length === 0) return { outcome: 'refused', code: 'no_scope', message: 'this process has no open execution scope' };
      const session = this.sessionReservation(scope.processId, scope.conversationId);
      if (session && (session.releasedAt !== undefined || (session.sessionState === 'scheduled' && options.mode === 'all'))) return { outcome: 'refused', code: 'session_state', message: 'the session state does not allow that' };
      if (options.mode === 'all' && !this.holds(scope.processId, scope.conversationId)) return { outcome: 'refused', code: 'not_reserved', message: 'every message of a conversation is read only by the process that holds its reservation' };
      if (options.mode === 'addressed' && !this.held(scope.processId, scope.conversationId)) return { outcome: 'refused', code: 'not_reserved', message: 'this process never held the reservation of this conversation' };
      if (existing) existing.mode = options.mode;
      else this.processSubscriptions.push({ ...scope, mode: options.mode, ended: false });
      this.refreshSubscriptions();
      return { outcome: 'subscribed', mode: options.mode };
    },
    modeOf: async (scope) => {
      const sub = this.subscriptionOf(scope);
      return sub && !sub.ended ? sub.mode : undefined;
    },
    onMessage: (agentSlug, handler) => {
      const set = this.listeners.get(agentSlug) ?? new Set();
      set.add(handler as (record: ConversationMessageRecord) => void | Promise<void>);
      this.listeners.set(agentSlug, set);
      return () => set.delete(handler as (record: ConversationMessageRecord) => void | Promise<void>);
    },
    getEvent: async (scope, messageId, revision) => {
      const matching = this.forScope(scope).filter((e) => e.messageId === messageId && (e.kind === 'created' || e.kind === 'edited' || e.kind === 'deleted'));
      if (revision !== undefined) return matching.find((e) => e.revision === revision);
      return matching.sort((a, b) => b.revision - a.revision)[0];
    },
    getEventById: async (scope, eventId) => this.forScope(scope).find((e) => e.eventId === eventId),
    onLinkRequest: (agentSlug, handler) => {
      const set = this.linkHandlers.get(agentSlug) ?? new Set();
      set.add(handler);
      this.linkHandlers.set(agentSlug, set);
      return () => set.delete(handler);
    },
    listSince: async (scope, opts) => {
      const all = this.forScope(scope);
      const start = opts?.after ? all.findIndex((e) => e.eventId === opts.after) + 1 : 0;
      const limit = opts?.limit ?? 100;
      const events = all.slice(start, start + limit);
      const last = events[events.length - 1];
      return { events, ...(last && start + limit < all.length ? { nextCursor: last.eventId } : {}) };
    },
    bindMessage: async (scope, ref) => {
      if (!this.subscriptionOf(scope)) return false;
      for (const id of [ref.messageId, ref.cardId]) if (id !== undefined) this.bound.set(id, scope.processId);
      return true;
    },
    onPrivateMessage: (agentSlug, handler) => {
      const set = this.privateHandlers.get(agentSlug) ?? new Set();
      set.add(handler);
      this.privateHandlers.set(agentSlug, set);
      return () => set.delete(handler);
    },
    onAddressedMessage: (agentSlug, handler) => {
      const set = this.addressedHandlers.get(agentSlug) ?? new Set();
      set.add(handler);
      this.addressedHandlers.set(agentSlug, set);
      return () => set.delete(handler);
    },
  };

  /** What a process may read: only what was stored for it. Reads end with
   *  the subscription. */
  private forScope(scope: ProcessMessageScope): ProcessConversationMessageRecord[] {
    const sub = this.subscriptionOf(scope);
    if (!sub || sub.ended) return [];
    const own = (this.events as ProcessConversationMessageRecord[]).filter((e) => e.processId === scope.processId && e.conversationId === scope.conversationId);
    // #2089: an older revision says it was superseded.
    const family = (e: ConversationMessageRecord): string | undefined => (e.kind === 'transcript_segment' ? `t:${e.messageId}` : e.kind === 'created' || e.kind === 'edited' || e.kind === 'deleted' ? `m:${e.messageId}` : undefined);
    const latest = new Map<string, number>();
    for (const e of own) {
      const key = family(e);
      if (key) latest.set(key, Math.max(latest.get(key) ?? -1, e.revision));
    }
    return own.map((e) => {
      const key = family(e);
      const newest = key ? latest.get(key) : undefined;
      return newest !== undefined && newest > e.revision ? { ...e, superseded: true, latestRevision: newest } : e;
    });
  }

  // ── link requests (#2089) and transcript segments ────────────────────────

  private readonly linkHandlers = new Map<string, Set<(request: LinkRequest) => Promise<LinkRequestReply>>>();
  readonly linkRequests = new Map<string, { conversationId: string; processIds: string[]; expiresAt: string; used: boolean }>();
  /** Answers the facilitator's link handling gave as the turn's answer. */
  readonly linkAnswers: Array<{ conversationId: string; userId: string; answer: string | undefined; handled: boolean }> = [];

  /**
   * A person mentions the facilitator in a conversation none of its
   * processes reads. As the kernel: a typed link request to the engine,
   * nothing stored, no read access.
   */
  async linkRequest(conversationId: string, userId: string, text: string, agentSlug = 'mira'): Promise<{ handled: boolean; answer?: string; linkRequestId?: string }> {
    const reads = this.processSubscriptions.some((s) => s.agentSlug === agentSlug && s.conversationId === conversationId && !s.ended && s.mode !== 'none');
    const processIds = [...new Set(this.scopes.filter((s) => s.agentSlug === agentSlug && s.state === 'open' && (s.kind === 'configuring' || s.kind === 'active')).map((s) => s.processId))];
    if (reads || processIds.length === 0) return { handled: false };
    const linkRequestId = this.nextId('link');
    const expiresAt = new Date(this.clock.now().getTime() + 3_600_000).toISOString();
    this.linkRequests.set(linkRequestId, { conversationId, processIds, expiresAt, used: false });
    const user = this.user(conversationId, userId);
    for (const handler of [...(this.linkHandlers.get(agentSlug) ?? [])]) {
      const reply = await handler({ linkRequestId, agentSlug, channelType: this.channelType, conversationId, principalId: userId, displayName: user.displayName, text, processIds, expiresAt });
      if (reply.handled) {
        this.linkAnswers.push({ conversationId, userId, answer: reply.answer, handled: true });
        return { handled: true, ...(reply.answer !== undefined ? { answer: reply.answer } : {}), linkRequestId };
      }
    }
    this.linkRequests.delete(linkRequestId);
    this.linkAnswers.push({ conversationId, userId, answer: undefined, handled: false });
    return { handled: false };
  }

  private readonly segmentRevisions = new Map<string, number>();

  /** A transcript segment of a live session (#2089). `participant`: the
   *  media channel is bound to `userId`; `shared`: a room microphone. */
  async transcript(conversationId: string, input: { segmentId: string; text: string; source: 'participant' | 'shared'; userId?: string; speakerHint?: string; sessionId?: string }): Promise<ConversationMessageRecord> {
    const revision = (this.segmentRevisions.get(input.segmentId) ?? -1) + 1;
    this.segmentRevisions.set(input.segmentId, revision);
    const author = input.source === 'participant' ? undefined : { kind: 'custom', id: 'media:room-1', displayName: 'Room microphone' };
    return this.emit(conversationId, input.userId ?? 'media:room-1', {
      kind: 'transcript_segment',
      messageId: input.segmentId,
      revision,
      text: input.text,
      transcript: { sessionId: input.sessionId ?? 'session-1', segmentId: input.segmentId, source: input.source, ...(input.speakerHint ? { speakerHint: input.speakerHint } : {}) },
      ...(author ? { author } : {}),
    });
  }

  /** false: a kernel before `onAddressedMessage` (plugin-api 1.73). */
  addressedMessages = true;
  private readonly addressedHandlers = new Map<string, Set<(request: AddressedMessageRequest) => Promise<AddressedMessageReply>>>();
  /** Every question the kernel asked about an addressed message. */
  readonly addressedAsked: AddressedMessageRequest[] = [];

  /**
   * A person mentions the facilitator in a group. As the kernel and the
   * channel together: the message is stored for the processes it goes to,
   * and the facilitator's turn starts unless a process reads every message
   * there. Before the model runs, the kernel asks the engine whether a
   * process that listens for addressed messages takes it.
   *
   * Returns who answers: `engine` (the turn stays silent), `turn` (the
   * ordinary turn runs; the test plays it), or `suppressed` (a process reads
   * everything and answers through the event).
   *
   * `event`: `known` (default) the event is stored and named on the turn;
   * `unnamed` it is stored but the turn does not know its id; `late` the turn
   * arrives first and the event is stored afterwards; `none` the channel
   * states no message id at all.
   */
  async mention(conversationId: string, userId: string, text: string, opts: SayOptions & { agent?: string; event?: 'known' | 'unnamed' | 'late' | 'none' } = {}): Promise<{ answeredBy: 'engine' | 'turn' | 'suppressed'; record: ConversationMessageRecord | undefined }> {
    const agentSlug = opts.agent ?? 'mira';
    const timing = opts.event ?? 'known';
    // `addressed`: the text is as the channel wrote it (a real mention).
    const body = opts.addressed === true || text.toLowerCase().includes(`@${agentSlug}`) ? text : `@${agentSlug} ${text}`;
    let record: ConversationMessageRecord | undefined;
    const store = async (): Promise<void> => {
      record = await this.say(conversationId, userId, body, opts);
    };
    if (timing !== 'late') await store();
    if (!this.ordinaryTurnRuns(agentSlug, conversationId)) {
      if (timing === 'late') await store();
      return { answeredBy: 'suppressed', record };
    }
    const processIds = this.processSubscriptions.filter((s) => s.agentSlug === agentSlug && s.conversationId === conversationId && !s.ended && s.mode === 'addressed').map((s) => s.processId);
    let handled = false;
    if (this.addressedMessages && processIds.length > 0) {
      const stored = record && record.eventId !== 'not-stored' ? record : undefined;
      const request: AddressedMessageRequest = {
        agentSlug,
        channelType: this.channelType,
        conversationId,
        principalId: userId,
        text: body,
        ...(timing !== 'none' && stored ? { messageId: stored.messageId } : timing === 'late' ? { messageId: `msg-${String(this.seq + 1).padStart(5, '0')}` } : {}),
        ...(timing === 'known' && stored ? { eventId: stored.eventId } : {}),
        processIds,
      };
      this.addressedAsked.push(request);
      for (const handler of [...(this.addressedHandlers.get(agentSlug) ?? [])]) {
        const reply = await handler(request);
        if (reply.handled === true) handled = true;
      }
    }
    if (timing === 'late') await store();
    return { answeredBy: handled ? 'engine' : 'turn', record };
  }

  /** A kernel before private status requests (plugin-api 1.68). */
  privateMessages = true;
  /** Private chats: what a person wrote to a facilitator and what they got. */
  readonly privateAnswers: Array<{ agentSlug: string; userId: string; text: string; answer: string | undefined }> = [];

  /**
   * A person writes to the facilitator in a private chat. As the kernel's
   * router: the message reaches the engine only when the person is listed on
   * an open scope of a process of that agent, and the engine's answer is
   * given only when it is authorized as a private message to that person.
   * `undefined`: the facilitator's fixed answer to private requests.
   */
  async privateMessage(agentSlug: string, userId: string, text: string): Promise<string | undefined> {
    const listed = [...new Set(this.scopes.filter((s) => s.agentSlug === agentSlug && s.state === 'open' && s.targets.some((t) => t.kind === 'person' && t.principalId.toLowerCase() === userId.toLowerCase())).map((s) => s.processId))];
    let answer: string | undefined;
    if (listed.length > 0) {
      for (const handler of [...(this.privateHandlers.get(agentSlug) ?? [])]) {
        const reply = await handler({ agentSlug, channelType: this.channelType, principalId: userId, text, processIds: listed });
        if (reply.handled !== true || reply.text.trim() === '' || !listed.includes(reply.authorization.processId)) continue;
        const scope = this.scopes.find((s) => s.id === reply.authorization.scopeId && s.processId === reply.authorization.processId);
        if (!scope) continue;
        const granted = this.authorizeAction({ scopeId: scope.id, phase: reply.authorization.phase, purpose: reply.authorization.purpose, action: 'direct_message', target: { kind: 'person', channelType: this.channelType, principalId: userId }, emission: reply.authorization.emission });
        if (granted.outcome !== 'authorized') continue;
        answer = reply.text.trim();
        break;
      }
    }
    this.privateAnswers.push({ agentSlug, userId, text, answer });
    return answer;
  }

  // ── conversationSend@2: every send is an authorized action ───────────────

  private authorizeSend(agentSlug: string, authorization: SendAuthorization | Omit<SendAuthorization, 'emission' | 'purpose'>, action: ExecutionActionType, target: ExecutionTarget | undefined, fixed: { purpose?: ExecutionPurpose } = {}): { authorizationId: string } | { outcome: 'unreachable'; code: string; message: string; executionCode: ExecutionRefusalCode } {
    const scope = this.scopes.find((s) => s.id === authorization.scopeId && s.processId === authorization.processId);
    if (!scope || scope.agentSlug !== agentSlug) {
      this.refusals.push({ code: 'unknown_scope', message: 'no such scope for this process and agent' });
      return { outcome: 'unreachable', code: 'not_authorized', message: 'no such scope for this process and agent', executionCode: 'unknown_scope' };
    }
    const full = authorization as SendAuthorization;
    const granted = this.authorizeAction({ scopeId: scope.id, phase: authorization.phase, purpose: fixed.purpose ?? full.purpose, action, ...(target ? { target } : {}), ...(full.emission ? { emission: full.emission } : {}) });
    return granted.outcome === 'authorized' ? { authorizationId: granted.authorizationId } : { outcome: 'unreachable', code: 'not_authorized', message: granted.message, executionCode: granted.code };
  }

  /** The channel's part of a post: faults, cards, the message itself. */
  private async post(agentSlug: string, conversationId: string, message: ScopedConversationSendRequest['message'], processId: string): Promise<{ outcome: 'delivered'; messageId: string; cardMessageId?: string } | { outcome: 'unreachable'; code: string; message: string }> {
    if (!this.hasIdentity(agentSlug)) return { outcome: 'unreachable', code: 'no_identity', message: 'no own identity' };
    const fault = this.sendFaults.shift();
    if (fault === 'throw') throw new Error('channel connection reset');
    // A channel call that never answers.
    if (fault === 'hang') return new Promise(() => undefined);
    if (fault && fault !== 'lost') return { outcome: 'unreachable', ...fault };
    const card = (message as { card?: QuestionCard }).card;
    // As the kernel: a card on a channel that declares none (or not that
    // kind) is refused and nothing is posted.
    if (card !== undefined && this.refuseCards > 0) {
      this.refuseCards -= 1;
      return { outcome: 'unreachable', code: 'channel_error', message: 'the card is too large' };
    }
    if (card !== undefined && (!this.cardSupport || card.questions.length > this.cardSupport.maxQuestions || card.questions.some((q) => !this.cardSupport?.kinds.includes(q.kind)))) {
      return { outcome: 'unreachable', code: 'channel_error', message: 'this channel does not render that card' };
    }
    // As Teams 0.38.4: a fixed candidate list needs one candidate where the
    // volunteer button is shown (the card's only question), two otherwise.
    for (const q of card?.questions ?? []) {
      if (q.kind !== 'assignment' || q.candidates === 'conversation_members') continue;
      const volunteerShown = q.allowVolunteer !== false && card?.questions.length === 1;
      if (q.candidates.length > 20) return { outcome: 'unreachable', code: 'channel_error', message: 'invalid question card: at most 20 candidates' };
      if (q.candidates.length < (volunteerShown ? 1 : 2)) {
        return { outcome: 'unreachable', code: 'channel_error', message: `invalid question card: question ${String((card?.questions.indexOf(q) ?? 0) + 1)}: at least ${volunteerShown ? 'one candidate is' : 'two options are'} needed` };
      }
    }
    const messageId = this.nextId('bot');
    const cardMessageId = `${messageId}-card`;
    this.posts.push({
      as: agentSlug,
      conversationId,
      text: message.text,
      mentions: [...(message.mentions ?? [])],
      ...(message.poll !== undefined ? { poll: message.poll } : {}),
      ...(card !== undefined ? { card, cardMessageId } : {}),
      messageId,
      processId,
    });
    // The kernel records which process the message and the card belong to.
    this.bound.set(messageId, processId);
    if (message.poll !== undefined || card !== undefined) this.bound.set(cardMessageId, processId);
    if (card !== undefined) this.bound.set(card.cardId, processId);
    if (fault === 'lost') return { outcome: 'unreachable', code: 'timeout', message: 'no confirmation from the channel' };
    return { outcome: 'delivered', messageId, ...(message.poll !== undefined || card !== undefined ? { cardMessageId } : {}) };
  }

  private readonly sendService: ScopedConversationSendService = {
    capabilities: () => (this.cardSupport ? { asOwnIdentity: true, mentions: true, poll: true, card: this.cardSupport } : { asOwnIdentity: true, mentions: true, poll: true }),
    sendToConversation: async (request): Promise<ScopedSendOutcome> => {
      const granted = this.authorizeSend(request.agentSlug, request.authorization, 'post', { kind: 'conversation', channelType: request.channelType, conversationId: request.conversationId });
      if ('outcome' in granted) return granted;
      const outcome = await this.post(request.agentSlug, request.conversationId, request.message, request.authorization.processId);
      return outcome.outcome === 'delivered' ? { ...outcome, authorizationId: granted.authorizationId } : { ...outcome, authorizationId: granted.authorizationId };
    },
    sendToPerson: async (request): Promise<ScopedSendOutcome> => {
      const principalId = request.principal.startsWith('user:') ? request.principal.slice(5) : '';
      if (!principalId) return { outcome: 'unreachable', code: 'not_permitted', message: `'${request.principal}' is not a user principal ('user:<id>')` };
      const granted = this.authorizeSend(request.agentSlug, request.authorization, 'direct_message', { kind: 'person', channelType: request.channelType, principalId });
      if ('outcome' in granted) return granted;
      if (!this.hasIdentity(request.agentSlug)) return { outcome: 'unreachable', code: 'no_identity', message: 'no own identity', authorizationId: granted.authorizationId };
      const blocked = this.dmBlocked.get(request.principal);
      if (blocked) return { outcome: 'unreachable', code: blocked, message: `cannot reach ${request.principal}: ${blocked}`, authorizationId: granted.authorizationId };
      this.dms.push({ as: request.agentSlug, principal: request.principal, text: request.message.text, processId: request.authorization.processId });
      return { outcome: 'delivered', authorizationId: granted.authorizationId, messageId: this.nextId('dm') };
    },
    updateCard: async (request) => {
      const granted = this.authorizeSend(request.agentSlug, request.authorization, 'card_update', { kind: 'conversation', channelType: request.channelType, conversationId: request.conversationId });
      if ('outcome' in granted) return granted;
      const fault = this.cardUpdateFaults.shift();
      if (fault) return { outcome: 'unreachable', ...fault };
      if (!this.cardSupport?.update) return { outcome: 'unreachable', code: 'channel_error', message: 'this channel cannot update cards' };
      this.cardUpdates.push({ as: request.agentSlug, conversationId: request.conversationId, cardMessageId: request.cardMessageId, update: request.update });
      return { outcome: 'updated' };
    },
    checkReadiness: async (request) => {
      if (this.absent.has('readiness')) return { outcome: 'unreachable', code: 'channel_error', message: 'no channel readiness is wired on this host' };
      const granted = this.authorizeSend(request.agentSlug, request.authorization, 'check', undefined, { purpose: 'readiness_check' });
      if ('outcome' in granted) return granted;
      return { outcome: 'checked', report: this.readinessOf(request), authorizationId: granted.authorizationId };
    },
  };

  private readonly turnService: ScopedAgentTurnService = {
    runTurn: async (request): Promise<ScopedAgentTurnOutcome> => {
      const scope = this.scopes.find((s) => s.id === request.scopeId && s.processId === request.processId);
      if (!scope || scope.agentSlug !== request.agentSlug) return { outcome: 'refused', code: 'not_authorized', message: 'no such scope for this process and agent', executionCode: 'unknown_scope' };
      const granted = this.authorizeAction({ scopeId: scope.id, phase: request.phase, purpose: request.purpose, action: 'model_turn', emission: 'prose', modelCalls: request.budget.modelCalls, ...(request.target ? { target: request.target } : {}) });
      if (granted.outcome !== 'authorized') return { outcome: 'refused', code: 'not_authorized', message: granted.message, executionCode: granted.code };
      this.turns.push(request);
      const answer = await this.onTurn(request);
      const used = Math.min(this.turnModelCalls, request.budget.modelCalls);
      await this.executionService.settle(granted.authorizationId, { modelCalls: used });
      // The reservation is a hard cap: a call it does not cover is not made,
      // and the turn returns no text.
      if (this.turnModelCalls > request.budget.modelCalls) {
        return { outcome: 'refused', code: 'reservation_exceeded', message: 'the turn needed more model calls than it reserved', authorizationId: granted.authorizationId, modelCalls: { reserved: request.budget.modelCalls, used, refused: this.turnModelCalls - request.budget.modelCalls } };
      }
      if (typeof answer !== 'string') return answer as ScopedAgentTurnOutcome;
      return { outcome: 'completed', text: answer, authorizationId: granted.authorizationId, modelCalls: { reserved: request.budget.modelCalls, used } };
    },
    getProfile: async (agentSlug) => ({
      agentSlug,
      kind: 'facilitator',
      archetype: 'facilitator',
      displayName: this.names.get(agentSlug) ?? `${agentSlug.charAt(0).toUpperCase()}${agentSlug.slice(1)}`,
      ...(this.languages.has(agentSlug) ? { language: this.languages.get(agentSlug) as string } : {}),
      ownIdentityChannelTypes: this.identityChannels(agentSlug),
      ...(this.agentSettings.has(agentSlug) ? { archetypeSettings: this.agentSettings.get(agentSlug) } : {}),
    }),
  };

  private readinessOf(request: { agentSlug: string; conversationId: string }): ChannelReadinessReport {
    const missing = [
      ...(!this.hasIdentity(request.agentSlug) ? [{ code: 'no_identity', message: 'the facilitator has no bot of its own' }] : []),
      ...(this.notReady.get(`${request.agentSlug}|${request.conversationId}`) ?? []),
    ];
    const has = (code: string): boolean => missing.some((m) => m.code === code);
    return {
      ready: missing.length === 0,
      installed: !has('app_not_installed') && !has('no_identity'),
      canReadAllMessages: !has('consent_missing'),
      canPost: !has('cannot_post'),
      missing,
    };
  }

  private readonly readinessService: ChannelReadinessService = {
    check: async (request): Promise<ChannelReadinessReport> => this.readinessOf(request),
    repairConsent: async (request) => {
      const key = `${request.agentSlug}|${request.conversationId}`;
      this.repairs.push(key);
      if (!this.repairable.has(key)) return { outcome: 'failed', code: 'graph_forbidden', message: 'an admin has to consent' };
      this.notReady.delete(key);
      return { outcome: 'upgraded' };
    },
  };

  private readonly capabilitiesService: SessionCapabilitiesService = {
    getSnapshot: async (request) =>
      this.snapshots.get(`${request.conversationId}|${request.sessionRef ?? ''}`) ?? {
        channelType: request.channelType,
        conversationId: request.conversationId,
        ...(request.sessionRef ? { sessionRef: request.sessionRef } : {}),
        modality: 'chat',
        inputs: ['text', 'message_edits', 'reactions'],
        outputs: ['text', 'mentions', 'private_messages'],
        capturedAt: this.clock.now().toISOString(),
      },
    onChange: (agentSlug, handler) => {
      const set = this.capabilityListeners.get(agentSlug) ?? new Set();
      set.add(handler);
      this.capabilityListeners.set(agentSlug, set);
      return () => set.delete(handler);
    },
    onSessionEvent: (agentSlug, handler) => {
      const set = this.sessionListeners.get(agentSlug) ?? new Set();
      set.add(handler);
      this.sessionListeners.set(agentSlug, set);
      return () => set.delete(handler);
    },
  };

  private readonly eventsService: ConversationEventsService = {
    subscribe: (fn) => {
      this.membershipListeners.add(fn);
      return () => this.membershipListeners.delete(fn);
    },
  };

  private readonly rostersService: ConversationRostersService = {
    getRoster: async (_channelType: string, conversationId: string, opts?: { agentSlug?: string; fresh?: boolean }): Promise<ConversationRoster | undefined> => {
      this.rosterAsks.push({ conversationId, ...(opts?.agentSlug ? { agentSlug: opts.agentSlug } : {}), ...(opts?.fresh ? { fresh: true } : {}) });
      // The channel's cache (Teams: five minutes): an answer younger than
      // `rosterCacheMs` is given again unless the caller asks for a fresh one.
      const cached = this.rosterCache.get(conversationId);
      if (cached && opts?.fresh !== true && this.clock.now().getTime() - cached.at < this.rosterCacheMs) return cached.roster;
      const roster = this.readRoster(conversationId, opts);
      this.rosterCache.set(conversationId, { at: this.clock.now().getTime(), roster });
      return roster;
    },
  };

  /** How long the channel caches a member list; 0 = no cache. */
  rosterCacheMs = 0;
  /** What the channel's cache holds per conversation. */
  private readonly rosterCache = new Map<string, { at: number; roster: ConversationRoster | undefined }>();
  /** A status the channel states for a conversation's member list (#2091). */
  readonly rosterStatus = new Map<string, 'complete' | 'partial' | 'unknown'>();

  private readRoster(conversationId: string, opts?: { agentSlug?: string }): ConversationRoster | undefined {
    {
      const members = this.members.get(conversationId);
      if (!members || this.noRosters.has(conversationId)) return undefined;
      // Only the facilitator's own bot is in this conversation: the kernel
      // can list it as that agent, and only a kernel that knows how.
      if (this.ownBotOnly.has(conversationId)) {
        const asked = this.rosterAsAgent ? opts?.agentSlug : undefined;
        if (!asked || !this.hasIdentity(asked)) return undefined;
      }
      const stated = this.rosterStatus.get(conversationId);
      return {
        conversationType: 'group',
        partial: stated !== undefined ? stated !== 'complete' : this.partialRosters.has(conversationId),
        ...(stated !== undefined ? { status: stated } : {}),
        participants: [
          ...members.map((m) => ({ userRef: { kind: this.userKind, id: m.id, displayName: m.displayName, ...(m.email ? { email: m.email } : {}) } })),
          { userRef: { kind: this.botKind, id: 'bot', displayName: 'Bot' }, isBot: true },
        ],
      };
    }
  }

  /** What the kernel answers for the bare name `conversationMessages` instead
   *  of the first major (a kernel on which the name means something else). */
  legacyAnswer: unknown;

  /** The first major, kept for a facilitation from before 1.4.0. */
  private readonly legacyMessagesService: Pick<ConversationMessagesService, 'unsubscribe'> = {
    unsubscribe: async (scope) => {
      this.legacySubscriptions.delete(scopeKey(scope));
    },
  };

  /** The accessor the engine consumes. */
  kernel(): Kernel {
    const unless = <T>(name: keyof Kernel, value: T) => (): T | undefined => (this.absent.has(name) ? undefined : value);
    return {
      db: () => (this.absent.has('db') ? undefined : this.database),
      execution: unless('execution', this.executionService),
      grants: unless('grants', this.grantsService),
      messages: () => {
        if (this.absent.has('messages')) return undefined;
        const { onPrivateMessage, onAddressedMessage, ...older } = this.messagesService;
        return { ...older, ...(this.privateMessages ? { onPrivateMessage } : {}), ...(this.addressedMessages ? { onAddressedMessage } : {}) } as ProcessConversationMessagesService;
      },
      agentTurn: unless('agentTurn', this.turnService),
      conversationSend: unless('conversationSend', this.sendService),
      legacyMessages: () => (this.absent.has('legacyMessages') ? undefined : ((this.legacyAnswer as Pick<ConversationMessagesService, 'unsubscribe'> | undefined) ?? this.legacyMessagesService)),
      readiness: unless('readiness', this.readinessService),
      sessionCapabilities: unless('sessionCapabilities', this.capabilitiesService),
      conversationEvents: unless('conversationEvents', this.eventsService),
      rosters: unless('rosters', this.rostersService),
      followup: () => (this.absent.has('followup') ? undefined : this.followup),
    };
  }
}
