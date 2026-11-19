// The kernel's subscription under a facilitation.
//
// A facilitation reads its conversation through a subscription of its own
// (`conversationMessages@2`): bound to the facilitation, so it sees only what
// arrived for it. The kernel ends the subscription when its ground is gone
// (the facilitation has no open scope left, the engine's grant was revoked,
// the agent was disabled), and nothing tells the engine. So the engine asks
// (`modeOf`): when it comes up, on every scheduler pass, and before a tool
// acts.
//
//   still there        -> nothing happens
//   gone, given back   -> the group is told once that the facilitation continues
//   gone, refused      -> after a grace period the facilitation ends as aborted,
//                         with the kernel's reason on record
//
// A facilitation is never left active without a subscription.
//
// A facilitation that began before 1.4.0 has no scope and reads through the
// first major's subscription. It is taken over here, once: its scopes are
// opened, it subscribes as itself, and the old subscription is given back.

import { MINUTE_MS } from '../clock.js';
import * as store from '../db/store.js';
import type { Facilitation } from '../model.js';
import { texts } from '../texts/index.js';
import { endFollowup } from './actionItems.js';
import type { EngineCore } from './core.js';
import { abortInWork, releaseConversation } from './lifecycle.js';
import { ensureScope, scopeKeyFor, wantedMode } from './scopes.js';

/** How long the kernel may refuse before the facilitation ends. A refusal can
 *  pass on its own: after a grant change the kernel rebuilds the facilitator. */
export const SUBSCRIBE_GRACE_MS = 2 * MINUTE_MS;

export type SubscriptionState =
  | { state: 'ok' | 'restored' | 'unknown' }
  /** The kernel does not let the engine read the conversation (right now). */
  | { state: 'refused'; code: string; message: string; ended: boolean };

const LIVE = new Set(['configuring', 'active', 'concluding']);

/**
 * Take over a facilitation from before execution scopes. Its scopes are
 * opened in the kernel's order (the ones it is past are ended by the sync),
 * and the first major's subscription is given back: from now on the
 * conversation is read for this facilitation alone.
 */
async function takeOver(engine: EngineCore, f: Facilitation): Promise<Facilitation> {
  const key = scopeKeyFor(f, '', false);
  const scope = await ensureScope(engine, f, key.kind, key.eventId);
  if (!scope.ok) {
    engine.log(`facilitation ${f.id}: it began before execution scopes and could not be taken over (${scope.code}: ${scope.message})`);
    return f;
  }
  try {
    // A kernel that no longer has the first major (it ended those
    // subscriptions itself) answers nothing here, or answers the name with a
    // service that has no `unsubscribe`: then there is nothing to give back.
    const legacy = engine.deps.kernel.legacyMessages();
    if (typeof legacy?.unsubscribe === 'function') await legacy.unsubscribe({ agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId });
  } catch (err) {
    engine.log(`facilitation ${f.id}: its subscription from before execution scopes could not be given back: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The cursor named an event of the old subscription; the new one starts empty.
  await engine.db().query(`UPDATE plg_omadia_agent_facilitator_facilitations SET inbound_cursor = NULL, settings = (settings - 'released') || '{"scoped": true}'::jsonb WHERE id = $1`, [f.id]);
  engine.log(`facilitation ${f.id}: taken over under execution scopes (${key.kind})`);
  return (await store.getFacilitation(engine.db(), f.id)) ?? f;
}

/** Make sure a facilitation that reads a conversation still can. Called
 *  outside any unit of work: it calls the kernel. */
export async function reconcileSubscription(engine: EngineCore, stored: Facilitation): Promise<SubscriptionState> {
  const messages = engine.deps.kernel.messages();
  if (!messages || !engine.deps.kernel.execution()) return { state: 'unknown' };
  const f = stored.settings.scoped === true ? stored : await takeOver(engine, stored);
  if (f.settings.scoped !== true) return { state: 'unknown' };
  const wanted = wantedMode(f);
  if (wanted === 'none') return { state: 'ok' };
  const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId, processId: f.id };
  const mode = await messages.modeOf(scope);
  // `addressed` where everything should be read is the kernel's doing too
  // (the reservation was taken away); reading less than wanted is a loss.
  const held = mode === wanted || (mode === 'all' && wanted === 'addressed');
  if (held && f.settings.subscriptionLost !== true && f.settings.refusedSince === undefined) return { state: 'ok' };
  const lost = !held || f.settings.subscriptionLost === true;
  // A subscription needs an open scope, and reading everything needs the
  // conversation's reservation.
  const key = scopeKeyFor(f, '', false);
  await ensureScope(engine, f, key.kind, key.eventId);
  if (wanted === 'all') await engine.deps.kernel.execution()?.reserveConversation({ agentSlug: f.facilitatorAgent, processId: f.id, channelType: f.channelType, conversationId: f.conversationId });
  const outcome = await messages.subscribe(scope, { mode: wanted });

  if (outcome.outcome === 'subscribed') {
    if (!lost && f.settings.refusedSince === undefined) return { state: 'ok' };
    await engine.work(f.id, async (w) => {
      const { refusedSince: _refusedSince, subscriptionLost: _lost, ...settings } = w.f.settings;
      await w.patch({ settings: lost ? { ...settings, subscribedAt: w.now.toISOString() } : settings });
      if (!lost) return;
      await w.event('subscription_restored', 'engine', {});
      if (LIVE.has(w.f.phase)) {
        w.post({ purpose: 'resumed', to: 'group', deliveryClass: 'essential', text: texts(w.f.language).resumed() });
      }
    });
    engine.log(`facilitation ${f.id}: ${lost ? 'the kernel had ended its subscription; subscribed again' : 'the kernel accepts the subscription again'}`);
    return { state: lost ? 'restored' : 'ok' };
  }

  const reason = `${outcome.code}: ${outcome.message}`;
  const ended = await engine.work(f.id, async (w) => {
    if (!LIVE.has(w.f.phase) && w.f.followupState !== 'active') return false;
    const since = w.f.settings.refusedSince ? new Date(w.f.settings.refusedSince) : undefined;
    if (!since) {
      await w.patch({ settings: { ...w.f.settings, refusedSince: w.now.toISOString() } });
      await w.event('subscription_refused', 'engine', { reason });
      return false;
    }
    if (w.now.getTime() - since.getTime() < SUBSCRIBE_GRACE_MS) return false;
    // It does not come back. What the facilitation still has to say is
    // authorized by its scopes, not by the subscription: the abort report
    // goes out where the kernel still lets it.
    if (LIVE.has(w.f.phase)) {
      await abortInWork(w, { reason: texts(w.f.language).abortNoSubscription(), actor: 'engine', detail: { subscription: reason } });
    } else {
      await endFollowup(w);
      await w.event('followup_orphaned', 'engine', { subscription: reason });
    }
    return true;
  });
  if (ended) {
    engine.log(`facilitation ${f.id}: ended, the kernel does not let it read its conversation (${reason})`);
    const after = await store.getFacilitation(engine.db(), f.id);
    if (after) await releaseConversation(engine, after);
  } else {
    engine.log(`facilitation ${f.id}: the kernel refuses its subscription (${reason})`);
  }
  return { state: 'refused', code: outcome.code, message: outcome.message, ended };
}

/** Every facilitation that reads a conversation. One that fails does not
 *  stop the others. Returns the ids that can be read. */
export async function reconcileAll(engine: EngineCore): Promise<Set<string>> {
  const readable = new Set<string>();
  for (const f of await store.listSubscribed(engine.db())) {
    try {
      const result = await reconcileSubscription(engine, f);
      if (result.state !== 'refused') readable.add(f.id);
    } catch (err) {
      engine.log(`facilitation ${f.id}: checking its subscription failed: ${err instanceof Error ? err.message : String(err)}`);
      readable.add(f.id);
    }
  }
  return readable;
}
