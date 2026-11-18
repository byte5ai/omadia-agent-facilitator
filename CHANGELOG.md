# Changelog

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

### Fixed (defects of the field test, spec 4)

- Votes without a mention are recorded (F1); the engine counts, not a model
  (F2, F3, F4); no reminder after completion (F5); time runs from the deadline
  (F6); a met definition of done concludes without waiting for the initiator
  (F7); the group gets its result (F8); the definition of done changes without
  a restart (F9); nothing ends without a report (F10); the facilitator posts
  as itself (F11); the conversation and the initiator come from the kernel
  (F12); name and language come from the facilitator's profile (F13); quotas
  are per facilitator (F14).
