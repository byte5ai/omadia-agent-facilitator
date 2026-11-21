# Acceptance matrix: spec B §9, criteria 1 to 64

Every acceptance criterion of byte5ai/omadia `specs/2043-native-facilitators/spec.md` §9
(spec B, current text) mapped to the automated tests that fail when it regresses (#2068).

- **Plugin tests** (`file.test.ts` › "title") run in this repository's CI on every push and
  pull request (`.github/workflows/ci.yml`): end to end on the fake kernel
  (`tests/fakeKernel.ts`, a simulated channel per transport), a fake clock and a real
  Postgres, restarts as a new engine on the same database. Skipped is not passed: CI fails
  without Postgres.
- **Kernel tests** (`omadia:` = byte5ai/omadia) cover the contract half of a criterion
  (execution scopes, grants, process-bound reads, omissions). They run in the kernel's CI;
  the plugin tests hold the kernel to the same contract through the fake kernel.
- **Channel tests** (`teams:` = byte5ai/omadia-channel-teams) cover the Teams transport.
- `node scripts/check-acceptance-matrix.mjs` (a CI step) fails when a criterion has no row,
  a row names no plugin test, a referenced test was renamed or deleted, or a test named
  "N. ..." is not referenced in row N.

Coverage: **A** fully automated here; **A+K** automated here plus the kernel's contract
tests; **A+M** automated plus a recorded manual check.

| # | Criterion | Plugin tests | Kernel / channel tests | Cov. |
|---|---|---|---|---|
| 1 | Field scenario (ranked vote, restart) | `acceptance.test.ts` › "1. field scenario"; `fieldScenarioChannels.test.ts` › "without Teams: the field scenario runs"; `reactions.test.ts` › "a ballot gets a thumbs-up on its own message"; `contributions.test.ts` › "a contribution read from free text counts only after its author confirmed the echo" | `teams:tests/facilitatorScenarios.test.ts` scenario 1 | A |
| 2 | Deadline reminders, honest close | `acceptance.test.ts` › "2. deadline"; `scheduler.test.ts` › "deadline scenario: one reminder at -24 h" | | A |
| 3 | Races and delivery | `acceptance.test.ts` › "3. races and delivery"; `scheduler.test.ts` › "race: a reminder already written to the outbox"; "crash after commit and before send"; "lost send confirmation"; "last vote and deadline at the same time"; "race: the last vote lands between"; `sessionClose.test.ts` › "criteria 3 and 38" | | A |
| 4 | Authorship and currency | `acceptance.test.ts` › "4. authorship and currency"; `contributions.test.ts` › "Anna agrees too"; "refused: foreign message, message from before the start"; "an edit retires the older revision" | `omadia:middleware/test/scopedAgentTurnInboundEvent.test.ts` | A+K |
| 5 | Methods and evaluation table | `acceptance.test.ts` › "5. methods and evaluation"; "5b. methods through the engine"; `methods.test.ts` › "evaluate: "; "assignment: a declined nomination reopens the item"; `decide.test.ts` › "a tie starts a runoff"; `scheduler.test.ts` › "runoff timeout"; `transparency.test.ts` › "a pending change proposal blocks the conclusion" | | A |
| 6 | Ambiguity | `acceptance.test.ts` › "6. ambiguity"; `contributions.test.ts` › "an unclear message gets exactly one clarifying question" | | A |
| 7 | Definition-of-done change | `acceptance.test.ts` › "7. definition of done changes without a restart"; `transparency.test.ts` › "definition of done changes without a restart" | | A |
| 8 | Membership | `acceptance.test.ts` › "8. membership"; `lifecycle.test.ts` › "membership: joining is welcomed and counted"; `transparency.test.ts` › "an initiator who left receives nothing" | | A |
| 9 | Several facilitators | `acceptance.test.ts` › "9. several facilitators" | `teams:tests/facilitatorScenarios.test.ts` scenario 6 | A |
| 10 | Omissions | `acceptance.test.ts` › "10. omissions (engine part)" | `omadia:middleware/test/facilitatorContractGuards.pg.test.ts` "every enforced omission is refused for a facilitator", "a private request for help gets the refusal without a model call"; `omadia:middleware/test/facilitatorOmissionsRoutes.test.ts`; `omadia:middleware/test/facilitatorOmissionsRuntime.test.ts` | A+K |
| 11 | Visibility, audited operator access | `acceptance.test.ts` › "11. visibility"; `governance.test.ts` › "visibility: an active participant sees everything, one who left"; "operator: metadata without contents"; `dispatch.test.ts` › "30. a mixed protocol to stakeholders" | | A |
| 12 | No silent end | `acceptance.test.ts` › "12. no silent end"; `governance.test.ts` › "quota per facilitator"; "quota of messages per facilitation"; `scheduler.test.ts` › "no silent end: a job that keeps failing" | | A |
| 13 | Teams contract tests, other channels | `fieldScenarioChannels.test.ts` › "without Teams: the field scenario runs"; "a facilitator whose only identity is on Teams is refused there" | `teams:tests/facilitatorScenarios.test.ts` (all §6.2 scenarios on the simulated Bot Framework/Graph transport, `tests/support/teamsSimulation.ts`); `teams:tests/teamsRosterStatus.test.ts`; manual checklist `teams:docs/facilitator-live-verification.md` (M1–M6 passed 2026-11-18/19; recorded run on a real instance: omadia-channel-teams#43) | A+M |
| 14 | Retrospective | `acceptance.test.ts` › "14. retrospective"; `process.test.ts` › "retrospective: ideas without mentions" | | A |
| 15 | Assignment (#330) | `acceptance.test.ts` › "15. assignment"; `decide.test.ts` › "assignment: one confirmed name per role" | | A |
| 16 | Silent voices and balance | `acceptance.test.ts` › "16. silent voices and balance"; `process.test.ts` › "silent voices: before a discussion closes"; `turnGuard.test.ts` › "S3: the group never reads from the facilitator who has not contributed"; `processBound.test.ts` › "a participant asks for the status in a private chat" | | A |
| 17 | Timebox | `acceptance.test.ts` › "17. timebox"; `process.test.ts` › "timebox: when it ends the engine says where the step stands" | | A |
| 18 | Online meeting, chat and cards only | `acceptance.test.ts` › "18. online meeting with chat and cards only"; `sessions.test.ts` › "a meeting: agenda before it"; `capabilities.test.ts` › "the agreed follow-up meeting is created from free/busy" | | A |
| 19 | Adaptation (audio mid-session) | `acceptance.test.ts` › "19. adaptation"; `sessions.test.ts` › "adaptation mid-session"; "explicit consent per participant" | | A |
| 20 | Scoped capabilities and revocation | `acceptance.test.ts` › "20. scoped capabilities"; `dispatch.test.ts` › "20. the dispatch grant ends 7 days after"; "20. without action items: the dispatch grant is revoked"; `capabilities.test.ts` › "the facilitator cannot reach anybody the group did not confirm"; "the grant is revoked when the follow-up ends" | `omadia:middleware/test/executionScopes.pg.test.ts` "#2078 kernel-issued grants" | A+K |
| 21 | Multi-step and follow-up | TODO | | |
| 22 | Meeting chat | `sessionConversations.test.ts` › "criterion 22 and 46"; "a turn there knows nothing of the home conversation" | `omadia:middleware/test/processConversationMessages.test.ts` | A+K |
| 23 | Content authenticity | `parts.test.ts` › "criterion 23: a tool-call ballot that differs from the message is refused" | `omadia:middleware/test/scopedAgentTurnInboundEvent.test.ts`; `omadia:middleware/test/processConversationMessages.test.ts` "an edited message: the latest revision is plain" | A+K |
| 24 | Group consent | `consentWindow.test.ts` › "criterion 24: no claim of agreement counts"; "criterion 24: one objection within the window blocks the proposal" | `omadia:middleware/test/executionScopes.pg.test.ts` (grants only from the owning plugin under closing, scheduling or follow-up scopes) | A+K |
| 25 | Execution scopes | TODO | `omadia:middleware/test/executionScopes.pg.test.ts`; `omadia:middleware/test/scopedSendService.test.ts` | |
| 26 | Follow-up horizon | `closing.test.ts` › "26. follow-up horizon"; `process.test.ts` › "follow-up ends by itself 7 days"; `acceptanceStaysPersonal.test.ts` › "37. with only unaccepted nominations the facilitation goes from" | `omadia:middleware/test/processConversationMessages.test.ts` "events of a running process are not purged by age" | A+K |
| 27 | Closing and session confirmation | TODO | `omadia:middleware/test/executionScopes.pg.test.ts` "the session state follows the table" | |
| 28 | Follow-up replies | TODO | `omadia:middleware/test/privateMessageRouter.test.ts`; `omadia:middleware/test/addressedMessageRouter.test.ts` | |
| 29 | Session paths, process correlation | `correlation.test.ts` › "criterion 29: two follow-ups and an active facilitation"; TODO | | |
| 30 | Stakeholder filter, completion mapping | `dispatch.test.ts` › "30. a mixed protocol to stakeholders"; `smallTexts.test.ts` › "without a number closes the only open item of its owner, and asks which one" | | A |
| 31 | Consent step, closing scopes | `consentWindow.test.ts` › "criterion 31: all agree early to a consent step"; "criterion 31: a consent may be withdrawn"; TODO | | |
| 32 | Result at the deadline | TODO | | |
| 33 | Structured inputs | `cards.test.ts` › "nothing a client sends back is trusted"; "a change of the method by consent posts a new version of the card"; TODO | `omadia:middleware/test/addressedMessageRouter.test.ts` "a card answer never stands in for the message" | |
| 34 | Final confirmation after the deadline | `closing.test.ts` › "34. the confirmation window starts when the delivery is confirmed"; "34. a standing objection"; "the absolute limit: nothing of a closing is sent after 30 days"; TODO | | |
| 35 | Unknown roster | `electorate.test.ts` › "criterion 35: a declared list counts"; "criterion 35: a join the channel did not report"; "criterion 35: a fresh answer `partial` holds"; "criterion 35: an unknown roster at the decision" | `teams:tests/teamsRosterStatus.test.ts` | A |
| 36 | Preparation | TODO | | |
| 37 | Acceptance stays personal | `acceptanceStaysPersonal.test.ts` › "37. an acceptance before"; "37. with only unaccepted nominations"; "after the freeze changes nothing and is answered once" | | A |
| 38 | Closing documents survive changes | `closing.test.ts` › "38. a closing document survives later changes"; `sessionClose.test.ts` › "criteria 3 and 38" | | A |
| 39 | Private status, result status | `dispatch.test.ts` › "39. stakeholders receive a published, a confirmed"; `processBound.test.ts` › "a participant asks for the status in a private chat"; "somebody who takes part in several facilitations is asked which one" | `omadia:middleware/test/privateMessageRouter.test.ts` | A+K |
| 40 | Pending session confirmation at close | `closing.test.ts` › "40. the result waits for a session closing" | | A |
| 41 | Private status in every phase | TODO | | |
| 42 | Closing limits | TODO | | |
| 43 | Stop during closing | `sessionClose.test.ts` › "criterion 49 (stop)"; TODO | | |
| 44 | Unverifiable electorate, failed delivery | `closing.test.ts` › "44. a roster that stays partial"; "44. a result that never gets delivered"; `electorate.test.ts` › "criterion 44: the final consent asks the roster fresh" | | A |
| 45 | Linked session in preparation | `sessionConversations.test.ts` › "criterion 45: linked during configuring" | `omadia:middleware/test/executionScopes.pg.test.ts` | A+K |
| 46 | Session guest status | `sessionConversations.test.ts` › "criterion 22 and 46"; "gives the session status only"; TODO | | |
| 47 | Stop before invitations | `dispatch.test.ts` › "47. a follow-up meeting is agreed" | | A |
| 48 | Link authorization | `sessionConversations.test.ts` › "criterion 48: only a home participant links a meeting chat" | | A |
| 49 | Sessions at the end | `sessionClose.test.ts` › "criterion 49 (stop)"; "criterion 51 and 49 (regular close)"; `executionScopes.test.ts` › "when the configuring scope runs out"; `meetingEvents.test.ts` › "no session stays open when its facilitation has ended" | | A |
| 50 | Several contributions per message | `parts.test.ts` › "criterion 50: three ideas in one message"; "criterion 50: points read from free text" | | A |
| 51 | Session confirmation across the close | `sessionClose.test.ts` › "criterion 51 and 49 (regular close)" | | A |
| 52 | Stop during the final closing | `closing.test.ts` › "52. stop during the final consent window"; "52. stop before the final summary is delivered"; `dispatch.test.ts` › "52. a pending follow-up invitation survives" | | A |
| 53 | No reading across processes | `release.test.ts` › "does not replay the earlier chat"; `processBound.test.ts` › "a new facilitation next to a follow-up: each reads for itself"; TODO | `omadia:middleware/test/processConversationMessages.test.ts` "two facilitations one after another", "overlap: a reply or card answer bound to the older process reaches it alone" | |
| 54 | Session electorate | `sessionElectorate.test.ts` › "a step run inside a live session declares its participants"; TODO | | |
| 55 | Stakeholders | `capabilities.test.ts` › "a stakeholder counts only when the group confirmed"; TODO | | |
| 56 | Stop with action items | `closing.test.ts` › "56. stop with confirmed action items" | | A |
| 57 | Change after a closed vote | `repeats.test.ts` › "criterion 57: a changed method repeats the closed vote"; "criterion 57: a different outcome replaces the old decision" | | A |
| 58 | Agent disabled or deleted | `endOfService.test.ts` › "a disabled facilitator ends every running facilitation"; "the reason is said in words"; TODO | | |
| 59 | Definition of done waits for last session | `sessionClose.test.ts` › "criterion 59: at the deadline the last session closes"; TODO | | |
| 60 | Session readiness | `sessionConversations.test.ts` › "criterion 60: a meeting chat without permission"; TODO | `omadia:middleware/test/executionScopes.pg.test.ts` (live needs readiness) | |
| 61 | Retention and open scopes | `closing.test.ts` › "61. retention of one day"; `governance.test.ts` › "retention: records are deleted 90 days after the close" | `omadia:middleware/test/conversationMessagesLifecycle.test.ts` | A+K |
| 62 | Spoken contributions | `transcript.test.ts` › "criterion 62, personal microphone"; "criterion 62, shared room microphone"; "a segment revision that a later one replaced" | | A |
| 63 | Session vs facilitation protocol | `acceptanceProtocols.test.ts` › "63. a first session closes while the facilitation continues"; `sessionConversations.test.ts` › "a meeting in the linked chat starts and ends its session" | | A |
| 64 | One ballot per person and round | `cards.test.ts` › "the newest answer of a person wins, whether typed or clicked"; `confirmations.test.ts` › "a confirmation from round one does not wipe the ballot of the runoff"; TODO | | |

## Not automatable, and where it is recorded instead

- **13, real Teams tenant:** the §6.2 contract runs against the simulated transport in the
  Teams channel's suite; the manual checklist on a real instance is
  `teams:docs/facilitator-live-verification.md`, its recorded passing run belongs in
  omadia-channel-teams#43. Nothing else in §9 needs a real platform.
