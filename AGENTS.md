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
  `initdb`/`pg_ctl` or `FACILITATOR_TEST_DATABASE_URL`; skipped is not passed).
- Shared types (`src/model.ts`) and migration numbers land as small PRs first, because
  several streams change this repository in parallel.

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
