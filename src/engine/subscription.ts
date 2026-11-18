// The kernel's subscription under a facilitation.
//
// Reading a conversation and posting in it both ride on the subscription the
// kernel keeps for the facilitator. The kernel ends it on its own when its
// ground is gone (the engine's grant was revoked, the engine was reinstalled,
// the agent was disabled), and nothing tells the engine. So the engine asks
// (`isSubscribed`, or on an older kernel infers it from what the kernel stored):
// when it comes up, on every scheduler pass, and before a tool acts.
//
//   still there        -> nothing happens
//   gone, given back   -> the group is told once that the facilitation continues
//   gone, refused      -> after a grace period the facilitation ends as aborted,
//                         with the kernel's reason on record
//
// A facilitation is never left active without a subscription.

import { DAY_MS, MINUTE_MS } from '../clock.js';
import * as store from '../db/store.js';
import type { Facilitation } from '../model.js';
import { texts } from '../texts/index.js';
import { endFollowup } from './actionItems.js';
import type { EngineCore } from './core.js';
import { abortInWork, releaseConversation } from './lifecycle.js';

/** How long the kernel may refuse before the facilitation ends. A refusal can
 *  pass on its own: after a grant change the kernel rebuilds the facilitator. */
export const SUBSCRIBE_GRACE_MS = 2 * MINUTE_MS;
/** The kernel keeps stored events for 30 days; older ones prove nothing. */
const EVENT_EVIDENCE_MS = 29 * DAY_MS;

export type SubscriptionState =
  | { state: 'ok' | 'restored' | 'unknown' }
  /** The kernel does not let the engine read the conversation (right now). */
  | { state: 'refused'; code: string; message: string; ended: boolean };

const LIVE = new Set(['configuring', 'active', 'concluding']);

/**
 * Is there evidence that the subscription is gone? Only for a kernel that
 * cannot be asked (before plugin-api 1.56). The engine reads the kernel's store: a subscription
 * that delivered events to this facilitation still lists them. An empty list
 * after events arrived means the subscription those events belonged to ended.
 */
async function lostByEvidence(engine: EngineCore, f: Facilitation, listed: number): Promise<boolean> {
  if (f.settings.subscriptionLost === true) return true;
  if (listed > 0) return false;
  const now = engine.now();
  const since = f.settings.subscribedAt ? new Date(f.settings.subscribedAt) : f.createdAt;
  const seen = await engine.pool().query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_inbound WHERE facilitation_id = $1 AND processed_at > $2 AND processed_at > $3 LIMIT 1`,
    [f.id, since, new Date(now.getTime() - EVENT_EVIDENCE_MS)],
  );
  return seen.rows.length > 0;
}

/** Make sure a facilitation that reads a conversation still can. Called
 *  outside any unit of work: it calls the kernel. */
export async function reconcileSubscription(engine: EngineCore, f: Facilitation): Promise<SubscriptionState> {
  const messages = engine.deps.kernel.messages();
  if (!messages) return { state: 'unknown' };
  const scope = { agentSlug: f.facilitatorAgent, channelType: f.channelType, conversationId: f.conversationId };
  let lost: boolean;
  if (typeof messages.isSubscribed === 'function') {
    // The kernel answers exactly (plugin-api 1.56).
    const held = await messages.isSubscribed(scope);
    if (held && f.settings.subscriptionLost !== true && f.settings.refusedSince === undefined) return { state: 'ok' };
    lost = !held || f.settings.subscriptionLost === true;
  } else {
    // An older kernel: inferred from what it stored.
    const listed = (await messages.listSince(scope, { limit: 1 })).events.length;
    // Events are listed: the subscription stands, whatever else is going on.
    if (listed > 0 && f.settings.subscriptionLost !== true && f.settings.refusedSince === undefined) return { state: 'ok' };
    lost = await lostByEvidence(engine, f, listed);
  }
  const outcome = await messages.subscribe(scope);

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
    // It does not come back. Nothing of this facilitation can be posted any
    // more, so nothing is kept waiting for it either.
    await w.patch({ settings: { ...w.f.settings, orphaned: true } });
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
    const after = await store.getFacilitation(engine.pool(), f.id);
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
  for (const f of await store.listSubscribed(engine.pool())) {
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
