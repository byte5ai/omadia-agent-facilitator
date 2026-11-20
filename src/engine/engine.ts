// The engine as the plugin and the tests hold it: wiring of the kernel's
// message delivery to the units of work, replay after a restart, and the
// queue of facilitator turns.

import { installRepeats } from './repeats.js';
import type { ConversationMessageRecord, SessionCapabilitySnapshot, SessionEventRecord } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { ConversationMembershipEvent } from '../kernel.js';
import type { Facilitation } from '../model.js';
import { installCapabilities } from './capabilities.js';
import { EngineCore } from './core.js';
import type { EngineDeps } from './core.js';
import { installActionItems } from './actionItems.js';
import { installDecisionMethods } from './decide.js';
import { advanceClosings, installClosing } from './closing.js';
import { installProcess } from './process.js';
import { installProposals } from './proposals.js';
import { installGovernance, purgeExpired } from './governance.js';
import { endProcessesOfAgent } from './endOfService.js';
import type { ProcessEndReport, ProcessEndRequest } from './endOfService.js';
import { processRecord } from './inbound.js';
import { onOpened, releaseConversation } from './lifecycle.js';
import { installScheduler, scheduleDeadlineJobs, tick } from './scheduler.js';
import { applySnapshot, fetchSnapshot, installSessions, meetingEnded, meetingStarted } from './sessions.js';
import { processMembership } from './membership.js';
import { decideAddressed } from './addressed.js';
import { answerPrivateMessage } from './privateMessages.js';
import { syncAllScopes, syncScopes } from './scopes.js';
import { reconcileAll, reconcileSubscription } from './subscription.js';
import type { SubscriptionState } from './subscription.js';
import { installTransparency } from './transparency.js';
import { runFacilitatorTurn } from './turn.js';
import { installSessionClose, sessionSummariesDelivered } from './sessionClose.js';
import { handleLinkRequest, linkedMeetingEvent, replaySessionConversations, syncAllSessionConversations, syncSessionConversations } from './sessionLinks.js';
import { installTranscript } from './transcript.js';

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
  installClosing();
  installProcess();
  installRepeats();
  installActionItems();
  installTransparency();
  installGovernance();
  installSessions();
  installSessionClose();
  installTranscript();
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
    this.core.onAfterDispatch(advanceClosings);
    // A session summary that went out opens its consent window, or is done.
    this.core.onAfterDispatch(sessionSummariesDelivered);
    // After every unit of work the kernel's scopes follow the facilitation's
    // state: what is over ends, a changed deadline moves, the people are told.
    this.core.onAfterRelease((engine, facilitationId) => syncScopes(engine, facilitationId));
    // The kernel's state of each linked session conversation follows the
    // session's (spec 5.3).
    this.core.onAfterRelease((engine, facilitationId) => syncSessionConversations(engine, facilitationId));
  }

  private readiness: (() => Promise<unknown>) | undefined;

  /** How the engine is brought up when a call finds it down (the plugin
   *  looks for the database again). */
  setReadiness(readiness: () => Promise<unknown>): void {
    this.readiness = readiness;
  }

  async ensureReady(): Promise<void> {
    await this.readiness?.();
  }

  private usable: (() => boolean) | undefined;

  /** What else has to hold before the engine may work (its tables are migrated). */
  setUsable(usable: () => boolean): void {
    this.usable = usable;
  }

  /** Whether the engine can keep state at all: it has its database, and the
   *  tables in it are the ones this version expects. */
  available(): boolean {
    return this.core.deps.kernel.db() !== undefined && (this.usable?.() ?? true);
  }

  /** Attach to the kernel and catch up on what arrived while we were down. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.available()) return;
    this.attachMembership();
    // What a previous process left undelivered is settled first.
    const waiting = await this.core.db().query<{ facilitation_id: string }>(
      `SELECT DISTINCT facilitation_id FROM plg_omadia_agent_facilitator_outbox WHERE status IN ('pending', 'sending')`,
    );
    for (const row of waiting.rows) await this.core.flush(row.facilitation_id);
    await this.catchUp();
  }

  /** Check the kernel's subscription of every facilitation that reads a
   *  conversation, then read what the kernel stored for those that still can. */
  private async catchUp(): Promise<void> {
    const readable = await reconcileAll(this.core);
    for (const f of await store.listSubscribed(this.core.db())) {
      if (!readable.has(f.id)) continue;
      this.attach(f.facilitatorAgent);
      await this.replay(f);
      await replaySessionConversations(this.core, f, (record) => this.receive(f.facilitatorAgent, record));
    }
  }

  /** The kernel ends this facilitator's service: every facilitation of it
   *  ends with its report, within the kernel's wait. */
  async endProcessesOfAgent(request: ProcessEndRequest, budgetMs?: number): Promise<ProcessEndReport> {
    await this.ensureReady();
    if (!this.available()) return { ended: [] };
    return endProcessesOfAgent(this.core, request, budgetMs);
  }

  /** Before a tool acts on a facilitation: can it still be read? */
  reconcile(f: Facilitation): Promise<SubscriptionState> {
    return reconcileSubscription(this.core, f);
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
    // A participant asks for the status in a private chat (kernel #2089).
    if (typeof messages.onPrivateMessage === 'function') {
      disposers.push(messages.onPrivateMessage(agentSlug, (request) => (this.stopped ? Promise.resolve({ handled: false as const }) : this.track(answerPrivateMessage(this.core, request)))));
    }
    // Who answers a mention during a follow-up: the kernel asks, the engine
    // decides at once and works after it answered (kernel #2089). Absent on
    // an older kernel: there a mention is left to the ordinary turn.
    if (typeof messages.onAddressedMessage === 'function') {
      this.core.addressedHook.add(agentSlug);
      disposers.push(() => this.core.addressedHook.delete(agentSlug));
      disposers.push(
        messages.onAddressedMessage(agentSlug, async (request) => {
          if (this.stopped) return { handled: false };
          const decision = await this.track(decideAddressed(this.core, request));
          if (!decision.handled) return { handled: false };
          void this.track(
            decision
              .work()
              .then((done) => {
                // A question in a linked session conversation before its session gets the facilitator's answer there.
                if (done?.modelTurn) this.queueTurn(decision.facilitationId, done.record);
              })
              .catch((err: unknown) => {
              this.core.log(`facilitation ${decision.facilitationId}: an addressed message it took could not be worked on: ${err instanceof Error ? err.message : String(err)}`);
            }),
          );
          return { handled: true };
        }),
      );
    }
    // A request to link a meeting chat, made inside it (kernel #2089): a
    // typed event, without read access before the link.
    if (typeof messages.onLinkRequest === 'function') {
      disposers.push(messages.onLinkRequest(agentSlug, (request) => (this.stopped ? Promise.resolve({ handled: false as const }) : this.track(handleLinkRequest(this.core, request)))));
    }
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
          const f = await store.findLiveByConversation(this.core.db(), snapshot.channelType, snapshot.conversationId);
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
          const live = (await store.listSubscribed(this.core.db())).find((f) => f.conversationId === event.conversationId && f.facilitatorAgent === agentSlug);
          if (!live) {
            // A meeting of a linked session conversation starts or ends that session.
            await linkedMeetingEvent(this.core, agentSlug, event);
            return;
          }
          if (event.kind === 'participant_joined' || event.kind === 'participant_left') {
            await this.core.work(live.id, (w) => w.event('session_presence', 'engine', { kind: event.kind, sessionRef: event.sessionRef, participants: event.participants ?? [] }));
            return;
          }
          // What the meeting offers, and afterwards what the chat offers, is
          // asked before the unit of work: at the start and at the end.
          const snapshot = await fetchSnapshot(this.core, live, event.kind === 'session_started' ? event.sessionRef : undefined);
          await this.core.work(live.id, (w) => (event.kind === 'session_started' ? meetingStarted(w, event.sessionRef, snapshot) : meetingEnded(w, event.sessionRef, snapshot)));
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
    const f = await store.getFacilitation(this.core.db(), facilitationId);
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
   *  every moderated conversation in case a live delivery was lost.
   *
   *  It does not wait for facilitator turns: a model that takes its time must
   *  not hold the tick (the kernel gives it a fixed time), and a turn that
   *  was started by the catch-up finishes on its own. */
  async tick(): Promise<void> {
    if (this.stopped || !this.available()) return;
    await this.track(
      (async () => {
        await tick(this.core);
        await this.finishConcluding();
        await purgeExpired(this.core);
        await syncAllScopes(this.core);
        await syncAllSessionConversations(this.core);
        await this.deliveredSessionSummaries();
        await this.catchUp();
      })(),
    );
  }

  /** A session summary that went out while the engine went down: its
   *  delivery is taken note of on the next pass (the consent window opens). */
  private async deliveredSessionSummaries(): Promise<void> {
    const pending = await this.core.db().query<{ facilitation_id: string }>(
      `SELECT DISTINCT facilitation_id FROM plg_omadia_agent_facilitator_closings WHERE kind = 'session' AND ended_at IS NULL AND delivery_status = 'pending' LIMIT 50`,
    );
    for (const row of pending.rows) {
      try {
        await this.core.flush(row.facilitation_id);
      } catch (err) {
        this.core.log(`facilitation ${row.facilitation_id}: a session summary's delivery could not be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** A facilitation that is concluding is looked at on every tick: the close
   *  may have been lost after the result went out, or the result may have
   *  finally failed. Either way it does not stay concluding. */
  private async finishConcluding(): Promise<void> {
    // Every facilitation with a closing that has not ended: its parts have
    // limits that pass without any delivery (spec 5.2).
    const concluding = await this.core.db().query<{ id: string }>(
      `SELECT f.id FROM plg_omadia_agent_facilitator_facilitations f
        WHERE f.phase = 'concluding' OR EXISTS (SELECT 1 FROM plg_omadia_agent_facilitator_closings c WHERE c.facilitation_id = f.id AND c.ended_at IS NULL)
        ORDER BY f.concluded_at NULLS LAST LIMIT 50`,
    );
    for (const row of concluding.rows) {
      try {
        await this.core.flush(row.id);
      } catch (err) {
        this.core.log(`facilitation ${row.id}: finishing the conclusion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Read everything the kernel stored after the facilitation's cursor. */
  async replay(f: Facilitation): Promise<number> {
    const messages = this.core.deps.kernel.messages();
    if (!messages) return 0;
    const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, processId: f.id };
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
