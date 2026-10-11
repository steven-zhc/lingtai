# The waiting lane — one row per `Hold`, one row per `Judgement`

This is the table 0118's *Not decided here* sends to `doc/design/`
([0118 §1](../decisions/0118-a-hold-explains-itself.md), *"the per-kind table
... is design, not decision, and belongs in `doc/design/`"*). It does not
change 0118. Where this table disagrees with 0118's own sketch of a variant,
the disagreement is written down as an open question at the end, not settled
here.

`Hold`, `Judgement`, `allowedMoves` and `recommendedMove` do not exist yet —
`allowedMoves` is #441's and #439's to write. This table describes **what the
code does today**, read off `main` at `2cf21587` (which includes #404's
groundwork through `15040829`, *"task_view moves to waiting only through
`WorkItemBlocked`"*), and maps each route onto the variant 0118 says it should
become. A cell that says what a route records today and a cell that says what
0118 suggests are two different claims; where they differ, that is an open
question, not a decision made in a table.

**Waiting with no block is no longer a row.** Before #405 and #406,
`DispatchRefused`, `RunAwaitingInput`, a bare `RunFailed`, `ApprovalRequested`
and `IntegrationRefused` could each leave an item in the `waiting` state with
`blocked: false`. On this tree, `WorkItemBlocked` is the only fold in
`packages/projector/src/task-view.ts` that sets `state: 'waiting'`
(`:321-349`); every other one of those five either writes `state: 'queued'`
conditionally on no standing block (`DispatchRefused`, `:450-501`) or touches
no `state` column at all (`RunAwaitingInput` `:516-523`, `RunFailed` `:599-608`,
`ApprovalRequested` `:675-710`, `IntegrationRefused` `:714-728`). A card in the
Waiting lane is `Held`, and `Held` carries a `Hold` — confirmed on this tree,
not merely asserted by 0118.

## The three appenders

- `packages/conductor/src/conduct.ts:3547-3565` is the pass. Its question and
  `needs` come from `whatIsWaitingOnYou` (`:3195-3309`), called from `blocked()`
  (`:3184-3193`), which appends the `unpushed` sentence where there is one, as
  a trailing parenthetical (`:3139`, `:3184-3193`).
- `packages/conductor/src/ask.ts:68-81` is `lingtai ask`, before any run:
  `runId: null`, `needs: 'judgement'` hard-coded.
- `packages/conductor/src/approve.ts:390-406` is a merge refused after an
  approval was already granted and spent: `needs: 'acknowledgement'`
  hard-coded.

## Hold

| Hold | produced by | page shows | moves offered today | default recommendation | triage runs (0118 §3) | `unpushed` |
|---|---|---|---|---|---|---|
| `Question` | `ask.ts:68-81`, `runId: null` | the question only; no rail line, no run to read a diagnosis off | Answer (`answer()`, `ask.ts:109-168`, appends `WorkItemUnblocked` with the answer as its note) or Withdraw (`requeue` with no answer); Close | none (`BlockRecommendation` only exists on a run's diagnosis) | **No** — "the person wrote the question" (0118 §3) | cannot apply — no run exists (0118 `:94-97`) |
| `Judgement.Asked` | `conduct.ts:3264-3267`, `stopped.ending.ending === 'asked'` | the step's own question, no recommendation (`:3259-3263`: *"no recommendation goes with it... a recommendation the board cannot carry out would be a sentence"*) | Requeue (`requeueHolding` appends `WorkItemUnblocked`, cutting a new pass from the base — not the asking step run again, per 0118 §7 — and any answer typed into the requeue's note is dropped before the next attempt sees it: `answersBrief` keeps only `runId === null` answers (`attempts.ts:558-561`, `:572`), `priorAttempts` records the attempt as `blocked, asking: <question>` with nothing of the reply (`attempts.ts:153-160`), and `answer()` itself refuses outright on a run-held block (`ask.ts:136-141`) — writing the answer into the issue body is the only channel that reaches the next attempt, per 0118 §6); Close; Approve only if `onOrigin !== null` and the step is `judged` — but `asked` is excluded from `judged` (`conduct.ts:3501`, `held` is the only exclusion named — see open question 5) | none | **Yes** — a judgement | today a trailing parenthetical on `diagnosis.what` (`conduct.ts:3139` builds `(and <branch> was not pushed: …)`; `:3192` appends it to the end of the sentence `whatIsWaitingOnYou` already composed) — not shown first; 0118 (`:94-97`) decides the new page shows it first, above everything else, with what it takes to rescue it, which this tree is not yet built into |
| `Judgement.Gate` (at `proposed`) | a declared `human:` action — `humanPlugin.at` carries only `proposed` (`packages/recipe/src/recipe.ts:730-746`) — or a declared `watch:` reaching the same ending from the same step: `watchPlugin.at` is `{proposed: notBuiltYet}` (`recipe.ts:726`), `watch-action.ts:83` answers `verdict: spec.then === 'fail' ? 'failed' : 'needs-approval'` with `then` defaulting to `request-approval` (`recipe.ts:713`), and the default case reaches `heldAt` (`action.ts:795-802`) — both ending `held` (`endingOf`, `pass.ts:1754-1756`), and `proposed` is excluded from `ARRIVE_AT_THE_ROUTER` so `stoppedAt = {step: 'proposed', ending}` directly (`pass.ts:1000-1008`, `:1415-1421`) | the declared question | Approve, Requeue, Close | **none** — the approve-recommendation test is `stopped === null \|\| (stopped.step === 'merge' && ending === 'held')` (`conduct.ts:3299-3307`), which a hold at `proposed` never satisfies; this disagrees with 0118 §1's *"approve at a gate"* (`:126`), which answers one default for the whole `Gate` variant rather than one per step — see open question 9 | **Yes** | as above |
| `Judgement.Gate` (at `merge`) | `alsoHeldAtMerge()` injects a `human:` action at `merge` for `--no-merge` (`options.merge === false`) or a repair (`repairOf !== null`; `retiredRepairPending` answers non-null only off a log still carrying an unclaimed pre-#143 `RepairRequested`, so whether this half still has a live producer is open rather than settled — see open question 3) (`conduct.ts:2330-2349`); ending `held`, `merge` **is** in `ARRIVE_AT_THE_ROUTER` but `goesToTheRouter` admits only `refused`/`asked` so a `held` ending at `merge` falls to the same direct `stoppedAt = {step, ending}` as any non-arriving ending (`pass.ts:1415-1421`) | *"Merge `branch` into `base`? Every step passed, and this run was asked not to merge."* | Approve, Requeue, Close | **approve** — *every step passed on this diff; approving merges what this run produced* (`conduct.ts:3299-3307`), vetoed by any live finding | **Yes** | as above |
| `Judgement.Routed{findings}` | three arrivals, all judged at `proposed`'s way-through visit and all landing here because `judged()` sends `waiting` through `toAPerson` with `reported: null` (`pass.ts:1401-1407`), so `stoppedAt` stays `null`: (1) `review` passes carrying findings (`pass-steps.ts:1240-1247`); (2) a `review` refusal that carries no finding with a failure scenario, `!carriesACriterion(arrival)` (`pass-steps.ts:895-901`); (3) a `review` answer that did not parse at all, `arrival.unreadable` (`pass-steps.ts:885-894`) — asked ahead of (2) because an unparseable answer is read as `findings: []` and is not a criterion either | *"`branch` into `base` is waiting on you. `<why>`"* | Approve, Requeue, Close | arrival (1): `findings.length === 0` is false by construction (findings are why it arrived) — so in practice **none**, unless a later round cleared them before another hold. Arrivals (2) and (3): `findings` on `PassResult` is empty (nothing was judged), so `conduct.ts:3299-3302`'s test (`findings.length === 0 && stopped === null`) is true and the default is **approve** — measured at 10% of `review`'s refusals in fourteen days, 24 of them (`pass-steps.ts:675`). This row is the only one that reaches the `stopped === null` half of `conduct.ts:3300-3302`'s recommendation test — the review-rounds-ran-out row below sets `stoppedAt` to the refusing step, per its own produced-by cell, so it is never in that branch. See open question 10 | **Yes** | as above |
| `Failure.MergeRefused` | two sources: `conduct.ts:3203-3214` (`stopped.step === 'merge' && ending.ending === 'refused'`) and `approve.ts:378-406` (a granted approval whose merge still failed) | `<reason>: <why>`, plus `diagnoseRefusal`'s reading (`attribution.ts`) | On the `conduct.ts:3203-3214` producer: Approve ("merge anyway"), Requeue, Close, with Approve offered only where `onOrigin !== null` and `judged` (`conduct.ts:3501-3502` — `judged = stopped === null \|\| ending === 'refused'`, true here). The `approve.ts:378-406` producer draws no Approve at all: its approval was already spent — `ApprovalGranted` cleared `task_view.awaiting_sha` (`task-view.ts:702`), the `WorkItemBlocked` fold here does not set it again (`:321-349`), so `standing.tsx:402` draws no Approve control, and `approveHolding` itself refuses `not-awaiting-approval` for a run back at `gating` (`approve.ts:192-201`) — `approve.ts`'s own comment names this #84's *a card offers the move that is left, never a control that refuses*. That producer offers only Requeue and Close | none from `whatIsWaitingOnYou`; `diagnoseRefusal` may add its own per-reason advice (not drawn through `recommendedMove`'s `BlockRecommendation` today) | **Yes — but not one run per hold.** 0118 §8 (`:279-285`) gives a conflict its own triage shape: it resolves the mechanical hunks and asks one question per hunk whose behaviour differs on the two sides, each question carried by that hunk; the hunks are counted from the mirror before any agent is called, and past 20 none is dispatched — the triage is *merge by hand* with the hunk count and total, answered `Mechanical` (§3) at no cost. A non-conflict `MergeRefused` (the lane's other six reasons) has no hunks and triages as an ordinary judgement | `approve.ts`'s path is bound to an `onSha` already on origin, so `unpushed` does not arise there (confirmed against `approve.ts:340-354`); the `conduct.ts` path can carry it |
| `Failure`, ceiling | `conduct.ts:2764-2766` sets `ceilingHit` from `outcome.failure.kind` (`'out-of-turns'` \| `'out-of-usd'`); `:3217-3238` turns it into the block, `needs: 'acknowledgement'` | *"`<kind>`: `<detail>`... the limit is a scope alarm"* | Requeue (recommended); Close — **never Approve, at any `onOrigin`.** A ceiling hit reaches `work-action.ts:172` as `verdict: 'did-not-finish'`, and `pass.ts:1699` is explicit that every one of the ten steps ends `did-not-finish`, *"never `refused` or `asked`"* — so `ending.ending` here is `'did-not-finish'`, `judged` (`conduct.ts:3501`) is false, and `conduct.ts:3502`'s guard cannot fire. This is the shape `conduct.ts:3483-3495` names — *an agent stopped at `runtime.limits.turns` having committed twice* — as the one that *must not offer the control* | **requeue** — 0118's *"requeue at a ceiling"* (`:126`) | **Yes** | as above |
| `Failure`, step that did not finish | at `implement`: a crash (`conduct.ts:2767`, `threw`-style), a no-commits stop (`:2792`, *"the agent produced no commits"*), or a hook failure (`:2592-2599`, `:2722`), all three reaching `work-action.ts`'s fallthrough, `verdict: 'did-not-finish'` (`packages/actions/src/work-action.ts:170`); at `admit`: the `worktree:` action failing to cut the tree, which the step's own body answers `did-not-finish` directly rather than through `work-action.ts` — `admit` is not one of `REFUSING_STEPS` (`pass.ts:108`), so a failed clone "could not become a refusal either" (`pass-steps.ts:1043-1049`), and `conduct.ts:3483-3495`'s own comment names it beside `implement`'s shape: *"`admit`'s is a clone that did not finish"* | *"the `<step>` step did-not-finish: `<why>`"* | Requeue; Close — **never Approve, at any `onOrigin`.** As with the ceiling row above, `ending.ending === 'did-not-finish'` here too, so `judged` (`conduct.ts:3501`) is false and `conduct.ts:3502`'s guard cannot fire regardless of `onOrigin` | none | **Yes** | as above |
| `Failure`, setup refused before any agent ran | a refusal at `prepared` only — `admit` cannot land here: it is not one of `REFUSING_STEPS` (`pass.ts:108`), `pass-steps.ts:1043-1049` says so in words, and `pass.ts:1968-1973` throws on a `refused` ending from a step `spec.refuses` excludes, so a failed clone at `admit` is the *step that did not finish* row above instead. `prepared`'s install refusing is this row's one producer: `directionOf` names it `red` regardless (`pass-steps.ts:613-623`, *"`arriving.step !== 'merge'` → `'red'`"*), same mechanical path as a red `build`; `implement` is not on `offer.affordable` (no agent has run), so `MECHANICALLY['same-worktree'].orElse === 'waiting'` fires (`pass-steps.ts:658-660`, `:954-956`) | the step's own refusal, `needs: 'acknowledgement'` | Requeue; Close | none | **Yes** | as above |
| `Failure`, check that stayed red (rounds ran out) | see *the two routes traced by hand* below — a `red` refusal with rounds spent, arising at a non-`merge` step such as `build`; `stoppedAt` is set to the refusing step with `ending.ending === 'refused'` (`pass.ts:1446`, `conduct.ts:3264-3267`). A `verify-failed` refusal can only arise at `merge` (`directionOf`, `pass-steps.ts:620-622`), so the same rounds-spent route lands in `Failure.MergeRefused` above instead — `stopped.step === 'merge' && ending.ending === 'refused'` is that row's own produced-by condition (`conduct.ts:3203-3214`), and it is checked ahead of this row's branch-3 test | *"the `<step>` step refused: `<why>`"*, with the rounds-spent sentence appended (`conduct.ts:3274`) | Requeue; Close; **Approve, where `onOrigin !== null`.** Unlike the ceiling and step-did-not-finish rows above, `ending.ending === 'refused'` here, so `judged` (`conduct.ts:3501`) is **true** and `conduct.ts:3502`'s guard can fire — this is the one `Failure` variant outside `MergeRefused` that offers "merge it anyway" rather than withholding it. `judge.ts:456-460`'s count of 34 `red` refusals belongs to this row; its 26 `verify-failed` refusals belong to `MergeRefused` instead | none from `whatIsWaitingOnYou` | **Yes** | as above |

## Judgement

| `Judgement` variant | today's `needs`/`stoppedAt` shape | which `JudgeWhen` values can reach it |
|---|---|---|
| `Asked` | `stopped.ending.ending === 'asked'`, `needs: 'judgement'` (`conduct.ts:3264-3267`) | the arrival that stopped to ask, at `admit`, `design` or `implement` (the three that can ask — `pass.ts:908-912`) |
| `Gate` | `stopped.ending.ending === 'held'` | not a `JudgeWhen` at all — a `held` ending never reaches `directionOf`/`judged`; it stops the walk directly (`pass.ts:1415-1421`), before any judge is asked |
| `Routed` | `stopped === null` | **`findings` only, as traced on this tree.** The other four `JudgeWhen` values (`red`, `verify-failed`, `conflict`, `needs-input`) all arrive through the `ARRIVE_AT_THE_ROUTER` branch, which calls `take(router.ending, {step: at, ending}, arrival)` with a non-null `reported` (`pass.ts:1446`), so `stoppedAt` is set and `stopped !== null`. Only the way-through visit at `proposed` — which judges `findings` and nothing else (`pass-steps.ts:1240-1247`) — calls `take(ending, null, offer)` (`pass.ts:1406`). **This corrects 0118's list** (`:80-84`, which offers `Routed{when: JudgeWhen}` over all five): as the code stands, `Routed` can only ever carry `findings`. Whether the other four should be moved into `Routed` by changing what `stoppedAt` carries, or whether `Routed` should simply be typed to carry `'findings'` alone, is open — see question 1. |

## The two routes traced by hand

**A review whose rounds ran out.** This is one `WorkItemBlocked`, not a
variant of its own — which `Judgement`/`Failure` row it lands in depends on
*which step the pass last visited*, not on whether a review ever ran:

- **Last arrival was `findings`** (`review` passed carrying findings, and
  `proposed`'s way-through judged them). `BUILT_IN_FOR.findings` is `null`
  (`judge.ts:466-472`), so a declared `judge:` answers it or, with none
  declared, `judged()` sends it straight to a person (`pass-steps.ts:947-952`).
  `reported` is `null` (`pass.ts:1406`), so `stoppedAt` is `null`: recorded as
  `judgement`, matching `Judgement.Routed{findings}` above.
- **Last arrival was `red`** (a `build` refusal, with rounds already spent).
  `BUILT_IN_FOR` answers `same-worktree` mechanically (`judge.ts:466-468`);
  with `implement` not affordable, `MECHANICALLY['same-worktree'].orElse` is
  `'waiting'` (`pass-steps.ts:658-660`, `:954-956`), and the route carries
  `chose: 'implement'` beside `to: 'waiting'` (`:957-970`) — *the destination
  the mechanical rule wanted and did not get, because the rounds are spent*.
  This call goes through the `ARRIVE_AT_THE_ROUTER` branch with a non-null
  `reported` (`pass.ts:1446`), so `stoppedAt = reported` is `build`, with
  `ending.ending === 'refused'`. `conduct.ts`'s `stopped.step === 'merge'`
  test for `MergeRefused` (`:3203-3214`) is false here, so the branch-3 test
  (`:3264-3267`) is what applies, and that is false too (`refused` is
  neither `held` nor `asked`), so `needs: 'acknowledgement'` — a **`Failure`**,
  specifically the *check that stayed red* row, even though a mechanical
  judgement routed it.
- **Last arrival was `verify-failed`** (a re-verify refusal at `merge`, with
  rounds already spent). `directionOf` names `verify-failed` only at `merge`
  (`pass-steps.ts:620-622`), so `stoppedAt = reported` here is `{step: 'merge',
  ending}` (`pass.ts:1446`). That satisfies `MergeRefused`'s own produced-by
  condition, `stopped.step === 'merge' && ending.ending === 'refused'`
  (`conduct.ts:3203-3214`), which is checked ahead of the branch-3 test — so
  this route is a **`Failure.MergeRefused`**, not the *check that stayed red*
  row, despite carrying the same mechanical rounds-spent cause as the `red`
  case above.
- 0061 §3's measurement, quoted at `judge.ts:455-460`, counts `red` and
  `verify-failed` refusals together — 60 of the refusals it counted, not one
  of them a human judgement — but on this tree the two land in different rows
  of this table, per the split above.
- **The log fact that tells the two apart from a person who asked to wait on
  purpose** is `RouteTaken.chose` beside `RouteTaken.to: 'waiting'`
  (`pass.ts:1334-1346`, recorded on every `PassRouted`). Where `chose` names a
  destination other than `'waiting'` itself, something wanted to keep going and
  a ceiling said no. This document does not assert from the code how often
  each half actually happens — that is a query over `PassRouted`, not a count
  to recite here.

**A fixer that declined to change anything.** This ending does not exist on
this tree as its own thing:

- [0039 §5](../decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md)
  (`:70-76`, `:136`) says *"committing nothing **is** the decline, and it
  becomes a disagreement a person"* reads — the intent was never to give a
  decline its own signal.
- `fix.ts:160` still types `{ ended: 'declined' }` and `fix.ts:236-278`
  branches on it, but that is the old fix loop's own return type.
  `conduct.ts:181` imports only `fixBrief` from `fix.ts` — confirmed by grep: no
  other import, and no call anywhere in `conduct.ts` reaches a `'declined'`
  value. **The pass itself never produces one.**
- A first `implement` that commits nothing and a re-entered fix round that
  declines are two different code paths, with different appends.
  `conduct.ts:2792` — `if (head === startedAt) return { stopped: 'the agent
  produced no commits' }` — is inside `firstDispatch` only, and appends
  neither `RunFailed` nor `FixApplied`; the stop surfaces solely through
  `StepDidNotFinish.detail` (`action.ts:770-772`), carrying that exact
  sentence. `fixRound` has its own stop, `conduct.ts:2943-2950`, reached only
  after it unconditionally appends `FixApplied` (`:2910-2924`), whose
  `headSha` and `failure` fields fold `committed` and `fixed.failure`:
  `headSha: null, failure: null` is what a decline writes, next to `failure:
  'crash: …'` for a crash in the same round and `failure: 'out-of-turns: …'` /
  `'out-of-usd: …'` for a ceiling hit there. Each of the three — decline,
  crash, ceiling — gets its own sentence into `StepDidNotFinish.detail` too.
- Both stops fold into `work-action.ts:170`'s `verdict: 'did-not-finish'`
  fallthrough alongside a crash and a ceiling hit from a first dispatch.
  `did-not-finish` is not one of the two endings `goesToTheRouter` admits
  (`refused`/`asked`, `pass.ts:1026-1028`), so it never reaches a judge and
  `stoppedAt` is set directly (`:1415-1421`). `conduct.ts` records it
  `acknowledgement` — the *step that did not finish* `Failure` row.
- So today, a declined fixer is not indistinguishable from a crash or a
  ceiling on the log: `FixApplied.failure` is `null` for exactly a decline and
  non-null and self-describing for the other two, and a first dispatch's
  no-commit stop leaves no `FixApplied` at all to compare against. What the
  log cannot say is *why* the fixer declined — only that it ran, touched
  nothing, and lands in the same `acknowledgement` `Failure` row a crash
  would. Whether that fact alone earns a declined fix round its own
  `Judgement` variant, separate from the crash/ceiling `Failure` it shares a
  row with today, is open — see question 4.

## #427 — what triage named, for the holds it ran against

Not in this repository; the result comment on #427, 2026-10-07. Seven holds
were triaged twice each; both runs named the same cause for 7 of 7 and the
same move for 6 of 7; `none` was never chosen; all 14 runs together cost
$0.93.

| hold | cause triage named |
|---|---|
| #390, #316 | *decision* |
| #314 | *setup* |
| #370 | *merge* |
| #377 | *decision* |
| #269, #308 | *narrower* |

Three of the seven wanted a move that does not exist — #426's finding, listed
below under open moves, never decided in this table.

## Moves #426 names and nothing offers

Not in the moves column above, because they are not offered by any code on
this tree:

- one more round on the current branch, past the recipe's rounds;
- splitting a ticket into chained tickets;
- merging the base into the branch with a conflict's resolution.

Each changes what a pass may buy
([0108](../decisions/0108-a-refusal-buys-a-round.md)); each is #426's
own ticket to decide, not this one's.

## Open questions

1. **Is a `red`/`verify-failed` route with rounds spent `Routed{when: 'red' |
   'verify-failed'}`, or does it stay a `Failure`?** Today it is recorded
   `acknowledgement` (a `Failure`) purely because `stoppedAt` is non-null on
   that path (`pass.ts:1446`), not because anything about the situation
   differs from the `findings` case that *is* recorded `judgement`. 0118
   `:91` calls a ceiling *"which one, and what was spent"* — whether *rounds*
   is the ceiling meant there, or whether this route should instead become
   `Routed{red}` / `Routed{verify-failed}` by changing what `reported` carries
   on the `ARRIVE_AT_THE_ROUTER` branch, is for #439 to decide. If it is not
   fixed, `Routed` as typed by 0118 (`when: JudgeWhen`, all five values) is
   wrong today in two ways: it both overclaims (4 of 5 `JudgeWhen` values never
   reach it with `stoppedAt === null`) and underclaims (the `red`/`verify-failed`
   routes that *are* mechanical judgements are filed as machine failures).

2. **Which Hold does a migration-bearing diff produce, and is it really one
   thing?** `pass.ts:930-931`'s own comment says a `human:` action, a `watch:`
   that saw a migration, and a repair all end their step `held` — 0118 itself
   says nothing about migrations anywhere (`grep -n migration
   doc/decisions/0118-a-hold-explains-itself.md` has no match); the claim is
   this code comment's alone. But the merge
   lane's own migration check (`packages/repo/src/integrate.ts:433-441`)
   returns `refuse('pending-migration', ...)` — a `RefusalReason`, which is a
   `refused` ending, not `held`. `directionOf` gives `pending-migration` no
   name (only `conflict` and `verify-failed` are named at `merge`,
   `pass-steps.ts:613-623`), so it falls through to `toAPerson` directly
   (`:1275-1279`) and is recorded `acknowledgement` through the same explicit
   branch as any other merge refusal (`conduct.ts:3203-3214`) — a
   `Failure.MergeRefused` today, every time, on this tree. The `held` ending
   `pass.ts:930` describes is a separate, optional mechanism: a recipe-declared
   `watch:` (`packages/recipe/src/recipe.ts:711-727`), which globs the diff's
   file list and can be pointed at a migrations directory, ends its step
   `held` directly and bypasses the merge lane's check entirely — a project
   that declares no such `watch:` never reaches it. So which Hold a migration
   produces depends on whether the project's recipe happens to declare a
   matching `watch:`: with one, `Gate`; without one (the common case, since
   `watch:` is a generic tamper-guard rather than a migration-specific
   feature), `Failure.MergeRefused`, always, regardless of what `pass.ts:930`'s
   comment implies. #439 should decide whether migrations are meant to be
   `Gate` unconditionally — which would mean adding a dedicated check rather
   than relying on an optional `watch:` — or whether `Failure.MergeRefused` is
   the right call and `pass.ts:930`'s comment describes an aspiration
   `integrate.ts` does not implement. There is no ADR text to correct either
   way: 0118 never made this claim, so settling this is a code-and-comment
   question, not an edit to 0118.

3. **Is the repair half of `pass.ts:930-931` still live?** `alsoHeldAtMerge()`
   (`conduct.ts:2330-2349`) still injects a `human:` action at `merge` when
   `repairOf !== null`. `repairOf` **is** set on every pass —
   `conduct.ts:908`: `const repairOf = retiredRepairPending(before)` — so a
   grep of `repairOf = ` finds a live assignment, not an absent one; *nothing
   on this tree sets `repairOf`* is the wrong premise. What
   `retiredRepairPending` (`packages/domain/src/work-item.ts:425-437`) returns
   is null on every log written since #143, and non-null only where a
   pre-#143 `RepairRequested` still sits after the last `WorkItemClaimed` on a
   stream old enough to carry one — its own comment: *"read off a log written
   before `#143`, and never produced by this build."* So the real question is
   not whether the assignment exists, but whether any project's log can still
   hold such an unclaimed pre-#143 event: if none can, this half of
   `Judgement.Gate`'s row has no live producer left and #439 can retire it; if
   one still can, the path has to stay, and `Judgement.Gate` needs to say a
   repair can still produce it. #439 should answer this by checking whether
   any project's log still carries an unclaimed pre-#143 `RepairRequested`,
   not by grepping for the assignment.

4. **Is a declined fixer a `Judgement` at all?** As traced above, the engine
   *can* tell a declined fix round apart from a crash or a ceiling hit in the
   same round — `FixApplied.failure` is `null` for exactly the decline — and
   apart from a first dispatch's no-commit stop, which leaves no `FixApplied`
   at all. What it cannot say is *why* the agent declined. 0118 lists it under
   `Judgement` because a person reading the transcript can often say why; the
   log, today, only says that it happened. #439 decides whether that one fact
   — ran, touched nothing, `FixApplied.failure: null` — is enough to give a
   declined fix round its own `Judgement` variant, separate from the
   crash/ceiling `Failure` it shares a row with today, or whether the
   distinction only matters once a person, or a triage agent reading the
   transcript, says why.

5. **`judged` excludes `asked` exactly as it excludes `held`, so Approve is
   never drawn on a `Judgement.Asked` hold, at any `onOrigin`.**
   `conduct.ts:3501`'s predicate (`stopped === null || ending === 'refused'`)
   is false for an `asked` ending the same way it is false for a `held` one —
   `conduct.ts:3502`'s guard (`!held && judged && onOrigin !== null`)
   therefore never fires there, so `conduct.ts` never appends
   `ApprovalRequested` for an `asked` hold. The pipeline's own append for a
   `needs-approval` verdict (`action.ts:795-802`) answers a different ending —
   it fires on the action that asked for approval, which ends `held`, not
   `asked` — so no `ApprovalRequested` exists for an `asked` hold at any
   `onOrigin`, and the board has nothing to draw an Approve control from.
   #439/#441 must not read this question, or the `Judgement.Asked` row above,
   as license to put `approve` in `allowedMoves(Judgement.Asked)` gated on
   `onOrigin` alone — doing so would offer "merge it anyway" on a diff where
   `build` and `review` never ran, the exact shape `conduct.ts:3483-3495`
   names (`#237`/`#249`) as the one that must not offer the control. What is
   actually open is whether `asked` should ever gain a path to Approve at all
   — which would need a plugin or pipeline change, not a table change — not
   whether today's `onOrigin !== null` gate already permits it, which it does
   not.

6. **Does `Failure`'s "lifts by itself" setup sub-variant have a producer at
   all?** 0118 §4 names two halves of *fix the setup*: a condition that lifts
   by itself (an account's usage limit) and one a person has to fix (a
   runtime missing the tier a recipe asks for). Neither reaches `WorkItemBlocked`
   on this tree. An account-wide wall sets `outcome` to `'failed'`, not
   `'blocked'` (`pass.ts:1236-1237`, `ending.ending === 'never-ran'`), and
   `conduct.ts:3593-3624` calls `standDownConductor` but does not return, so
   the same pass falls through to `release(reason)` (`conduct.ts:3631`), which
   appends `WorkItemReleased` to the item's own stream (`conduct.ts:1057-1095`)
   — the item goes back to the queue with that event as the record, and there
   is still no `WorkItemBlocked`. A runtime missing the recipe's tier is
   `DispatchRefused` (`conduct.ts:826-841`), which 0118 itself already
   excludes from the lane (`:58-59`, *"the refusal is the pass's rather than
   this item's... the conductor pauses instead"*) and which `task-view.ts:450-501`
   confirms writes `state: 'queued'`, never `'waiting'` — and, since #405,
   that refusal also pauses the conductor itself (`conduct.ts:826-860`,
   `pauseConductorOnce({until: null, ...})`) rather than letting the pass move
   on to the next queued item, so the item is left Queued until a person runs
   `lingtai resume`. The only `Failure` "setup" row with a
   real producer today is the per-item one in the Hold table above — `admit`
   or `prepared` refusing on *this* diff, which does reach `WorkItemBlocked`.
   Whether 0118's two-part taxonomy should be narrowed to that one case, or
   whether a future change is meant to route the account-wide wall into a Hold
   too, is #439's to decide.

7. **`lingtai status` and the GitHub comment** — unchanged from 0118's own
   *Not decided here*: whether either carries the cause or only links to the
   page.

8. **`triageRuns` for the sub-variant in question 6** — if it never produces a
   Hold, #441's `triageRuns` has no row to answer for it either; that falls
   out of question 6 rather than needing its own decision.

9. **Does `recommendedMove`'s default for `Gate` depend on which step it is
   at, or is every `Gate` a gate?** 0118 §1 (`:122-127`) decides: with no
   advice, *"the hold's own default stands: approve at a gate, requeue at a
   ceiling, and nothing elsewhere"* — one answer for the whole `Gate`
   variant, not one per step. Today's code answers two different things for
   the one variant: `held` at `proposed` gets no prefilled move
   (`conduct.ts:3299-3301`'s test requires `stopped.step === 'merge'`), while
   `held` at `merge` gets `approve`. The `Failure` ceiling row above cites
   this same ADR line for its own `requeue` default, so the disagreement sits
   one row away in this document without being named anywhere. #439 decides
   whether `recommendedMove(Gate, ...)` should answer `approve` regardless of
   step — matching 0118, which would mean widening `conduct.ts:3299-3301`'s
   test — or whether 0118's *"at a gate"* was written with only the
   merge-time gate in mind and the ADR's wording needs a person to say so.

10. **A `review` refusal that carries no finding, or an answer that did not
    parse, defaults to `approve`.** 0118 §1 does not name `Routed{findings}`'s
    default at all, and nothing about either arrival looks like a diff a
    person should wave through on sight: a reviewer that found nothing to
    hold the agent to, or a machinery failure that lost the answer entirely,
    is not the same thing as a review that passed. Today's code offers
    `approve` anyway, because the only test `conduct.ts:3299-3302` runs is
    `findings.length === 0`, and both arrivals leave `findings` empty for the
    same reason a clean pass would — `conduct.ts` cannot tell *review passed*
    apart from *review had nothing to say* once it is looking only at the
    `findings` array. Whether `recommendedMove(Routed{findings}, ...)` should
    answer `none` on these two arrivals specifically — which would need
    `PassResult` to carry `unreadable`/`carriesACriterion` rather than just
    `findings` — or whether `approve` is the intended default regardless of
    which of the three arrivals produced it, is #439's to decide.
