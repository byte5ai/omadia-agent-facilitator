# omadia Facilitator (`@omadia/agent-facilitator`)

The archetype plugin for facilitators
([byte5ai/omadia#2043](https://github.com/byte5ai/omadia/issues/2043),
archetype plugins [#2088](https://github.com/byte5ai/omadia/issues/2088)).

Since 1.2.0 the manifest is of kind `archetype`: its `archetype:` block is the
descriptor of the archetype `facilitator` that the kernel enforces (what a
facilitator never gets, which kernel services the plugin may use for it, what
it requires, and the neutrality contract that closes its identity). Installing
it needs the operator's explicit confirmation.

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
| omadia kernel | with execution scopes and scoped sends (#2089, #2090, #2091, #2078) and `@omadia/plugin-api` >= 1.69.0. The manifest says so (`compat.core: >=1.69.0 <2.0`), so the Hub does not offer the package to an older kernel. On a kernel that lacks one of the services a facilitation needs, nothing starts and the facilitator says what is missing |
| Model of the facilitator | Sonnet-class or stronger (see "Which model") |
| Postgres | required. The plugin declares `permissions.sql`; an operator grants it. The kernel then creates the schema `plg_omadia_agent_facilitator` and two roles for it (one that runs the migrations, one the engine works as) and hands the engine `ctx.sql`. The shared pool (`graphPool`) is not used |
| Channel | one that gives each facilitator its own identity and delivers every message of a moderated conversation. Teams: `@omadia/channel-teams` >= 0.39.0 (it delivers what is addressed to a facilitator during a follow-up, and private messages of participants) |
| Follow-up (optional) | an integration that provides `facilitation.followup`. Microsoft 365: `@omadia/m365-connector` >= 0.9.0; from the version that verifies kernel grants it asks the kernel before every mail and calendar operation |

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
- **In its own schema, without a connection of its own.** The engine reaches
  the database through one statement or one transaction at a time
  (`ctx.sql.query`, `ctx.sql.transaction`), as a role that can read and write
  the tables of its schema and nothing else. It relies on no state of a
  database session, so it works behind a pooler in transaction mode. A
  facilitation's lock is a row with a lease, taken, renewed and released by
  single statements and with a deadline. At most two units of locked work run
  at the same time, and no transaction is open across a call into the channel
  or an integration. Mail and calendar calls run after the close is
  committed, at most once.
- **Every outgoing text** passes one guard: no tool fragments, no raw JSON, no
  unrestored privacy placeholders.

Contributions count only from the group conversation. A private message to a
facilitator is not a turn, so private reminders ask to answer in the group.

## Question cards

Where the channel declares question cards (Teams from 0.38.0, kernel with
plugin-api 1.59.0), a vote, a consent, an assignment and a collecting step are
posted as a card, and `facilitation_questionnaire` asks up to five structured
questions on one. A chat ballot stays valid next to a card and the newest
answer of a person wins. Without cards everything is a chat ballot as before.
Every answer is checked against the card the engine sent; only participants
can answer, and an answer the platform did not verify waits for its owner's
confirmation in the group.

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
| `protocol_mail_enabled` [false] | mail the protocol of EVERY facilitation through the follow-up integration. Without it a facilitation mails its protocol only when the request asked for it (`protocolByMail` at the start) |

### Per facilitator

On the facilitator's page ("Facilitators", section of this archetype) an
operator sets defaults for that facilitator alone. The kernel stores them per
agent (archetype agent settings, declared under `archetype.agent_settings` in
`manifest.yaml`) and hands them to the engine with the facilitator's profile.
Every one is optional: unset, the instance field of the same name applies. A
value that is not valid is ignored and logged; the instance field applies.

| Field | Meaning |
|---|---|
| `default_decision_method` | `ranked`, `single`, `approval` or `consent`: the method of a template's deciding step and of a vote that names only its options. A consent step (format alignment) stays consent |
| `default_prioritisation_method` | `ranked` or `approval`: the method of a template's prioritising step |
| `ranked_points` | points per rank for this facilitator's ranked votes |
| `reminder_offsets_hours` | this facilitator's reminders before the deadline; announced in the handshake, and derived again from them when the group moves the deadline |

A facilitation can still state its own reminders, points and method; the group
decides. A kernel without archetype agent settings (plugin-api older than the
version that adds `AgentProfile.archetypeSettings`) hands over none, and the
instance fields apply.

### Working modes

A facilitator can have working modes that add moderation methods (spec 2043
§2.3), for example a retrospective or a dot-voting technique. The kernel
refuses a mode that would replace the facilitator's identity, composes every
mode beneath the identity and the neutrality contract, and never lets a mode
change who speaks. Earlier versions of this manifest omitted working modes
altogether (`persona_skill`); that omission is gone.

### Privacy mode

The kernel adds a privacy mode to every plugin with tools (`_privacy_mode`,
operator-owned). It decides what the model sees of a tool's **answer**:

- **Set it to `bypass` for this plugin** (the manifest recommends it and the
  settings form shows the reason). The engine's tools answer the facilitator
  itself: what was recorded, what was refused and why, what to tell the group.
  Under `guarded` the kernel replaces each answer by an identity-free digest
  and the facilitator moderates blind. The engine states the mode in force at
  every activation and logs a warning when it is not `bypass`.
- What the answers carry: names and words of the participants of the
  conversation the facilitator moderates. Nothing from other systems.
- Tool **inputs** do not depend on the mode: the kernel restores the real
  values before a tool runs, so names and message texts reach the engine's
  tables and the chat as people wrote them. A privacy placeholder that was not
  restored is refused by the engine's text guard and never posted.
- An organisation that forces `guarded` for every plugin
  (`OMADIA_PRIVACY_FORCE_GUARDED`) cannot run facilitators reliably until the
  kernel exempts the facilitation tools.

### Upgrading from 0.7.x

The settings of 0.7.x (`facilitator_agent_slug`, `initiator_role_key`,
`reporting_mode`, `moderation_style`, `auto_setup`, `disclose_report_target`)
are dropped on upgrade; nothing reads them. The privacy mode the operator had
set is kept and stated in the log.

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

## Execution scopes (1.4.0)

Everything a facilitation does is an action the kernel authorizes: a model
turn, a post, a private message, a card update, a readiness check. Each is
drawn from an **execution scope** the kernel keeps for the facilitation, with
a deadline, a budget and the targets it may address (specification 2043 §0).

| Scope | Opened | Ends |
|---|---|---|
| `configuring` | with the start request; it takes the conversation's reservation | when the handshake is posted, or after the kernel's limit (72 hours): then the facilitation ends with a short note |
| `active` | with the handshake | at the facilitation's deadline (one hour of room for the evaluation at that time; a runoff moves it), or when the facilitation concludes |
| `closing` | one per closing event: the result, an end without a result | when its documents are out (result, report, protocol, protocol mail) |
| `scheduling` | when the group agreed a follow-up meeting | when the invitation is settled, or at once on a stop |
| `follow_up` | when a facilitation closes with action items | on the scheduler pass after the follow-up ended |

What follows from it:

- **One facilitation or discussion per conversation.** The reservation is the
  kernel's; a conversation another facilitation or an agent discussion holds
  is not taken. It is released at `closed` or `aborted`, so a new facilitation
  can start while documents still go out and action items are followed up.
- **Reading is bound to the facilitation.** While it runs it reads every
  message. In follow-up the mention gate is back on: the facilitator hears a
  mention, a reply to one of its messages and a card button. After the end it
  reads nothing.
- **An operator's stop holds everything**, the scheduler included: no turn,
  no post, no reminder, no evaluation of a deadline. What was refused is in
  the protocol (`execution_refused`) and in the log, once per kind. Essential
  messages go out when the stop is lifted.
- **A turn has a hard cap** of model calls. A turn that would need more
  returns no text, and the group is told; a used-up budget is said once.
  Votes, "status" and "stop" need no model and keep working.
- **Mail and calendar need a kernel grant** next to the list of people the
  group confirmed: `protocol_dispatch` under the closing scope,
  `followup_scheduling` under the scheduling scope. A grant is issued with the
  current recipients before each use and revoked when its work is done.
- **One mention, one reply.** While a facilitation runs the engine answers
  and the kernel suppresses the turn a mention would start. In follow-up the
  kernel asks the engine who answers a mention (plugin-api 1.73.0): the
  engine takes "done 2" and "status" and answers them without a model, and
  declines everything else, which the facilitator's ordinary turn answers
  (it can close an item through `facilitation_action_done`). On a kernel
  that does not ask, every mention in follow-up is the ordinary turn's. A
  reply to one of the facilitation's messages, a card button and a private
  message are always the engine's.
- **A participant can ask for the status privately.** "status" in a private
  chat with the facilitator answers with the status of their facilitation and
  nothing else; with several, the facilitator asks which. An owner can report
  an action item as done there ("done", or "done 2"). Everything else gets the
  facilitator's ordinary answer to private requests.

The budgets per scope are fixed in `src/engine/scopes.ts` (`SCOPE_BUDGETS`,
`TURN_MODEL_CALLS`).

### Upgrading to 1.4.0

- Needs a kernel with `@omadia/plugin-api` >= 1.69.0 and, for Teams,
  `@omadia/channel-teams` >= 0.39.0.
- Migration `0006` adds the table of scopes and renames the session states to
  the names of the specification (`running` to `live`, `ended` to `closed`).
- A facilitation that is running or in follow-up when 1.4.0 activates is
  taken over on the first pass: its scopes are opened in the kernel's order,
  it subscribes as itself, and the subscription of the first major is given
  back. The log says `taken over under execution scopes`.
- In follow-up a plain "done 2" in the group is no longer heard. Reminders
  say how to answer: privately, by a reply, or with a mention.

## Upgrading to 1.3.0 (own database)

Up to 1.2.0 the tables lived in the shared schema `public` and the engine used
the kernel's pool. From 1.3.0 the plugin has its own schema.

- The kernel decides from the manifest: an archetype plugin that does not
  require `graphPool` gets its own database. At the first activation of 1.3.0
  it moves the `plg_omadia_agent_facilitator_*` tables (the migration ledger
  included) out of `public` into the schema `plg_omadia_agent_facilitator`.
  Functions, types, sequences and views under the same prefix move with
  them. Rows are not touched.
- Migration `0005` is the safety net for the trigger function of the event
  log: it makes sure the function the append-only trigger calls is the one
  inside the schema.
- **There is no way back.** 1.2.0 and earlier look for the tables in `public`
  and would create empty ones there. Do not install an older version after
  1.3.0 was active.
- Needs a kernel with `@omadia/plugin-api` >= 1.62.0.

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
