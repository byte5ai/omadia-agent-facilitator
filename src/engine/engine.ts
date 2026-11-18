// The engine as the plugin and the tests hold it: wiring of the kernel's
// message delivery to the units of work, replay after a restart, and the
// queue of facilitator turns.

import type { ConversationMessageRecord, SessionCapabilitySnapshot, SessionEventRecord } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { ConversationMembershipEvent } from '../kernel.js';
import type { Facilitation } from '../model.js';
import { installCapabilities } from './capabilities.js';
import { EngineCore } from './core.js';
import type { EngineDeps } from './core.js';
import { installActionItems } from './actionItems.js';
import { closeWhenResultDelivered, installDecisionMethods } from './decide.js';
import { installProcess } from './process.js';
import { installProposals } from './proposals.js';
import { installGovernance, purgeExpired } from './governance.js';
import { processRecord } from './inbound.js';
import { onOpened, releaseConversation } from './lifecycle.js';
import { installScheduler, scheduleDeadlineJobs, tick } from './scheduler.js';
import { applySnapshot, endSession, installSessions, startSession } from './sessions.js';
import { processMembership } from './membership.js';
import { installTransparency } from './transparency.js';
import { runFacilitatorTurn } from './turn.js';

const REPLAY_PAGE = 200;

let installed = false;

/**
 * Register the engine's readings, job handlers, proposal kinds and hooks.
 *
 * They live at module level and are shared by every engine of the process (a
 * replica in a test, a second activation after an upgrade), so they are
 * registered exactly once and none of them holds on to an engine: a hook takes
 * the kernel from the unit of work it runs in.
 */
function installOnce(): void {
  if (installed) return;
  installed = true;
  installDecisionMethods();
  installScheduler();
  onOpened(scheduleDeadlineJobs);
  installProposals();
  installProcess();
  installActionItems();
  installTransparency();
  installGovernance();
  installSessions();
  installCapabilities();
}

export class FacilitationEngine {
  readonly core: EngineCore;
  private readonly attached = new Map<string, () => void>();
  private membership: (() => void) | undefined;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly turnQueues = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(deps: EngineDeps) {
    this.core = new EngineCore(deps);
    installOnce();
    this.core.onAfterDispatch(closeWhenResultDelivered);
  }

  /** Whether the engine can keep state at all. */
  available(): boolean {
    return this.core.deps.kernel.pool() !== undefined;
  }

  /** Attach to the kernel and catch up on what arrived while we were down. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.available()) return;
    this.attachMembership();
    // What a previous process left undelivered is settled first.
    const waiting = await this.core.pool().query<{ facilitation_id: string }>(
      `SELECT DISTINCT facilitation_id FROM facilitation_outbox WHERE status IN ('pending', 'sending')`,
    );
    for (const row of waiting.rows) await this.core.flush(row.facilitation_id);
    for (const f of await store.listSubscribed(this.core.pool())) {
      this.attach(f.facilitatorAgent);
      await this.replay(f);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const dispose of this.attached.values()) dispose();
    this.attached.clear();
    this.membership?.();
    this.membership = undefined;
    await this.idle();
  }

  /** Wait until every message and turn that is under way has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    return work;
  }

  /** Live delivery for one facilitator. Idempotent; called again whenever a
   *  facilitation starts, because the service may not have existed earlier. */
  attach(agentSlug: string): void {
    if (this.attached.has(agentSlug)) return;
    const messages = this.core.deps.kernel.messages();
    if (!messages) return;
    const disposers = [messages.onMessage(agentSlug, (record) => this.receive(agentSlug, record))];
    // What the channel offers can change mid-session; meetings start and end.
    const capabilities = this.core.deps.kernel.sessionCapabilities();
    if (capabilities) {
      disposers.push(capabilities.onChange(agentSlug, (snapshot) => this.receiveSnapshot(agentSlug, snapshot)));
      if (capabilities.onSessionEvent) disposers.push(capabilities.onSessionEvent(agentSlug, (event) => this.receiveSessionEvent(agentSlug, event)));
    }
    this.attached.set(agentSlug, () => {
      for (const dispose of disposers) dispose();
    });
  }

  async receiveSnapshot(agentSlug: string, snapshot: SessionCapabilitySnapshot): Promise<void> {
    if (this.stopped) return;
    await this.track(
      (async () => {
        try {
          const f = await store.findLiveByConversation(this.core.pool(), snapshot.channelType, snapshot.conversationId);
          if (f && f.facilitatorAgent === agentSlug) await this.core.work(f.id, (w) => applySnapshot(w, snapshot));
        } catch (err) {
          this.core.log(`capability change failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })(),
    );
  }

  async receiveSessionEvent(agentSlug: string, event: SessionEventRecord): Promise<void> {
    if (this.stopped) return;
    await this.track(
      (async () => {
        try {
          const live = (await store.listSubscribed(this.core.pool())).find((f) => f.conversationId === event.conversationId && f.facilitatorAgent === agentSlug);
          if (!live) return;
          await this.core.work(live.id, async (w) => {
            const sessions = (await store.listSessions(w.tx, w.f.id)).filter((s) => s.kind === 'live');
            const session = sessions.find((s) => s.meetingRef === event.sessionRef) ?? sessions.find((s) => s.status === 'scheduled' || s.status === 'running');
            if (event.kind === 'participant_joined' || event.kind === 'participant_left') {
              await w.event('session_presence', 'engine', { kind: event.kind, sessionRef: event.sessionRef, participants: event.participants ?? [] });
              return;
            }
            if (!session) return;
            if (event.kind === 'session_started') await startSession(w, session);
            else if (event.kind === 'session_ended') await endSession(w, session);
          });
        } catch (err) {
          this.core.log(`session event failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })(),
    );
  }

  private attachMembership(): void {
    if (this.membership) return;
    const events = this.core.deps.kernel.conversationEvents();
    if (!events) return;
    this.membership = events.subscribe((event) => {
      void this.receiveMembership(event);
    });
  }

  /** Lazy attachment for services the kernel published after activation. */
  ensureAttached(agentSlug: string): void {
    this.attach(agentSlug);
    this.attachMembership();
  }

  async receiveMembership(event: ConversationMembershipEvent): Promise<void> {
    if (this.stopped) return;
    await this.track(
      processMembership(this.core, event).catch((err: unknown) => {
        this.core.log(`membership event failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }

  /** One stored event from the kernel (live or replayed). Never throws: the
   *  kernel's delivery must not break on a single bad message. */
  async receive(agentSlug: string, record: ConversationMessageRecord): Promise<void> {
    if (this.stopped) return;
    await this.track(this.process(agentSlug, record));
  }

  private async process(agentSlug: string, record: ConversationMessageRecord): Promise<void> {
    try {
      const handled = await processRecord(this.core, agentSlug, record);
      if (!handled) return;
      if (handled.result.ended) await this.release(handled.facilitationId);
      if (handled.result.modelTurn) this.queueTurn(handled.facilitationId, record);
    } catch (err) {
      this.core.log(`inbound event ${record.eventId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async release(facilitationId: string): Promise<void> {
    const f = await store.getFacilitation(this.core.pool(), facilitationId);
    if (f) await releaseConversation(this.core, f);
  }

  /** Turns of one facilitation run one after the other, off the inbound path:
   *  a slow model never delays the recording of a ballot. */
  private queueTurn(facilitationId: string, record: ConversationMessageRecord): void {
    const previous = this.turnQueues.get(facilitationId) ?? Promise.resolve();
    const next = previous
      .then(() => runFacilitatorTurn(this.core, facilitationId, record))
      .catch((err: unknown) => {
        this.core.log(`facilitator turn for ${record.eventId} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.turnQueues.set(facilitationId, next);
    void this.track(next).finally(() => {
      if (this.turnQueues.get(facilitationId) === next) this.turnQueues.delete(facilitationId);
    });
  }

  /** One scheduler pass: due jobs, delivery retries, and a catch-up read of
   *  every moderated conversation in case a live delivery was lost. */
  async tick(): Promise<void> {
    if (this.stopped || !this.available()) return;
    await this.track(
      (async () => {
        await tick(this.core);
        await purgeExpired(this.core);
        for (const f of await store.listSubscribed(this.core.pool())) {
          this.attach(f.facilitatorAgent);
          await this.replay(f);
        }
      })(),
    );
    await this.idle();
  }

  /** Read everything the kernel stored after the facilitation's cursor. */
  async replay(f: Facilitation): Promise<number> {
    const messages = this.core.deps.kernel.messages();
    if (!messages) return 0;
    const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId };
    let after = f.inboundCursor ?? undefined;
    let count = 0;
    for (;;) {
      const page = await messages.listSince(scope, { ...(after !== undefined ? { after } : {}), limit: REPLAY_PAGE });
      for (const record of page.events) {
        await this.receive(f.facilitatorAgent, record);
        count += 1;
      }
      if (!page.nextCursor || page.events.length === 0) return count;
      after = page.nextCursor;
    }
  }
}
