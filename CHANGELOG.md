# Changelog

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
