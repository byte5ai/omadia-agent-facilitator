// Stakeholders named in a start request (spec 5.2 Prepare, 5.7 group consent).
// The model keeps no memory between messages, so a stakeholder the request
// names is put to the group in the same call that sets the facilitation up;
// otherwise it was lost (live finding 2026-11-21).

import * as store from '../db/store.js';
import type { StakeholderRole } from '../model.js';
import { newStakeholders, proposeStakeholders } from '../engine/capabilities.js';
import type { StakeholderInput } from '../engine/capabilities.js';
import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { asObject, oneOf, optionalString } from './toolkit.js';

export const STAKEHOLDER_ROLES: readonly StakeholderRole[] = ['receives_protocol', 'invited_to_followups'];

/** The `stakeholders` argument of facilitation_start; entries without a name are dropped. */
export function stakeholderList(args: Record<string, unknown>): StakeholderInput[] {
  const raw = args['stakeholders'];
  if (!Array.isArray(raw)) return [];
  const out: StakeholderInput[] = [];
  for (const entry of raw) {
    const o = asObject(entry);
    const name = optionalString(o, 'name');
    if (!name) continue;
    const address = optionalString(o, 'address');
    out.push({ displayName: name, role: oneOf(o, 'role', STAKEHOLDER_ROLES) ?? 'receives_protocol', ...(address ? { address } : {}) });
  }
  return out;
}

/**
 * Put the named stakeholders the group has not seen yet to the group as one
 * proposal. Never fails the start: what could not be proposed comes back as
 * notes for the facilitator (ask for a mail address, propose later).
 */
export async function proposeNamedStakeholders(
  engine: FacilitationEngine,
  facilitationId: string,
  named: readonly StakeholderInput[],
  addedBy: string,
): Promise<{ notes: string[]; posted: boolean }> {
  if (named.length === 0) return { notes: [], posted: false };
  const fresh = await newStakeholders(engine.core.db(), facilitationId, named);
  if (fresh.length === 0) return { notes: [], posted: false };
  const needAddress = fresh.filter((s) => s.address === undefined);
  const notes: string[] = [];
  let posted = false;
  try {
    const proposed = await engine.core.work(facilitationId, async (w) => {
      const participants = new Set((await store.listParticipants(w.tx, facilitationId)).map((p) => p.displayName.toLowerCase()));
      const ready = fresh.filter((s) => s.address !== undefined || participants.has(s.displayName.toLowerCase()));
      if (ready.length > 0) await proposeStakeholders(w, ready, addedBy);
      return ready;
    });
    if (proposed.length > 0) {
      posted = true;
      notes.push(`Stakeholders put to the group as one proposal: ${proposed.map((s) => s.displayName).join(', ')}. That proposal is already in the group; do not repeat it.`);
    }
    const missing = needAddress.filter((s) => !proposed.includes(s));
    if (missing.length > 0) {
      notes.push(`Not in this conversation and no mail address given: ${missing.map((s) => s.displayName).join(', ')}. Ask for the address, then call facilitation_stakeholder.`);
    }
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    notes.push(`The stakeholders ${fresh.map((s) => s.displayName).join(', ')} could not be put to the group yet (${err.message}). Call facilitation_stakeholder for them once the open proposal is decided.`);
  }
  return { notes, posted };
}
