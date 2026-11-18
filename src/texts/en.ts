// Everything the engine itself says to people, in English. `de.ts` mirrors
// this file key for key (the type is taken from here).
//
// These texts are written by the engine, not by a model: a handshake, a
// status or a report must be complete and exact every time.

export interface HandshakeBasics {
  facilitator: string;
  initiator: string;
  goal: string;
  definitionOfDone: string;
  participants: string[];
  deadline?: string;
  /** How to contribute, one line per rule of the method. */
  rules?: string[];
}

export interface ResultInput {
  goal: string;
  decisions: string[];
  /** Set when the deadline closed it before everybody contributed. */
  atDeadline?: { contributed: number; of: number };
}

export const en = {
  list: (items: readonly string[]): string => {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
  },

  handshake: (h: HandshakeBasics): string =>
    [
      `Hello, I am ${h.facilitator} and I facilitate this conversation from now on. I am neutral: I structure the way, you decide.`,
      `Started by: ${h.initiator}`,
      `Goal: ${h.goal}`,
      `Done when: ${h.definitionOfDone}`,
      `Participants: ${h.participants.join(', ')}`,
      ...(h.deadline ? [`Deadline: ${h.deadline}`] : []),
      ...(h.rules ?? []),
      `The result goes to this group first, then to ${h.initiator} with the protocol. ${h.initiator} receives nothing you were not told about.`,
      'Ask "status" at any time. "stop" ends the facilitation.',
    ].join('\n'),

  echoRecorded: (name: string, summary: string): string => `Recorded for you, ${name}: ${summary}`,
  echoInterpreted: (name: string, summary: string): string =>
    `${name}, I read your message as: ${summary}. Reply "yes" (or react with 👍) to confirm, or correct me. It counts once you confirmed.`,
  echoChanged: (name: string, summary: string): string => `Changed for you, ${name}: ${summary}`,
  echoConfirmed: (name: string, summary: string): string => `Confirmed, ${name}: ${summary}`,
  echoDeclined: (name: string): string => `Understood, ${name}: I did not record that.`,
  echoWithdrawn: (name: string): string => `${name}, you deleted your message, so I withdrew the contribution it carried.`,
  whichConfirmation: (name: string, open: readonly string[]): string =>
    `${name}, several things wait for your confirmation. Please reply directly to the one you mean:\n${open.map((o) => `- ${o}`).join('\n')}`,

  stopped: (name: string): string =>
    `${name} asked to stop. The facilitation ends here without a result. Nothing further will be sent.`,
  aborted: (reason: string): string => `This facilitation ends without a result. Reason: ${reason}`,

  joined: (name: string, goal: string): string =>
    `Welcome, ${name}. This conversation is being facilitated. Goal: ${goal}. You count as a participant from now on; ask "status" for where we are.`,
  left: (name: string): string => `${name} has left the conversation. Their contributions so far stay counted.`,
  initiatorLeft: (name: string): string =>
    `${name} started this facilitation and has left the conversation. From now on ${name} receives neither further contributions nor the report.`,

  statusBasics: (s: { phase: string; goal: string; dodVersion: number; contributed: string[]; missing: string[]; deadline?: string }): string =>
    [
      `Status: ${s.phase}. Goal: ${s.goal}`,
      `Definition of done: version ${String(s.dodVersion)}`,
      `Contributed: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'nobody yet'}`,
      `Still open: ${s.missing.length > 0 ? s.missing.join(', ') : 'nobody'}`,
      ...(s.deadline ? [`Deadline: ${s.deadline}`] : []),
    ].join('\n'),

  words: { abstention: 'abstention', consent: 'consent', objection: 'objection', declined: 'declined' },

  options: (options: readonly { key: string; label: string }[]): string => options.map((o) => `${o.key} = ${o.label}`).join(', '),

  rules: {
    ranked: (options: string, points: readonly number[]): string =>
      `How to vote: rank the options, best first, e.g. "A > C > B". Options: ${options}. Points per rank: ${points.join('/')}; a partial ranking is fine, ranks you leave out score 0.`,
    single: (options: string): string => `How to vote: write the one option you choose, e.g. "B". Options: ${options}.`,
    approval: (options: string): string => `How to vote: write every option you approve of, e.g. "A, C". Options: ${options}.`,
    consent: (statement: string): string =>
      `Proposal: ${statement}. Write "consent" if you can go along with it, or "objection: <your reason>". It passes when no objection stands.`,
    assignment: (items: string): string =>
      `To be assigned: ${items}. Take one with "I take A", or propose somebody with "A: Name". A name counts only when that person said yes themselves.`,
    common: (closeRule: 'all_contributed' | 'at_deadline'): string =>
      `"abstain" counts as a contribution. You can change your contribution ${closeRule === 'at_deadline' ? 'until the deadline' : 'until everybody has contributed'} by writing a new one or editing your message. All contributions are open. A tie goes to a runoff among the tied options.`,
  },

  hint: {
    duplicate_option: (detail: string): string => `an option appears twice (${detail}). Please name each option once.`,
    duplicate_rank: (detail: string): string => `a rank is used twice (${detail}). Please give each option its own rank.`,
    bad_rank: (detail: string): string => `the ranks must run 1, 2, 3 without gaps (you wrote ${detail}).`,
    unknown_option: (detail: string): string => `I do not know this option: ${detail}. Which of the options do you mean?`,
    too_many_options: (detail: string): string => `this vote takes exactly one option (you named ${detail}). Which one?`,
    reason_required: (): string => `an objection needs its reason: "objection: <reason>". What is yours?`,
    unknown_person: (detail: string): string => `I cannot match "${detail}" to a participant. Who do you mean?`,
    ambiguous_person: (detail: string): string => `"${detail}" fits more than one participant. Please use the full name.`,
  },

  nominated: (nominee: string, by: string, item: string): string =>
    `${nominee}, ${by} proposes you for ${item}. Reply "yes" to take it or "no" to decline, here in the group.`,
  nominationAccepted: (nominee: string, item: string): string => `${nominee} takes ${item}.`,
  nominationDeclined: (nominee: string, item: string): string => `${nominee} declined ${item}. It is open again.`,
  itemTaken: (name: string, item: string, holder: string): string => `${name}, ${item} is already taken by ${holder}.`,

  runoff: (tied: string, until: string): string =>
    `The vote ended level between ${tied}. Runoff among these, same method, until ${until}. Please vote again.`,
  notInRunoff: (name: string, options: string): string => `${name}, the runoff is only between ${options}. Please choose among these.`,
  objectionStands: (objections: readonly string[]): string =>
    `An objection stands, so the proposal has not passed:\n${objections.map((o) => `- ${o}`).join('\n')}\nLet us look at what would make it workable.`,
  putAgain: (statement: string): string => `Amended proposal: ${statement}. Write "consent" or "objection: <your reason>".`,

  decided: {
    winner: (title: string, option: string, scores: string): string => `${title}: ${option} (${scores})`,
    consent: (statement: string): string => `Agreed by consent: ${statement}`,
    assignment: (title: string, pairs: string): string => `${title}: ${pairs}`,
  },

  result: (r: ResultInput): string =>
    [
      `Result for "${r.goal}":`,
      ...r.decisions.map((d) => `- ${d}`),
      ...(r.atDeadline ? [`The deadline has passed; ${String(r.atDeadline.contributed)} of ${String(r.atDeadline.of)} contributed, and this is the result of what was contributed.`] : []),
      'This facilitation is complete. Thank you.',
    ].join('\n'),
  abortTie: (tied: string): string => `the deadline passed with the vote level between ${tied}`,
  abortObjection: (objections: string): string => `the deadline passed with an objection standing (${objections})`,
  abortOpenItems: (items: string): string => `the deadline passed with these still open: ${items}`,
  abortNothing: (): string => 'the deadline passed and the definition of done was not met',

  phase: {
    configuring: 'being set up',
    active: 'running',
    concluding: 'concluding',
    closed: 'closed',
    aborted: 'ended without a result',
  },
};

export type Texts = typeof en;
