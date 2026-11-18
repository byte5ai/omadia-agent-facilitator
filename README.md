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
| omadia kernel | with native facilitators (#2043) and `@omadia/plugin-api` >= 1.55.0. The manifest says so (`compat.core: >=1.55.0 <2.0`), so the Hub does not offer the package to an older kernel. With 1.56.0 the engine asks the kernel whether a subscription still stands (`isSubscribed`); on 1.55 it infers it |
| Model of the facilitator | Sonnet-class or stronger (see "Which model") |
| Postgres | required (`requires: graphPool`). The plugin declares `permissions.sql`; an operator grants it. A pool or a grant that arrives after activation is picked up without a restart |
| Channel | one that gives each facilitator its own identity and delivers every message of a moderated conversation. Teams: `@omadia/channel-teams` >= 0.36.0 |
| Follow-up (optional) | an integration that provides `facilitation.followup`. Microsoft 365: `@omadia/m365-connector` >= 0.9.0 |

## Set-up

1. Install the plugin and **grant its SQL permission**. It owns the tables
   `plg_omadia_agent_facilitator_*` (the kernel-reserved namespace of this
   plugin) and records its migrations in
   `plg_omadia_agent_facilitator_migrations`. Without the grant the engine
   activates, reports itself unavailable, and every facilitator says that
   facilitation is not available.
2. Create a facilitator under "Facilitators" and give it its **own channel
   identity**. A facilitator never speaks through another agent's bot; without
   an identity of its own it does not start and says so.
3. Give the facilitator a **Sonnet-class model or stronger**.
4. Add the facilitator to a group conversation and ask it there to start.

### Which model

A facilitator needs a Sonnet-class model. The engine does what must not
depend on a model: it records ballots, counts, keeps time, never names in the
group who has not contributed, does not let a turn call something closed that
is open, and posts the reason when a tool refused. What is left to the model
is understanding free text, choosing the right tool and wording.

In the integration runs a small model (Haiku class) did that unreliably: it
described a setup without storing it, picked a close rule that contradicted
its own definition of done, and ignored a participant's proposal. The engine
now refuses or repairs what it can see, but it cannot see a turn that the
channel started (the kernel posts that answer). Use a small model only for
trying things out. The engine cannot read which model a facilitator runs on,
so the facilitations view shows no warning: the choice is the operator's.

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
  within the window (12 h by default, never past the deadline). While a
  consent vote is open, and always for consent to processing speech, only a
  reply to the proposal's own message answers the proposal.
- **On a shared pool.** The engine holds at most two connections for locked
  work, takes a facilitation's lock with a deadline, and never keeps a
  transaction open across a call into the channel or an integration. Mail and
  calendar calls run after the close is committed, at most once.
- **Every outgoing text** passes one guard: no tool fragments, no raw JSON, no
  unrestored privacy placeholders.

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

- **After a restart or a grant change** the engine comes up by itself and
  resumes what was running. A facilitation whose conversation the kernel no
  longer lets it read (grant revoked, engine reinstalled, facilitator
  disabled) is taken up again with a line to the group, or, when the kernel
  keeps refusing for two minutes, ended as aborted with the reason in its
  protocol. It is never left active.

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
