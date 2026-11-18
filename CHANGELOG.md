# Changelog

## 1.0.0

The plugin becomes the facilitation engine for native facilitators
(byte5ai/omadia#2043). This is a cut-over from 0.7.x; nothing is migrated.

### Requires

- A kernel with native facilitators and `@omadia/plugin-api` >= 1.55.0.
- Postgres, and the operator's grant for `permissions.sql`.
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

### Fixed (defects of the field test, spec 4)

- Votes without a mention are recorded (F1); the engine counts, not a model
  (F2, F3, F4); no reminder after completion (F5); time runs from the deadline
  (F6); a met definition of done concludes without waiting for the initiator
  (F7); the group gets its result (F8); the definition of done changes without
  a restart (F9); nothing ends without a report (F10); the facilitator posts
  as itself (F11); the conversation and the initiator come from the kernel
  (F12); name and language come from the facilitator's profile (F13); quotas
  are per facilitator (F14).
