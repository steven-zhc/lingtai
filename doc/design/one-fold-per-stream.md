# One fold per stream, in `@lingtai/domain`: map and path

The plan for [0101](../decisions/0101-typescript-packages-effect-unbuilt.md) §4 *a stream's fold exists once, here*. Surveyed 2026-10-31; line numbers are from that day's `main`.

Read-only survey of `main` at `690dbbbb`, 2026-10-31. The context is ADR 0124
(`doc/decisions/0124-a-stream-fold-is-cached-as-a-snapshot.md`, uncommitted): *"the
fold exists once, in `@lingtai/domain`"* and *"where a projection folds one stream's
part of a row, it calls the same domain `apply`"*.

## 0. The count

Pattern: `case '<T>'`, `.type === '<T>'`, `type === '<T>'`, with `<T>` one of the 66
names in `doc/events.json`. Only `src/` files, `packages/domain/src` and
`apps/board/.next/` (a build copy that doubles every board count) excluded.

**138 branches in 34 files.** A second pass for `.type !== '<T>'` finds 13 more that the
first pattern misses. They are listed in §1.9 and are not part of the 138.

| Class | Branches | Where |
|---|---:|---|
| **F**: a stream fold that duplicates a domain reducer | **48** | run 26, ticket 14, control 4, chat 4 (chat has no domain reducer) |
| **P**: a projection fold | **46** | task-view 20, ticket-report 16, spend 6, backlog 4 |
| **R**: a reaction, trigger or renderer | **17** | tell 7, extension 5, work-loop 3, markdown 1, conduct 1 |
| **S**: a select or lookup | **27** | spread over 14 files |

None of the 48 F branches folds a **project** or **integration** stream.
`reduceProject` and `reduceIntegration` have no rival copy anywhere. The integration
events outside domain are all P (`task-view.ts:480`, `:496`; `ticket-report.ts:467-469`).

Five domain reducers exist (`control.ts:136`, `ticket.ts:465`, `run.ts:417`,
`project.ts:109`, `integration.ts:124`). Some per-event "fact" readers already
exist in `read-model.ts` as well: `cardFactOf`:306, `boardFactOf`:526,
`attemptFactOf`:422, `waitsOf`:85, `routesOf`:65, `triageFactsOf`:113. Callers outside
domain are `reduceTicket` (19 files), `reduceRun` (3: `resolve-wait.ts`,
`attempts.ts:264`, `approve.ts`), `applyTicket` (1: `task.ts:821`), `reduceControl`
(5), `reduceProject` (4) and `reduceIntegration` (1).

**One finding about domain itself.** Domain has two step-verdict ladders, and they
disagree. One is `run.ts:197` `stepStateOf`, which `reduceRun`/`stepsOn` use. The other
is `read-model.ts:158` `verdictOf`, which `cardFactOf`/`boardFactOf` use, and so do the
board and task_view. See decision D1. The board's folds call domain already; they call
the *second* ladder.

---

## 1. Per file

### 1.1 `apps/board/src/lib/task.ts`: 26 branches (F 21, S 5)

| Lines | What | Class | Reducer |
|---|---|---|---|
| 818-826 `standingOf` | calls `applyTicket` itself; `since` = `at` of last `LIFECYCLE_MOVES` (630) | F, already on domain | ticket |
| 853, 858, 860, 861×2, 864, 870 | `afterMove`: last `WaitResolved`, its `WaitStarted`, whether a later `WaitStarted` exists, the `TicketClosed`/`TicketReleased` after it, whether that is the latest lifecycle move | **F** (7) | ticket |
| 893×2, 897, 929 | `bodyOutcome`: last `IssueUpdated`/`IssueUpdateFailed{change:'body'}` after the last `WaitStarted` | **S** (4) | none, see D9 |
| 1119 (+1130 `!==`) `foldChat` | asks/answers on a `chat-` stream | **F** (1) | none, see D7 |
| 1250 `claimsOf` | claims (deduped through `claimShapeOf`) plus the release reason per run | **F** (1) | ticket |
| 1306, 1313, 1316, 1323, 1331, 1340, 1343, 1353, 1363, +1372 (`BoardFact` tag) `foldRun` | one run's state | **F** (10) | run |
| 1578 | `RunStarted.ticketId` → branch, used to label history groups | **S** (1) | run (`ticketId`) |
| 1621×2 `ticketFieldsOf` | title/kind/labels from `TicketDiscovered` **or `TicketClaimed`**, latest non-null wins | **F** (2) | ticket |

**`foldRun` against `reduceRun`**, field by field:

| Field | Domain has | Board does differently |
|---|---|---|
| `baseSha` | `RunStarted.baseSha` (run.ts:318) | same |
| `configHash` | from `RunStarted` (run.ts:319) | **from `StepsResolved`** (task.ts:1310-1314, on purpose, #190). Domain lacks it |
| `prompt` | `prompt` text + `prompts` count (run.ts:330) | `{version, bytes, text}` from `RunPrompted` (1316-1322). Domain lacks `bytes` and RunPrompted's own `promptVersion` |
| files | `touched` list, every touch (run.ts:335) | deduped by path, last op wins (1323-1330). This is a pure function over `touched`, so it needs no new state |
| `headSha`, `diff` | yes (run.ts:349-365) | same (1331-1342) |
| `turns`/`durationMs`/`exitCode` | `receipt` (run.ts:372) | same |
| running step | **ignored** (run.ts:386-387) | `StepStarted` puts `'running'` on key `${step}:` and the next `StepEnded` deletes it (1353-1366). Domain lacks it |
| verdicts | `steps` via `stepStateOf` | via `boardFactOf` → `verdictOf` + `STEP_ENDING_STATE` (1198-1205). The ladders differ, see D1 |
| signoff requested | lifecycle `awaiting-approval`, overwritten by any later lifecycle event (run.ts:396-406) | `awaitingSha` set and never cleared, step state `'pending'` (1395-1396) |
| failure | lifecycle `failed`, **last event wins** | `failure` sticky; `outcomeOf` (1455-1470) is worst-first: failure > finished > released > running > claimed. See D3 |
| `current` (stale verdict) | `stepsOn` (run.ts:183) compares `action.onSha` to `headSha` | **dead code.** 1411-1417 looks for an event whose top-level `data.step === g.step && data.onSha`. `g.step` is `step:action`, `StepStarted` carries `{runId, step, round}` (events.ts:999-1004) and `StepEnded` carries `onSha` only per action. Nothing matches, so `current` is always `true`, and no board test asserts `current: false` on a step. See D2 |
| `released` | not a run fact | `claim.released`, joined from the ticket stream. Stays a caller join |

### 1.2 `apps/board/src/lib/progress.ts` `foldProgress` (359): 8 branches, all F (run)

`RunStarted` 437 (wallMs from `invocation.limits`, phase `AGENT`), `RunFinished` 446,
`RunSpent` 450 (cost per granted round, keyed `grant:round`, 458), `StepsResolved` 467
(the plan), `MergeLaneWaited` 473, `StepStarted` 485 (running placeholder; `implement`
with `round>0` = *fixing round n*), `StepEnded` 524 and the fact tag at 536.
`RoundOpened` 590 counts `PassRouted` fix rounds.

Domain `RunState` has `invocation` (so wallMs) and nothing else on this list. It lacks
the current step with `since`/`round`, the resolved plan, the lane-wait instant, the
rounds opened, and grant spend. The *labels* (`AGENT`, `FIXING`, `WAITING_FOR_LANE`)
and the `now`/budget phase are presentation. See D10.

### 1.3 Other board files

- `queued.ts:217` `backoffOf` (210): **F** ticket. `lastAttemptAt` is the `at` of
  the last claim **or continuation** (`claimShapeOf !== null`). Domain lacks it.
  task_view has `last_attempt_at` for the same thing.
- `saved-fix-work.ts:13`: **S**, the last `RunRefsPublished`. Should be a field
  (`RunState.published`).
- `markdown.ts:85`: **R**, a renderer choosing a field format.
- `app/api/webhook/route.ts:67`: **S**, a delivery-id idempotency check on the queue
  stream. Leave it.
- `history.ts` names no event in a branch. It renders per event through `boardFactOf`
  (31). Not a fold, out of scope.

### 1.4 `packages/projector`: 46 branches, all P

**`task-view.ts` (20).** Per ticket stream: `TicketDiscovered` 231,
`TicketClaimed`/`Continued` 248-271, `TicketReleased` 278, `TicketSplit` 306,
`TicketClosed` 314, `TicketLanded` 333, `DispatchRefused` 350, and the card-fact cases
`WaitStarted` 568, `TriageStarted` 597, `WaitTriaged` 610, `WaitResolved` 621. Those
can come from `applyTicket` plus `triageFactsOf`.

Genuinely cross-stream:
- the `task_view_run` link;
- `RunStarted` → running (408);
- `RunAwaitingInput` note (419);
- head/diff (428);
- `RunProposedCompletion` → `verifying` (459-461);
- `RunFinished` turns (472);
- verdicts and `awaiting_sha` (`cardFactOf` default);
- `RoundOpened` → running plus note (557);
- `IntegrationRefused` 480 and `IntegrationSucceeded` 496, which is keyed by
  `d.ticketId` on the integration stream;
- `note`, one "latest sentence" column that seven different events overwrite.

Where task_view and `reduceTicket` disagree on lifecycle today (decision D5):

| Case | task_view | domain |
|---|---|---|
| `WaitResolved{GrantFixRound}` | `queued` (622 only special-cases `Approve`; everything else falls to 688) | `approved` (ticket.ts:373) |
| `WaitResolved{Close}` | `queued` until `TicketClosed` lands, and records an answer | stays `blocked`, no answer (ticket.ts:390-396) |
| claim after `TicketClosed` | `running` (249-271 has no guard) | ignored: `closed` absorbs (ticket.ts:249) |
| `IntegrationSucceeded` with no `TicketLanded` | `landed` (496) | not landed |
| answer | one `answer` jsonb, question = the **current `note`** (685). `RunAwaitingInput`/`RunEnded`/`IntegrationRefused` can overwrite that note while the wait stands | `answers[]`, question = `waitWords(reason).line` (ticket.ts:402-417) |

**`ticket-report.ts` (16).**

- Per ticket: claim/continue 358-375 (passes, `passTimes`, `claims`, and `kind` only
  from `TicketClaimed`, 369), `TicketLanded` 387, `TicketClosed` 396 (never
  overrides landed, 400), `TicketReleased` 407, waits 412-449.
- Cross-stream: review `StepEnded` via link 451, `Integration*` 467, `RunSpent` 478,
  and the interval/`signOfLife` machinery.
- **It reopens a closed ticket on a later claim (372-375).** Domain says `closed`
  absorbs. See D6.

**`spend.ts` (6).** Link tables (`RunStarted` 143, `DiscussionRequested` 180),
`spend_kind` from the claim's kind (158-178) and `RunSpent` 190. The only per-stream
part is "the ticket's latest non-null kind", which is `TicketState.kind` once D4 lands.

**`backlog.ts` (4).** `RunStarted` link 131. `FindingAccepted`/`Proposed`/`Declined`
141-162 fold one `backlog-` stream's status, and no domain reducer exists for it.
Raised findings already come from domain `findingsRaisedOf`.

### 1.5 `packages/conductor/src`

- **`attempts.ts` (9).**
  - `priorAttempts` 161: **F** ticket, `TicketClaimed`/`Continued` 187-188 and
    `TicketReleased` 209. Each attempt's `ended` is the release reason, or *"blocked,
    asking: …"* from a `WaitStarted` naming the run (171-183). The later event wins.
    This is a second copy of board `claimsOf` with different `ended` rules (see §3,
    risk on C6/C7).
  - `attemptOutcome` 328: **F** run, `RunProducedDiff` 338, `RunKeptUncommitted` 344,
    `RunFinished` 350, `RunFailed` 356, `StepStarted` 374, `StepEnded` 381. Its own
    header (320-326) says it avoids `reduceRun` because the fold keeps neither the
    *last refusal* nor a step that started and never ended. Those are the fields to
    add.
- **`day-ceiling.ts` (4).** **F** control.
  - `liftOwnPause` 173-175: is the current pause the ceiling's? That is
    `reduceControl(...).by === 'lingtai' && reason.startsWith(CEILING_REASON)`. It
    already returns early unless `paused` (166-167).
  - `resumedPast` 141-148: did a person resume the last *ceiling* pause, ignoring
    non-ceiling pauses in between? `ControlState` cannot answer that, because
    `ConductorResumed` clears `by`/`reason`/`until` (control.ts:185-196). See D8.
- **`discuss.ts` (2).** `turnsOf` 750 and `outstanding` 775: **F** chat.
- **`conduct.ts` (2).** 662 is **S**: the highest `implement` round from `StepStarted`
  plus `routesOf` fix rounds. It should be `RunState.round`. 3506 is **R**: it tallies
  spend while emitting.
- **`resolve-wait.ts` (2).** 407 **S**, last `RunRefsPublished`. 418 **S**, a
  `RunKeptUncommitted` matching `armSha`/`arm`. Both become `RunState` fields.
- **`split-ticket.ts:174`.** **S**, the *first* `SplitStarted` for the wait. Domain
  `splitProgressOf` keeps the *last* (split-progress.ts:47-49), so do not merge them
  without a decision. Leave it.
- **`end-step.ts:99`.** **S**, an idempotency guard on `EndActionsResolved`. Leave it.
- **`create-app.ts:842`.** **S**, latest `GitHubAppCreated` on a one-event-type stream.
  Leave it.
- **`tell.ts` (7, 457-469).** **R**: edits ended-wait comments. It reads waits plus
  `IssueUpdated` comment ids. The wait half could use `waitsOf`. The `IssueUpdated`
  half is D9.

### 1.6 `apps/cli/src`

- **`discuss.ts` (3).**
  - `headOf` 153-162: **F** run, identical to `RunState.headSha`. Both take the last of
    `RunProducedDiff`/`RunProposedCompletion` (run.ts:355, :364).
  - 462: **F** chat, counting answers.
- **`status.ts` (2).** 202 **S**, the last `RunRefsPublished`. `lastStep` 232-240
  **S**, the last `StepStarted` unless a `StepEnded` follows it. That is the same
  "current step" `foldRun`/`foldProgress`/`attemptOutcome` each rebuild.
- **`triage.ts` (6).**
  - 172 **S**, a `TriageStarted` envelope at an attempt, beside `triageFactsOf`.
  - 461-462 **S**, the last `PassRouted` and the last `RunRefsPublished`.
  - 604 and 610 **S**, wait known and prior attempt numbers. These should be
    `triageFactsOf`/`waitsOf`.
  - 674 **S**, race detection over a slice. Leave it.
- **`day-ceiling.ts:30`.** **S**, a whole-log scan for today's `RunSpent`. It checks
  projection lag. Leave it.

### 1.7 `packages/daemon/src`

- **`work-loop.ts` (3: 403, 587, 590).** **R**.
- **`converge.ts` (2: 356, 369).** **S**: the last outcome per `IssueUpdated.change`
  and the labels last written, plus `EndActionsResolved` refs. See D9.
- **`control.ts:293` `startAfter`.** **S**, the first `ConductorStarted` after a
  version. It is a watermark query. Leave it.

### 1.8 `packages/extension/src/index.ts` (5, 110-126)

**R**, the notification text for each event.

### 1.9 The 13 `!==` branches outside the 138

| Location | Class | Action |
|---|---|---|
| task.ts:1130 | F chat | |
| task.ts:1178 | S | `DiscussionHeld` → `chatIdsFor` |
| cli/status.ts:237 | S | |
| cli/subscribers.ts:95 | S | becomes `RunState.ticketId` |
| cli/discuss.ts:492 | R | |
| cli/triage.ts:238 | R | |
| cli/triage.ts:784 | S | idempotency check |
| converge.ts:362 ×2 | S | |
| conductor/discuss.ts:758 | F chat | |
| tell.ts:575 | R | |
| conductor/backlog.ts:344 | S | last event on the finding stream; also :177, :184 |
| base-check.ts:95 | S | latest `BaseChecked`; leave it |

---

## 2. What each domain reducer needs first

These are additions only. No existing field changes meaning except where a decision
(§4) says so. Under 0124 §3 each one raises the fold's version.

**`RunState` (run.ts)**

1. `step: { step, round, since: Date } | null`. `StepStarted` sets it. A `StepEnded`
   for that step clears it, and so does any `StepEnded` if `lingtai status`'s rule
   (status.ts:236) is kept.
   Used by `foldRun` 1353, `foldProgress` 485, `attemptOutcome` 374 and `lastStep` 232.
2. `round: number`, the highest `StepStarted{implement}.round` and fix round seen.
   Used by `conduct.ts:655-664` and `foldProgress` 590.
3. `resolved: { configHash, steps: {step, actions}[] } | null` from `StepsResolved`.
   Used by `foldRun` 1314 and `foldProgress` 467.
4. `promptMeta: { version, bytes } | null` from `RunPrompted`. Used by `foldRun` 1316.
5. `published: PayloadOf<'RunRefsPublished'> | null`, the last one. Used by
   `saved-fix-work.ts:13`, `status.ts:202`, `triage.ts:462` and `resolve-wait.ts:407`.
6. `kept: PayloadOf<'RunKeptUncommitted'>[]`. Used by `resolve-wait.ts:418` and
   `attempts.ts:344`.
7. `route: PayloadOf<'PassRouted'> | null`, the last one. Used by `triage.ts:461`.
8. `refusal: { key, evidence, findings } | null`, the last refused verdict. Used by
   `attemptOutcome`. Today that is `attemptFactOf` at attempts.ts:385-393.
9. `failure: { kind, detail } | null`. It is sticky and independent of `lifecycle`
   (D3). Used by `foldRun`'s `outcomeOf` and `attemptOutcome` 356.
10. `laneWaitedAt: Date | null` from `MergeLaneWaited`. Used by `foldProgress` 473.
11. Optional, see D10: `grants: Record<"waitId:round", {round, waitId, costUsd|null}>`
    from `RunSpent{for: Action, grant}`. Used by `foldProgress` 450-466.
12. Helpers rather than state: `filesOf(state)` (dedupe `touched` by path, last op wins)
    and one verdict ladder (D1).

**`TicketState` (ticket.ts)**

1. `title`/`kind` from `TicketClaimed`, latest non-null wins (D4). Today
   `applyTicket` takes them only from `TicketDiscovered` (254-266). No `src/` file
   appends `TicketDiscovered` any more (task-view.ts:226-230 says so; a search for
   `type: 'TicketDiscovered'` finds no appender). So `reduceTicket(...).title` and
   `.kind` are null on every current ticket.
2. `claims: { runId, at, released: string|null, blockedBy: WaitId|null }[]`, a fresh
   claim per `claimShapeOf === 'claim'`. Used by `claimsOf` 1229 and `priorAttempts`
   161.
3. `lastAttemptAt: Date | null`, a claim **or** continuation. Used by `backoffOf` 210
   and task_view `last_attempt_at`.
4. `since: Date`, the `at` of the last lifecycle event. Used by `standingOf` 819-824
   (D11).
5. `lastMove: { waitId, resolution, by, note, current: boolean, then: 'closed'|'released'|null, releaseCause }`.
   Used by `standingOf` 853-890.

**`ControlState` (control.ts)**

1. The 0124 §2 split: a fold with no `now`, plus `evaluate(state, now)` for the
   `until` lapse (control.ts:231-237). Today `reduceControl` builds state in a loop and
   has no `apply` (136-240), so it becomes `applyControl` first.
2. A ceiling waiver (D8): either `ceiling: { until, waivedBy } | null`, or a typed
   cause on `ConductorPaused`.

**New: `ChatState` (`chat-` stream, D7)**

`{ attempt, turns: {question, by, at, reading, answer|null}[], costUsd, answered: number }`.
It replaces `foldChat` task.ts:1112, `turnsOf` conductor/discuss.ts:750, `outstanding`
775 and the cli/discuss.ts:462 count.

**`ProjectState`, `IntegrationState`: nothing.** No caller duplicates them.

---

## 3. Tickets, in order

One file or one fold per ticket. T0 comes first. Each D-ticket is pure domain plus
tests and changes no caller. Each C-ticket switches one caller and adds no domain
field.

| # | Ticket | Depends | Risk (concrete) |
|---|---|---|---|
| **T0a** | Fixture histories in `packages/domain/test/histories.ts`. They cover every event type each of run/ticket/control/chat handles, built with the existing `makeStream`/`aRun`/`aClaim`/… (`packages/domain/test/events.ts`). This is also what 0124 §3 asks for | none | none. Edge: `makeStream` seq is module-global (`task-view-rebuild.test.ts:18-20`), so histories are built once, at module scope |
| **T0b** | Characterization pins, unit project, snapshot generated from **today's** code and never regenerated: `foldRun`, `foldProgress`, `standingOf`, `claimsOf`, `ticketFieldsOf`, `foldChat`, `backoffOf`, `priorAttempts`, `attemptOutcome`, `turnsOf`, `outstanding`, `headOf`, `lastStep`, `resumedPast`/`liftOwnPause` (export or test via the public fn) | T0a | none. It only adds tests |
| **T0c** | Rebuild pins for `ticket_report`, `spend` and `finding_backlog` on `createSqliteProjectionStore(openSqliteProjections(':memory:'))`, the same harness as `packages/projector/unit/task-view-rebuild.test.ts`. task_view is already pinned there | T0a | none |
| D1 | `RunState.step`, `round` | T0 | none (additive) |
| D2 | `RunState.published`, `kept`, `route` | T0 | none |
| D3 | `RunState.resolved`, `promptMeta`, `failure`, `laneWaitedAt`, `refusal`; `filesOf` | T0 | none |
| D4 | `TicketState.claims`, `lastAttemptAt`, `since` | T0 | none |
| D5 | `TicketState.lastMove` | D4 | none |
| D6 | `TicketState.title`/`kind` from `TicketClaimed` | **decision D4** | **behaviour change for every `reduceTicket` reader of `.title`/`.kind`**: `prompt.ts:113` → `{{title}}` at :230 if it reads the fold, and `schedule.ts`. Check every reader in the ticket |
| D7 | `applyControl` + `evaluateControl(state, now)` (0124 §2) | T0 | `reduceControl(events, now)` keeps its signature. Callers unchanged |
| D8 | Control ceiling waiver | **decision D8** | |
| D9 | `reduceChat` | **decision D7** | |
| C1 | cli/discuss.ts `headOf` → `reduceRun().headSha` | T0b | lowest. Same two events, same last-wins |
| C2 | `RunState.published` readers: saved-fix-work.ts:13, status.ts:202, triage.ts:461-462, resolve-wait.ts:407-418 | D2 | low. Every one takes "last". `resolve-wait`'s `kept` match is by `sha` **and** `arm` (418-421), so `kept` must be a list, not last-only |
| C3 | `RunState.step` readers: status.ts:232 `lastStep`, conduct.ts:655-664 | D1 | low. `lastStep` returns null after **any** later `StepEnded` (236), not that step's. Keep the rule or pin the difference |
| C4 | attempts.ts `attemptOutcome` → `reduceRun` | D1, D2, D3 | medium. `evidence` precedence today: last refusal, then `RunFailed`, then the unfinished step (395-400). The new code must keep that order, not the lifecycle's |
| C5 | attempts.ts `priorAttempts` → `TicketState.claims` | D4 | medium. `ended` = whichever of release reason / *blocked, asking* comes **later** (171-183 runs before the switch on the same event) |
| C6 | board `claimsOf` + `backoffOf` → `TicketState.claims`/`lastAttemptAt` | D4 | medium. `claimsOf` defaults `released` to `'released'` on an empty reason (1251) and ignores waits, which disagrees with C5's `ended`. `backoffOf` counts continuations and `claimsOf` does not. Keep two fields; do not unify |
| C7 | board `ticketFieldsOf` → `TicketState.title/kind/labels` | D6 | low after D6. Board reads `labels` off `TicketClaimed` (1626), which has no `labels` (events.ts:188-193), so it is dead |
| C8 | board `standingOf` `afterMove`/`since` → `TicketState.lastMove`/`since` | D5 | medium. `since`: board counts a `TicketContinued` naming an unclaimed run as a move (task.ts:628-629). Domain ignores it (ticket.ts:273) |
| C9 | board `foldRun` → `reduceRun` plus a board mapping | D1-D3, **decisions D1, D2, D3** | **high**: the biggest visible change. See D1-D3 for the cells that move |
| C10 | board `foldProgress` → `reduceRun` + `progressOf(state, plan, over)` | C9, **decision D10** | high. `now` ordering rules (StepEnded clears only if the label matches, 524-533; RunFinished clears only AGENT or LANE) must survive as a pure function of state |
| C11 | `foldChat`, `turnsOf`, `outstanding`, cli/discuss.ts:462 → `reduceChat` | D9 | low. `outstanding` counts answers (775); `foldChat`/`turnsOf` drop an answer with no open turn (1131-1132, 759). An orphan answer makes `outstanding` say *answered* while the fold shows the ask open. Pin it |
| C12 | day-ceiling.ts → `ControlState` | D7, D8 | medium. The pause with `until` lapse is now evaluated after the fold |
| P1 | spend.ts `spend_kind` → `TicketState.kind` (claim-kind, latest non-null) | D6 | low. The SQL is already "latest non-null by seq" (167-174) |
| P2 | ticket_report: outcome/passes/claims/waits from `applyTicket` state kept in the row's JSON state | D4, **decision D6** | medium. Reopen-after-close (372-375) |
| P3 | task_view: keep `TicketState` jsonb on the row, derive `state`/`answer`/`restarts`/`split`/`wait_*` from it. Run/integration columns stay cross-stream | D4-D6, **decision D5** | **high**: five lifecycle cells change (§1.4 table). Needs `lingtai projection rebuild task_view` on deploy |
| P4 (optional) | backlog finding status → a domain finding fold | decision D7 | low |

R (17) and the S branches marked "leave" are left alone. That covers tell, extension,
work-loop, markdown, webhook, create-app, end-step, base-check, daemon/control
`startAfter`, cli/day-ceiling and triage:674/784.

---

## 4. How each ticket proves nothing moved

1. **Pins first (T0b/T0c), from today's code.** They follow `task-view-rebuild.test.ts`'s
   header convention: *"generated from today's code, and never regenerated after the
   src change… inspect the changed values rather than regenerating"*. A C/P ticket is
   green only if the pin is byte-identical. The exception is a ticket that implements a
   decision (D1-D6). There the ticket body lists the exact cells that change, and the
   snapshot diff is reviewed as *exactly those lines*.
2. **Dual run inside the switching ticket.** Copy the old fold verbatim into the test
   file as `legacyFoldRun` etc. Fold every fixture history through old and new, map
   both to the **view the page draws** (`RunView`, `StandingView`, `DiscussionView`,
   a task_view row) and `toStrictEqual`. Also prefix-fold every history (each `k`
   in `1..n`), because the page renders mid-run. That exercises the "running" and
   "pending" cells a whole-history pin never sees. The legacy copy is deleted in the
   follow-up, never in the same diff that first proves equality.
3. **Domain D-tickets** are proved by the 0124 §3 hash table and by `reduce(h) ===
   prefix-apply(h)`, plus `decode(encode(s))` once 0124's codec exists.
4. **Projections:** the rebuild pin must give the same rows. For P3, incremental apply
   in batches of 1, 3 and all must give the same rows as a rebuild. That is 0022's
   "replay, never repair", and it catches a jsonb state column that a batch boundary
   loses (cf. spend.ts:153-157's warning about the `claimed` set).
5. `pnpm test` and `pnpm typecheck` only. No `Done when` asks for `pnpm test:integration`
   (CLAUDE.md).

Watch out: a recorded fixture exported from the live log is tempting but carries
prompt and issue text. 0124 also notes the log can be reset. Synthetic histories built
from the `test/events.ts` builders are the durable pin. A recorded one, if added at
all, is scrubbed and cited by issue number, not seq.

---

## 5. Decisions (the operator, 2026-10-31)

- **D1. One step-verdict ladder, cell by cell the cautious one:** `commit` `Completed`
  with `head === null` is `did-not-finish`; `worktree` `NotDone` is `did-not-finish`;
  `signoff` `Completed` with `requested` is `asked` (one of 0120's six). The first two
  change what a gate decides in those two cases, on purpose. `read-model.ts`'s ladder
  and `run.ts`'s become one, in domain.
- **D2. Stale verdicts are shown.** `current` comes from `stepsOn`; a verdict made on an
  older head reads as stale on the task page.
- **D3. A failure stays a failure; a requested signoff is cleared** by a later lifecycle
  event. `RunFailed` is not undone by a later `RunFinished`; `awaitingSha` is.
- **D4. Title and kind come from `TicketClaimed`** in `applyTicket`, latest non-null wins.
- **D5. task_view takes domain's ticket state** in all four cases (fix round granted is
  `approved`; Close is `waiting` until `TicketClosed`; `IntegrationSucceeded` alone is not
  landed; an answer comes from the resolution's reason, not `note`). A rebuild on deploy.
- **D6. A claim after a close reopens the ticket**, in domain, task_view and
  ticket_report alike.
- **D7. Domain gains `reduceChat` and a backlog-finding fold.**
- **D8. `ConductorPaused` gains an optional typed `cause`**; the day ceiling's pause is
  recognised by it, not by a reason prefix.
- **D9. The GitHub-write ledger is a `TicketState` field.**
- **D10. Facts of progress are `RunState`** (current step, round, since, lane wait, plan,
  rounds opened); phase labels and budgets stay on the board; spend is read from the
  `spend` projection only.
- **D11. A continuation counts as a lifecycle move for `since`**, as the board counts it
  today (default; not discussed).
- **Sequencing.** The D-tickets land first; 0124's registry and its version table land
  after them, so the fold's version starts at 1 with the final shape.
