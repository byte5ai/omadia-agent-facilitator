// Everything the engine itself says to people, in English. `de.ts` mirrors
// this file key for key (the type is taken from here).
//
// These texts are written by the engine, not by a model: a handshake, a
// status or a report must be complete and exact every time.

export interface ResultInput {
  goal: string;
  decisions: string[];
  /** Next steps with owner and due date. */
  actions?: string[];
  /** Open points from the parking lot. */
  open?: string[];
  /** Set when the deadline closed it before everybody contributed. */
  atDeadline?: { contributed: number; of: number };
}

export const en = {
  list: (items: readonly string[]): string => {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
  },

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
      ...(r.actions && r.actions.length > 0 ? ['Next steps:', ...r.actions.map((a) => `- ${a}`)] : []),
      ...(r.open && r.open.length > 0 ? ['Open points:', ...r.open.map((o) => `- ${o}`)] : []),
      ...(r.atDeadline ? [`The deadline has passed; ${String(r.atDeadline.contributed)} of ${String(r.atDeadline.of)} contributed, and this is the result of what was contributed.`] : []),
      'This facilitation is complete. Thank you.',
    ].join('\n'),
  abortTie: (tied: string): string => `the deadline passed with the vote level between ${tied}`,
  abortObjection: (objections: string): string => `the deadline passed with an objection standing (${objections})`,
  abortOpenItems: (items: string): string => `the deadline passed with these still open: ${items}`,
  abortNothing: (): string => 'the deadline passed and the definition of done was not met',

  reminderGroup: (open: number, deadline: string | undefined): string =>
    `Reminder: ${open === 1 ? 'one contribution is' : `${String(open)} contributions are`} still open.${deadline ? ` Deadline: ${deadline}.` : ''} Ask "status" for the details.`,
  reminderDirect: (name: string, goal: string, deadline: string | undefined): string =>
    `Hello ${name}, your contribution to "${goal}" is still open.${deadline ? ` Deadline: ${deadline}.` : ''} Please answer in the group; I cannot take contributions here.`,
  directUnreachable: (): string =>
    'I cannot reach everybody privately here (my app is not installed for everyone). Reminders therefore stay in this group, without names.',
  abortJobFailed: (): string => 'an internal step failed repeatedly and could not be completed',

  // ── process ──────────────────────────────────────────────────────────────
  stepKinds: {
    open: 'Opening',
    collect: 'Collect',
    discuss: 'Discuss',
    cluster: 'Cluster',
    prioritise: 'Prioritise',
    decide: 'Decide',
    assign: 'Assign',
    close: 'Close',
  },
  stepInstruction: {
    open: '',
    collect: 'Write what you want to bring in, one point per message.',
    discuss: 'Say what speaks for and against, and what matters to you about it.',
    cluster: 'I will propose groups for what was collected; you confirm or correct them.',
    prioritise: '',
    decide: '',
    assign: '',
    close: '',
  },
  agendaLine: (position: number, title: string, timebox: number | null): string =>
    `${String(position)}. ${title}${timebox ? ` (${String(timebox)} min)` : ''}`,
  stepOpened: (position: number, total: number, title: string, instruction: string, until: string | undefined): string =>
    [`Step ${String(position)} of ${String(total)}: ${title}.`, instruction, until ? `Timebox until ${until}.` : ''].filter((l) => l !== '').join(' '),
  stepClosed: (title: string): string => `"${title}" is closed.`,
  stepExtended: (title: string, minutes: number, until: string): string => `"${title}" is extended by ${String(minutes)} minutes, until ${until}.`,
  timeboxOver: (title: string, contributions: number, people: number, of: number): string =>
    `The timebox for "${title}" is over. So far: ${String(contributions)} contribution${contributions === 1 ? '' : 's'} from ${String(people)} of ${String(of)} people.`,
  timeboxOverVote: (title: string, open: number): string =>
    `The timebox for "${title}" is over; ${open === 1 ? 'one contribution is' : `${String(open)} contributions are`} still open. The step stays open until it is decided.`,
  needOptions: (title: string): string => `"${title}" needs its options before you can vote. I will put them to you in a moment.`,
  decisionSet: (title: string): string => `Now deciding: ${title}.`,

  proposalKinds: {
    step_close: (title: string): string => `close "${title}" and move on`,
    clusters: (lines: readonly string[]): string => `group what was collected like this:\n${lines.map((l) => `- ${l}`).join('\n')}`,
    summary: (text: string): string => `take this summary into the record:\n${text}`,
    decision: (statement: string): string => `record this decision: ${statement}`,
    close: (summary: string): string => `close the facilitation with this summary:\n${summary}`,
  },
  proposalAnnounce: (what: string, until: string, extendable: boolean): string =>
    `Proposal: ${what}\nIt holds if nobody objects until ${until}, or at once when everybody agreed. Write "agreed" or "objection: <your reason>"${extendable ? ', or "extend 10" for ten more minutes' : ''}.`,
  proposalAccepted: (what: string): string => `Accepted, nobody objected: ${what}`,
  proposalRejected: (what: string, objections: readonly string[]): string =>
    `Not accepted: ${what}\nStanding objection${objections.length === 1 ? '' : 's'}:\n${objections.map((o) => `- ${o}`).join('\n')}`,
  proposalObjection: (name: string, reason: string): string =>
    `${name} objects: ${reason}. The proposal does not hold while this stands. ${name}, write "agreed" if it is resolved for you.`,
  proposalBusy: (): string => 'One proposal at a time: the open one is decided first.',

  silentInviteDirect: (name: string, title: string): string =>
    `Hello ${name}, we are about to close "${title}". If you would like to add something, the group would value hearing it. Please write it in the group; I cannot take contributions here.`,
  silentInviteGroup: (title: string): string =>
    `Before we close "${title}": whoever has not had the chance yet is welcome to add something now.`,
  parked: (topic: string): string => `Parked for later, so we stay on the current step: ${topic}`,

  actionPrompt: (owner: string, number: number, description: string, due: string): string =>
    `${owner}, action item #${String(number)} is proposed for you: ${description}, due ${due}. Reply "yes" to take it or "no" to decline, here in the group.`,
  actionConfirmed: (owner: string, number: number, description: string, due: string): string =>
    `Action item #${String(number)}: ${description}. Owner: ${owner}, due ${due}.`,
  actionDeclined: (owner: string, number: number, description: string): string =>
    `${owner} declined action item #${String(number)} (${description}). It has no owner yet.`,
  actionReminder: (owner: string, number: number, description: string, due: string): string =>
    `Hello ${owner}, action item #${String(number)} is due ${due}: ${description}. When it is done, write "done ${String(number)}" in the group.`,
  actionReminderGroup: (owner: string, number: number, description: string, due: string): string =>
    `${owner}, action item #${String(number)} is due ${due}: ${description}. Write "done ${String(number)}" when it is done.`,
  actionDone: (owner: string, number: number, description: string): string => `Done, thank you ${owner}: #${String(number)} ${description}`,
  actionNotYours: (name: string, number: number): string => `${name}, action item #${String(number)} is not yours to close.`,
  actionStatus: (lines: readonly string[]): string => `Status of the action items:\n${lines.map((l) => `- ${l}`).join('\n')}`,
  actionLine: (number: number, description: string, owner: string, due: string, status: string): string =>
    `#${String(number)} ${description} (${owner}, due ${due}): ${status}`,
  actionStatusWords: { proposed: 'waiting for the owner', confirmed: 'open', done: 'done', declined: 'declined' },
  followupEnded: (): string => 'The follow-up of the action items has ended. I am no longer reading this conversation.',

  closeSummary: (s: { decisions: readonly string[]; actions: readonly string[]; open: readonly string[] }): string =>
    [
      'Decisions:',
      ...(s.decisions.length > 0 ? s.decisions.map((d) => `- ${d}`) : ['- none']),
      'Next steps:',
      ...(s.actions.length > 0 ? s.actions.map((a) => `- ${a}`) : ['- none']),
      'Open points:',
      ...(s.open.length > 0 ? s.open.map((o) => `- ${o}`) : ['- none']),
    ].join('\n'),

  protocol: {
    title: (goal: string): string => `Protocol: ${goal}`,
    facilitator: 'Facilitator',
    initiator: 'Started by',
    participants: 'Participants',
    left: 'left',
    definitionOfDone: 'Definition of done',
    version: 'version',
    agenda: 'Agenda',
    decisions: 'Decisions',
    rationale: 'Rationale',
    clusters: 'Clusters confirmed by the group',
    summaries: 'Summaries confirmed by the group',
    contributions: 'Contributions',
    actions: 'Action items',
    parked: 'Open points (parking lot)',
    changes: 'Changes to the rules',
    capabilities: 'Use of scoped capabilities',
    outcome: 'Outcome',
    none: 'none',
  },

  // ── transparency ─────────────────────────────────────────────────────────
  formats: {
    decision: 'Decision',
    prioritisation: 'Prioritisation',
    assignment: 'Role or task assignment',
    ideas: 'Idea collection',
    retrospective: 'Retrospective',
    alignment: 'Alignment',
    custom: 'Agreed with you',
  },
  handshakeFull: (h: {
    facilitator: string;
    initiator: string;
    goal: string;
    definitionOfDone: string;
    format: string;
    agenda: string[];
    rules: string[];
    participants: string[];
    deadline?: string;
    reminders?: string;
    followUp: boolean;
    changeWindowHours: number;
    perception?: string;
    notes: string[];
  }): string =>
    [
      `Hello, I am ${h.facilitator} and I facilitate this conversation from now on. I am neutral: I structure the way, you decide. I never vote and I treat every contribution the same.`,
      `Started by: ${h.initiator}`,
      `Goal: ${h.goal}`,
      `Done when (version 1): ${h.definitionOfDone}`,
      `Format: ${h.format}`,
      ...(h.agenda.length > 0 ? ['Agenda:', ...h.agenda] : []),
      ...h.rules,
      `Participants: ${h.participants.join(', ')}`,
      h.deadline ? `Deadline: ${h.deadline}` : 'Deadline: none agreed',
      ...(h.reminders ? [`Reminders: ${h.reminders} before the deadline, only while contributions are open; in the group without names, and privately to the people concerned where I can reach them.`] : []),
      h.followUp
        ? 'Action items: I remind each owner before the due date and stop when everything is done or past due.'
        : 'Action items: no follow-up after the close, unless you ask for it.',
      `Changes: anyone can propose to change the definition of done, the method or the deadline. A change holds when nobody objects within ${String(h.changeWindowHours)} hours (never past the deadline), and I announce it with its new version.`,
      ...(h.perception ? [h.perception] : []),
      ...h.notes,
      `Report: the result goes to this group first, then to ${h.initiator} with the protocol. ${h.initiator} receives nothing you were not told about.`,
      'Ask "status" at any time. "stop" ends the facilitation.',
    ].join('\n'),
  reminderTimes: (hours: readonly number[]): string => hours.map((h) => `${String(h)} h`).join(', '),

  status: (s: {
    phase: string;
    goal: string;
    step?: string;
    dodVersion: number;
    definitionOfDone: string;
    contributed: string[];
    missing: string[];
    tally?: string;
    provisional: boolean;
    proposal?: string;
    deadline?: string;
  }): string =>
    [
      `Status: ${s.phase}. Goal: ${s.goal}`,
      ...(s.step ? [`Current step: ${s.step}`] : []),
      `Definition of done (version ${String(s.dodVersion)}): ${s.definitionOfDone}`,
      `Contributed: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'nobody yet'}`,
      `Still open: ${s.missing.length > 0 ? s.missing.join(', ') : 'nobody'}`,
      ...(s.tally ? [`${s.provisional ? 'Provisional tally' : 'Tally'}: ${s.tally}`] : []),
      ...(s.proposal ? [`Open proposal: ${s.proposal}`] : []),
      s.deadline ? `Deadline: ${s.deadline}` : 'Deadline: none',
    ].join('\n'),

  initiatorReport: (name: string, outcome: string, protocol: string): string =>
    `Hello ${name}, you started this facilitation, so here is the report. It contains nothing the group was not told.\n\n${outcome}\n\n${protocol}`,
  initiatorUnreachable: (name: string): string => `I could not send the report to ${name} privately. It is all here in the group.`,

  change: {
    definition_of_done: (text: string, version: number): string => `change the definition of done to (version ${String(version)}): ${text}`,
    deadline: (when: string): string => `move the deadline to ${when}`,
    close_rule: (rule: 'all_contributed' | 'at_deadline'): string =>
      rule === 'at_deadline' ? 'evaluate at the deadline instead of when everybody has contributed' : 'evaluate as soon as everybody has contributed instead of at the deadline',
    method: (title: string, rules: string): string => `change how "${title}" is decided. ${rules}`,
    dod_met: (summary: string): string => `the definition of done is met, and we close with this:\n${summary}`,
  },
  changed: {
    definition_of_done: (version: number, text: string): string => `The definition of done is now version ${String(version)}: ${text}`,
    deadline: (when: string): string => `The deadline is now ${when}. Reminders move with it.`,
    close_rule: (rule: 'all_contributed' | 'at_deadline'): string =>
      rule === 'at_deadline' ? 'From now on the result is evaluated at the deadline.' : 'From now on the result is evaluated as soon as everybody has contributed.',
    method: (title: string, rules: string): string => `"${title}" is now decided like this. ${rules}`,
  },
  actAgain: (names: string): string => `Contributions made under the old rules no longer fit. Please contribute again: ${names}.`,

  phase: {
    configuring: 'being set up',
    active: 'running',
    concluding: 'concluding',
    closed: 'closed',
    aborted: 'ended without a result',
  },
};

export type Texts = typeof en;
