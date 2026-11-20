// The engine's unit of work.
//
// `work(facilitationId, fn)` is the only way state changes: it takes the
// facilitation's lock, runs `fn` in one transaction, and then, still under the
// lock, delivers what `fn` queued. Messages are written to the outbox in the
// same transaction as the change that caused them, so there is no state change
// without its message and no message without its state change.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Clock } from '../clock.js';
import type { EngineConfig } from '../config.js';
import type { Db, Queryable } from '../db/pool.js';
import { insertIfAbsent } from '../db/sql.js';
import * as store from '../db/store.js';
import { withFacilitationLock } from '../db/tx.js';
import type { Kernel } from '../kernel.js';
import type { DeliveryClass, Facilitation, Job, OutboxPayload, OutboxRow, Phase } from '../model.js';
import { texts } from '../texts/index.js';
import { guardOutgoing } from './guard.js';
import { namePrincipals } from './names.js';
import { dispatchOutbox } from './outbox.js';

/** Test seams: a fault at a named point of a send. Never set in production. */
export interface EngineHooks {
  /** After the attempt was recorded, before the channel call. */
  beforeChannelCall?(row: OutboxRow): void | Promise<void>;
  /** After the channel call returned, before the outcome is recorded. */
  afterChannelCall?(row: OutboxRow): void | Promise<void>;
  /** Inside the unit of work of an inbound message, before it is read. */
  beforeInbound?(record: { eventId: string; text?: string }): void | Promise<void>;
  /** After the result was delivered, before the close is committed. */
  beforeClose?(): void | Promise<void>;
  /** After a due job was leased, before it runs under the facilitation's lock. */
  beforeJob?(job: Job): void | Promise<void>;
}

export interface EngineDeps {
  readonly kernel: Kernel;
  readonly config: EngineConfig;
  readonly clock: Clock;
  readonly log: (msg: string) => void;
  /** Identifies this engine process in outbox rows and job leases. */
  readonly instanceId?: string;
  readonly hooks?: EngineHooks;
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** A refusal the caller (a tool, a route) reports as its answer. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

/** What is said in the group when a private message cannot arrive. */
export interface GroupFallback {
  purpose: string;
  text: string;
  mentions?: { user: string; text: string }[];
  /** With a key the fallbacks of several private messages are one group message. */
  key?: string;
  /** Default: droppable. Essential for what somebody is owed. */
  deliveryClass?: 'essential' | 'droppable';
}

export interface Outgoing {
  /** What the message is, for the protocol and for idempotency. */
  purpose: string;
  /** Makes the idempotency key deterministic (a job id, a contribution id). */
  key?: string;
  to: 'group' | { principalId: string };
  text: string;
  mentions?: { user: string; text: string }[];
  poll?: OutboxPayload['poll'];
  card?: OutboxPayload['card'];
  cardFallbackText?: string;
  cardUpdate?: OutboxPayload['cardUpdate'];
  /** `prose`: a model wrote this text (an agent turn). Absent: a template
   *  the engine filled. The kernel records it with the send. */
  emission?: 'prose';
  deliveryClass: DeliveryClass;
  /** Delivered only while the facilitation is in one of these phases. */
  requiredPhases?: Phase[];
  /** Droppable messages are bound to the state they were computed from
   *  unless this is false (an answer to a status question stays true enough). */
  versionBound?: boolean;
  /** A private message only: what goes to the group instead when the person
   *  cannot be reached privately. */
  fallback?: GroupFallback;
  /** Row to stamp with the channel's message id once the send returned. */
  link?: { kind: 'ack' | 'proposal' | 'card' | 'transcript' | 'closing'; id: string };
  /** A closing document (spec 5.6): its closing event and document version.
   *  Retried while that closing is valid, whatever the state is by then. */
  closing?: { id: string; version: number };
  /** A linked session conversation to post in (5.3); absent: home. */
  conversationId?: string;
  /** Drawn from the `closing` scope of this event (a session protocol). */
  closingEvent?: string;
}

/** Answers to the person who wrote in a linked session conversation: they
 *  go back there. */
const ANSWERS_IN_PLACE: ReadonlySet<string> = new Set([
  'echo', 'echo_confirmed', 'echo_withdrawn', 'echo_declined', 'clarification', 'status', 'which_confirmation',
  'proposal_hint', 'card_answer_hint', 'vote_open_hint', 'moderation',
  'item_taken', 'action_not_yours', 'parked', 'media_stopped', 'session_objection', 'session_consent_hint',
  'adopted', 'adopt_outdated', 'adopt_no_step', 'transcript_shared',
]);
/** The agenda moving on: said at home and in the session conversation. */
const MIRRORED_IN_SESSION: ReadonlySet<string> = new Set(['step_opened', 'step_closed', 'step_extended', 'timebox_over']);

export interface Work {
  readonly tx: Queryable;
  readonly now: Date;
  readonly config: EngineConfig;
  /** The engine this unit of work runs in. Hooks are shared by every engine
   *  of the process, so they take the kernel from here, never from a closure. */
  readonly engine: EngineCore;
  /** The facilitation as of the last change in this unit of work. */
  readonly f: Facilitation;
  patch(patch: Partial<Facilitation>): Promise<Facilitation>;
  /** Mark this unit of work as a state change (bumps `state_version` once). */
  bump(): void;
  post(message: Outgoing): void;
  event(kind: string, actor: string, payload?: Record<string, unknown>): Promise<void>;
  /** The conversation this unit of work answers in: a linked session
   *  conversation the inbound message came from (5.3). Group posts without
   *  a conversation of their own go there. Absent: the home conversation. */
  readonly within: string | undefined;
  answerIn(conversationId: string | undefined): void;
}

/** Runs after the lock was released; may use the db and call the kernel. */
export type AfterRelease = (engine: EngineCore, facilitationId: string) => Promise<void>;

/** Runs after delivery, still under the facilitation's lock. It gets the
 *  locked connection and must not take another one. */
export type AfterDispatch = (engine: EngineCore, client: Db, facilitationId: string) => Promise<void>;

/** What a tool call did, seen from the units of work that ran inside it. */
interface ToolCallScope {
  /** Messages queued for the group. */
  groupPosts: number;
  /** The conversation the call came from (a linked session conversation
   *  answers there, spec 5.3). */
  conversationId?: string;
}
const toolCall = new AsyncLocalStorage<ToolCallScope>();
/** How long the engine remembers that a turn's tools posted. */
const TURN_MEMORY_MS = 60 * 60_000;

export class EngineCore {
  readonly instanceId: string;
  private readonly afterDispatch: AfterDispatch[] = [];
  private readonly afterRelease: AfterRelease[] = [];
  /** Facilitators for which the kernel asks the engine who answers a message
   *  that addresses them in follow-up (`onAddressedMessage`). */
  readonly addressedHook = new Set<string>();
  /** Messages the engine took through that question without a stored event,
   *  by platform message id: their event, should it arrive, is not answered. */
  private readonly hookTaken = new Map<string, number>();

  noteTakenByHook(messageId: string): void {
    const now = Date.now();
    for (const [id, at] of this.hookTaken) if (now - at > TURN_MEMORY_MS) this.hookTaken.delete(id);
    this.hookTaken.set(messageId, now);
  }

  takenByHook(messageId: string): boolean {
    return this.hookTaken.has(messageId);
  }

  /** What the tools of a turn did, by the inbound event the turn answers. */
  private readonly turnNotes = new Map<string, { posted: boolean; refusals: string[]; at: number }>();

  private noteOf(inboundEventId: string): { posted: boolean; refusals: string[]; at: number } {
    const now = Date.now();
    for (const [eventId, note] of this.turnNotes) if (now - note.at > TURN_MEMORY_MS) this.turnNotes.delete(eventId);
    const note = this.turnNotes.get(inboundEventId) ?? { posted: false, refusals: [], at: now };
    this.turnNotes.set(inboundEventId, note);
    return note;
  }

  /**
   * Run a tool call and note whether it made the facilitator post in the
   * group. The turn that called the tool has then said what there is to say:
   * its own text is not posted on top (the model is not relied on to stay
   * silent).
   */
  async inToolCall<T>(inboundEventId: string | undefined, run: () => Promise<T>, conversationId?: string): Promise<T> {
    const scope: ToolCallScope = { groupPosts: 0, ...(conversationId !== undefined ? { conversationId } : {}) };
    try {
      return await toolCall.run(scope, run);
    } finally {
      if (inboundEventId !== undefined && scope.groupPosts > 0) this.noteOf(inboundEventId).posted = true;
    }
  }

  /** A tool of the turn refused what it was asked to do. */
  noteRefusal(inboundEventId: string | undefined, code: string): void {
    if (inboundEventId !== undefined) this.noteOf(inboundEventId).refusals.push(code);
  }

  /** What the tools of the turn for this inbound event did. Asked once, when
   *  the turn is over. */
  takeTurnNotes(inboundEventId: string): { posted: boolean; refusals: readonly string[] } {
    const note = this.turnNotes.get(inboundEventId);
    this.turnNotes.delete(inboundEventId);
    return { posted: note?.posted ?? false, refusals: note?.refusals ?? [] };
  }

  /** Register work for after the lock and its connection were given back
   *  (releasing the conversation: a kernel call, and queries of its own). */
  onAfterRelease(hook: AfterRelease): void {
    this.afterRelease.push(hook);
  }

  private async released(facilitationId: string): Promise<void> {
    for (const hook of this.afterRelease) {
      try {
        await hook(this, facilitationId);
      } catch (err) {
        this.log(`facilitation ${facilitationId}: follow-up after a unit of work failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Register follow-up work for after every delivery (closing once the
   *  result is out). */
  onAfterDispatch(hook: AfterDispatch): void {
    this.afterDispatch.push(hook);
  }

  private async delivered(client: Db, facilitationId: string): Promise<void> {
    await dispatchOutbox(this, client, facilitationId);
    // A hook may queue more (the report and the protocol that follow the
    // result), and what that delivers lets a closing move on again (its
    // dispatch ends once its sends are out): two rounds.
    for (let round = 0; round < 2; round += 1) {
      for (const hook of this.afterDispatch) await hook(this, client, facilitationId);
      await dispatchOutbox(this, client, facilitationId);
    }
  }

  constructor(readonly deps: EngineDeps) {
    this.instanceId = deps.instanceId ?? randomUUID();
  }

  get config(): EngineConfig {
    return this.deps.config;
  }

  now(): Date {
    return this.deps.clock.now();
  }

  log(msg: string): void {
    this.deps.log(msg);
  }

  db(): Db {
    const db = this.deps.kernel.db();
    if (!db) {
      throw new EngineUnavailableError(
        'The facilitation engine has no database: grant this plugin its SQL permission and run the middleware with Postgres.',
      );
    }
    return db;
  }

  /** One locked unit of work on a facilitation, followed by delivery. */
  async work<T>(facilitationId: string, fn: (w: Work) => Promise<T>): Promise<T> {
    const result = await withFacilitationLock(this.db(), facilitationId, async (client) => {
      const value = await this.workOn(client, facilitationId, fn);
      await this.delivered(client, facilitationId);
      return value;
    });
    await this.released(facilitationId);
    return result;
  }

  /** The transaction of a unit of work, on a connection that already holds
   *  the facilitation's lock. Queues messages; the caller delivers. */
  async workOn<T>(client: Db, facilitationId: string, fn: (w: Work) => Promise<T>): Promise<T> {
    return client.transaction(async (tx) => {
      const loaded = await store.getFacilitation(tx, facilitationId);
      if (!loaded) throw new Refusal('unknown_facilitation', `Facilitation ${facilitationId} does not exist (any more).`);
      const now = this.now();
      let current = loaded;
      let bumped = false;
      // A tool call from a session conversation answers there.
      const calledFrom = toolCall.getStore()?.conversationId;
      let within: string | undefined = calledFrom !== undefined && calledFrom !== loaded.conversationId ? calledFrom : undefined;
      const queued: Outgoing[] = [];
      const w: Work = {
        tx,
        now,
        config: this.deps.config,
        engine: this,
        get f() {
          return current;
        },
        async patch(patch) {
          const next = await store.patchFacilitation(tx, facilitationId, patch);
          if (!next) throw new Error(`facilitation ${facilitationId} vanished mid-transaction`);
          current = next;
          bumped = true;
          return next;
        },
        bump() {
          bumped = true;
        },
        post(message) {
          if (within === undefined || message.to !== 'group' || message.conversationId !== undefined) {
            queued.push(message);
            return;
          }
          // A message from a linked session conversation is answered there;
          // what belongs to the whole facilitation stays at home, so nothing
          // of the home conversation reaches a session's guests (5.3, 5.8).
          if (ANSWERS_IN_PLACE.has(message.purpose)) queued.push({ ...message, conversationId: within });
          else if (MIRRORED_IN_SESSION.has(message.purpose)) queued.push(message, { ...message, key: `${message.key ?? message.purpose}:session`, conversationId: within });
          else queued.push(message);
        },
        get within() {
          return within;
        },
        answerIn(conversationId) {
          within = conversationId !== undefined && conversationId !== current.conversationId ? conversationId : undefined;
        },
        async event(kind, actor, payload = {}) {
          await store.appendEvent(tx, { facilitationId, kind, actor, payload, occurredAt: now });
        },
      };
      const value = await fn(w);
      const version = bumped ? await store.bumpStateVersion(tx, facilitationId) : current.stateVersion;
      for (const message of queued) await this.enqueue(tx, current, version, now, message);
      const scope = toolCall.getStore();
      if (scope) scope.groupPosts += queued.filter((m) => m.to === 'group').length;
      return value;
    });
  }

  /** Deliver whatever is pending for a facilitation, under its lock. */
  async flush(facilitationId: string): Promise<void> {
    await withFacilitationLock(this.db(), facilitationId, (client) => this.delivered(client, facilitationId));
    await this.released(facilitationId);
  }

  private async enqueue(tx: Queryable, f: Facilitation, version: number, now: Date, m: Outgoing): Promise<void> {
    const facilitationId = f.id;
    // Every outgoing text passes the guard, whoever wrote it. What it refuses
    // is replaced by a neutral line and put on record; nothing is posted for
    // "say nothing".
    // People are named by their name: an id the facilitation knows goes out
    // as that name.
    // A card without a text is a whole message: the card says it all.
    const verdict = m.card && m.text === '' ? ({ ok: true, text: '' } as const) : guardOutgoing(await namePrincipals(tx, f, m.text));
    if (!verdict.ok) {
      await store.appendEvent(tx, { facilitationId, kind: 'text_refused', actor: 'engine', occurredAt: now, payload: { purpose: m.purpose, reason: verdict.reason } });
      this.log(`facilitation ${facilitationId}: outgoing ${m.purpose} refused by the text guard (${verdict.reason})`);
      if (verdict.reason === 'silent' || verdict.reason === 'empty') return;
    }
    const fallback = m.fallback && m.to !== 'group' ? { ...m.fallback, text: await namePrincipals(tx, f, m.fallback.text) } : undefined;
    const payload: OutboxPayload & { link?: Outgoing['link']; fallback?: Outgoing['fallback']; emission?: 'prose' } = {
      ...(m.emission && verdict.ok ? { emission: m.emission } : {}),
      text: verdict.ok ? verdict.text : texts(f.language).guardFallback(),
      ...(m.conversationId && m.conversationId !== f.conversationId ? { conversationId: m.conversationId } : {}),
      ...(m.closingEvent ? { closingEvent: m.closingEvent } : {}),
      ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
      ...(m.poll ? { poll: m.poll } : {}),
      ...(m.card ? { card: m.card } : {}),
      ...(m.cardFallbackText ? { cardFallbackText: m.cardFallbackText } : {}),
      ...(m.cardUpdate ? { cardUpdate: m.cardUpdate } : {}),
      ...(m.link ? { link: m.link } : {}),
      ...(fallback ? { fallback } : {}),
    };
    const versionBound = m.versionBound ?? m.deliveryClass === 'droppable';
    await insertIfAbsent<OutboxRow>(
      tx,
      'plg_omadia_agent_facilitator_outbox',
      {
        facilitationId,
        idempotencyKey: `${facilitationId}:${m.purpose}:${m.key ?? randomUUID()}`,
        purpose: m.purpose,
        targetKind: m.to === 'group' ? 'group' : 'direct',
        targetPrincipal: m.to === 'group' ? null : m.to.principalId,
        payload,
        deliveryClass: m.deliveryClass,
        requiredPhases: m.requiredPhases ?? null,
        requiredStateVersion: versionBound && !m.closing ? version : null,
        ...(m.closing ? { closingId: m.closing.id, documentVersion: m.closing.version } : {}),
        owner: this.instanceId,
        createdAt: now,
      },
      '(idempotency_key)',
    );
  }
}
