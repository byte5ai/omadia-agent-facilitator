// Stakeholders named in a start request (spec 5.2 Prepare, 5.7 group consent).
// The model keeps no memory between messages, so a stakeholder the request
// names is recorded in the same call that sets the facilitation up; otherwise
// it was lost (live finding 2026-11-21). It is put to the group once the
// facilitation is open.

import * as store from '../db/store.js';
import type { StakeholderRole } from '../model.js';
import { newStakeholders, proposeStakeholders, stakeholderProblem } from '../engine/capabilities.js';
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
 * Record the named stakeholders the group has not seen yet. In `configuring`
 * they wait for the opening (nothing is posted before it, spec 5.2); once
 * active they go to the group as one proposal, or wait for an open one.
 * Read and write happen in one unit of work, under the facilitation's lock,
 * so a repeated or concurrent call never records the same person twice.
 * Every entry is checked on its own: one bad address does not hold up the
 * others, and each one left out gets its own note for the facilitator.
 * Never fails the start.
 */
export async function proposeNamedStakeholders(
  engine: FacilitationEngine,
  facilitationId: string,
  named: readonly StakeholderInput[],
  addedBy: string,
): Promise<{ notes: string[]; posted: boolean }> {
  if (named.length === 0) return { notes: [], posted: false };
  try {
    return await engine.core.work(facilitationId, async (w) => {
      const fresh = await newStakeholders(w.tx, facilitationId, named);
      const participants = await store.listParticipants(w.tx, facilitationId);
      const notes: string[] = [];
      const ready: StakeholderInput[] = [];
      for (const s of fresh) {
        const problem = stakeholderProblem(s, participants);
        if (problem === 'bad_address') notes.push(`Not noted as a stakeholder: ${s.displayName}. "${s.address ?? ''}" is not a mail address. Ask for the correct address, then call facilitation_stakeholder.`);
        else if (problem === 'needs_address') notes.push(`Not noted as a stakeholder: ${s.displayName}. Not in this conversation and no mail address given. Ask for the address, then call facilitation_stakeholder.`);
        else ready.push(s);
      }
      if (ready.length === 0) return { notes, posted: false };
      const { proposed } = await proposeStakeholders(w, ready, addedBy);
      const names = ready.map((s) => s.displayName).join(', ');
      notes.unshift(
        proposed
          ? `Stakeholders put to the group as one proposal: ${names}. That proposal is already in the group; do not repeat it.`
          : w.f.phase === 'configuring'
            ? `Stakeholders noted: ${names}. Nothing was posted about them yet: they are put to the group as one proposal once the facilitation is open. Do not propose them yourself.`
            : `Stakeholders noted: ${names}. Another proposal is being decided; they are put to the group as one proposal afterwards. Do not propose them yourself.`,
      );
      return { notes, posted: proposed };
    });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return { notes: [`The stakeholders ${named.map((s) => s.displayName).join(', ')} could not be noted (${err.message}). Call facilitation_stakeholder for them later.`], posted: false };
  }
}
