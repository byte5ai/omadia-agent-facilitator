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
  /** What the group answered on its questionnaire, one line per question. */
  answers?: string[];
  /** The title of a questionnaire nobody answered. */
  unanswered?: string;
  /** Set when the deadline closed it before everybody contributed. */
  atDeadline?: { contributed: number; of: number };
}

export const en = {
  list: (items: readonly string[]): string => {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
  },

  echoRecorded: (name: string, summary: string): string => `Recorded for you, ${name}: ${summary}`,
  /** A questionnaire answer: who, and how many have answered. Not what. */
  questionnaireAnswered: (name: string, answered: number, of: number, changed: boolean): string =>
    `${changed ? 'Answer changed by' : 'Answer recorded from'} ${name} (${String(answered)} of ${String(of)})`,
  questionnaireNoAnswer: 'no answer',
  echoInterpreted: (name: string, summary: string): string =>
    `${name}, I read your message as: ${summary}. Reply "yes" (or react with 👍) to confirm, or correct me. It counts once you confirmed.`,
  /** A card answer the platform did not verify: its owner confirms it here. */
  echoUnverifiedCard: (name: string, summary: string): string =>
    `${name}, an answer on the card came in under your name, and the channel could not confirm that it is yours: ${summary}. Reply "yes" (or react with 👍) to confirm, or correct me. It counts once you confirmed.`,
  echoChanged: (name: string, summary: string): string => `Changed for you, ${name}: ${summary}`,
  echoConfirmed: (name: string, summary: string): string => `Confirmed, ${name}: ${summary}`,
  echoDeclined: (name: string): string => `Understood, ${name}: I did not record that.`,
  echoWithdrawn: (name: string): string => `${name}, you deleted your message, so I withdrew the contribution it carried.`,
  whichConfirmation: (name: string, open: readonly string[]): string =>
    `${name}, several things wait for your confirmation. Please reply directly to the one you mean:\n${open.map((o) => `- ${o}`).join('\n')}`,

  stopped: (name: string): string =>
    `${name} asked to stop. The facilitation ends here without a result. Nothing further will be sent.`,
  aborted: (reason: string): string => `This facilitation ends without a result. Reason: ${reason}`,

  /** What a question card says (the channel words its own buttons). */
  card: {
    chatToo: 'An answer in the chat counts too; your newest answer counts.',
    stepOf: (position: number, total: number): string => `Step ${String(position)} of ${String(total)}.`,
    voteOnCard: 'You vote on the card; an answer in the chat counts too.',
    rank: 'Rank the options, best first.',
    rankLabel: (rank: number, points: number | undefined): string => {
      const ordinal = `${String(rank)}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} place`;
      return points === undefined ? ordinal : `${ordinal} (${String(points)} point${points === 1 ? '' : 's'})`;
    },
    single: 'Choose one option.',
    approval: 'Choose every option you can go along with.',
    idea: 'Your idea (one per submission)',
    superseded: 'Replaced by a new version of this vote. Please answer on the new card.',
    supersededQuestionnaire: 'Replaced by a new questionnaire. Please answer on the new card.',
    closed: (when: string): string => `Closed on ${when}.`,
    numberExpected: (min: number | undefined, max: number | undefined): string =>
      `A number only, for example 15${min !== undefined && max !== undefined ? `, between ${String(min)} and ${String(max)}` : min !== undefined ? `, at least ${String(min)}` : max !== undefined ? `, at most ${String(max)}` : ''}.`,
    dateExpected: 'A date, for example 2026-11-24 or 24.11.2026.',
    notAsExpected: (label: string, expected: string): string => `I could not use your answer to "${label}". I need: ${expected.charAt(0).toLowerCase()}${expected.slice(1)} Please answer again on the card; nothing of that submission was recorded.`,
  },

  /** A participant the channel gave no name for (until a message carries one). */
  unnamedPerson: 'a participant without a name',
  /** In place of an id nobody here has a name for. */
  someone: 'someone here',

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
      ...(r.answers && r.answers.length > 0 ? ['Answers:', ...r.answers.map((a) => `- ${a}`)] : []),
      ...(r.unanswered !== undefined ? [`Nobody answered the questionnaire "${r.unanswered}", so there are no answers to report.`] : []),
      ...(r.actions && r.actions.length > 0 ? ['Next steps:', ...r.actions.map((a) => `- ${a}`)] : []),
      ...(r.open && r.open.length > 0 ? ['Open points:', ...r.open.map((o) => `- ${o}`)] : []),
      ...(r.atDeadline ? [`The deadline has passed; ${String(r.atDeadline.contributed)} of ${String(r.atDeadline.of)} contributed, and this is the result of what was contributed.`] : []),
      'This facilitation is complete. Thank you.',
    ].join('\n'),
  abortTie: (tied: string): string => `the deadline passed with the vote level between ${tied}`,
  abortObjection: (objections: string): string => `the deadline passed with an objection standing (${objections})`,
  abortOpenItems: (items: string): string => `the deadline passed with these still open: ${items}`,
  abortNoVotes: (): string => 'the deadline passed and nobody voted',
  abortOnlyAbstentions: (): string => 'the deadline passed and nobody voted for an option',
  abortNothing: (): string => 'the deadline passed and the definition of done was not met',

  reminderGroup: (open: number, deadline: string | undefined): string =>
    `Reminder: ${open === 1 ? 'one contribution is' : `${String(open)} contributions are`} still open.${deadline ? ` Deadline: ${deadline}.` : ''} Ask "status" for the details.`,
  /** Nobody can be counted as missing: the member list is unknown. */
  reminderGroupOpen: (deadline: string | undefined): string =>
    `Reminder: this vote is open${deadline ? ` until ${deadline}` : ''}. Whoever has not contributed yet can still do so.`,
  reminderDirect: (name: string, goal: string, deadline: string | undefined): string =>
    `Hello ${name}, your contribution to "${goal}" is still open.${deadline ? ` Deadline: ${deadline}.` : ''} Please answer in the group; I cannot take contributions here.`,
  directUnreachable: (): string =>
    'I cannot reach everybody privately here (my app is not installed for everyone). Reminders therefore stay in this group, without names.',
  abortJobFailed: (): string => 'an internal step failed repeatedly and could not be completed',
  abortNoSubscription: (): string => 'I can no longer read this conversation',
  resumed: (): string =>
    'I could not read this conversation for a while. The facilitation continues. If you wrote something in the meantime that should count, please post it again.',

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
  moveOnHint: { collect: 'Write "next" when everything is collected.', discuss: 'Write "next" when everything has been said.' },
  afterInviteHint: (): string => 'After that, write "next" to close this step.',
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
    vote_close: (title: string, cast: number, of: number): string => `close the vote on "${title}" now and count the ${String(cast)} of ${String(of)} votes cast`,
    clusters: (lines: readonly string[]): string => `group what was collected like this:\n${lines.map((l) => `- ${l}`).join('\n')}`,
    summary: (text: string): string => `take this summary into the record:\n${text}`,
    decision: (statement: string): string => `record this decision: ${statement}`,
    close: (summary: string): string => `close the facilitation with this summary:\n${summary}`,
    media_consent: (what: string): string => what,
  },
  proposalAnnounce: (what: string, until: string, extendable: boolean, mustReply: boolean): string =>
    `Proposal: ${what}\nIt holds if nobody objects until ${until}, or at once when everybody agreed. ${mustReply ? 'Reply to this message with' : 'Write'} "agreed" or "objection: <your reason>"${extendable ? ', or "extend 10" for ten more minutes' : ''}.${mustReply ? ' Only a reply to this message (or a 👍 on it) counts for it.' : ''}`,
  proposalAccepted: (what: string): string => `Accepted, nobody objected: ${what}`,
  proposalRejected: (what: string, objections: readonly string[]): string =>
    `Not accepted: ${what}\nStanding objection${objections.length === 1 ? '' : 's'}:\n${objections.map((o) => `- ${o}`).join('\n')}`,
  proposalObjection: (name: string, reason: string): string =>
    `${name} objects: ${reason}. The proposal does not hold while this stands. ${name}, write "agreed" if it is resolved for you.`,
  proposalBusy: (): string => 'One proposal at a time: the open one is decided first.',
  voteCloses: (rule: 'all_contributed' | 'at_deadline', when: string | undefined): string =>
    rule === 'at_deadline'
      ? `This vote closes at the deadline${when ? ` (${when})` : ''}.`
      : `This vote closes when everybody has voted${when ? `, at the latest at the deadline (${when})` : ''}.`,
  voteCloseHow: (): string => 'To close it earlier, write "next": I then ask the group, and it closes when nobody objects.',
  voteCloseNeedsVotes: (): string => 'Nobody has voted yet, so there is nothing to count. Once votes are in, write "next" to close it earlier; I then ask the group.',

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
    `Hello ${owner}, action item #${String(number)} is due ${due}: ${description}. When it is done, answer me here with "done ${String(number)}", or write it in the group and mention me.`,
  actionReminderGroup: (owner: string, number: number, description: string, due: string): string =>
    `${owner}, action item #${String(number)} is due ${due}: ${description}. Reply to this message with "done ${String(number)}" when it is done.`,
  actionDone: (owner: string, number: number, description: string): string => `Done, thank you ${owner}: #${String(number)} ${description}`,
  actionDoneWhich: (name: string, numbers: readonly number[]): string => `${name}, which one is done? Reply with ${numbers.map((n) => `"done ${String(n)}"`).join(' or ')}.`,
  actionNotYours: (name: string, number: number): string => `${name}, action item #${String(number)} is not yours to close.`,
  /** The status of a facilitation that has ended: what it reached and what
   *  is still followed up. Nothing about an open step; there is none. */
  statusAfterClose: (s: { phase: string; goal: string; reason?: string; decisions: readonly string[]; contributed: readonly string[]; actions: readonly string[]; open: number; notAccepted?: readonly string[]; until?: string }): string =>
    [
      `Status: ${s.phase}${s.reason ? ` (${s.reason})` : ''}. Goal: ${s.goal}`,
      ...(s.decisions.length > 0 ? ['Decisions:', ...s.decisions.map((d) => `- ${d}`)] : []),
      `Contributed: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'nobody'}`,
      ...(s.actions.length > 0 ? [`Action items (${String(s.open)} open):`, ...s.actions.map((a) => `- ${a}`)] : ['Action items: none']),
      ...(s.notAccepted && s.notAccepted.length > 0 ? ['Open points:', ...s.notAccepted.map((a) => `- ${a}`)] : []),
      ...(s.until ? [`Followed up until: ${s.until}`] : []),
    ].join('\n'),
  actionStatus: (lines: readonly string[]): string => `Status of the action items:\n${lines.map((l) => `- ${l}`).join('\n')}`,
  actionLine: (number: number, description: string, owner: string, due: string, status: string): string =>
    `#${String(number)} ${description} (${owner}, due ${due}): ${status}`,
  actionStatusWords: { proposed: 'waiting for the owner', confirmed: 'open', done: 'done', declined: 'declined' },
  /** A nomination its owner did not accept before the result was frozen: an
   *  open point, never an action item (spec 5.4, criterion 37). */
  notAccepted: (number: number, description: string, owner: string): string => `#${String(number)} ${description}: proposed for ${owner}, not accepted`,
  /** A "yes" to a nomination after the result was frozen: said once. */
  lateAcceptance: (owner: string, number: number, description: string): string =>
    `Thank you, ${owner}. The result was already final when you said yes, so #${String(number)} ${description} stays an open point in the protocol and is not followed up. You can start a new facilitation for it.`,
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
    parked: 'Open points',
    changes: 'Changes to the rules',
    changeKinds: { proposal_accepted: 'proposal accepted', proposal_rejected: 'proposal rejected', proposal_amended: 'proposal amended' } as Record<string, string>,
    runoff: (between: string): string => `runoff between ${between}`,
    capabilities: 'Use of scoped capabilities',
    outcome: 'Outcome',
    none: 'none',
  },

  // ── result status and delivery status (spec 5.11) ────────────────────────
  resultStatus: {
    label: 'Result status',
    published: 'published',
    confirmed: 'confirmed',
    not_confirmed: 'not confirmed',
    aborted: 'aborted',
    reasons: {
      objection: 'objection',
      electorate_unverified: 'participants could not be verified',
      not_delivered: 'not delivered',
      stopped: 'facilitation stopped',
    } as Record<string, string>,
    delivery: 'Delivery',
    deliveryStatus: { pending: 'pending', delivered: 'delivered', not_delivered: 'not delivered' } as Record<string, string>,
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
    /** Absent: nobody has stated the name of the person who asked yet. */
    initiator?: string;
    goal: string;
    definitionOfDone: string;
    format: string;
    agenda: string[];
    rules: string[];
    participants: string[];
    /** The channel could not list the members (or not all of them). */
    rosterOpen: boolean;
    /** Named in the request (and listed under participants), matched to nobody yet. */
    unmatched: string[];
    /** A vote without a known list: evaluated at the deadline only. */
    atDeadlineOnly: boolean;
    deadline?: string;
    reminders?: string;
    /** There is a deadline and no reminder will be sent: the minutes to the
     *  deadline when that is why, `null` when the group wants none. */
    noReminders?: number | null;
    followUp: boolean;
    /** The protocol also goes out by mail after the close. */
    protocolMail: boolean;
    changeWindowHours: number;
    perception?: string;
    notes: string[];
  }): string =>
    [
      `Hello, I am ${h.facilitator} and I facilitate this conversation from now on. I am neutral: I structure the way, you decide. I never vote and I treat every contribution the same.`,
      `Started by: ${h.initiator ?? 'the person who asked me just now'}`,
      `Goal: ${h.goal}`,
      `Done when (version 1): ${h.definitionOfDone}`,
      `Format: ${h.format}`,
      ...(h.agenda.length > 0 ? ['Agenda:', ...h.agenda] : []),
      ...h.rules,
      h.participants.length === 0
        ? 'Participants: I could not get the member list of this conversation. Whoever writes here takes part.'
        : `Participants: ${h.participants.join(', ')}${h.rosterOpen ? ' (I could not get the complete member list; whoever writes here takes part)' : ''}`,
      ...(h.unmatched.length > 0 ? [`I do not know yet who of you ${h.unmatched.length === 1 ? `${h.unmatched[0] ?? ''} is` : `${h.unmatched.join(', ')} are`}: please write here once.`] : []),
      ...(h.atDeadlineOnly ? ['I cannot see who belongs to this conversation, so I cannot tell when everybody has voted. I evaluate at the deadline.'] : []),
      h.deadline ? `Deadline: ${h.deadline}` : 'Deadline: none agreed',
      ...(h.reminders ? [`Reminders: ${h.reminders} before the deadline, only while contributions are open; in the group without names, and privately to the people concerned where I can reach them.`] : []),
      ...(h.noReminders !== undefined ? [h.noReminders === null ? 'Reminders: none.' : `Reminders: none, the deadline is in ${String(h.noReminders)} minute${h.noReminders === 1 ? '' : 's'}.`] : []),
      h.followUp
        ? 'Action items: I remind each owner before the due date and stop when everything is done or past due.'
        : 'Action items: no follow-up after the close, unless you ask for it.',
      ...(h.protocolMail ? ['Protocol: after the close it also goes by mail to the participants whose address the channel knows.'] : []),
      `Changes: anyone can propose to change the definition of done, the method or the deadline. A change holds when nobody objects within ${String(h.changeWindowHours)} hours (never past the deadline), and I announce it with its new version.`,
      ...(h.perception ? [h.perception] : []),
      ...h.notes,
      h.initiator
        ? `Report: the result goes to this group first, then to ${h.initiator} with the protocol. ${h.initiator} receives nothing you were not told about. If I cannot write to them privately, the protocol goes here instead.`
        : 'Report: the result goes to this group first, then with the protocol to the person who started this facilitation. They receive nothing you were not told about. If I cannot write to them privately, the protocol goes here instead.',
      'Ask "status" at any time. "stop" ends the facilitation.',
    ].join('\n'),
  reminderTimes: (hours: readonly number[]): string =>
    // Whole hours in hours, everything else in minutes.
    hours.map((h) => (Number.isInteger(h) ? `${String(h)} h` : `${String(Math.max(1, Math.round(h * 60)))} min`)).join(', '),

  status: (s: {
    phase: string;
    goal: string;
    step?: string;
    dodVersion: number;
    definitionOfDone: string;
    /** Names in a private answer; a count in the group, which never names
     *  who is missing (spec 5.7, criterion 16). */
    contributed: string[] | number;
    missing: string[] | number;
    /** What can be chosen in the open step, each option with its key. */
    options?: string;
    tally?: string;
    provisional: boolean;
    proposal?: string;
    deadline?: string;
  }): string =>
    [
      `Status: ${s.phase}. Goal: ${s.goal}`,
      ...(s.step ? [`Current step: ${s.step}`] : []),
      `Definition of done (version ${String(s.dodVersion)}): ${s.definitionOfDone}`,
      typeof s.contributed === 'number'
        ? `Contributed: ${String(s.contributed)} of ${String(s.contributed + (typeof s.missing === 'number' ? s.missing : s.missing.length))}`
        : `Contributed: ${s.contributed.length > 0 ? s.contributed.join(', ') : 'nobody yet'}`,
      typeof s.missing === 'number'
        ? `Still open: ${s.missing === 0 ? 'none' : s.missing === 1 ? '1 contribution' : `${String(s.missing)} contributions`}`
        : `Still open: ${s.missing.length > 0 ? s.missing.join(', ') : 'nobody'}`,
      ...(s.options ? [`Options: ${s.options}`] : []),
      ...(s.tally ? [`${s.provisional ? 'Provisional tally' : 'Tally'}: ${s.tally}`] : []),
      ...(s.proposal ? [`Open proposal: ${s.proposal}`] : []),
      s.deadline ? `Deadline: ${s.deadline}` : 'Deadline: none',
    ].join('\n'),

  initiatorReport: (name: string, outcome: string, protocol: string): string =>
    `Hello ${name}, you started this facilitation, so here is the report. It contains nothing the group was not told.\n\n${outcome}\n\n${protocol}`,
  /** A report or protocol could not arrive privately: said once, with what is owed. */
  protocolInGroup: (protocol: string): string => `I could not send the report with the protocol to everybody privately, so here it is:\n\n${protocol}`,

  change: {
    definition_of_done: (text: string, version: number): string => `change the definition of done to (version ${String(version)}): ${text}`,
    deadline: (when: string): string => `move the deadline to ${when}`,
    close_rule: (rule: 'all_contributed' | 'at_deadline'): string =>
      rule === 'at_deadline' ? 'evaluate at the deadline instead of when everybody has contributed' : 'evaluate as soon as everybody has contributed instead of at the deadline',
    method: (title: string, rules: string): string => `change how "${title}" is decided. ${rules}`,
    reminders: (times: string): string => (times === '' ? 'send no reminders before the deadline' : `remind ${times} before the deadline`),
    dod_met: (summary: string): string => `the definition of done is met, and we close with this:\n${summary}`,
  },
  changed: {
    definition_of_done: (version: number, text: string): string => `The definition of done is now version ${String(version)}: ${text}`,
    deadline: (when: string): string => `The deadline is now ${when}. Reminders move with it.`,
    close_rule: (rule: 'all_contributed' | 'at_deadline'): string =>
      rule === 'at_deadline' ? 'From now on the result is evaluated at the deadline.' : 'From now on the result is evaluated as soon as everybody has contributed.',
    method: (title: string, rules: string): string => `"${title}" is now decided like this. ${rules}`,
    reminders: (times: string): string => (times === '' ? 'No reminders are sent before the deadline any more.' : `Reminders are now sent ${times} before the deadline.`),
  },
  actAgain: (names: string): string => `Contributions made under the old rules no longer fit. Please contribute again: ${names}.`,

  // ── operator, quotas, retention ──────────────────────────────────────────
  system: {
    messageQuota: (max: number): string =>
      `System notice: this facilitation has reached its limit of ${String(max)} messages from the facilitator. From now on only the result or an abort report will be posted. An operator can raise the limit.`,
    activeQuota: (max: number): string =>
      `System notice: this facilitator already runs ${String(max)} facilitations, which is its limit. It cannot start another one until one of them has ended. An operator can raise the limit.`,
    instanceQuota: (max: number): string =>
      `System notice: this instance already runs ${String(max)} facilitations, which is its limit. No further facilitation can be started right now.`,
    startQuota: (max: number): string =>
      `System notice: this facilitator has started ${String(max)} facilitations within the last hour, which is its limit. Please try again later.`,
  },
  abortResultUndelivered: (error: string): string => `the result could not be posted to the group (${error})`,
  resultUndeliveredReport: (result: string): string => `I could not post the result in the group. This is what was reached:\n\n${result}`,
  messageUnprocessed: (): string => 'One message here could not be processed because of a technical problem. If you were waiting for me to record something, please send it again.',
  defaultDod: (goal: string, decision: boolean): string => (decision ? `A decision is made on: ${goal}` : `The group has reached: ${goal}`),
  notEverybodyYet: (): string => 'Not everybody has contributed yet. I do not name anybody here; reminders go to the people concerned.',
  stillOpen: (title: string, deadline: string | undefined): string => `"${title}" is still open${deadline ? ` until ${deadline}` : ''}. Ask "status" for where we stand.`,
  /** What the group reads when a tool refused and the facilitator said nothing. */
  refusals: {
    generic: 'I could not do that just now. Ask "status" for where we stand.',
    deciding_step: 'This step is decided by its vote. It closes when the result is in: once everybody has contributed, or at the deadline if that is what was agreed.',
    closing_step: 'The closing step ends when you have confirmed the summary.',
    proposal_open: 'One proposal at a time: the open one is decided first.',
    no_open_step: 'No step is open right now.',
    not_a_deciding_step: 'That step is not decided by a vote, so there is no method to change. Write "next" to move on.',
    foreign_options: 'I can only put the options of this step to the vote. If you want other options, propose them explicitly.',
    ballots_exist: 'People have already voted in this step. Changing it now needs a proposal that you all consent to.',
  } as Record<string, string>,
  guardFallback: (): string => 'I could not put my answer into words just now. Ask "status" for where we stand.',
  abortConfiguringExpired: (): string => 'it was not opened within the time a facilitation may take to be set up',
  abortLifetime: (days: number): string => `the maximum duration of ${String(days)} days was reached`,
  abortOperator: (reason: string): string => `an operator ended it (${reason})`,
  abortAgentDisabled: (): string => 'this facilitator was disabled by an operator and can no longer moderate',
  abortAgentDeleted: (): string => 'this facilitator is being deleted by an operator',
  abortArchetypeRemoved: (): string => 'the facilitator archetype is being removed from this instance, so no facilitator can moderate here any more',
  notVisible: (): string => 'You are not a participant of this facilitation, so its protocol is not available to you.',

  // ── sessions and media ───────────────────────────────────────────────────
  perceive: {
    intro: 'What I perceive here:',
    text: 'I read the chat',
    message_edits: 'edited messages',
    reactions: 'reactions to my own posts',
    card_answers: 'the polls',
    presence: 'who joins and leaves',
    hand_raise: 'raised hands',
    transcribed_speech: 'what is said in the call, as a transcript with the speaker',
    shared_documents: 'shared documents',
    not: {
      transcribed_speech: 'I do not hear the call',
      hand_raise: 'I do not see raised hands',
      presence: 'I do not see who is present',
      card_answers: 'I cannot run polls here, so votes are written in the chat',
      private_messages: 'I cannot write to anyone privately here, so reminders stay in the group',
    },
    sentence: (can: readonly string[], cannot: readonly string[]): string =>
      `What I perceive here: ${can.join(', ')}.${cannot.length > 0 ? ` ${cannot.join('. ')}.` : ''} Nobody should assume more.`,
  },
  pollHint: (ballotExample: string): string => `Answer in the poll, or write your choice in the chat (e.g. "${ballotExample}").`,
  pollUnverified: (name: string, summary: string): string =>
    `${name}, a poll answer came in under your name that the platform could not verify: ${summary}. Reply "yes" in the group to make it count.`,
  sessionAgenda: (title: string, when: string, agenda: readonly string[]): string =>
    [`Agenda for "${title}" on ${when}:`, ...agenda, 'Topics and pre-reads you want to bring: write them here beforehand, one point per message.'].join('\n'),
  sessionStarted: (title: string, until: string | undefined, perception: string): string =>
    [`"${title}" starts now.${until ? ` We have until ${until}.` : ''}`, perception].join('\n'),
  /** A meeting nobody scheduled here is running, and it offers something else
   *  than the chat: what changes for what the facilitator perceives. */
  meetingDiffers: (gained: readonly string[], lost: readonly string[]): string =>
    ['A meeting is running in this conversation.', ...(gained.length > 0 ? [`In it I also perceive: ${gained.join(', ')}.`] : []), ...(lost.length > 0 ? [`I no longer perceive: ${lost.join(', ')}.`] : [])].join(' '),
  sessionEnded: (title: string): string => `"${title}" has ended. What is still open continues here in the chat.`,
  timeNotice: (title: string, minutes: number): string => `Time check: ${String(minutes)} minutes left for "${title}".`,
  speakingOrder: (names: readonly string[], remoteFirst: boolean): string =>
    `Speaking order for this round${remoteFirst ? ' (remote first)' : ''}: ${names.join(', ')}. Say "pass" if you have nothing to add.`,
  capabilityGained: (what: readonly string[]): string => `Something changed in this session. I can now also perceive: ${what.join(', ')}.`,
  capabilityLost: (what: readonly string[]): string => `Something changed in this session. I can no longer perceive: ${what.join(', ')}. I continue with what is left.`,
  mediaConsent: (): string =>
    'process the transcribed speech of this call, so that I can record what is said. Raw audio and video are not stored, only the protocol. Anybody can stop it at any time with "stop listening"',
  mediaConsentGranted: (): string => 'I now follow the transcript of the call. What I record from speech stays unconfirmed until the person confirms it in the chat. "stop listening" ends it at once.',
  mediaConsentRefused: (): string => 'Understood. I do not process the speech of this call and continue with chat and polls only.',
  mediaStopped: (name: string): string => `${name} asked me to stop. I no longer process the speech of this call.`,
  spokenEcho: (name: string, summary: string): string =>
    `${name}, I heard you say: ${summary}. Reply "yes" in the chat to confirm, or correct me. It counts once you confirmed.`,

  // ── scoped capabilities ──────────────────────────────────────────────────
  stakeholderRoles: { receives_protocol: 'receives the protocol', invited_to_followups: 'is invited to follow-up meetings' },
  proposeStakeholder: (name: string, role: string): string => `add ${name} as a stakeholder who ${role}`,
  proposeFollowupMeeting: (subject: string, minutes: number, from: string, to: string): string =>
    `after the close I look for a common free time and send the invitation for "${subject}" (${String(minutes)} minutes, between ${from} and ${to}). For that I read only when people are busy, never what their appointments are`,
  /** What the protocol says about the use of scoped capabilities. */
  capabilityLog: {
    names: { 'free/busy': 'free/busy', invitation: 'invitation', 'protocol mail': 'protocol mail' } as Record<string, string>,
    refused: (capability: string, reason: string): string => `${capability}: refused (${reason})`,
    refusedByIntegration: (capability: string, reason: string): string => `${capability}: refused by the integration (${reason})`,
    outcomeUnknown: (capability: string, detail: string): string => `${capability}: outcome unknown (${detail})`,
    freeBusy: (people: number, from: string, to: string): string => `free/busy read for ${String(people)} people, ${from} to ${to}`,
    invitation: (subject: string, start: string, people: number): string => `invitation "${subject}" for ${start} sent to ${String(people)} people`,
    mailed: (addresses: number): string => `protocol mailed to ${String(addresses)} addresses`,
    grantIssued: (addresses: number): string => `grant issued for ${String(addresses)} addresses (participants and confirmed stakeholders)`,
    grantRevoked: (reason: 'followup_ended' | 'period_ended'): string => `grant revoked: ${reason === 'followup_ended' ? 'the follow-up ended' : 'the follow-up period ended'}`,
    protocolSent: (participants: number): string => `protocol sent privately to ${String(participants)} participant${participants === 1 ? '' : 's'}`,
  },
  protocolDirect: (name: string, protocol: string): string => `Hello ${name}, here is the protocol of the facilitation you took part in.\n\n${protocol}`,
  protocolMailSubject: (goal: string): string => `Protocol: ${goal}`,
  protocolSent: (channel: number, mail: number): string =>
    `The protocol has been sent: privately to ${String(channel)} participant${channel === 1 ? '' : 's'}${mail > 0 ? ` and by mail to ${String(mail)} address${mail === 1 ? '' : 'es'}` : ''}.`,
  /** Nobody to mail to. With the protocol when the group does not have it yet. */
  protocolMailNoAddresses: (protocol: string | undefined): string =>
    `I cannot mail the protocol: this channel does not give me the mail addresses of the participants, and I do not collect addresses in the chat. ${protocol === undefined ? 'The protocol is in this group.' : `Here it is instead:\n\n${protocol}`}`,
  protocolMailUnavailable: (reason: string): string => `The protocol could not be mailed (${reason}). It is in this group, and participants got it privately where I can reach them.`,
  followupCreated: (subject: string, when: string, link: boolean, unknown: number): string =>
    `Follow-up meeting "${subject}" is in the calendars for ${when}.${link ? '' : ' The invitation went out without a meeting link.'}${unknown > 0 ? ` For ${String(unknown)} ${unknown === 1 ? 'person' : 'people'} I could not see availability, so please check the time.` : ''}`,
  protocolMailUnknown: (): string => 'I do not know whether the protocol mail went out: the mail service did not answer. I will not send it again, so nobody gets it twice. Please check, or share the protocol from this group.',
  followupUnknown: (subject: string): string => `I do not know whether the invitation for "${subject}" went out: the calendar service did not answer. I will not send it again. Please check your calendars and send it yourselves if it is missing.`,
  followupNoSlot: (subject: string): string => `I found no time between the agreed dates at which everybody is free for "${subject}". Please pick a time yourselves.`,
  followupUnavailable: (subject: string, reason: string): string => `I could not schedule "${subject}" (${reason}). Please send the invitation yourselves.`,
  followupReasons: {
    not_configured: 'no calendar integration is set up for this instance',
    no_service: 'no calendar integration is installed',
    recipient_not_allowed: 'somebody on the list was not confirmed by the group',
    provider_error: 'the calendar service reported an error',
    grant_revoked: 'the follow-up of this facilitation has ended',
    grant_refused: 'the instance did not grant this (the facilitation was stopped, or its time for it has passed)',
    no_grant_service: 'this instance cannot grant a facilitation mail or calendar access',
    unknown_outcome: 'the service did not answer',
    no_addresses: 'this channel does not give me the mail addresses of the participants, and I do not collect addresses in the chat',
  },
  invitationBody: (goal: string, summary: string): string => `Follow-up to "${goal}".\n\n${summary}`,

  phase: {
    configuring: 'being set up',
    active: 'running',
    concluding: 'concluding',
    closed: 'closed',
    aborted: 'ended without a result',
    following_up: 'closed, action items are being followed up',
    ended: 'ended',
  },
  /** What the group or a person reads when the instance refused an action. */
  execution: {
    turnLimit: (): string => 'I could not answer the last message: the limit for a single answer of mine was reached. Votes, "status" and "stop" work as before.',
    turnBudget: (): string => 'The budget for answers of my own is used up for this part of the facilitation. Votes, "status" and "stop" work as before, and the result is still evaluated.',
  },
  /** Private status requests of participants (answered in the private chat). */
  privateStatus: {
    which: (goals: readonly string[]): string =>
      `You take part in several facilitations of mine. Which one do you mean? Answer with "status" and its number:\n${goals.map((goal, i) => `${String(i + 1)}. ${goal}`).join('\n')}`,
    doneWhich: (items: readonly string[]): string => `Which of your action items is done? Answer with "done" and its number:\n${items.join('\n')}`,
    done: (number: number, description: string): string => `Noted: action item ${String(number)} ("${description}") is done. I tell the group.`,
    nothingOpen: (): string => 'You have no open action item in a facilitation of mine.',
  },
};

export type Texts = typeof en;
