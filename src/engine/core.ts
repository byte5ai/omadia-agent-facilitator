// The engine's unit of work.
//
// `work(facilitationId, fn)` is the only way state changes: it takes the
// facilitation's lock, runs `fn` in one transaction, and then, still under the
// lock, delivers what `fn` queued. Messages are written to the outbox in the
// same transaction as the change that caused them, so there is no state change
// without its message and no message without its state change.

import { randomUUID } from 'node:crypto';

import type { Clock } from '../clock.js';
import type { EngineConfig } from '../config.js';
import type { PoolLike, Queryable } from '../db/pool.js';
import { insertIfAbsent } from '../db/sql.js';
import * as store from '../db/store.js';
import { inTransaction, withFacilitationLock } from '../db/tx.js';
import type { Kernel } from '../kernel.js';
import type { DeliveryClass, Facilitation, OutboxPayload, OutboxRow, Phase } from '../model.js';
import { dispatchOutbox } from './outbox.js';

/** Test seams: a fault at a named point of a send. Never set in production. */
export interface EngineHooks {
  /** After the attempt was recorded, before the channel call. */
  beforeChannelCall?(row: OutboxRow): void | Promise<void>;
  /** After the channel call returned, before the outcome is recorded. */
  afterChannelCall?(row: OutboxRow): void | Promise<void>;
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

export interface Outgoing {
  /** What the message is, for the protocol and for idempotency. */
  purpose: string;
  /** Makes the idempotency key deterministic (a job id, a contribution id). */
  key?: string;
  to: 'group' | { principalId: string };
  text: string;
  mentions?: { user: string; text: string }[];
  card?: OutboxPayload['card'];
  deliveryClass: DeliveryClass;
  /** Delivered only while the facilitation is in one of these phases. */
  requiredPhases?: Phase[];
  /** Droppable messages are bound to the state they were computed from
   *  unless this is false (an answer to a status question stays true enough). */
  versionBound?: boolean;
  /** Row to stamp with the channel's message id once the send returned. */
  link?: { kind: 'ack' | 'proposal'; id: string };
}

export interface Work {
  readonly tx: Queryable;
  readonly now: Date;
  readonly config: EngineConfig;
  /** The facilitation as of the last change in this unit of work. */
  readonly f: Facilitation;
  patch(patch: Partial<Facilitation>): Promise<Facilitation>;
  /** Mark this unit of work as a state change (bumps `state_version` once). */
  bump(): void;
  post(message: Outgoing): void;
  event(kind: string, actor: string, payload?: Record<string, unknown>): Promise<void>;
}

export class EngineCore {
  readonly instanceId: string;

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

  pool(): PoolLike {
    const pool = this.deps.kernel.pool();
    if (!pool) {
      throw new EngineUnavailableError(
        'The facilitation engine has no database: grant this plugin its SQL permission and run the middleware with Postgres.',
      );
    }
    return pool;
  }

  /** One locked unit of work on a facilitation, followed by delivery. */
  async work<T>(facilitationId: string, fn: (w: Work) => Promise<T>): Promise<T> {
    return withFacilitationLock(this.pool(), facilitationId, async (client) => {
      const result = await inTransaction(client, async (tx) => {
        const loaded = await store.getFacilitation(tx, facilitationId);
        if (!loaded) throw new Refusal('unknown_facilitation', `Facilitation ${facilitationId} does not exist (any more).`);
        const now = this.now();
        let current = loaded;
        let bumped = false;
        const queued: Outgoing[] = [];
        const w: Work = {
          tx,
          now,
          config: this.deps.config,
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
            queued.push(message);
          },
          async event(kind, actor, payload = {}) {
            await store.appendEvent(tx, { facilitationId, kind, actor, payload, occurredAt: now });
          },
        };
        const value = await fn(w);
        const version = bumped ? await store.bumpStateVersion(tx, facilitationId) : current.stateVersion;
        for (const message of queued) await this.enqueue(tx, facilitationId, version, now, message);
        return value;
      });
      await dispatchOutbox(this, client, facilitationId);
      return result;
    });
  }

  /** Deliver whatever is pending for a facilitation, under its lock. */
  async flush(facilitationId: string): Promise<void> {
    await withFacilitationLock(this.pool(), facilitationId, (client) => dispatchOutbox(this, client, facilitationId));
  }

  private async enqueue(tx: Queryable, facilitationId: string, version: number, now: Date, m: Outgoing): Promise<void> {
    const payload: OutboxPayload & { link?: Outgoing['link'] } = {
      text: m.text,
      ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
      ...(m.card ? { card: m.card } : {}),
      ...(m.link ? { link: m.link } : {}),
    };
    const versionBound = m.versionBound ?? m.deliveryClass === 'droppable';
    await insertIfAbsent<OutboxRow>(
      tx,
      'facilitation_outbox',
      {
        facilitationId,
        idempotencyKey: `${facilitationId}:${m.purpose}:${m.key ?? randomUUID()}`,
        purpose: m.purpose,
        targetKind: m.to === 'group' ? 'group' : 'direct',
        targetPrincipal: m.to === 'group' ? null : m.to.principalId,
        payload,
        deliveryClass: m.deliveryClass,
        requiredPhases: m.requiredPhases ?? null,
        requiredStateVersion: versionBound ? version : null,
        owner: this.instanceId,
        createdAt: now,
      },
      '(idempotency_key)',
    );
  }
}
