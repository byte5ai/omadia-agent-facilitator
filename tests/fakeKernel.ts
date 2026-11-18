// A fake kernel with a simulated channel, for developing against the
// plugin-api 1.55 contract while the kernel's implementation is being built.
//
// It keeps what the real kernel keeps (subscriptions and stored events), so a
// "restart" in a test is a new engine against the same fake kernel and the
// same database. Authorship is whatever `say()` was called with: the channel
// states it, the engine can only read it.

import type {
  AgentTurnOutcome,
  AgentTurnRequest,
  AgentTurnService,
  ChannelReadinessReport,
  ChannelReadinessService,
  ConversationMessageRecord,
  ConversationMessageScope,
  ConversationMessagesService,
  ConversationSendOutcome,
  ConversationSendRequest,
  ConversationSendService,
  FacilitationFollowupService,
  SessionCapabilitiesService,
  SessionCapabilitySnapshot,
  SessionEventRecord,
  TargetedSendDeliveryOutcome,
  TargetedSendRequest,
  TargetedSendService,
} from '@omadia/plugin-api';

import type { Clock } from '../src/clock.js';
import type { PoolLike } from '../src/db/pool.js';
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
  messageId: string;
}

export interface DirectMessage {
  as: string | undefined;
  principal: string;
  text: string;
}

export interface SayOptions {
  replyTo?: string;
  quoted?: boolean;
  forwarded?: boolean;
  at?: string;
}

/** A stand-in for the M365 connector's `facilitation.followup`: it refuses
 *  anybody outside the grant, answers on a quarter-hour grid in UTC, and
 *  never returns anything but busy intervals. */
export class FakeFollowup implements FacilitationFollowupService {
  readonly calls: { method: string; grant: { facilitationId: string; allowed: readonly string[] }; request: Record<string, unknown> }[] = [];
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

  private refuse(grant: { allowed: readonly string[] }, people: readonly string[]) {
    if (!this.configured) return { outcome: 'refused' as const, code: 'not_configured' as const, message: 'no organiser mailbox is configured' };
    const rejected = people.filter((p) => !grant.allowed.includes(p));
    return rejected.length > 0 ? { outcome: 'refused' as const, code: 'recipient_not_allowed' as const, message: 'outside the grant', rejected } : undefined;
  }

  async freeBusy(grant: { facilitationId: string; allowed: readonly string[] }, request: { attendees: readonly string[]; from: string; to: string }) {
    this.calls.push({ method: 'freeBusy', grant, request });
    await this.onCall('freeBusy');
    const refused = this.refuse(grant, request.attendees);
    if (refused) return refused;
    return {
      outcome: 'ok' as const,
      busy: request.attendees.filter((a) => this.calendars.has(a)).map((attendee) => ({ attendee, intervals: this.calendars.get(attendee) ?? [] })),
    };
  }

  async createInvitation(grant: { facilitationId: string; allowed: readonly string[] }, request: { attendees: readonly string[]; subject: string; start: string; end: string; body: string; online?: boolean }) {
    this.calls.push({ method: 'createInvitation', grant, request });
    await this.onCall('createInvitation');
    const refused = this.refuse(grant, request.attendees);
    if (refused) return refused;
    this.invitations.push(request);
    return this.finish('createInvitation', { outcome: 'created' as const, eventId: `event-${String(this.invitations.length)}`, ...(request.online && this.joinLinks ? { joinUrl: 'https://teams.example/join/1' } : {}) });
  }

  async sendMail(grant: { facilitationId: string; allowed: readonly string[] }, request: { recipients: readonly string[]; subject: string; body: string }) {
    this.calls.push({ method: 'sendMail', grant, request });
    await this.onCall('sendMail');
    const refused = this.refuse(grant, request.recipients);
    if (refused) return refused;
    this.mails.push(request);
    return this.finish('sendMail', { outcome: 'sent' as const });
  }
}

const scopeKey = (s: { agentSlug: string; channelType: string; conversationId: string }): string =>
  `${s.agentSlug}|${s.channelType}|${s.conversationId}`;

export class FakeKernel {
  readonly channelType = 'teams';
  readonly posts: Post[] = [];
  readonly dms: DirectMessage[] = [];
  readonly turns: AgentTurnRequest[] = [];
  readonly events: ConversationMessageRecord[] = [];
  readonly subscriptions = new Set<string>();
  /** Where each subscription began: like the real hub, a subscription sees
   *  only what was stored since it started. */
  private readonly subscribedFrom = new Map<string, number>();
  /** Agents without an identity of their own on the channel. */
  readonly noIdentity = new Set<string>();
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
  onTurn: (request: AgentTurnRequest) => string | AgentTurnOutcome | Promise<string | AgentTurnOutcome> = () => '[silent]';
  followup: FacilitationFollowupService | undefined;
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
  /** A kernel that states the caller's display name with a tool call. */
  statesCallerName = false;
  private readonly listeners = new Map<string, Set<(record: ConversationMessageRecord) => void | Promise<void>>>();
  private readonly membershipListeners = new Set<(event: ConversationMembershipEvent) => void>();
  private readonly capabilityListeners = new Map<string, Set<(s: SessionCapabilitySnapshot) => void | Promise<void>>>();
  private readonly sessionListeners = new Map<string, Set<(e: SessionEventRecord) => void | Promise<void>>>();
  private readonly revisions = new Map<string, number>();
  private readonly originals = new Map<string, ConversationMessageRecord>();

  constructor(
    private readonly pool: PoolLike | undefined,
    readonly clock: FakeClock,
  ) {}

  // ── the simulated channel ────────────────────────────────────────────────

  conversation(id: string, members: FakeUser[], opts: { partialRoster?: boolean; noRoster?: boolean } = {}): string {
    this.members.set(id, [...members]);
    if (opts.partialRoster) this.partialRosters.add(id);
    if (opts.noRoster) this.noRosters.add(id);
    return id;
  }

  /** The kernel ends a subscription on its own (grant revoked, engine
   *  reinstalled, agent disabled). Nothing tells the engine. */
  endSubscription(agentSlug: string, conversationId: string): void {
    const key = scopeKey({ agentSlug, channelType: this.channelType, conversationId });
    this.subscriptions.delete(key);
    this.subscribedFrom.delete(key);
  }

  /** Subscribe refusals to answer next, per agent (the kernel will not give
   *  the conversation back). */
  readonly subscribeRefusals = new Map<string, { code: 'unavailable' | 'not_ready' | 'not_present'; message: string }>();

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
      author: { kind: 'teams-aad', id: user.id, displayName: user.displayName, principalId: `user:${user.id.toLowerCase()}` },
      tenantId: 'tenant-1',
      occurredAt: when,
      receivedAt: when,
      ...partial,
    };
    let last: ConversationMessageRecord | undefined;
    // The kernel stores one record per subscribed facilitator.
    for (const key of [...this.subscriptions]) {
      const [agentSlug, channelType, conv] = key.split('|');
      if (channelType !== this.channelType || conv !== conversationId || !agentSlug) continue;
      const record: ConversationMessageRecord = { ...base, eventId: this.nextId('evt'), receivedByChannelKey: `28:${agentSlug}` };
      this.events.push(record);
      last = record;
      for (const listener of [...(this.listeners.get(agentSlug) ?? [])]) await listener(record);
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

  async answerCard(conversationId: string, userId: string, cardId: string, value: unknown, messageId = cardId): Promise<ConversationMessageRecord> {
    return this.emit(conversationId, userId, { kind: 'card_answer', messageId, revision: 0, cardAnswer: { cardId, value } });
  }

  join(conversationId: string, user: FakeUser): void {
    this.members.set(conversationId, [...(this.members.get(conversationId) ?? []), user]);
    this.emitMembership({ kind: 'members_added', conversationId, members: [{ kind: 'teams-aad', ...user }] });
  }

  /** Another bot is added to the conversation (a second facilitator, an assistant). */
  joinBot(conversationId: string, id: string, displayName: string): void {
    this.emitMembership({ kind: 'members_added', conversationId, members: [{ kind: 'teams-bot', id, displayName, isBot: true }] });
  }

  leave(conversationId: string, userId: string): void {
    const user = this.user(conversationId, userId);
    this.members.set(conversationId, (this.members.get(conversationId) ?? []).filter((m) => m.id !== userId));
    this.emitMembership({ kind: 'members_removed', conversationId, members: [{ kind: 'teams-aad', ...user }] });
  }

  private emitMembership(partial: Pick<ConversationMembershipEvent, 'kind' | 'conversationId' | 'members'>): void {
    const event: ConversationMembershipEvent = { channelId: 'teams-1', channelType: this.channelType, occurredAt: this.clock.now().toISOString(), ...partial };
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
      callerUserRef: { kind: 'teams-aad', id: callerId, ...(name ? { displayName: name } : {}) },
      ...(inboundEventId ? { inboundEventId } : {}),
    };
  }

  groupPosts(conversationId: string, as?: string): Post[] {
    return this.posts.filter((p) => p.conversationId === conversationId && (as === undefined || p.as === as));
  }

  // ── the services ─────────────────────────────────────────────────────────

  /** false: a kernel before plugin-api 1.56, without `isSubscribed`. */
  exactSubscriptions = true;

  private readonly messagesService: ConversationMessagesService = {
    isSubscribed: async (scope) => this.subscriptions.has(scopeKey(scope)),
    subscribe: async (scope) => {
      if (this.noIdentity.has(scope.agentSlug)) return { outcome: 'refused', code: 'no_identity', message: `agent '${scope.agentSlug}' has no identity on ${scope.channelType}` };
      const refusal = this.subscribeRefusals.get(scope.agentSlug);
      if (refusal && !this.subscriptions.has(scopeKey(scope))) return { outcome: 'refused', ...refusal };
      if (!this.members.has(scope.conversationId)) return { outcome: 'refused', code: 'not_present', message: 'the bot was never observed in this conversation' };
      if (!this.subscriptions.has(scopeKey(scope))) this.subscribedFrom.set(scopeKey(scope), this.events.length);
      this.subscriptions.add(scopeKey(scope));
      return { outcome: 'subscribed' };
    },
    unsubscribe: async (scope) => {
      this.subscriptions.delete(scopeKey(scope));
      this.subscribedFrom.delete(scopeKey(scope));
    },
    onMessage: (agentSlug, handler) => {
      const set = this.listeners.get(agentSlug) ?? new Set();
      set.add(handler);
      this.listeners.set(agentSlug, set);
      return () => set.delete(handler);
    },
    getEvent: async (scope, messageId, revision) => {
      const matching = this.forScope(scope).filter((e) => e.messageId === messageId && (e.kind === 'created' || e.kind === 'edited' || e.kind === 'deleted'));
      if (revision !== undefined) return matching.find((e) => e.revision === revision);
      return matching.sort((a, b) => b.revision - a.revision)[0];
    },
    listSince: async (scope, opts) => {
      const all = this.forScope(scope);
      const start = opts?.after ? all.findIndex((e) => e.eventId === opts.after) + 1 : 0;
      const limit = opts?.limit ?? 100;
      const events = all.slice(start, start + limit);
      const last = events[events.length - 1];
      return { events, ...(last && start + limit < all.length ? { nextCursor: last.eventId } : {}) };
    },
  };

  private forScope(scope: ConversationMessageScope): ConversationMessageRecord[] {
    const from = this.subscribedFrom.get(scopeKey(scope));
    if (from === undefined) return [];
    return this.events.slice(from).filter((e) => e.receivedByChannelKey === `28:${scope.agentSlug}` && e.channelType === scope.channelType && e.conversationId === scope.conversationId);
  }

  private readonly sendService: ConversationSendService = {
    sendToConversation: async (request: ConversationSendRequest): Promise<ConversationSendOutcome> => {
      if (request.asOwnIdentity !== true) return { outcome: 'unreachable', code: 'not_own_identity', message: 'the engine must post as the facilitator itself' };
      if (this.noIdentity.has(request.agentSlug)) return { outcome: 'unreachable', code: 'no_identity', message: 'no own identity' };
      if (!this.subscriptions.has(scopeKey(request))) return { outcome: 'unreachable', code: 'not_permitted', message: 'no subscription for this conversation' };
      const fault = this.sendFaults.shift();
      if (fault === 'throw') throw new Error('channel connection reset');
      // A channel call that never answers.
      if (fault === 'hang') return new Promise<ConversationSendOutcome>(() => undefined);
      if (fault && fault !== 'lost') return { outcome: 'unreachable', ...fault };
      const messageId = this.nextId('bot');
      const message = request.message;
      this.posts.push({
        as: request.agentSlug,
        conversationId: request.conversationId,
        text: message.text,
        mentions: [...(message.mentions ?? [])],
        ...(message.poll !== undefined ? { poll: message.poll } : {}),
        messageId,
      });
      if (fault === 'lost') return { outcome: 'unreachable', code: 'timeout', message: 'no confirmation from the channel' };
      return { outcome: 'delivered', messageId, ...(message.poll !== undefined ? { cardMessageId: `${messageId}-card` } : {}) };
    },
  };

  private readonly targetedService: TargetedSendService = {
    sendToPrincipal: async (request: TargetedSendRequest) => {
      let outcome: TargetedSendDeliveryOutcome;
      const blocked = this.dmBlocked.get(request.principal);
      if (!request.asAgentSlug || this.noIdentity.has(request.asAgentSlug)) outcome = { outcome: 'unreachable', code: 'no_identity', message: 'no own identity' };
      // As the kernel: it only writes to people of a conversation it moderates.
      else if (![...this.subscriptions].some((key) => key.startsWith(`${request.asAgentSlug}|`))) outcome = { outcome: 'unreachable', code: 'not_permitted', message: 'not part of a conversation this agent moderates' };
      else if (blocked) outcome = { outcome: 'unreachable', code: blocked, message: `cannot reach ${request.principal}: ${blocked}` };
      else {
        this.dms.push({ as: request.asAgentSlug, principal: request.principal, text: request.message.text });
        outcome = { outcome: 'delivered', messageId: this.nextId('dm') };
      }
      return { resolution: { kind: 'single-user' as const }, deliveries: [{ principalId: request.principal, outcome }], diagnostics: [] };
    },
  };

  private readonly turnService: AgentTurnService = {
    runTurn: async (request) => {
      this.turns.push(request);
      const answer = await this.onTurn(request);
      return typeof answer === 'string' ? { outcome: 'completed', text: answer } : answer;
    },
    getProfile: async (agentSlug) => ({
      agentSlug,
      kind: 'facilitator',
      displayName: this.names.get(agentSlug) ?? `${agentSlug.charAt(0).toUpperCase()}${agentSlug.slice(1)}`,
      ...(this.languages.has(agentSlug) ? { language: this.languages.get(agentSlug) as string } : {}),
      ownIdentityChannelTypes: this.noIdentity.has(agentSlug) ? [] : [this.channelType],
    }),
  };

  private readonly readinessService: ChannelReadinessService = {
    check: async (request): Promise<ChannelReadinessReport> => {
      const missing = [
        ...(this.noIdentity.has(request.agentSlug) ? [{ code: 'no_identity', message: 'the facilitator has no bot of its own' }] : []),
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
    },
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
    getRoster: async (_channelType, conversationId): Promise<ConversationRoster | undefined> => {
      const members = this.members.get(conversationId);
      if (!members || this.noRosters.has(conversationId)) return undefined;
      return {
        conversationType: 'group',
        partial: this.partialRosters.has(conversationId),
        participants: [
          ...members.map((m) => ({ userRef: { kind: 'teams-aad', id: m.id, displayName: m.displayName, ...(m.email ? { email: m.email } : {}) } })),
          { userRef: { kind: 'teams-bot', id: 'bot', displayName: 'Bot' }, isBot: true },
        ],
      };
    },
  };

  /** The accessor the engine consumes. */
  kernel(): Kernel {
    const unless = <T>(name: keyof Kernel, value: T) => (): T | undefined => (this.absent.has(name) ? undefined : value);
    return {
      pool: () => (this.absent.has('pool') ? undefined : this.pool),
      messages: () => {
        if (this.absent.has('messages')) return undefined;
        if (this.exactSubscriptions) return this.messagesService;
        const { isSubscribed: _isSubscribed, ...older } = this.messagesService;
        return older;
      },
      agentTurn: unless('agentTurn', this.turnService),
      conversationSend: unless('conversationSend', this.sendService),
      targetedSend: unless('targetedSend', this.targetedService),
      readiness: unless('readiness', this.readinessService),
      sessionCapabilities: unless('sessionCapabilities', this.capabilitiesService),
      conversationEvents: unless('conversationEvents', this.eventsService),
      rosters: unless('rosters', this.rostersService),
      followup: () => (this.absent.has('followup') ? undefined : this.followup),
    };
  }
}
