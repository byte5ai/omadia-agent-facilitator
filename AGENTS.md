# AGENTS.md — omadia-agent-facilitator

Notes for agents and contributors working in this repository. Spec: byte5ai/omadia
`specs/2043-native-facilitators/spec.md` (spec B). Where an issue's "Changes after review"
section and the older text differ, the review section holds. Decisions with an ADR live in
byte5ai/omadia `docs/adr/`.

## Ground rules

- Plugin-first: the facilitation engine (tables, lifecycle, scheduler, outbox, closing,
  retention) lives here; the kernel only provides contracts (`@omadia/plugin-api`).
- A facilitator-plugin PR does not bump the version; releases are cut separately.
- Gates: `npm run typecheck`, `npm run build`, `npm test` (Node 22, a real Postgres via
  `initdb`/`pg_ctl` or `FACILITATOR_TEST_DATABASE_URL`; skipped is not passed), and
  `node scripts/check-acceptance-matrix.mjs`. CI runs all of them.
- Shared types (`src/model.ts`) and migration numbers land as small PRs first, because
  several streams change this repository in parallel.

## Acceptance matrix and CI (spec B §9; #2068; ADR-0028 in byte5ai/omadia)

- `docs/acceptance-matrix.md` maps every criterion 1 to 64 of spec B §9 to the tests that
  fail when it regresses: plugin tests here, the kernel's contract tests (`omadia:`) and
  the Teams channel's (`teams:`) where the criterion crosses that boundary.
- A new acceptance test is named by its criterion (`test('21. ...')`) and listed in that
  row; `node scripts/check-acceptance-matrix.mjs` fails on a criterion without a row, a row
  without a plugin test, a referenced title that no longer exists, and a numbered test
  missing from its row. Reference syntax: `` `file.test.ts` › "title fragment" ``.
- Acceptance tests run end to end on the fake kernel (simulated channel per transport,
  `createHarness({ channel })`), the fake clock and a real Postgres; a restart is
  `h.restart()`. A test is only listed after it was seen red with the behaviour broken.
- CI (`.github/workflows/ci.yml`) checks this repository out next to byte5ai/omadia
  (`../odoo-bot`, sparse: the plugin-api package and the zip extractor), builds
  `@omadia/plugin-api` there, then runs typecheck, build, the matrix check and `npm test`
  with `FACILITATOR_TEST_REQUIRE_PG=1` (no Postgres fails the run instead of skipping).
  `workflow_dispatch` takes a kernel ref for testing against an unreleased contract.
- Criterion 13 is the one criterion with a manual part: the §6.2 contract runs on the
  simulated transport in omadia-channel-teams, the real-instance checklist is
  `docs/facilitator-live-verification.md` there, its recorded run belongs in
  omadia-channel-teams#43.

## Result status and delivery status (spec 5.2, 5.11; ADR "Facilitation closing procedure")

- Every closing event (the result of `concluding`, an abort, the close of one session) is one
  row in `plg_omadia_agent_facilitator_closings` (migration 0007), with its frozen closing
  document, `document_version` and the scope event id (`result`, `abort`, `session:<id>`).
- Result status (`ResultStatus`): `published`, `confirmed`, `not_confirmed` with a
  `NotConfirmedReason` (`objection`, `electorate_unverified`, `not_delivered`, `stopped`),
  `aborted`. The table refuses `not_confirmed` without a reason.
- Delivery status (`DeliveryStatus`): `pending`, `delivered`, `not_delivered`, kept apart from
  the result status.
- `src/engine/resultStatus.ts` is the one place that names and marks a status:
  `markDocument`/`resultStatusLine` put the status on every final document,
  `stoppedMark`/`undeliveredMark` give "not confirmed (…)" only where the document's
  confirmation was required, otherwise `published`. Session protocols (F1) use the same
  module and `openClosing(kind: 'session', sessionId)`.
- Limits (`CLOSING_LIMITS`): delivery 7 days, confirmation window default 24 h and at most
  72 h from confirmed delivery, electorate re-checked hourly for at most 24 h, dispatch 7 days,
  absolute 30 days from the event.
- Outbox rows of closing documents carry `closing_id` and `document_version`.
- `facilitations.ended_at`: when `ended` or `aborted` was reached; retention counts from here.
- `stakeholders.disclosure` (`full`, `existence`, `none`, default `existence`): what a
  stakeholder's protocol says about parts left out for them.

## Status and personal acceptance (spec 5.4, 5.7; criteria 16, 37)

- `statusText(q, f, audience)`: `group` (default; status command in the group and the
  `facilitation_status` tool) gives counts only ("Contributed: 2 of 4", "Still open: 2
  contributions") and never names anybody; `private` (a home participant asking in a private
  chat) gets the names. Before the close the group status names nobody, also not who
  contributed. After the close it names who contributed: the protocol every participant
  received lists the contributions with their authors anyway, and nobody is "missing" then.
- A nomination its owner has not accepted when the result is frozen is an open point
  ("#2 Order drinks: proposed for Cara, not accepted") in the result, the protocol and the
  status after close, never an action item; it gets no reminder and starts no follow-up.
- A "yes" to such a nomination after the freeze (a reply to or reaction on its own message, or
  a free-standing one when nothing else is open) is answered once (`late_acceptance`) and
  changes nothing. It is only seen while the conversation is still read for this facilitation
  (`concluding`, a confirmation window, or `following_up`); an `ended` facilitation reads
  nothing, so a "yes" after that gets no answer (deliberate: nothing is tracked after `ended`).
- Assignment steps are not affected: an assignment is decided only with every item confirmed
  by its nominee, otherwise it stays open (and aborts at the deadline), so no unaccepted
  assignment nomination reaches a frozen result.

## Known electorate (spec 5.5, #2061 criteria 35 and 44)

- `facilitations.electorate_source` is fixed at start on a fresh roster
  query: `platform_roster` when the channel answers `complete` with at least
  one person, else `declared_list`. The engine reads the roster's `status`
  (falling back to `partial` only for an older kernel).
- Platform roster: every automatic completeness or consent decision (a vote
  closing because everybody voted, a proposal passing at its window's end, a
  questionnaire complete, the only participant closing) first asks the roster
  with `fresh: true`. Anything but `complete` holds the decision: one notice
  in the group, a retry with the next contribution or reminder (a held
  proposal also an hour later, bounded by the deadline; at the deadline it
  fails). A `complete` answer brings the participants up to date (missed
  joins and leaves). The query runs inside the unit of work (answer and
  decision belong together) and is bounded to 5 s; no answer is `unknown`.
- What holds which decision: "everybody contributed" and "everybody agreed"
  need a verified list with every waited-for name matched. A consent window
  ("nobody objected") is held only by a roster that is not `complete`; a
  pending name or an undeclared open list does not hold it. A consent step
  evaluated at the facilitation's deadline cannot wait: on an unverifiable
  list it ends with an abort report ("participants could not be verified").
- Where the initiator named the participants on a complete roster, the list
  is theirs: the fresh roster takes over departures, never additions.
- Declared list: participant sources `declared` (named by the initiator),
  `named` (named by a participant with `facilitation_name_participant`,
  counted once they wrote themselves), `posted` (wrote here and was on no
  list; welcomed), plus `roster` and `joined`. Nobody is removed by others.
  Without any declared names ("open roster") there is no "everybody": votes
  close at the deadline, and a person who writes takes part without a
  welcome.
- Final consent of a closing: `finalConsentElectorate(w, windowEnd)` in
  `src/engine/electorate.ts` answers `verified`, `retry` (hourly) or
  `unverifiable` (24 h after the window: result `not confirmed`, reason
  "participants could not be verified"). The closing procedure (#2064) calls
  it; it never tells the group itself.

## Closing procedure (spec 5.2; ADR 0024 in byte5ai/omadia)

- `src/engine/closing.ts` drives every open closing after each delivery and on every tick
  (`advanceClosings`, registered as after-dispatch hook): `waiting` (the result waits for open
  session closings that need confirmation: rows of kind `session` with `requires_confirmation`
  and no status) → `delivery` (≤ 7 days) → `confirmation` (window from the confirmed delivery,
  `final_confirm_window_hours`, default 24, max 72; decided only at its end; electorate via
  F3 `finalConsentElectorate`, hourly retries ≤ 24 h) → `dispatch` (≤ 7 days from final) →
  `done`. Nothing of a closing is sent after its absolute limit (30 days).
- `conclude(w, { atDeadline, confirm })`: `confirm` only for a free-text definition of done
  closed on request with more than one participant (`closeOnRequest`). The `dod_met` proposal
  is no longer opened.
- The final confirmation is a proposal of kind `final_confirmation` (`windowOnly`: the
  proposals module never settles it). In `concluding` only its answers, status and stop count.
- Stop in `concluding` (`stopAfterConcluding`, also an operator terminate): `closed` with
  `close_reason = 'stopped'`, the result re-delivered as version 2 marked
  `not confirmed (facilitation stopped)` / `published`, no abort report, no follow-up, no
  follow-up invitation. Only `actor: 'kernel'` aborts a concluding facilitation.
- A failed delivery closes `closed` with delivery status `not_delivered` (no longer `aborted`).
- Abort reports are closing documents (closing kind `abort`) and list invitations already sent.
- Session protocols (F1): `src/engine/sessionClose.ts` opens and drives closings of kind
  `session` itself; `advanceClosings` only drives `result` and `abort`. The result waits while
  a session closing that requires confirmation has no `ended_at`. Closing documents in the outbox carry
  `closing: { id, version }` (`Outgoing.closing`). Stakeholders never receive session protocols.

## Protocols, stakeholders, retention, quotas

- `buildProtocol` puts `Result status:` and `Delivery:` right after the title.
- Stakeholders get `stakeholderProtocol(q, f, disclosure)` (`src/engine/stakeholderProtocol.ts`),
  one mail each, at the close or the abort only. Labels: `protocol` (header, decisions, next
  steps, open points), `talk` (summaries, clusters, participants), `contribution` (never to a
  stakeholder). `full` knows `protocol` + `talk`; `existence` and `none` only `protocol`; the
  note about withheld parts from `existence` up.
- Stakeholders named in the start request (spec 5.2 Prepare, 5.7 group consent; live finding
  2026-11-21: they were lost because the model keeps no memory between messages):
  `facilitation_start` takes `stakeholders`. `proposeNamedStakeholders` reads (`newStakeholders`)
  and writes in ONE `engine.core.work` unit, under the facilitation lock, so a re-call or a
  concurrent call never records the same name or address twice. Each entry is checked on its
  own (`stakeholderProblem`): a bad address or a missing one for somebody outside the
  conversation drops only that entry, with its own note; the others are recorded. The start
  never fails on this.
- Decision (spec 5.2: in `configuring` nothing goes public, the facilitation goes public with
  the handshake; 5.7: stakeholders are agreed by group consent, a proposal posted in the
  conversation): `proposeStakeholders` only inserts unconfirmed rows in `configuring`; no
  proposal is opened before `facilitation_open`. An `onOpened` hook queues the
  `stakeholder_proposal` job, which puts every unconfirmed stakeholder to the group as ONE
  proposal (payload `stakeholderIds` + `names`; older proposals with a single `stakeholderId`
  are still accepted) once no proposal is open, and re-queues itself (5 min) while one is.
  The `stakeholder` kind `yields` (`ProposalKind.yields`): any other proposal (step_close,
  vote_close, close, media_consent, ...) is never refused because of it. `openProposal`
  withdraws it (`proposal_withdrawn` event, its rows stay pending), posts
  `stakeholdersDeferred` and queues it again. Busy checks use `blockingProposal(w)`, which
  ignores a yielding proposal; `store.openProposal` still returns it.
- `markEnded(w)` sets `ended_at` and `purge_after` (retention from `ended`/`aborted`). Follow-up
  ends at min(last due + `followup_grace_days`, close + `followup_horizon_days`); a later due
  date is refused (`due_beyond_horizon`). Purge waits for every open closing and scope;
  `EFFECTIVE_DELETION_SQL` gives the effective time, shown in the facilitations view.
- `facilitator_limits` (`limitsOf` in `src/engine/quota.ts`) overrides active, starts per hour
  and messages per facilitation for single facilitators; the instance limit stays shared.

## Contributions (spec 5.3, 5.14; #2061 criteria 23, 50; ADR 0025)

- Recording is quiet: a contribution in the announced format posts no text. Where the
  channel declares reactions (`conversationSend@2` `capabilities(channelType).reactions` and
  `react`, plugin-api 1.82.0) the engine queues an outbox row with `reaction` (purpose
  `reaction`, droppable, not a message) that sets a thumbs-up on the person's message,
  named by its stored event id; elsewhere nothing is said. Card answers get no reaction
  (no message of their own). Only free-text readings ask their author once; a declined
  reading gets one line.
- One message, several parts: `part_index` (migration 0009); `recordParts` retires
  all parts of the older revision; `listLiveBySourceMessage` lists them.
- A step that closed keeps what it counted: edits and deletions of its messages are
  on record as `late_change` and change nothing.
- `facilitation_record_contribution` parses the stored original text first; a
  differing tool ballot is `content_mismatch`, an older stated revision
  `outdated_revision`.
- Imports: `pending_import` + ack kind `import` for the named person; the payload's
  `import` holds `by`, `origin`, `messageId`. `personNamed` never guesses between two
  people who share a name.

## Consent, processes, repeats, ties, lifecycle (spec 5.2, 5.3, 5.5, 5.7; ADR 0025)

- Group consent is decided only when its window ends (or at the deadline); full early
  agreement never shortens it, consents may be withdrawn. Consent steps get a window
  (`startConsentWindow`, job `consent_window`); a legacy consent step without
  `round_deadline` still closes on completeness.
- One process per message: `correlate()` (`src/engine/correlation.ts`) before a "stop"
  or "done" takes effect. Several possible processes and no reply reference: exactly
  one question, asked by the live process (else the newest); nothing changes.
- A method change for a closed step repeats it (`src/engine/repeats.ts`); decisions get
  `status` (`valid`, `pending_repeat`, `replaced`, `void`), action items
  `pending_repeat`/`void`. Results, closing summaries and status count `valid`
  decisions only; the protocol shows the others with their status.
- Ties: v1 has one tie rule, the runoff (window `runoffWindowHours`, never past the
  deadline). No other rule is offered until the spec names one.
- `following_up` and `ended` are derived (`lifecycleOf`: `phase = closed` plus
  `followup_state`), not stored phases; `phase` keeps the moderation lifecycle that the
  "one live facilitation per conversation" index and the scopes depend on.

## Working modes (spec 2043 §2.3; byte5ai/omadia#2060)

- 2026-11-20: the manifest no longer omits `persona_skill`. A working mode adds a moderation
  method; the kernel refuses a mode that would replace the facilitator's identity and composes
  every mode beneath the identity and the neutrality contract. ADR in byte5ai/omadia
  `docs/adr/` ("working modes for facilitators").

## Per-facilitator defaults (spec 2043 §5.6, §7; byte5ai/omadia#2066)

- 2026-11-20: default methods, points per rank and reminder offsets are archetype agent
  settings: declared in `archetype.agent_settings`, stored per agent by the kernel, edited on
  the facilitator's page, handed to the engine as `AgentProfile.archetypeSettings`
  (`facilitatorConfig` in `src/config.ts`). They sit over the instance setup fields, which
  stay the default; an invalid value is ignored and logged.
- The engine keeps no copy of the settings. A facilitation stores what it started with
  (`reminderPolicy.baseHours`, `settings.rankedPoints`, `settings.defaultDecisionMethod`), so a
  later change of the facilitator's defaults does not change a running facilitation, and a
  deadline change derives the reminders from the facilitator's offsets again.

## Readiness per channel identity (byte5ai/omadia#2066, review change 2026-11-18)

- A facilitator is ready in a conversation when it has its own identity on that
  conversation's channel; Teams installation and RSC are checked only for Teams.
- The simulated transport (`tests/fakeKernel.ts`) takes a channel type and per-agent
  identities; `tests/fieldScenarioChannels.test.ts` runs the field scenario on Slack, Discord
  and Telegram without Teams.


## Sessions and linked session conversations (spec 5.2, 5.3, 6.3; ADR-0026 in byte5ai/omadia)

- `src/engine/sessionLinks.ts`: link requests (`onLinkRequest`) name a running facilitation;
  only an active home participant, from inside the target chat, links it. The kernel's
  session state of the reservation is the read table; the engine's session status is the
  truth and `syncSessionConversations` (after every unit of work and on every pass) moves
  the kernel along. `live` only through `goLiveAtKernel` (readiness, criterion 60).
- A message of a session conversation is gated by `gateSessionRecord` (scheduled:
  questions and status/stop; confirming: consent answers, status, stop) and answered in
  that conversation (`Work.answerIn`, `Outgoing.conversationId`). Session conversations have
  their own cursor (`sessions.inbound_cursor`).
- Session participants (`session_participants`) are never home participants; they are
  `status_only` targets and get only their sessions' status privately.
- `src/engine/sessionClose.ts`: every agreed session closes with a frozen summary as closing
  event `session:<id>` (F2's closings table); posts carry `closingEvent`, so they are drawn
  from that event's `closing` scope. Jobs `session_confirmation` survive `conclude` and
  `releaseOnEnd`; stop or abort ends them in `sessionsAtAbort`.
- `src/engine/transcript.ts`: `transcript_segment` events only; never attribute speech to a
  speaker name. Participant-bound: author = platform principal, confirm exactly that
  revision. Shared: adoption by reply ("mine"), `payload.adoptedFromTranscript`.
- Texts of these modules live in `src/texts/sessions.ts`.

## Session electorate (spec 5.5, 6.3; ADR-0026 in byte5ai/omadia)

- `session_participants` lists every member of a linked session conversation: session-only
  participants (`home` false) and home participants who are in it (`home` true). Guest-only
  readers (private status, scope targets) filter `NOT home`.
- A session fixes its electorate source when it is linked (`sessions.electorate_source`):
  the meeting chat's roster if `complete`, otherwise a declared list (joins and writers).
- `steps.electorate_session_id`: a step run inside a live linked session may declare that
  session's participants (`facilitation_step_electorate`, only before any contribution).
  `stepElectorate()` in `src/engine/sessionElectorate.ts` is the one place that says who is
  expected for a step; counting, "missing", completeness, timebox and the electorate check
  use it. Session-only participants never count for home steps.
- The media consent of a linked session uses the proposal hooks `electorate`,
  `verifyElectorate` and `answerer`: the session's members answer, guests included.
