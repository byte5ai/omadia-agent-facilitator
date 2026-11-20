// Spoken contributions (spec 5.3, 6.3; #2077, #2089; criteria 19, 62).
//
// What is said in a live session arrives as `transcript_segment` events of
// the session's authenticated media source, one per revision of a segment.
// Speaker recognition never sets authorship:
//
//   participant   the platform delivered a media channel bound to one
//                 participant's account: that principal is the author. The
//                 segment is recorded unconfirmed and counts once its author
//                 confirms exactly this revision; a confirmation by anyone
//                 else, or of an older revision, counts nothing.
//   shared        a room microphone or a mixed stream: nobody is the author.
//                 The segment is shown unattributed; a participant may adopt
//                 exactly this revision as their own contribution by replying
//                 to it. The protocol records it as "adopted from the
//                 transcript", never as "said by".
//
// Nothing of a call is processed before the group consented to it, and
// "stop listening" ends it (sessions.ts). Raw audio is never stored; the
// text of a segment is kept for its facilitation's retention.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { insertIfAbsent, one } from '../db/sql.js';
import * as store from '../db/store.js';
import { principalKey } from '../kernel.js';
import { parseBallot } from '../methods/ballot.js';
import type { Ballot } from '../methods/ballot.js';
import type { Ack, Contribution, Participant, Session, Step, TranscriptSegment } from '../model.js';
import { sessionTexts } from '../texts/sessions.js';
import { mention } from './contributions.js';
import type { Work } from './core.js';
import { recordBallot, roundOptions } from './decide.js';
import type { InboundHandler } from './inbound.js';
import { PRIORITY, registerInboundHandler } from './inbound.js';

const SEGMENTS = 'plg_omadia_agent_facilitator_transcript_segments';

/** What a spoken text is in the open step: a ballot where a vote is open and
 *  the text reads as one in the announced format, a position otherwise. */
function spokenAs(step: Step, text: string): { kind: Contribution['kind']; ballot?: Record<string, unknown> } {
  if (!step.method) return { kind: 'position' };
  const parsed = parseBallot({ method: step.method, options: roundOptions(step), text });
  return parsed.kind === 'ballot' ? { kind: 'vote', ballot: parsed.ballot as unknown as Record<string, unknown> } : { kind: 'position' };
}
const ADOPT = /^(mine|that was me|that's mine|meins|das war ich|übernehmen|uebernehmen|adopt)$/u;

/** The session a segment belongs to: its own conversation's, or the running
 *  meeting of the home conversation. */
async function sessionOf(w: Work, record: ConversationMessageRecord): Promise<Session | undefined> {
  const sessions = await store.listSessions(w.tx, w.f.id);
  const there = sessions.find((s) => s.conversationId === record.conversationId);
  if (there) return there;
  return sessions.find((s) => s.kind === 'live' && s.status === 'live' && s.conversationId === null) ?? sessions.find((s) => s.kind === 'async');
}

const hears = (session: Session | undefined): boolean => {
  const inputs = (session?.capabilitySnapshot as { inputs?: string[] } | null | undefined)?.inputs ?? [];
  return inputs.includes('transcribed_speech') && session?.mediaConsent === 'granted';
};

/** A new revision retires what the earlier one carried: its unconfirmed
 *  contribution and the question to its author. */
async function retireEarlier(w: Work, segmentId: string, revision: number): Promise<void> {
  const earlier = await w.tx.query<{ id: string }>(
    `SELECT id FROM plg_omadia_agent_facilitator_contributions
      WHERE facilitation_id = $1 AND source = 'speech' AND payload->>'segmentId' = $2 AND (payload->>'segmentRevision')::int < $3
        AND status IN ('unconfirmed', 'ambiguous')`,
    [w.f.id, segmentId, revision],
  );
  for (const row of earlier.rows) {
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_contributions SET status = 'superseded' WHERE id = $1`, [row.id]);
    await w.tx.query(`UPDATE plg_omadia_agent_facilitator_acks SET status = 'cancelled', resolved_at = $2 WHERE ref_id = $1 AND status = 'pending'`, [row.id, w.now]);
  }
}

/** A transcript segment from the session's media source. */
const segments: InboundHandler = async ({ w, record }) => {
  if (record.kind !== 'transcript_segment' || !record.transcript) return undefined;
  // A revision that a later one replaced counts nothing (#2089).
  if (record.superseded === true) return { outcome: 'transcript_superseded' };
  if (w.f.phase !== 'active') return { outcome: 'transcript_ignored' };
  const session = await sessionOf(w, record);
  // Nothing of a call is processed before the group consented.
  if (!hears(session)) return { outcome: 'transcript_without_consent' };
  const text = (record.text ?? '').trim();
  const { segmentId, source, speakerHint } = record.transcript;
  const author = source === 'participant' ? principalKey(record.author) : null;
  const stored = await insertIfAbsent<TranscriptSegment>(
    w.tx,
    SEGMENTS,
    {
      facilitationId: w.f.id,
      sessionId: session?.id ?? null,
      segmentId,
      revision: record.revision,
      eventId: record.eventId,
      source,
      authorPrincipal: author,
      speakerHint: speakerHint ?? null,
      text,
      receivedAt: w.now,
    },
    '(facilitation_id, segment_id, revision)',
  );
  if (!stored) return { outcome: 'duplicate' };
  await retireEarlier(w, segmentId, record.revision);
  await w.event('transcript_segment', author ?? 'transcript', { segmentId, revision: record.revision, source, eventId: record.eventId });
  const t = sessionTexts(w.f.language);
  if (source === 'shared') {
    w.post({
      purpose: 'transcript_shared',
      key: `${segmentId}:${String(record.revision)}`,
      to: 'group',
      deliveryClass: 'droppable',
      versionBound: false,
      requiredPhases: ['active'],
      text: t.spokenShared(text),
      link: { kind: 'transcript', id: `${String(record.revision)}:${segmentId}` },
    });
    return { outcome: 'transcript_shared' };
  }
  // A participant-bound source: that principal is the author, unconfirmed.
  const speaker = author ? await store.getParticipant(w.tx, w.f.id, author) : undefined;
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!speaker || speaker.status !== 'active' || !step) return { outcome: 'transcript_kept' };
  const contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: step.id,
    round: step.round,
    participantPrincipal: speaker.principalId,
    kind: spokenAs(step, text).kind,
    payload: { text, summary: text, segmentId, segmentRevision: record.revision, transcriptSource: 'participant', ...(spokenAs(step, text).ballot ? { ballot: spokenAs(step, text).ballot } : {}) },
    source: 'speech',
    sourceEventId: record.eventId,
    sourceRevision: record.revision,
    sourceOccurredAt: new Date(record.occurredAt),
    status: 'unconfirmed',
    interpreted: true,
    recordedAt: w.now,
  });
  const ack = await insertIfAbsent<Ack>(w.tx, 'plg_omadia_agent_facilitator_acks', { facilitationId: w.f.id, principal: speaker.principalId, kind: 'contribution', refId: contribution.id, detail: { summary: text, segmentId, segmentRevision: record.revision }, createdAt: w.now });
  w.bump();
  await w.event('contribution_recorded', speaker.principalId, { contributionId: contribution.id, status: 'unconfirmed', source: 'speech', segmentId, revision: record.revision });
  w.post({
    purpose: 'echo',
    key: contribution.id,
    to: 'group',
    deliveryClass: 'droppable',
    versionBound: false,
    requiredPhases: ['active'],
    text: t.spokenParticipantEcho(speaker.displayName, text),
    mentions: [mention(speaker)],
    ...(ack ? { link: { kind: 'ack' as const, id: ack.id } } : {}),
  });
  return { outcome: 'transcript_unconfirmed' };
};

/** A participant adopts exactly one revision of a shared segment, by an
 *  authenticated reply to the facilitator's post of it. */
const adoptions: InboundHandler = async ({ w, record, author, command }) => {
  if (record.kind !== 'created' || !author || !record.replyToMessageId || !ADOPT.test(command)) return undefined;
  const segment = await one<TranscriptSegment>(w.tx, `SELECT * FROM ${SEGMENTS} WHERE facilitation_id = $1 AND post_message_id = $2 AND source = 'shared'`, [w.f.id, record.replyToMessageId]);
  if (!segment) return undefined;
  return adopt(w, segment, author, record);
};

export async function adopt(w: Work, segment: TranscriptSegment, author: Participant, record: ConversationMessageRecord): Promise<{ outcome: string }> {
  const t = sessionTexts(w.f.language);
  // An older revision counts nothing.
  const newer = await one<{ revision: number }>(w.tx, `SELECT max(revision) AS revision FROM ${SEGMENTS} WHERE facilitation_id = $1 AND segment_id = $2`, [w.f.id, segment.segmentId]);
  if ((newer?.revision ?? segment.revision) > segment.revision) {
    w.post({ purpose: 'adopt_outdated', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.adoptOutdated(author.displayName), mentions: [mention(author)] });
    return { outcome: 'adopt_outdated' };
  }
  if (w.f.phase !== 'active') return { outcome: 'adopt_not_active' };
  const step = await store.openStepOf(w.tx, w.f.id);
  if (!step) {
    w.post({ purpose: 'adopt_no_step', key: record.eventId, to: 'group', deliveryClass: 'droppable', versionBound: false, text: t.adoptNoStep(author.displayName) });
    return { outcome: 'adopt_no_step' };
  }
  // Adopting the same revision twice creates nothing new.
  const twice = await w.tx.query(
    `SELECT 1 FROM plg_omadia_agent_facilitator_contributions
      WHERE facilitation_id = $1 AND participant_principal = $2 AND payload->>'segmentId' = $3 AND (payload->>'segmentRevision')::int = $4
        AND (payload->>'adoptedFromTranscript')::boolean`,
    [w.f.id, author.principalId, segment.segmentId, segment.revision],
  );
  if (twice.rows.length > 0) return { outcome: 'adopt_duplicate' };
  const reading = spokenAs(step, segment.text);
  if (reading.ballot) {
    // A vote: one effective ballot per person, as with any other input.
    const ballot = await recordBallot(w, { record: { ...record, text: segment.text }, author, step, ballot: reading.ballot as unknown as Ballot, interpreted: false, source: 'message' });
    await w.tx.query(
      `UPDATE plg_omadia_agent_facilitator_contributions SET payload = payload || $2::jsonb WHERE id = $1`,
      [ballot.id, JSON.stringify({ segmentId: segment.segmentId, segmentRevision: segment.revision, adoptedFromTranscript: true })],
    );
    await w.event('contribution_adopted', author.principalId, { contributionId: ballot.id, segmentId: segment.segmentId, revision: segment.revision, eventId: record.eventId });
    return { outcome: 'adopted' };
  }
  const contribution: Contribution = await store.addContribution(w.tx, {
    facilitationId: w.f.id,
    stepId: step.id,
    round: step.round,
    participantPrincipal: author.principalId,
    kind: spokenAs(step, segment.text).kind,
    payload: { text: segment.text, summary: segment.text, segmentId: segment.segmentId, segmentRevision: segment.revision, adoptedFromTranscript: true, ...(spokenAs(step, segment.text).ballot ? { ballot: spokenAs(step, segment.text).ballot } : {}) },
    // The adoption is the authenticated input: its message is the source.
    source: 'message',
    sourceMessageId: record.messageId,
    sourceRevision: record.revision,
    sourceEventId: record.eventId,
    sourceOccurredAt: new Date(record.occurredAt),
    status: 'valid',
    interpreted: false,
    recordedAt: w.now,
  });
  w.bump();
  await w.event('contribution_adopted', author.principalId, { contributionId: contribution.id, segmentId: segment.segmentId, revision: segment.revision, eventId: record.eventId });
  w.post({ purpose: 'adopted', key: contribution.id, to: 'group', deliveryClass: 'droppable', versionBound: false, requiredPhases: ['active'], text: t.adopted(author.displayName) });
  return { outcome: 'adopted' };
}

/** "adopted from the transcript" for the protocol of a contribution. */
export const adoptedMarker = (c: Pick<Contribution, 'payload'>, language: 'de' | 'en'): string | undefined =>
  c.payload['adoptedFromTranscript'] === true ? sessionTexts(language).adoptedMarker : undefined;

export function installTranscript(): void {
  registerInboundHandler(segments, PRIORITY.revisions + 1);
  registerInboundHandler(adoptions, PRIORITY.acknowledgements + 1);
}
