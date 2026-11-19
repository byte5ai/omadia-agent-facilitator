// Refusals of the kernel's execution authorization, in words.
//
// The kernel refuses an action that is outside its scope: stopped by an
// operator, past the deadline, beyond the budget, to a target the scope does
// not list. None of that ends silently. The facilitator's tool call gets a
// sentence it can repeat, the protocol and the log get the code, and the
// group is told where a message can still reach it.

import type { Db } from '../db/pool.js';
import type { EngineCore, Work } from './core.js';

export interface Refusal {
  code: string;
  message: string;
  /** What was refused: 'a post', 'a turn', ... */
  what: string;
}

const SENTENCES: Readonly<Record<string, string>> = {
  kill_switch: 'An operator has stopped this facilitator. Nothing it does is carried out until the operator lifts the stop.',
  budget_exhausted: 'The budget this part of the facilitation was given is used up.',
  deadline_passed: 'The time this part of the facilitation was given has passed.',
  scope_ended: 'This part of the facilitation has ended; nothing more is carried out for it.',
  limit_exceeded: 'That is longer than a facilitation may last.',
  target_not_allowed: 'This facilitation may not write to that conversation or person.',
  not_permitted: 'This facilitator is not in service right now (it is disabled, or its archetype is not delivered on this instance).',
  unknown_agent: 'This facilitator is not in service right now (it is disabled, or its archetype is not delivered on this instance).',
  conversation_busy: 'Another facilitation or a discussion already uses this conversation.',
  unavailable: 'The instance cannot authorize what a facilitation does right now.',
  no_service: 'The instance cannot authorize what a facilitation does right now.',
};

/** A refusal as the facilitator can say it. Never names the machinery. */
export function refusalText(code: string, message: string): string {
  return SENTENCES[code] ?? `The instance refused this (${code}: ${message}).`;
}

/** The execution code inside a failed send (`not_authorized:<code>`). */
export const executionCodeOf = (code: string): string | undefined => (code.startsWith('not_authorized:') ? code.slice('not_authorized:'.length) : undefined);

/**
 * Put a refusal on record: in the protocol of the facilitation and in the
 * log, where an operator reads it. Each code is written once per
 * facilitation and action, so a stop that lasts does not fill the protocol.
 */
export async function recordRefusal(engine: EngineCore, facilitationId: string, refusal: Refusal, client?: Db): Promise<void> {
  const key = `${refusal.what}:${refusal.code}`;
  const note = async (w: Work): Promise<void> => {
    const said = w.f.settings.refusalsSaid ?? [];
    if (said.includes(key)) return;
    // Not a state change: nothing that was computed becomes stale by it.
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_facilitations SET settings = jsonb_set(settings, '{refusalsSaid}', coalesce(settings->'refusalsSaid', '[]'::jsonb) || to_jsonb($2::text)) WHERE id = $1`, [w.f.id, key]);
    await w.event('execution_refused', 'kernel', { what: refusal.what, code: refusal.code, message: refusal.message, summary: refusalText(refusal.code, refusal.message) });
    engine.log(`facilitation ${w.f.id}: ${refusal.what} was refused by the execution authorization (${refusal.code}: ${refusal.message})`);
  };
  try {
    // Under the facilitation's lock already (a delivery): on that connection.
    if (client) await engine.workOn(client, facilitationId, note);
    else await engine.work(facilitationId, note);
  } catch (err) {
    engine.log(`facilitation ${facilitationId}: ${refusal.what} was refused (${refusal.code}: ${refusal.message}); that could not be put on record: ${err instanceof Error ? err.message : String(err)}`);
  }
}
