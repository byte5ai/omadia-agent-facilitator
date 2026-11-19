# Changelog

## 1.1.0

### Added

- **Question cards.** Where the channel declares them (kernel contract
  byte5ai/omadia#2105, plugin-api 1.59.0; Teams from 0.38.0), a step is put to
  the group as a card with typed answers:
  - ranked, single-choice and approval votes, consent with a reason for an
    objection, and assignment (one question per item, the participants as
    candidates, volunteering allowed);
  - a text field for a collecting step, one idea per submission;
  - `facilitation_questionnaire`: up to five structured questions on one
    card, read back with `facilitation_questionnaire_answers`.
- **Per channel capability, with chat ballots as the fallback.** The engine
  asks `conversationSend.capabilities()` and posts a card only for a kind the
  channel lists. Without cards, without the kind, for more options than a
  card holds, or when the channel refuses the card, the step is a chat ballot
  exactly as before. A kernel without the contract changes nothing.
- **Card and chat count next to each other.** Both are valid in one step and
  the newest answer of a person wins, whichever way it came.

### How an answer is checked

- Every card that was sent is stored (migration `0003`). An answer is checked
  against it: card id, proposal id and version, question, kind, every option
  id, bounds of text and numbers. What does not fit is dropped and put on
  record; nothing a client sends back is trusted.
- Only a participant can answer, and only a participant can be named in an
  assignment.
- An answer counts at once only when the platform verified who gave it.
  Otherwise it is recorded as unconfirmed and its owner is asked to confirm in
  the group.
- When a step is over its card is updated to the result. A runoff or a method
  changed by consent posts a new version of the card and marks the old one as
  replaced; an answer on the old card never counts.

### Limits

- No cards in private messages (the kernel's contract has none).
- A questionnaire answer that is not verified is on record and not read back;
  there is no confirmation round for it.
- `number` and `date` questions only where the channel lists them (Teams does
  not): ask those in the chat.

## 1.0.5

### Fixed

- **A facilitation's lock could stay taken for minutes while nothing ran.**
  Live, a mention in a meeting chat was not processed ("its lock was not free
  within 15015 ms", repeatedly, with the engine idle). The lock was a
  session-level Postgres advisory lock. An instance that reaches Postgres
  through a pooler in transaction mode runs each statement outside a
  transaction on whichever server session is free: the lock was taken on one
  session and its release ran on another, which releases nothing. It stayed
  held until that session ended, and everybody who landed on another session
  waited in vain.
  The lock is now a row with a lease (migration `0002`). Taking it is one
  statement, the holder renews the lease while it works and deletes the row
  when it is done, and a holder that died is waited for no longer than one
  lease (30 s). It means the same on every session, with or without a pooler.

## 1.0.4

Defects from the supervised live runs on 1.0.1 (Teams meeting chat and
channel thread, 2026-11-18), D15 to D21 of the rollout.

### Fixed

- **An empty or partial participant list is never "everybody contributed"
  (D15).** The list was empty at the start: the reminder reminded nobody
  without a word, the initiator got no report, and the first ballot of
  anybody would have closed a vote.
  - Participants named in the request are the list (`participants` on
    `facilitation_start`): matched to the members the channel lists; a name
    that matches nobody is kept as named, asked to write once, and waited for.
  - The initiator always takes part.
  - Without a member list and without named participants there is no
    "everybody": a vote needs a deadline and is evaluated there, and the
    handshake says so. `all_contributed` is refused, also as a change, and a
    facilitation stored otherwise is evaluated at its deadline all the same.
    A proposal is not accepted early by "everybody agreed" on such a list.
  - A reminder still goes to the group when nobody can be counted as missing;
    one with nobody waiting is put on record instead of ending silently.
  - A conversation is no longer subscribed to before the set-up is accepted.
- **Reminders (D16).** `facilitation_start` takes `reminderMinutesBefore`
  (minutes; an empty list for none); one that does not lie between now and the
  deadline is refused. Without it the configured offsets are used where they
  fit, else one reminder in the last quarter, none within ten minutes of the
  deadline. The handshake lists only reminders that will be sent, or says that
  there are none and why. The group changes them by consent
  (`facilitation_propose_change` with `reminders`).
- **Quiet in a vote (D19).** In a step decided by choosing between announced
  options, a message that is neither a ballot nor a command gets a model turn
  only when it is a question, names the facilitator, is about the process or
  the vote, or may be a ballot in other words. Small talk is on record and not
  answered.
- **Settings of 0.7.x and the privacy mode (D20).** `onMigrate` drops the six
  0.7.x keys. The engine needs the privacy mode `bypass` for its own tools
  (their answers are what the facilitator works from); the manifest declares
  it with the reason, the mode in force is logged at every activation, and
  anything else is a warning. Every setting 1.0.x reads is a manifest field
  and documented in the README.
- **Mail addresses (D21).** They come from the channel's member list, read
  again as the facilitator before a follow-up is planned and before mail and
  invitation run. Without any, planning a follow-up meeting is refused with
  the reason, and a protocol mail with nobody to go to says why and puts the
  protocol in the group. Nobody is asked for an address in the chat.

### Already fixed before, for the record

- D17 (names shown as principal ids): 1.0.2, completed by 1.0.3.
- D19, first half (a single vote became five steps): 1.0.2.
- D20, report that cannot arrive privately and the English protocol line:
  1.0.2.
- D21, the member list read through the facilitator's own bot: 1.0.3.

### Changed behaviour to know about

- A vote in a conversation whose members the channel cannot list is refused
  without a deadline or named participants. Before, it started and closed on
  the first ballot.
- In such a conversation a proposal waits for its window instead of being
  accepted when the people known so far agreed.

## 1.0.3

Uses what the kernel adds with plugin-api 1.57.0. Both are optional: on an
older kernel 1.0.3 behaves like 1.0.2. `compat.core` stays `>=1.55.0 <2.0`.

### Changed

- The member list is read as the facilitator:
  `rosters.getRoster(channelType, conversationId, { agentSlug })`. The kernel
  then asks the channel through the facilitator's own bot, which is the one
  that is in the conversation. Before, the instance's default bot was asked,
  and in a chat it is not a member of the handshake had no participants.
- The initiator is named from the tool call (`callerUserRef.displayName`), so
  the handshake says "Started by: <name>" even when the member list is
  unavailable. 1.0.2 already read the field; it is now part of the contract.

### Unchanged

- Without a member list the handshake still says so and whoever writes takes
  part; without a name the initiator is described, never shown as an id.

## 1.0.2

What the first real facilitation showed (Teams meeting chat, 2026-11-18).

### Fixed

- People are named by their name, never by an id. The handshake named the
  initiator as `user:<guid>` and printed an empty participant line, because
  the channel gave no member list for the chat. Every outgoing text now goes
  out with the name the facilitation knows for a principal id, or a neutral
  word, and the text guard refuses an id that is still there. Without a
  member list the handshake says so ("whoever writes here takes part") and
  describes the initiator instead of printing a key. A member the channel
  lists without a name gets the name of their first message. A caller name
  stated by the kernel with the tool call (`callerUserRef.displayName`) is
  used when it is there.
- A request that is just a vote gets one deciding step, open right after the
  handshake. A single ranked vote had become the five-step decision agenda
  with four confirmations before anybody could vote. A complete vote (method
  and what to choose from) is one step, whatever of `decision`,
  `prioritisation` or `assignment` was named with it; more steps around a
  vote need an `agenda`. The tool descriptions and the playbook say so.
- The protocol speaks of capabilities in the language of the group: the
  German protocol carried "protocol sent privately to 0 participants". Times
  are in the group's timezone, reasons are words instead of codes, and a
  dispatch to nobody is not recorded.
- A report that cannot arrive privately (`app_not_installed` is the normal
  case for a facilitator's app) puts the protocol into the group, once, with
  one short line and without a name, instead of pointing at a private message
  that cannot come. The same holds for a participant's protocol. Somebody who
  could not be reached before is not written to again, and the handshake says
  what happens in that case.

### Not changed here

- The AI label on the engine's own posts needs a flag on the kernel's send
  contract; the plugin adds no disclosure text of its own.

## 1.0.1

1.0.0 was withdrawn from the Hub; install 1.0.1 instead. Nothing changed in
the engine.

### Fixed

- `compat.core` is `>=1.55.0 <2.0`. 1.0.0 declared `>=1.0`, which offered the
  package to kernels without native facilitators, where it would have replaced
  a working 0.7.x. The range is compared against the host's
  `@omadia/plugin-api` version: 1.55.0 is the first that can run the engine,
  and what 1.56.0 adds (`isSubscribed`) is feature-detected.

### Added

- A packaging test builds the real zip and runs every entry through a mirror
  of the kernel's zip ingest rules (extension allowlist, declaration files,
  the `ui/` and `appPackage/` exceptions, names without an extension,
  symlinks, escaping paths), and compares the mirror with the kernel source
  when a checkout is next to this repo. The 1.0.0 zip already passed; the
  test keeps it that way.

## 1.0.0

The plugin becomes the facilitation engine for native facilitators
(byte5ai/omadia#2043). This is a cut-over from 0.7.x; nothing is migrated.

### Requires

- A kernel with native facilitators and `@omadia/plugin-api` >= 1.55.0.
- Postgres (`graphPool`, a hard requirement), and the operator's grant for
  `permissions.sql`.
- A channel with one identity per facilitator and delivery of every message
  of a moderated conversation (`@omadia/channel-teams` >= 0.36.0).

### Breaking

- Kind `agent` becomes `extension`; the plugin provides `facilitationEngine@1`.
  The kernel attaches it to every facilitator and to nothing else. The default
  agent loses the facilitation tools of 0.7.x.
- Removed: the ephemeral Conductor run and its pattern, run-state persistence
  and rehydration, the in-memory state store, agent provisioning, scoped
  roles, and the tools `facilitation_progress`, `facilitation_nudge`,
  `facilitation_contribution`, `facilitation_update`.
- Removed setup fields: `facilitator_agent_slug`, `initiator_role_key`,
  `report_channel_type`, `default_ttl_hours`, `reporting_mode`,
  `moderation_style`, `nudges_enabled`, `nudge_min_interval_hours`,
  `nudge_quiet_hours`, `auto_setup`, `disclose_report_target`. The report
  target is always disclosed; tone belongs to the facilitator's persona.
- A facilitator needs its own channel identity. There is no default-bot
  fallback.

### Added

- Data model as plugin migrations: facilitations, sessions, stakeholders,
  steps, participants, versions of the definition of done, contributions,
  clusters, decisions, action items, protocol events, outbox, plus the inbound
  ledger, scheduler jobs, proposals, acknowledgements and the access audit.
- Inbound consumer with cursor replay; authorship copied from the kernel's
  stored message; echo and confirmation; one clarifying question per message.
- Decision methods without a model: ranked vote, single choice, approval,
  consent, assignment; runoff after a tie; every row of the evaluation table.
- Leased scheduler from the deadline, outbox with delivery classes, one
  advisory lock per facilitation.
- Process: agenda templates for six formats, timeboxes, silent voices,
  clusters, summaries and the binding close by consent, action items with
  follow-up, the protocol.
- Handshake, status with tally, result to the group and then the initiator,
  changes to the definition of done, method, close rule and deadline by
  consent of the group.
- Visibility by membership, retention (90 days by default), quotas per
  facilitator and instance, an audited operator API, and the facilitations
  view with English and German labels.
- Sessions (meetings) and media-adaptive moderation: capability snapshot per
  session, polls as cards where available, consent before speech is processed.
- Facilitation-scoped capabilities: protocol dispatch and follow-up scheduling
  from free/busy on `facilitation.followup`, checked against the grant and
  written to the protocol.

### Hardening after review (before first use)

- Tables live in the kernel-reserved `plg_omadia_agent_facilitator_`
  namespace; the migration is idempotent.
- Bounded locking on the kernel's shared pool: try-lock with a deadline, at
  most two lock connections, send timeouts, no second connection under a lock.
- The conversation is released on close; a new facilitation never reads the
  earlier chat; a message that fails to process is retried, then reported.
- A result that cannot be posted ends the facilitation with a record instead
  of leaving it concluding.
- Mail and invitation run after the close is committed, outside the lock, at
  most once; an unknown outcome is said to the group and not repeated.
- A leftover confirmation cannot overwrite a later vote; an open proposal does
  not swallow the ballots of a consent vote; contributions are frozen from the
  conclusion on; stale reminders are skipped after downtime.
- One guard for every outgoing text; bots never become participants;
  retention deletes in batches.

### Fixed after the integration run (real kernel, real model)

- The engine comes up after a middleware restart without operator action:
  `graphPool` is a hard `requires`, and availability is no longer decided once
  at activation. The engine looks for the database again on a timer, on every
  scheduler pass and on every tool call, reports its state live and resumes
  running facilitations.
- A facilitation whose subscription the kernel ended (grant revoked, engine
  reinstalled, agent disabled) is reconciled when the engine comes up, on
  every scheduler pass and before a tool acts: the subscription is taken
  again and the group is told once that the facilitation continues; when the
  kernel keeps refusing for two minutes it ends as aborted with the reason on
  record. An ended facilitation without a subscription gives its messages up
  after three attempts; a later facilitation's subscription does not carry
  them.
- `facilitation_start` says that nothing is open yet and takes `open: true`;
  `facilitation_open` reports a handshake that was not posted; no tool answers
  created or opened for a facilitation that cannot be read.
- In a collecting step "next" / "weiter" proposes to close it, the step
  announcement says so, and a message about the process reaches the
  facilitator's turn instead of being recorded as a point.
- `facilitation_propose_change` refuses a method change for a step that is not
  decided by a vote and options that are not the step's own (unless
  `replaceOptions`).
- The text of a turn is dropped when one of its tools already posted in the
  group; no tool result names the machinery.
- Protocol: a runoff line names its options; a grant that reaches nobody is
  not listed; participants and initiator get the same protocol. The handshake
  says "no private messages" only when there is no way to send them.
- A send outcome without code or message is recorded readably.

### Fixed after the second integration run

- With `@omadia/plugin-api` 1.56.0 the engine asks the kernel whether a
  subscription still stands (`conversationMessages.isSubscribed`); on 1.55 it
  infers it as before. A gap is announced once whichever path repairs it.
- Guards that do not depend on the model: a turn text that names somebody as
  not having contributed is replaced by a neutral line; a text that calls the
  vote or the facilitation closed while it is open is replaced by what is
  true; a turn whose tool refused and that said nothing posts the reason.
- `facilitation_start` needs only the goal and is described as the first call
  of a request, so a setup is stored before anything is asked.
- "next" / "weiter" also proposes to close a discussing step; after the
  invitation of silent voices the group is told how the step ends.
- A close rule that contradicts the definition of done is refused.
- A bare yes is not a collected point; a deadline close counts who voted; an
  action reminder goes privately and to the group only as a fallback; "done"
  without a number works; offsets below one hour are printed in minutes.
- Recommendation: a facilitator needs a Sonnet-class model (README, set-up
  guide).

### Fixed (defects of the field test, spec 4)

- Votes without a mention are recorded (F1); the engine counts, not a model
  (F2, F3, F4); no reminder after completion (F5); time runs from the deadline
  (F6); a met definition of done concludes without waiting for the initiator
  (F7); the group gets its result (F8); the definition of done changes without
  a restart (F9); nothing ends without a report (F10); the facilitator posts
  as itself (F11); the conversation and the initiator come from the kernel
  (F12); name and language come from the facilitator's profile (F13); quotas
  are per facilitator (F14).
