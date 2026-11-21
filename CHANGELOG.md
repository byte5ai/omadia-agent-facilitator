# Changelog

## Unreleased (#2090, ADR-0028 in byte5ai/omadia)

### Compatibility

- Runs on kernels from plugin-api 1.82.0 (unchanged). **Must be rolled out before a kernel
  with plugin-api 1.84.0**: that kernel refuses moderation under a `closing` scope and a
  deadline wait without an open closing, which 1.6.0 relies on. Reply binding in private
  chats needs kernel 1.84.0 and channel adapters that state `replyToMessageId`.

### Changed

- Closing scopes are opened with `eventAt` (the closing's `started_at`) and the closing's
  `absolute_until` as deadline; `syncScopes` opens the scopes of all open closings first, then
  the deadline wait.
- What is sent under a closing maps to the kernel's closing purposes (consent replies and the
  confirmation card as `consent`, state reports as `status`).
- Private messages: a reply to a reminder completes that reminder's item; "stop" in reply to a
  reminder ends only that facilitation's follow-up; without a reference the "which one?"
  question offers `1a`/`1b`. Private answers are drawn with purpose `status`.

## Unreleased (#2090, ADR-0028 in byte5ai/omadia)

### Compatibility

- Runs on kernels from plugin-api 1.82.0 (unchanged). **Must be rolled out before a kernel
  with plugin-api 1.84.0**: that kernel refuses moderation under a `closing` scope and a
  deadline wait without an open closing, which 1.6.0 relies on. Reply binding in private
  chats needs kernel 1.84.0 and channel adapters that state `replyToMessageId`.

### Changed

- Closing scopes are opened with `eventAt` (the closing's `started_at`) and the closing's
  `absolute_until` as deadline; `syncScopes` opens the scopes of all open closings first, then
  the deadline wait.
- What is sent under a closing maps to the kernel's closing purposes (consent replies and the
  confirmation card as `consent`, state reports as `status`).
- Private messages: a reply to a reminder completes that reminder's item; "stop" in reply to a
  reminder ends only that facilitation's follow-up; without a reference the "which one?"
  question offers `1a`/`1b`. Private answers are drawn with purpose `status`.

## 1.6.0

### Compatibility

- **Requires plugin-api 1.82.0** (`compat.core: ">=1.82.0 <2.0"`): the release is built
  against the kernel contract that carries `conversationSend@2` `react`. A kernel below
  1.82.0 is not offered this version and stays on 1.5.7.

### Added

- **A session's own electorate** (spec 5.5): a linked session fixes the source of its member
  list when it is linked; a step run inside a live session can be decided by that session's
  participants (`facilitation_step_electorate`), guests included and people only at home not
  eligible; session-only participants never count as missing for home steps; leaving the
  meeting chat ends only the session membership. Migration `0011_session_electorate`.
- **Guests answer the media consent of their session** (spec 6.3): asked in the meeting chat,
  decided by the session's members; anyone there can object.
- **Quiet recording with a reaction (spec 5.14, #2061).** Where the channel
  declares reactions (kernel `conversationSend@2` `react`, plugin-api 1.82.0),
  a contribution in the announced format gets a thumbs-up on its message,
  set as the facilitator's own identity; elsewhere recording stays silent. A
  reaction is not counted as a message of the facilitation. Feature-detected:
  an older kernel or a channel without reactions changes nothing.
- **Repeat after a rule change (#2062 criterion 57; migration 0010).** A
  change of the method of a closed step repeats it as a new step linked to it
  (`repeats_step_id`), opened at once with fresh contributions; a step that was
  running waits and resumes after it. The old decision and what followed from
  it are `pending_repeat` until the repeat closes, then `replaced`; with a
  different outcome what followed is `void`, its people are told and asked to
  contribute again. The old step and its protocol stay as they were.
- **One process per message (criterion 29).** Where several processes of the
  same facilitator share a conversation, an unreferenced "stop" or "erledigt"
  that more than one could take gets exactly one question and changes nothing;
  a reply to one process's message goes to that one.

- **Several contributions per message (criterion 50; migration 0009).** A
  contribution is keyed by its message and a part index. A message written as
  a list in a collecting step becomes one idea per point; the model records a
  free-text message with several points as `parts`, confirmed in one question.
  A new revision before the step closes replaces exactly that message's parts;
  an edit or deletion after the step closed changes nothing.
- **Imported contributions (#2061).** `facilitation_record_import` records what
  another participant said elsewhere (older votes from a screenshot) as
  `pending_import` for that person, with who imported it and from where. It
  counts only once the person confirms it in their own message; status and
  protocol show the origin. A name shared by two participants is refused with
  both full names.

### Changed

- **Consent windows (criteria 24, 31).** Agreement by everybody no longer ends
  a proposal's window early; a consent may be withdrawn until the window ends.
  A consent step has its own window (the change window, never past the
  deadline) and closes at its end without a standing objection, not when
  everybody consented.
- **Quiet recording (spec 5.3, 5.14).** A contribution in the announced format
  is no longer echoed in the group, nor are confirmations, changes and
  deletions. Only a reading from free text gets its one confirmation question.
  (The kernel has no contract for the facilitator to react to a message; see
  ADR 0025.)
- **Content authenticity (criterion 23).** `facilitation_record_contribution`
  refuses a ballot that differs from what the stored message says in the
  announced format, and a stated revision that is not the latest.

- **Known electorate (spec 5.5, #2061 criteria 35 and 44).** The source of
  the list of participants is fixed at start (`platform_roster` or
  `declared_list`, migration 0008). With the platform roster the engine asks
  the channel fresh before every automatic completeness or consent decision;
  a list that is not `complete` holds the decision, the group is told once,
  and the engine tries again with the next contribution or reminder. A
  declared list grows by the initiator's names, by people a participant names
  (`facilitation_name_participant`) once they write, and by whoever posts.
  The final consent of a closing gets `finalConsentElectorate`: fresh at the
  window's end, hourly for at most 24 hours, then "participants could not be
  verified".

- **Defaults per facilitator** (byte5ai/omadia#2066, spec 2043 §5.6, §7): the
  archetype declares `agent_settings` (`default_decision_method`,
  `default_prioritisation_method`, `ranked_points`, `reminder_offsets_hours`).
  The operator sets them on the facilitator's page; the engine reads them from
  the facilitator's profile (`AgentProfile.archetypeSettings`) and puts them
  over the instance settings, which stay the default. A facilitation stores
  the offsets its reminders come from, so moving the deadline keeps the
  facilitator's offsets.
- **Field scenario without Teams** in the test suite: Slack, Discord and
  Telegram, each through the facilitator's own identity on that channel; a
  Teams identity does not make it ready elsewhere.

### Changed

- **Working modes are no longer omitted** (byte5ai/omadia#2060, spec 2043
  §2.3): `persona_skill` left `archetype.omits`. The kernel accepts modes that
  add moderation methods and refuses any identity replacement.

- **Sessions in a linked meeting chat** (#2076, #2089, spec 5.3): a home
  participant links a meeting chat from inside it by mentioning the
  facilitator and naming the facilitation. The chat gets its own
  reservation, subscription and cursor and is read as the session's state
  allows (scheduled: addressed messages, live and confirming: everything,
  closed: nothing). Its readiness is checked when it is linked and again
  before the session goes live; if it is missing the session does not start
  and the home conversation is told. People only in the meeting chat are
  session participants: they never see the home conversation's history, and
  a private "status" gives them only their sessions' status.
- **Binding close per session** (#2076, spec 5.2, 6.3): an agreed session
  ends with its summary (decisions, next steps, open points), frozen as the
  document of its own closing event `session:<id>` with its version. It is
  confirmed by the group only where the method or the definition of done
  requires it (the session is `confirming` meanwhile, and the window
  survives the facilitation's close); stop or abort ends it as "not
  confirmed (facilitation stopped)". Scheduled sessions are cancelled with a
  note in their chat at every end.
- **Spoken contributions from transcript segments** (#2077, #2089, spec
  5.3): a segment of a personal microphone waits for exactly its author to
  confirm exactly that revision; a segment of a shared room microphone names
  nobody, and a participant can adopt exactly that revision with "mine",
  recorded as "adopted from the transcript".

### Changed

- Speaker recognition never sets authorship: the tool
  `facilitation_record_spoken` is removed. A reply that confirms a question
  whose text was corrected since confirms nothing.
- Migration `0008_session_conversations`.
- Uses plugin-api 1.81.0 where present (`setSessionState`, `onLinkRequest`,
  `reserveConversation({ linkRequestId })`, `superseded`); on an older
  kernel a linked session cannot go live.

## 1.5.7

### Changed

- **A questionnaire answer is acknowledged in the group without its content:**
  "Answer recorded from Anna (2 of 5)" / "Antwort von Anna erfasst (2 von 5)",
  or "changed" for a newer answer. The question and the answer are not
  repeated; the card's receipt and the result list them. The echo of a chat
  ballot is unchanged. An answer the channel did not verify still asks its
  author to confirm what was read.

### Fixed

- **A result without answers says so.** A facilitation that is closed with a
  questionnaire nobody answered states that in its result, instead of only
  saying that it is complete. A question nobody answered is listed with "no
  answer" in the language of the group.

## 1.5.6

Rollout defects D37 to D39 and observation O3 (found on 1.5.5).

### Fixed

- **D37, an answer on a questionnaire card counts.** In a step without a vote
  a verified answer is that person's contribution: the status lists them under
  "Contributed", nobody who answered is invited again, and a newer answer
  replaces the earlier one. Next to a vote it is not a contribution: who
  answered a questionnaire has not voted.
- **D37, a facilitation that is a questionnaire finishes by itself.** When
  every participant has answered, the card closes with the answers and the
  facilitation concludes without a turn of the facilitator. This holds when
  the facilitator posted the card with the new `closesWhenAllAnswered`, or
  when the facilitation is one step without a vote whose definition of done
  says that it is done once everybody answered.
- **D37, the result names the answers.** The result of a facilitation lists
  what was answered on its questionnaire (`Answers:` / `Antworten:`).
- **D37, a turn knows the answers.** The state of a turn holds the latest
  questionnaire with its answers, so no tool call is needed to read them.
- **D38, closing on request fits a turn.** `facilitation_close` is one call:
  it needs no step closed first, the person who asked counts as agreeing, and
  where that person is the only participant the facilitation concludes at
  once instead of asking a group of one for objections. Closing the last step
  of a facilitation with a free-text definition of done is followed by the
  same close in the same call, so it is not left open with nothing to do. A
  turn reserves eight model calls instead of six.
- **D39, a deadline given as a span from now is kept.** `facilitation_start`
  takes `deadlineInMinutes` ("in 90 minutes" is 90) and works out the time
  itself. Its answer states the deadline that holds, or that none is set and
  what to do if the request named one.
- **O3, the person reads what was taken over.** A questionnaire answer in a
  step without a vote is acknowledged in the group with the value as the
  engine keeps it ("15min" is acknowledged as 15). The receipt the channel
  itself shows on the card is the channel's and unchanged.

## 1.5.5

Finding O2 of the rollout: a question card closed while an operator had
stopped the facilitator stayed open and clickable in the channel until its own
end.

The update that closes a card was queued as droppable. The kernel refused it
under the stop, and a droppable message is not tried again.

### Fixed

- **A card's closing update is not lost.** It is essential now: refused or
  failed, it is tried again until it is applied. There is one update per card
  (a card closes once), so only its final state is sent. For the kernel it is
  the same `moderation` action as before.
- **An operator's stop is not a failed attempt.** An essential message the
  kernel refuses because of a stop is held and asked again every minute,
  without counting attempts, so it goes out soon after the stop is lifted,
  however long it lasted. Before, it was retried with a growing pause and
  given up after twenty attempts. This holds for every essential message (the
  abort report, the result), not only for card updates.
- An update for a card that never reached the channel is given up at once, as
  before.

## 1.5.4

Finding O1 of the rollout: during a vote a participant asked which options
there are, and the facilitator answered that its state holds only the goal.

This was not a regression of the move to `agentTurn@2`: the state a turn gets
has never held the question or the options of a step, only its title and who
contributed.

### Fixed

- **A turn knows what is asked.** The state of a turn now holds, for the open
  step, the question, how it is decided (and the round of a runoff), every
  option with its key (`A = Samstag, B = Sonntag`), until when the step is
  open where it has its own end, and how the group was told to answer. A rule
  of the turn says to answer questions about it from that state.
- **Before the opening** the same is stated for what is set up to be asked.
- **The status lists the options** with their keys, above the tally
  (`Options: …` / `Optionen: …`), in a step that has options.

## 1.5.3

For a kernel without the first majors of the message, turn and send services
(K6.3).

The engine has used only the second majors since 1.4.0. The one thing left of
the first major was giving back the subscription of a facilitation that began
before 1.4.0, when it is taken over.

### Changed

- **Take-over on a kernel that has no `conversationMessages@1`:** nothing is
  given back (the kernel ended those subscriptions itself), and nothing is
  attempted that could fail. This also holds where the kernel answers the
  bare name with a service that has no `unsubscribe`; before, that attempt
  was caught and logged as a failure.
- The activation log no longer reports `conversationMessages` (the first
  major) as a missing service whose "feature degrades": nothing depends on it.

## 1.5.2

### Fixed

- **The status after the close described a step that no longer exists.**
  Asked during the follow-up (in the group or privately) it said "Contributed:
  nobody yet / Still open: nobody" and listed no action item. It now says what
  the facilitation reached: its decisions, who contributed (everybody whose
  contribution counted over all steps, and who took on an action item), the
  action items with number, owner, due date and state, how many are open, and
  until when they are followed up. For a facilitation that ended without a
  result it says why.
- **A ballot after a mention was not counted.** "Mona (Test) A" went to the
  facilitator's turn instead of being read as the ballot it is. The mention
  at the start is taken off before the ballot is read (the display name as
  Teams writes it, a tag, "@name").

## 1.5.1

A mention as Teams writes it (live finding D36).

### Fixed

- **A command after a real mention was not read when the facilitator's name
  has more than one word.** Teams stores the mentioned display name in the
  text, without an "@": "Mona (Test) erledigt 1". Only "@token" was taken off
  the start, so "erledigt 1", "status" and "stopp" after a mention were not
  recognised. In follow-up the engine declined the message and the ordinary
  turn answered that nothing was closed. Now the mention at the start is
  taken off as the channel wrote it: the whole display name (several words,
  parentheses), a tag (`<at>…</at>`), "@name", and, where the kernel states
  that the message addresses the facilitator, a part of the name or a name of
  one word ("Mona erledigt 1").
- **During a vote a request with a mention that did not end in "?" got no
  answer.** Whether a message addresses the facilitator was read from its
  text; the kernel's statement on the record (`addressedToBot`) was not
  looked at, and the kernel suppresses the ordinary turn there, so nobody
  answered. A message the kernel marks as addressed now always goes to the
  facilitator's turn. The name is also found anywhere in a text when it has
  several words.

## 1.5.0

The engine answers a mention during the follow-up itself (kernel #2089,
`onAddressedMessage`, plugin-api 1.73.0).

`compat.core` is unchanged (`>=1.69.0`): the hook is feature-detected. On a
kernel without it the behaviour is that of 1.4.1.

### Changed

- **In follow-up, "done N" and "status" with a mention are answered by the
  engine, without a model.** The kernel asks the engine who answers a message
  that addresses the facilitator where a facilitation listens for such
  messages. The engine decides from its state at once: it takes "done" of
  somebody who owns an open item (or names an item by its number) and
  "status" of a participant, and declines everything else, which the
  facilitator's ordinary turn then answers. Exactly one of the two answers.
  In 1.4.1 closing an item by a mention depended on the model calling a tool.
- The work happens after the kernel got its answer, through the same inbound
  path as every other message. The stored event of the same message is not
  answered a second time, however it arrives: named on the turn, pushed (a
  reply that also mentions), read on a later pass, or after a restart
  (`left_to_hook` in the inbound ledger).
- With several follow-ups in one conversation the message goes to the one it
  is about (the item's number, an item of the author), otherwise to the most
  recent one.

### Kept

- `facilitation_action_done` stays for the ordinary turn: for a message the
  engine declined ("the second one is finished") and for kernels without the
  hook.
- On a kernel without `onAddressedMessage` a mention in follow-up is left to
  the ordinary turn (`left_to_turn`), as in 1.4.1.

## 1.4.1

One mention, one reply.

### Fixed

- **A mention during the follow-up got two replies.** There the kernel
  delivers a mention to the engine as an event and also lets the
  facilitator's ordinary turn answer it; the engine answered "done 2" and the
  turn answered on top. The kernel gives the engine no way to claim the
  message, so the engine now leaves a mention in follow-up to the turn: it
  does nothing for it and posts nothing (`left_to_turn` in the inbound
  ledger). A reply to one of the facilitation's messages and a card button
  start no turn and stay the engine's, as does a mention where another
  facilitation of the facilitator is live in the conversation (no turn runs
  there).
- Next to a live facilitation, a "done" with a mention that is about an item
  of the earlier facilitation's follow-up no longer starts a model turn of
  the live one as well.

### Added

- **Tool `facilitation_action_done`** for the ordinary turn: closes an action
  item for the person who wrote the message (taken from the message, never
  from an argument), says so in the group, and asks which one when several
  are open. Because it posts, the kernel drops the turn's own text.
- `facilitation_status` also answers while action items are followed up.

## 1.4.0

Execution scopes (specification 2043 §0; kernel #2090, #2089, #2091, #2078).

**Needs kernel `@omadia/plugin-api` >= 1.69.0** (`compat.core: >=1.69.0 <2.0`)
and, for Teams, `@omadia/channel-teams` >= 0.39.0.

### Changed

- **Every action is drawn from an execution scope of the kernel.** The five
  scopes of the specification are opened and ended with the lifecycle:
  `configuring` (with the reservation of the conversation), `active`,
  `closing` (one per closing event), `scheduling`, `follow_up`. Each has its
  deadline and budget, and the people it may address are registered on it.
- **Model turns go through `agentTurn@2`**, with scope, facilitation, phase,
  purpose, emission type and a reservation of model calls.
- **Posts, private messages, card updates and the readiness check go through
  `conversationSend@2`**, each with its scope. The first majors of the send
  services and `targetedSend` are no longer used.
- **Reading goes through `conversationMessages@2`**, bound to the
  facilitation: every message while it runs, what is addressed to the
  facilitator during follow-up, nothing after the end. A facilitation never
  sees what an earlier one received in the same conversation.
- **The reservation is released at `closed` or `aborted`**, not when the last
  document is out: the closing scope still delivers them.
- **Follow-up mail and calendar run under kernel-issued grants**
  (`executionGrants`), passed to `facilitation.followup` with every call. The
  list of confirmed recipients stays as the second line.
- **Setting up is bounded.** When the `configuring` scope runs out (72 hours
  by the kernel's default) the facilitation ends with a short note.
- **Session states carry the names of the specification**: `scheduled`,
  `live`, `closed`, `cancelled` (migration `0006`).
- Reminders of action items say how to report one as done now that the
  follow-up hears only what is addressed to the facilitator.

### Added

- **Private requests of participants** (`onPrivateMessage`): "status" answers
  with the status of the facilitation the person takes part in, and asks which
  when there are several; an owner can report an action item as done. Anything
  else is handed back to the kernel.
- **Refusals are said.** `kill_switch`, a used-up budget, a passed deadline,
  a target outside the scope: on record in the protocol (`execution_refused`)
  and in the log, once per kind; the group is told where a message can still
  reach it (a turn over its reservation, a used-up budget for turns). A stop
  holds the scheduler: the job stays due and is not a failed attempt.
- **A kernel without these services**: nothing starts, and the facilitator is
  told what is missing.
- **Take-over** of a facilitation that was running or in follow-up before
  1.4.0: its scopes are opened in the kernel's order and it subscribes as
  itself.
- The lifecycle of the specification in status, protocol and the
  facilitations view: after the close a facilitation is `following_up` or
  `ended` (`state` in the operator API, next to `phase`).
- Migration `0006`: the table of scopes, and the session state names.

### Removed

- Support for kernels before plugin-api 1.69.0 (inferring a lost subscription
  from stored events, sends that ride on a subscription).

## 1.3.0

The plugin's own database (kernel #2088, K3).

**Needs kernel `@omadia/plugin-api` >= 1.62.0** (`compat.core: >=1.62.0 <2.0`).
**There is no way back to 1.2.0 or earlier** once this version was active: its
first activation makes the kernel move the tables out of `public`.

### Changed

- **The engine works in its own schema, as its own database role.** Every
  access goes through `ctx.sql.query` (one statement) or
  `ctx.sql.transaction` (one transaction). The shared pool is gone from the
  manifest (`requires: []`) and from the code; no connection is held anywhere.
  Table names were and stay unqualified.
- **The facilitation lock holds no connection.** It was already a row with a
  lease; taking, renewing and releasing it are now single statements, and the
  work under it uses a transaction or single statements. At most two units of
  locked work run at the same time, as before.
- **A database whose migrations failed is not worked on.** The tools answer
  "not available" until a later pass applied them; before, a tool call could
  reach tables of an older state.
- The log names the schema in use at activation, and a kernel that cannot
  give an archetype plugin its own database is named as the reason the engine
  is down.

### Added

- **Migration `0005`**, a safety net: the trigger that keeps the event log
  append-only must call a function inside the plugin's schema. The kernel
  moves that function together with the tables; the migration creates it in
  the schema and binds the trigger to it in case it is not there. Nothing
  changes where it already is.

### Tests

- The Postgres-backed tests run as a role that owns nothing: no attribute,
  member of no role, `search_path` set on the role, only SELECT, INSERT,
  UPDATE and DELETE on its schema, and a pool of four as the kernel opens it.
  Migrations run as a separate role that owns the schema.

## 1.2.0

The plugin becomes an archetype plugin (kernel #2088, P1 of the spec
alignment), and the findings of the live runs on 1.1.2 (D27, D28, D29).

**Needs kernel `@omadia/plugin-api` >= 1.60.0** (`compat.core: >=1.60.0 <2.0`),
the first kernel that knows the manifest kind `archetype`. An older kernel is
not offered this version. Installing or updating to it asks the operator for
an explicit confirmation.

### Added

- **Manifest kind `archetype`.** The manifest carries the descriptor of the
  archetype `facilitator` that the kernel enforces: the eleven omissions with
  their reasons, the four additions, the requirement of an own channel
  identity, labels and description in English and German, and the neutrality
  contract as `role_contract`. `provides: facilitationEngine@1` stays for
  kernels that find the engine by it. The German manifest texts use the
  product terms (Moderation, Kanalidentität); the display name is
  "Facilitator archetype".
- **Service `archetypeProcesses:facilitator`** (plugin-api 1.61.0; a kernel
  that never asks ignores it). Before the kernel disables or deletes a
  facilitator, or removes this plugin, `endProcessesOfAgent({ agentSlug,
  reason })` ends every running facilitation of that agent with its abort
  report, posted as the facilitator, with the reason in words. A closed
  facilitation that still follows up action items ends its follow-up. It is
  idempotent and answers within 17 s whatever a channel does (the kernel
  waits 20 s); what is not finished by then is reported as `failed`.
- **Closing a vote early, by consent (D28).** "next" / "weiter" in a ranked,
  single or approval vote proposes to close it now and count the votes cast;
  whoever writes it agrees with it. It closes when everybody agreed or nobody
  objected within the confirmation window; an objection keeps it open. A tie
  then goes to a runoff, never to an abort: the deadline has not passed.
  `facilitation_step` with `close` on such a vote puts the same proposal to
  the group instead of refusing.

### Changed

- **A vote is one message where the channel has cards (D30).** A card is
  posted without a text next to it; it carries the step ("Step 2 of 3."), the
  title, the question, until when it is open and one line that an answer in
  the chat counts too. The separate announcement of a vote step is not posted
  when the card stands for it; a card the channel refuses still brings the
  whole announcement into the chat. The handshake says "You vote on the card;
  an answer in the chat counts too." and explains the chat syntax only on
  channels without cards.

### Fixed

- **A refused card was recorded as posted (D27).** The event at queueing is
  now `card_queued`; `card_posted` is written when the channel took the card
  and `card_refused` (with the channel's reason and whether the question went
  out as text) when it did not.
- **An assignment with one candidate (D27).** One item and one candidate is a
  card of its own with the volunteer button (Teams 0.38.4 accepts it there).
  A card with several items never offers the button, which channels do not
  render there, and with a single candidate the question stays in the chat
  instead of on a card the channel has to refuse.
- **A number asked on a channel without a number field (D29).** `number` and
  `date` questions of a questionnaire are no longer refused there: they are
  text fields that say what is expected, and the typed answer is read and
  checked ("15min" is 15, "24.11.2026" is 2026-11-24). What cannot be read,
  or is out of range, is not recorded, and the person is told privately what
  is needed.
- **Process words in a vote were dropped without an answer (D28).** "next"
  before anybody voted, and an agreement with nothing open to agree to, are
  answered once per vote with when it closes and how the group can close it
  earlier. The facilitator no longer says it cannot close a vote.

## 1.1.2

### Changed

- **A meeting nobody scheduled through the facilitator is not narrated.** Its
  start is silent unless the meeting offers something else than the chat;
  then one line says what the facilitator perceives in addition or no longer.
  Its end is not announced. A meeting scheduled through the facilitator is
  announced as before.

### Fixed

- **A facilitation that starts while a meeting already runs** knows it: the
  conversation's snapshot is read at the start, and an `online` or `hybrid`
  modality is a running session from the first moment. The start event that
  arrives later belongs to the same session.
- **Sessions left running by facilitations that ended before 1.1.1** are
  closed once by migration `0004` (ended facilitations only).

## 1.1.1

Defects from the live runs on 1.0.5 (D25, D26, and the open part of D23).

### Fixed

- **The protocol by mail (D25).** A request for it had no effect: the mail
  was sent only when an operator had switched `protocol_mail_enabled` on for
  the whole instance, and no tool could ask for it. `facilitation_start` now
  takes `protocolByMail`; the handshake says that the protocol also goes by
  mail to the addresses the channel knows, and at the close it goes through
  `facilitation.followup.sendMail`. The outcome is on record per recipient
  (`protocol_mail` event: sent, not_sent, unknown). Without a mail
  integration the facilitator is told at the start and nothing is promised;
  "sent by mail" is said only for a mail the integration confirmed.
- **Meetings (D26).** A meeting that starts in a moderated chat opens a
  session with a capability snapshot read at that moment, whether or not it
  was scheduled through the facilitator, and the facilitator says what it
  perceives there. Its end closes the session and reads the chat's
  capabilities again. A vote opened while the meeting runs uses what the
  meeting offers (a card where the channel has cards, a poll where the session
  has polls). Nothing waits for participants to join. When a facilitation
  closes or aborts, its running sessions end and its scheduled ones are
  cancelled; before, they stayed "running".

### Tests

- A reminder directly followed by a mention, and messages arriving while the
  reminder runs, on the lease lock of 1.0.5 (D23).

### Not covered

- A facilitation that starts while a meeting is already running does not
  learn of it: the kernel reports a start, not a state.

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
