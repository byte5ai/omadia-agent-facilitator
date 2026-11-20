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
