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

  phase: {
    configuring: 'being set up',
    active: 'running',
    concluding: 'concluding',
    closed: 'closed',
    aborted: 'ended without a result',
  },
};

export type Texts = typeof en;
