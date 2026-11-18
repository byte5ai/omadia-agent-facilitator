# omadia Facilitator (`@omadia/agent-facilitator`)

The facilitation engine for native facilitators
([byte5ai/omadia#2043](https://github.com/byte5ai/omadia/issues/2043)).

A facilitator is a kind of agent the kernel owns: its identity, the neutrality
block in its prompt, its own channel identity, the stored inbound messages and
the model turn. Everything a facilitation is made of lives in this plugin:

- the data model and its migrations (`migrations/`), the lifecycle, and
  contributions whose authorship is copied from the kernel's stored message;
- decision methods that are counted without a model: ranked vote, single
  choice, approval, consent, assignment, with runoff after a tie;
- a scheduler that runs from the deadline, an outbox with delivery classes,
  and one advisory lock per facilitation;
- the process: agenda templates, steps and timeboxes, silent voices, clusters
  and summaries by consent, action items with follow-up, the protocol;
- transparency: handshake, status, result to the group first, rule changes by
  consent of the group;
- visibility, retention, quotas per facilitator, an audited operator API and
  the facilitations view;
- sessions (meetings) and media-adaptive moderation;
- facilitation-scoped capabilities for protocol dispatch and follow-up
  scheduling.

## Requirements

| What | Version |
|---|---|
| omadia kernel | with native facilitators (#2043) and `@omadia/plugin-api` >= 1.55.0 |
| Postgres | required. The plugin declares `permissions.sql`; an operator grants it |
| Channel | one that gives each facilitator its own identity and delivers every message of a moderated conversation. Teams: `@omadia/channel-teams` >= 0.36.0 |
| Follow-up (optional) | an integration that provides `facilitation.followup`. Microsoft 365: `@omadia/m365-connector` >= 0.9.0 |

## Set-up

1. Install the plugin and **grant its SQL permission**. It owns the
   `facilitation*` tables and records its migrations in
   `plg_omadia_agent_facilitator_migrations`. Without the grant the engine
   activates, reports itself unavailable, and every facilitator says that
   facilitation is not available.
2. Create a facilitator under "Facilitators" and give it its **own channel
   identity**. A facilitator never speaks through another agent's bot; without
   an identity of its own it does not start and says so.
3. Add the facilitator to a group conversation and ask it there to start.

The kernel attaches this engine to every facilitator. It is the one provider
of `facilitationEngine@1` on the instance; its tools cannot be granted to a
standard agent.

## How a facilitation runs

`configuring -> active -> concluding -> closed`, or `aborted` (stop, a deadline
without a result, an error). Nothing ends silently: every way out posts a
report in the group.

- **Deterministic first.** A message is a command (`status`, `stop`), a
  confirmation, an answer to a proposal, or a ballot in the announced format
  (`A > C > B`). Those are read without a model. Only free text reaches the
  facilitator's turn, which the kernel runs; what the model reads from it
  counts only after its author confirmed.
- **Authorship** comes from the kernel's stored message, never from a tool
  argument. A quoted or forwarded ballot, a message from another conversation
  or from before the start, and a non-participant's message record nothing.
- **Time** runs from the deadline: reminders 24 h and 2 h before it (neutral in
  the group, private to the people concerned where the channel can reach
  them), then a close with the state at that moment.
- **Every send** is written to the outbox first. Reminders and echoes are
  at-most-once and bound to the state they were computed from; handshake,
  result and abort report are retried until delivered.
- **Rules change by consent**: anyone proposes, it holds when nobody objects
  within the window (12 h by default, never past the deadline).

Contributions count only from the group conversation. A private message to a
facilitator is not a turn, so private reminders ask to answer in the group.

## Configuration

All fields are optional; defaults in brackets.

| Field | Meaning |
|---|---|
| `language` [de], `timezone` [Europe/Berlin] | used when the facilitator's profile or the facilitation states none |
| `reminder_offsets_hours` [24,2] | reminders before the deadline |
| `change_window_hours` [12] | consent window for rule changes |
| `runoff_window_hours` [12] | runoff after a tie |
| `confirm_window_minutes` [30] | clusters, summaries, closing a step |
| `ranked_points` [3,2,1] | points per rank |
| `action_reminder_lead_hours` [24] | reminder before an action item is due |
| `retention_days` [90] | records are deleted this long after the close |
| `max_lifetime_days` [30] | a facilitation still open then ends with an abort report |
| `max_active_per_facilitator` [10], `max_active_instance` [50], `starts_per_hour_per_facilitator` [20], `max_messages_per_facilitation` [500] | quotas; reaching one produces a system notice |
| `session_agenda_lead_minutes` [60] | agenda before a meeting |
| `media_consent_explicit` [false] | speech of a call needs a yes from every participant |
| `followup_grant_days` [14] | how long the scoped grant lasts without action items |
| `protocol_mail_enabled` [false] | also mail the protocol through the follow-up integration |

## Operators

- **Facilitations view** in the navigation ("Facilitations" / "Moderationen"):
  which facilitator runs which facilitation, phase, counts and dates. No
  contents.
- **API** under `/api/v1/facilitation` (operator session):
  `GET /facilitations`, `GET /facilitations/:id`,
  `POST /facilitations/:id/content` and `POST /facilitations/:id/terminate`
  (both need `{ "reason": "..." }` and are audited),
  `GET /facilitations/:id/audit`.

## Upgrading from 0.7.x

1.0.0 is a cut-over, not an upgrade in place. There is nothing to migrate.

- The plugin is now an `extension` that provides `facilitationEngine@1`. The
  ephemeral Conductor run, its state blob, the auto-provisioned "omadia
  Facilitator" agent and the scoped roles are gone.
- The old tools (`facilitation_progress`, `facilitation_nudge`,
  `facilitation_contribution`, `facilitation_update`, and the `query_facilitation`
  sub-agent) no longer exist. The default agent loses them when 1.0.0 is
  installed; facilitators are created under "Facilitators" instead.
- Install it together with the kernel release that has native facilitators and
  with channel-teams 0.36.0. 0.7.x does not run on that kernel.

## What is verified, and how

| | |
|---|---|
| Verified by tests against Postgres | everything in this repository, on a fake kernel with a simulated channel and a fake clock (`tests/acceptance.test.ts` for spec 9, criteria 1 to 20 except 13) |
| Verified in a browser | the facilitations view, in Chrome, through `scripts/ui-preview.mjs` with a mock API |
| Not verified here | the kernel's implementation of the services, a real Teams tenant (criterion 13), the facilitations view inside the web UI's frame, a real `facilitation.followup` integration |

## Development

```sh
npm install        # links @omadia/plugin-api from ../odoo-bot/middleware/packages/plugin-api
npm run typecheck  # sources and tests
npm run build
npm test           # or: npm test -- scheduler
npm run package    # out/omadia-agent-facilitator-<version>.zip
```

`npm test` transpiles `tests/*.test.ts` with esbuild and runs them with
`node --test`. Tests that need Postgres run against
`FACILITATOR_TEST_DATABASE_URL`; without it the runner starts a throwaway
cluster when `initdb` and `pg_ctl` are on the PATH. With neither, those tests
are reported as skipped, and the runner says so in its last line.

`node scripts/ui-preview.mjs` serves the facilitations view with the host's
content security policy and sample data.

The version lives in `package.json` and `manifest.yaml`; bump both.
