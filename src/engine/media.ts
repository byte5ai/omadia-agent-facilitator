// Media-adaptive moderation (spec 6.1): what a facilitator can perceive and
// do is limited by the channel and its media, not by the facilitator. Every
// technique is mapped to the best means the session's capability snapshot
// offers; a missing capability is never an error, the next best means is
// chosen and the facilitator says what it cannot do.
//
// Pure functions over a snapshot. More capabilities mean more active
// moderation without any change to the facilitator.

import type { SessionCapabilitySnapshot, SessionInputCapability, SessionOutputCapability } from '@omadia/plugin-api';

import type { Texts } from '../texts/index.js';

/** Text in, text out: what every channel offers. */
export function baselineSnapshot(channelType: string, conversationId: string, capturedAt: Date): SessionCapabilitySnapshot {
  return { channelType, conversationId, modality: 'chat', inputs: ['text'], outputs: ['text'], capturedAt: capturedAt.toISOString() };
}

export interface Means {
  /** A live vote: a poll card when the channel has polls and returns their
   *  answers, otherwise ballots written in the chat. */
  vote: 'poll' | 'chat_ballots';
  /** Time-keeping: a spoken cue, a pinned timer, or a post. */
  timekeeping: 'voice' | 'pinned_timer' | 'post';
  /** Speaking order: raised hands, or a round-robin list in the chat. */
  speakingOrder: 'hand_raise' | 'round_robin';
  /** Inviting a silent voice: privately, or with a neutral line in the group. */
  invitation: 'private_message' | 'group_neutral';
  /** A visible agenda: a pinned surface, or a post. */
  agenda: 'pinned' | 'post';
  /** Contributions: also from transcribed speech, or from text only. */
  contributions: 'text_and_speech' | 'text';
  /** Addressing somebody: a real mention, or the plain name. */
  addressing: 'mention' | 'name';
}

export function planMeans(snapshot: Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs'>): Means {
  const input = (c: SessionInputCapability): boolean => snapshot.inputs.includes(c);
  const output = (c: SessionOutputCapability): boolean => snapshot.outputs.includes(c);
  return {
    vote: (output('polls') || output('cards')) && input('card_answers') ? 'poll' : 'chat_ballots',
    timekeeping: output('voice') ? 'voice' : output('pinned_surface') ? 'pinned_timer' : 'post',
    speakingOrder: input('hand_raise') ? 'hand_raise' : 'round_robin',
    invitation: output('private_messages') ? 'private_message' : 'group_neutral',
    agenda: output('pinned_surface') ? 'pinned' : 'post',
    contributions: input('transcribed_speech') ? 'text_and_speech' : 'text',
    addressing: output('mentions') ? 'mention' : 'name',
  };
}

const INPUT_ORDER: readonly SessionInputCapability[] = ['text', 'message_edits', 'reactions', 'card_answers', 'presence', 'hand_raise', 'transcribed_speech', 'shared_documents'];

/** "I read the chat and the polls; I do not hear the call": what the
 *  facilitator says in the handshake so nobody assumes more. Only what a
 *  group would otherwise expect is named as missing. */
export function perceptionStatement(snapshot: Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs' | 'modality'>, t: Texts): string {
  const can = INPUT_ORDER.filter((c) => snapshot.inputs.includes(c)).map((c) => t.perceive[c]);
  const cannot: string[] = [];
  const live = snapshot.modality !== 'chat';
  if (live && !snapshot.inputs.includes('transcribed_speech')) cannot.push(t.perceive.not.transcribed_speech);
  if (live && !snapshot.inputs.includes('hand_raise')) cannot.push(t.perceive.not.hand_raise);
  if (live && !snapshot.inputs.includes('presence')) cannot.push(t.perceive.not.presence);
  if (!snapshot.inputs.includes('card_answers')) cannot.push(t.perceive.not.card_answers);
  if (!snapshot.outputs.includes('private_messages')) cannot.push(t.perceive.not.private_messages);
  return t.perceive.sentence(can.length > 0 ? can : [t.perceive.text], cannot);
}

export interface SnapshotDiff {
  gained: SessionInputCapability[];
  lost: SessionInputCapability[];
  changed: boolean;
}

export function diffSnapshots(
  before: Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs'> | undefined,
  after: Pick<SessionCapabilitySnapshot, 'inputs' | 'outputs'>,
): SnapshotDiff {
  const old = before ?? { inputs: [], outputs: [] };
  const gained = after.inputs.filter((c) => !old.inputs.includes(c));
  const lost = old.inputs.filter((c) => !after.inputs.includes(c));
  const outputsChanged = after.outputs.length !== old.outputs.length || after.outputs.some((c) => !old.outputs.includes(c));
  return { gained, lost, changed: gained.length > 0 || lost.length > 0 || outputsChanged };
}

/** The means of the session, as the facilitator's turn is told them. */
export function describeMeans(means: Means): string[] {
  return [
    means.vote === 'poll' ? 'Votes: the engine posts a poll card; chat ballots count as well.' : 'Votes: ballots written in the chat (no polls here).',
    means.timekeeping === 'voice'
      ? 'Time: spoken cues are possible.'
      : means.timekeeping === 'pinned_timer'
        ? 'Time: the engine keeps a visible timer.'
        : 'Time: the engine posts the timebox and a time check.',
    means.speakingOrder === 'hand_raise' ? 'Speaking order: by raised hands.' : 'Speaking order: no raised hands here; use facilitation_speaking_order for a round-robin list.',
    means.invitation === 'private_message' ? 'Silent voices: invited privately by the engine.' : 'Silent voices: no private messages here; the engine invites with a neutral line in the group.',
    means.contributions === 'text_and_speech'
      ? 'Speech: a transcript with speakers is available. Use facilitation_record_spoken only after the group consented; it stays unconfirmed until the person confirms in the chat.'
      : 'Speech: you do not hear the call. Only what is written counts; say so if somebody assumes otherwise.',
  ];
}
