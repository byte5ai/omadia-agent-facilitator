// One process per message (spec 5.3; #2061 criterion 29).
//
// A conversation can hold several processes of the same facilitator: a new
// facilitation while older ones follow up their action items. A message that
// changes state ("stop", "erledigt") must map to exactly one of them: by its
// reply to one process's message, or because only one process can accept it.
// Otherwise exactly one question is asked (by one process only, so the group
// does not get it twice) and nothing changes until it is clear.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { rows } from '../db/sql.js';
import type { Facilitation, Participant } from '../model.js';
import { lifecycleOf } from '../model.js';
import { texts } from '../texts/index.js';
import { mention } from './contributions.js';
import type { Work } from './core.js';

/** A state change a message asks for. */
export type StateCommand = { kind: 'stop' } | { kind: 'done'; number?: number };

/** `mine`: this process takes it; `asked`: the question went out; `others`:
 *  another process takes it or asks, this one does nothing. */
export type Correlation = 'mine' | 'asked' | 'others';

const LIVE = ['configuring', 'active', 'concluding'];
/** A Postgres array literal: `sql.ts` sends a JS array as JSON text. */
const pgArray = (values: readonly string[]): string => `{${values.join(',')}}`;

/** The processes of this facilitator in this conversation that could accept
 *  the command. */
async function candidates(w: Work, author: Participant, command: StateCommand): Promise<{ all: Facilitation[]; able: Facilitation[] }> {
  const all = await rows<Facilitation>(
    w.tx,
    `SELECT * FROM plg_omadia_agent_facilitator_facilitations
      WHERE facilitator_agent = $1 AND channel_type = $2 AND conversation_id = $3
        AND (phase = ANY($4::text[]) OR followup_state = 'active')
      ORDER BY created_at`,
    [w.f.facilitatorAgent, w.f.channelType, w.f.conversationId, `{${LIVE.join(',')}}`],
  );
  // "stop" ends a running facilitation, or only the follow-up of a closed one.
  if (command.kind === 'stop') return { all, able: all.filter((f) => f.phase === 'active' || f.phase === 'configuring' || f.phase === 'concluding' || (f.phase === 'closed' && f.followupState === 'active')) };
  const owning = await rows<{ facilitationId: string }>(
    w.tx,
    `SELECT DISTINCT facilitation_id FROM plg_omadia_agent_facilitator_action_items
      WHERE facilitation_id = ANY($1::uuid[]) AND owner_principal = $2 AND status = 'confirmed' AND ($3::int IS NULL OR number = $3)`,
    [pgArray(all.map((f) => f.id)), author.principalId, command.number ?? null],
  );
  return { all, able: all.filter((f) => owning.some((o) => o.facilitationId === f.id)) };
}

/** Which process a state-changing message belongs to. */
export async function correlate(w: Work, record: ConversationMessageRecord, author: Participant, command: StateCommand): Promise<Correlation> {
  const { all, able } = await candidates(w, author, command);
  if (able.length <= 1) return 'mine';
  // A reply to one process's message is about that process.
  if (record.replyToMessageId !== undefined) {
    const owner = await rows<{ facilitationId: string }>(
      w.tx,
      `SELECT facilitation_id FROM plg_omadia_agent_facilitator_outbox WHERE channel_message_id = $1 AND facilitation_id = ANY($2::uuid[]) LIMIT 1`,
      [record.replyToMessageId, pgArray(able.map((f) => f.id))],
    );
    const [hit] = owner;
    if (hit) return hit.facilitationId === w.f.id ? 'mine' : 'others';
  }
  // One question, from one process: the live one, else the newest.
  // The live process reads every message of the conversation, also one it
  // could not take itself; a follow-up hears only what is addressed to it.
  // Only a process whose handler runs for the command can ask: the running
  // one (it reads every message), else the one the message reached.
  const asker = all.find((f) => f.phase === 'active' || (command.kind === 'stop' && (f.phase === 'configuring' || f.phase === 'concluding'))) ?? w.f;
  if (asker?.id !== w.f.id) return 'others';
  const t = texts(w.f.language);
  await w.event('which_process', author.principalId, { messageId: record.messageId, command: command.kind, candidates: able.map((f) => f.id) });
  w.post({
    purpose: 'which_process',
    key: record.eventId,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    text: t.whichProcess(author.displayName, able.map((f) => `${f.goal} (${t.phase[lifecycleOf(f)]})`)),
    mentions: [mention(author)],
  });
  return 'asked';
}
