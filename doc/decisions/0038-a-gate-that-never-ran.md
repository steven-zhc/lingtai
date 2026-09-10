# 0038 — A gate that never ran has judged nothing, and the same quota stops the conductor

**Status** accepted · 2026-09-10 · applies
[0031](0031-a-run-that-never-started.md) to the agent inside a gate, which 0031
did not have; declines a lane, per [0016](0016-the-settled-model.md) §8

## Context

`#123`'s fourth attempt:

```
attempt 4   prepared:install  exited 0 in 8.2s
            proposed:build    exited 0 in 322.3s
            proposed:review   the reviewer did not finish (crash):
                              You've hit your session limit · resets 2pm (America/Chicago)
```

The build passed in five minutes. The reviewer produced no verdict about the
diff, because the account was out of quota. The gate refused, the item blocked,
and the card said **a review gate refused it** — a sentence about this diff,
produced by a condition that has nothing to do with any diff.

**This is 0031's case one layer up.** 0031 decided that a run which never
started is its own outcome, that it is Lingtai's failure and buys no agent, and
that an account-wide condition stops the *conductor* rather than backing the
item off — *because per-item backoff answering an account-wide condition is what
eighty events in ninety-two seconds looked like*.

The agent inside a gate does not travel that path. `agent-gate.ts` received a
failed outcome, turned it into a failed verdict, and the pipeline treated it as
any other refusal: this item blocked, the next item claimed, the next item's
review meeting the same wall.

### Why it stayed hidden

0031 landed when the only agent in a pass was the implementer. The `agent` gate
existed and had **never once run**: it was handed the run's hook settings
without the run's hook environment, so every review returned the hook's refusal
instead of findings (`d4fbd1a`, fixed the same day this was found). The second
agent in a pass became reachable and met the quota wall in its first afternoon.

0031's tests pass today and this happened anyway. They had to: the run itself
started, took turns and spent money, so nothing about *it* is `never-started`.
The classification was right and it was being asked in one place out of two.

## Decision

### 1. A gate whose agent never started did not judge, and says so

A fourth `GateVerdict`, `never-ran`, and its own event, `GateNeverRan`.

**It cannot pass.** A green gate for a diff nobody assessed is what
`agent-gate.ts` already refuses to emit for an unreadable answer, and this is
the same absence with a different cause.

**It must not fail.** `GateFailed` is a verdict *about the diff*, carried into
the next attempt's prompt as evidence, counted on the card as a refusal, and
read by a person as "the reviewer found something". None of that is true here.

**It is not `quota`,** for 0031 §1's reason: the name is what is checkable, not
the cause inferred from prose. The gate does not read the message and does not
re-derive the classification from `outcome.turns` and `outcome.costUsd` either
— it takes `RunFailed.kind === "never-started"`, which the adapter decided from
those three facts. One home for the classification. A receipt that would not
parse leaves turns at zero out of ignorance rather than evidence, which is a
crash and must stay one, and a second derivation at this seam is where the two
would drift.

### 2. The event exists so that the absence of a verdict is readable

The alternative was to emit nothing: the point is reached, `GateRequested` and
`GateStarted` are on the log, and no third event follows. Every reader would
then show the gate as **running** — the board's task page, the progress bar, and
`attempts.ts`, which would tell the next agent a review *died inside* this diff.
That is the same species of wrong sentence, one screen along.

So the point says what happened, in a type that is not a verdict, carrying the
runtime's own words whole as `detail`.

**`detail` and not `evidence`, and every reader has to be told.** The other gate
events call their text `evidence`, meaning evidence *about the diff*; this is
evidence about the account, and the name says so. A fold that reads `evidence`
alone gets `null` here — and the task page shows only gates that said something,
so the wrong key hides the one gate that stopped the run from the page this
section is about.

### 3. The conductor stands down, and the item comes back on its own

0031 §3 and §5's *mechanism*, reused whole: `standDown` reads a reset time out
of the message where there is one and the recipe's backoff where there is not,
the first `never-ran` pauses the conductor through `ctl-conductor`, and a pause
already holding is left exactly as it is. Its *sentence* is not reused; see
below.

The item is **released**, like any run that did not land — it keeps its place
and the queue brings it back when the pause lifts. No person requeues anything.

**And that includes a repair, which is where `release` needed changing rather
than reusing.** `#84`'s handover blocks with *the repair could not fix it*: a
verdict on the diff the repair produced, and this run reached none — nothing
read it. It would also park the item in **Waiting on you** behind the very pause
this run just caused, so the one thing a person would have to undo by hand is
the one thing 0031 §5 exists to prevent. What a spent repair must not do is come
back as an *ordinary* attempt knowing nothing about the conflict, and that is
answered by giving the repair back rather than by blocking: `RepairRequested`
again, same fingerprint, so the next claim consumes the same repair.

The fold makes that free. A repair's identity is its fingerprint —
`decideRepair` already refuses a duplicate by it — so `applyWorkItem` treats a
second request for one it holds as *the same repair, still owed*: `pendingRepair`
is restored and `repairs` is unchanged. Nothing that buys a repair can reach that
branch, and a quota does not eat an attempt off 0025 §3's ceiling.

**The pause names the gate, because *nothing spent* would be false.** This is
0031's mechanism and not 0031's sentence. That sentence opens *a run ended
without ever starting — no turns taken, nothing spent*, and it is what the
board's chip and `lingtai doctor` show. Here the run started, took turns and was
paid: the implementer produced the diff the reviewer was being asked about.
Writing the run-level sentence about this pass would put `#133`'s own false
claim one screen along from the card it started on — a person woken by the chip
at 2am reads it before anything else.

So `standDown` takes *what* never started, and there are two: the run's own
agent, and the one inside a named gate.

### 4. The pipeline stops, and no question is put to a person

The gates after this one would ask the same account the same question. The run
ends there: no merge point, no `ApprovalRequested`, no block. Under
`--no-merge` — the flag this repository passes every time — the hold would
otherwise ask a person to *merge anyway* over a gate that refused nothing.

The branch is pushed first, as it is for a genuine refusal. Pushing is not
merging, and the work an agent did is not thrown away because a reviewer could
not be reached.

## What this does not add: a lane, or a run failure

**No `RunFailed`.** The run finished: it took three turns and spent money in
the test, and hours in the incident. Appending `never-started` to it would say
the opposite of what the receipt shows, and would make the release sentence —
*nothing was spent* — a lie about a run that spent an agent.

**No new column and no new work item state.** The item is queued, exactly as
0031 leaves one, and the pause chip `#77` added already says why nothing is
moving.

## Consequences

- `GateVerdict` gains `never-ran` in `@lingtai/actions` and in the run fold;
  `PipelineResult` gains `neverRanAt`, which is how `run-once.ts` tells this
  ending from a refusal without reading a sentence.
- `GateNeverRan` is additive at version 1. Nothing ever wrote one with the old
  `diff` point name, so it needs no upcaster; `gate-audit.ts` counts it as proof
  the point was reached.
- The card's line for such an item says the gate never ran and that nothing
  judged the diff, and names no refusal. Not *nothing was spent*, which is the
  run-level sentence and would be false: the implementer was paid.
- `attempts.ts` carries none of it into the next prompt: a quota has nothing to
  say to an agent about the code.
- `standDown` takes a `NeverStarted` — `run` or a named gate — and 0031's
  sentence is what `run` produces, unchanged. A third depth would need a third
  clause, and would not compile without one.
- `Stopped` gains `aboutTheDiff`, false on exactly one ending. `release` reads it
  for one decision: whether a repair hands over.
- `applyWorkItem` folds a repeated `RepairRequested` by fingerprint. Inert for
  every path that existed, because `decideRepair` cannot produce one.
- The page's fold reads `GateNeverRan.detail` where the others read `evidence`.
  The names differ on purpose — one is evidence about the account — and
  `Evidence` shows only gates that said something, so reading the wrong key hides
  the one gate that stopped the run.
- The two paths now share one answer and are still asked in two places — the
  dispatch and the gate. A third agent in a pass would need the third.
