# The card, and the sequence inside it

**Status** built · 2026-09-16 · `#170` · a picture at
`claude.ai/code/artifact/aa70a184-eaea-4594-932e-e1a01df4240d`

What is in `apps/board/src/app/rail.tsx` is `Segs` and `Rail`; what holds the
line is `apps/board/test/rail.test.tsx`, which counts the objects on a running
card and reads the geometry out of `globals.css` rather than out of itself.

Thirteen objects, all of them boxed, wrapping to five rows at `22rem` — which is
the width the column actually gives a card.

## Every one of them earned its place, and nobody looked at the row

`#79` gave a running card its run's elapsed rather than `updatedAt`, because
*the last time anything was appended* labelled `running 12s` would say a run
eight minutes in had just started. `#84` separated what answering a refusal
costs from what the work costs, because answering is default-on and folding it
in makes an invisible bill. `0039 §3` renamed that chip from *repair* to
*answering*, because the column holds every round a pass bought and only one of
them was ever a repair. `#113` made the age absent rather than invented on a
ticket the log has never moved. `#95` turned *whether* into *when*. `#100` split
the three things a Queued card can be. `0040 §3` put *which arm* beside *how
many attempts*, because a crash, a backoff and an abandoned approach all read as
`attempt 3` and only one of them means a whole approach was thrown away. `#147`
split one brass chip into the two different waits it was standing for.

Every argument is sound. **The row is the thing none of them was about** — and
this is `the-bar.md`'s story, one surface along and with the same ending.

## But a card has a second problem the bar does not

The bar is a set. A card holds a **sequence**, and renders it as one:

```
.meta  (the card)   running 15m15s │ 48 turns │ $5.92 │ 1 passed
                    $4.88 answering │ attempt 2 │ restart 1 of 1

.meta  (in `Now`)   proposed:build 42s/20m │ admit │ prepared │ proposed │ merge │ end
```

Two `<ul className="meta">`, the same class and the same pill styling, holding
two kinds of fact that are not alike. The first is scalars — counters and money,
no order, any one readable on its own. The second is **a position in a
sequence**, flattened into a wrapped row of equal pills, which loses the one
thing a sequence has: that it runs one way, and one of its members is *here*.

**And the same six tones mean different things across the two.** `pill pass`
green is *a gate action passed* above and *this point passed* below. A reader has
to know which list they are in before the colour means anything — which is a
thing you can only know by reading the code.

There is a **second sequence hiding in the first list**. `attempt 2` and
`restart 1 of 1` are `0040`'s two axes; they sit as two unrelated pills among the
counters, and *which round am I watching* is the question they answer worst.

## What a card is for

Not the same two questions the bar answers. A card in a column answers:

1. **Where has this got to** — and it is a sequence, so the answer has a shape.
2. **Which time round** — an attempt is not a restart, and `0040` is the reason.
3. **What has it cost** — turns and money, which are genuinely scalars.
4. **Is it on me** — only in the lane where that is true.

The first two are sequences and were drawn as sets. That is the whole of it.

## The rule to keep

**A sequence is not a set, and a pill cannot say which.** Anything that has an
order — the five points, the rounds, anything added later that runs one way —
gets a form that shows the order. Anything that does not stays a pill.

It is in the code beside `Rail` in `apps/board/src/app/rail.tsx`, where the next
point-shaped thing would be added, and so where the argument has to be made.

## Which surfaces draw it

**Two, from one file** (`#189`). `rail.tsx` is imported by both routes and
defined in neither:

| surface | what it draws | fed by |
|---|---|---|
| the board, a Running or Waiting card | `Rail` — the segments, the five names, the one sentence | `laneProgress`, cut by `railCandidates` |
| the board, a Landed row drawn open | `Segs`, unlabelled — scanned for the hatch | the same |
| the task page, rank 2 of a **running** item | `Rail`, live — which point, the action, its elapsed and its bound | `loadTask`, the run in flight folded with the recipe's plan |
| the task page, under every attempt in the record | `Segs`, labelled, nothing lit | `foldRun`, with `over` only on the attempt that landed |

It was the board's alone for a day. The task page listed the points off
`task.ts`'s own `PointView` — a second fold over the same events, with no
`running` and no `never-ran` — so it lit nothing and printed `N pending` for a
point that had been configured and never ran, while quoting 0016 §4 beside it.
`PointView` is gone rather than kept beside `RunProgress`: once the rail was on
the page nothing read it that the other fold did not serve better, and two folds
over one stream is how the two surfaces came to disagree. A third surface
imports `rail.tsx` and reads `foldProgress`; it does not grow a list.

## Why the bar cannot be "filled means done"

> **All five, always.** A point that is merely omitted is indistinguishable from
> one that was configured and silently did not run, and **only the second of
> those is Lingtai's bug**.
> — `page.tsx`, on the five points ([0016 §4](../decisions/0016-the-settled-model.md))

Three of the seven states look empty and mean different things, so the segment
carries the distinction the sentence above demands:

| state | segment |
|---|---|
| `passed` | filled, `--pass` |
| `running` | filled, `--accent`, pulsing — the only motion on the card |
| `failed` | filled, `--fail` |
| `waived` | filled, `--held`. Never green — an override of a red build must not look like a green one |
| `pending` | flat `--rule`. Quiet, because nothing is wrong |
| `skipped` | dashed outline, no fill. Nothing configured (`admit: []`, `merge: []`); it keeps its place without claiming anything happened in it |
| `never-ran` | hatched, `--fail`. The one segment that breaks the bar's rhythm, and the only place the fail colour appears with no verdict behind it |

**`never-ran` is not an extra.** A bar that draws all five points must have a
mark for *configured and did not run*, or that state renders as something it is
not — which is the failure `0016 §4` names. It reached `lingtai doctor` as a FAIL
naming `#49`, `#53` and `#55` at the merge point and reached the board as nothing
at all. It costs no projection: `foldProgress` now makes
`landedWithoutGatePoints`'s own comparison, and the same one rather than a
looser one, because this mark accuses Lingtai and a false one is worse than
none. All three halves of it:

| | |
|---|---|
| the plan named actions here | and **`GatesResolved` is the plan**, never the recipe being read now — a stream without one is folded against a recipe the run never saw, which cannot accuse it of skipping anything (doctor's `planned` CTE selects from those rows and nothing else) |
| the run recorded none | no request, no verdict, no approval, no waiver |
| **the item landed** | and not merely that it is over. The pipeline stops at the first refusal (`0041 §4`), so a **closed** item's later points recorded nothing because nothing should have run in them — and `closed` shares the Landed column, which is how the two get confused. Doctor is anchored on `WorkItemLanded`; so is this |

The caller supplies the last of those, because the landing is on the merge
lane's stream and the work item's, not on the run's — `railCandidates` is where
it is decided and where a test holds it.

**Four points and not five**, and doctor makes the same exclusion in as many
words: `end`'s record is `EndActionsResolved` on the work item's stream, which
this fold does not read. A silent `end` here is a question the run's stream
cannot answer rather than a point that did not run.

## The labels, and what they let go

The five names sit under the five segments, which lets the sentence below drop
the point name: `proposed:build 42s / 20m` becomes `build 42s / 20m`, because
the highlighted label already said `proposed`.

Four tones, and the third does work no colour alone can:

| | |
|---|---|
| `at` | accent-ink, weight 500 — where it is now |
| `done` | muted — behind it |
| `off` | `rule-2`, **italic** — nothing configured. Italic because *nothing configured* and *not reached yet* are both grey, and the difference between them has to survive being grey |
| `bad` | fail — it stopped here |

**The sentence under the bar has four readings and not two.** `build 42s / 20m`
while something is running, `between points` while the agent has finished and no
point has started — and `build refused`, because a refusal clears the live phase
and leaves neither. Drawing the second of those on the third told an operator
the agent had just finished, under a segment that was red.

The fourth is `nothing running`, and it is the one the run's own stream cannot
name. *In flight between two points* and *stopped, by something that is not on
this stream* fold identically — no phase, no refusal — so **the lane settles
which**, exactly as it settles the elapsed pill. A pass the merge lane refused
is that card: `IntegrationRefused` goes to the integration lane's stream, the
board never reads it, and the rail above the sentence is five passed points.

**A refusal being answered is not a refusal**, which is why the refused reading
is only reached with nothing in flight *and* off the running lane: its hover
says a person is being waited on, and that is a fact about the column rather
than about the stream. A bought round
appends `FixRequested`, runs an agent against the findings and appends
`FixApplied` — and no `RunStarted`, because a round is a step inside a run. With
`rounds: 3` that is the ordinary path here, so a fold that saw no phase in it
put `build refused` under a hover saying a person was being waited on, on a card
that was spending money at the time. The round is a phase: `fixing round 2 of 3`,
under the wall clock `RunStarted` recorded, which is the one the fixer is
launched with.

## What was settled, and how

**`N passed` goes, and the segment carries what it said.** `prepared: [install]`
is one action, so *1 passed* **was** *prepared went green*; `proposed` holds
`build` and `review`, so there it was half a point and said so nowhere. The bar
draws **one cell per planned action**, each with its own verdict, which is the
granularity the counter had and the flattened row did not — so `proposed` with a
running build and an unreached review is visibly half a point. All four counters
go with it and not `passed` alone: *failed*, *waived* and *approved* are the
same fact at the same two granularities, and keeping three of the four would
have left a reader deciding which list to believe.

They stay, unchanged, on a card with **no** rail: a lane that does not fold, a
run whose stream would not read, a Landed row the lane keeps collapsed. That is
the rule in one sentence — *the counters are the fallback, not the reading* —
and it is written where they are rendered.

**The two money figures stay two.** `#84`'s reason is intact and the compression
was not needed: the bar, its five labels and its sentence are **one** object,
which is the whole of the design, so a running card carrying elapsed, turns,
both figures and its round is six.

**The second sequence is one object and not yet a form.** `attempt 2` and
`restart 1 of 1` read as `attempt 2 · restart 1 of 1` in a single pill. One
object is what stops 0040's two axes being drawn as a set; the form that shows
*their* order is a later ticket, and the rule above says it is owed one.

## What this lane costs, and where it stops

The rail draws wherever the run's stream was read, and `railCandidates` decides
that: Running, the head of Waiting, and the Landed rows the lane renders open.
It was Running alone, on `#79`'s argument that every other lane describes
something over and the counts carry that whole truth. The counts were the thing
that turned out not to be true — *configured and did not run* is not a number.

**Every added lane is cut by a number, and *it is small* is not one.**
`progress.ts`'s trade is that only a lane holding a handful of cards may read a
stream each, on a route that re-renders on every append. Waiting was argued into
this design as small and is the opposite: the `COLUMNS` entry that gives it a
column of its own says why it has one — *45 items and growing* — so it is cut to
`WAITING_RAILS`, at the head, which is where `readTasks`'s oldest-first order
puts what to do next. Landed grows without bound and has no read that fetches
many runs at once, so it is cut to the `LANDED_OPEN` rows the lane draws open —
and to *those* rows, `runId` filtered after the slice and not before, or a
ticket closed before any run was claimed pulls the fold down into the collapsed
`older` disclosure. Everything past either cut keeps its counters.

Which makes `railCandidates` pure and separate from the read: the cut is the
whole of what makes the rail cheap, and a claim about cost that no test can hold
is the one this design already got wrong once.

## Related

- [`the-bar.md`](the-bar.md) — the same disease one surface along, and the rule
  it left behind: *a chip is not free, and the row is the unit*.
- [`task-detail-page.md`](task-detail-page.md) — the other place a run is
  described. Its ranks are `#132`'s and `#152`'s; `#189` put the rail inside
  rank 2 of a running item, above the log, and added no rank.
- [0016 §4](../decisions/0016-the-settled-model.md) — a configured point that
  silently does not run is Lingtai's bug.
- [0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) — rounds
  bound depth, restarts bound breadth. The second sequence.
