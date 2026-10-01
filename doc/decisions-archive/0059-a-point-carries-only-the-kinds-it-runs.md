# 0059 — A point carries only the kinds it runs, and the recipe refuses the rest

**Status** accepted · 2026-09-22 · **completes
[0016 §4](0016-the-settled-model.md)** — *a gate that was configured and did not
run is Lingtai's bug* — for the ten cells where it was still true · narrows what
a recipe may **say** at a point, and none of [0015](0015-five-gates-and-two-extensions.md)'s
rules about what a point **is** · **thirty cells are sixty** since 2026-09-23
([0058](0058-lingtai-is-a-development-pipeline.md) §3, `#227`), on the same
two-valued rule: the six steps nothing constructs a pipeline for refuse every
kind by name, exactly as `admit` does below

A gate action is a point and a kind. Five points × six kinds is thirty cells,
and ten of them were accepted by the schema and executed by nothing. A kind a
point does not run is refused when the recipe resolves, by name.

## Context

0015 gives a plugin exactly two powers and the first is *a gate action attached
to a point*. 0016 §4 makes the rule that keeps that power honest: an
unconfigured gate is skipped and that is the user's call; **a gate that was
configured and did not run is Lingtai's bug.**

`#58` was that bug at `merge` — an action resolved into `GatesResolved`, printed
by `lingtai add`, drawn on the board, and never built into a pipeline. Lingtai's
own `human:` there watched two of its own changes merge with nobody's approval.
`#55` was the same shape at `end`. Both were fixed one point at a time, and
nothing asked whether there were others.

There were ten, and `#61` counted them:

```
admit      six kinds   no pipeline is constructed for this point anywhere
end        four kinds  `if (!("when" in a)) continue;`  — end-point.ts
prepared   human       the hold is folded into a release — run-once.ts, section 7
```

`admit`'s six are the `#58` shape exactly. `end`'s four are one line: a `run:`,
an `agent:`, a `watch:` or a `human:` declared there resolved to an empty list,
and `EndActionsResolved` recorded the point as having run with nothing in it —
the one record 0015 promised would make this detectable, saying the wrong thing.

`prepared` × `human:` is the subtler one and the most expensive. The gate is
built and it runs; it emits `ApprovalRequested` and returns `heldAt`. Then
`run-once.ts` folds `heldAt` into `failedAt` and stops the run, which **releases
the item to the queue** — so the question is on the log and on the card, and
`lingtai approve` answers `not-awaiting-approval` because the run it belonged to
is over. The ticket comes back after the backoff, cuts a worktree, pays for an
install, and asks the same unanswerable question again, every pass, forever.

### Why it stayed hidden

Because *a point runs its actions* and *a point runs this kind of action* look
like the same sentence, and only the first was ever written down. `GatesResolved`
records what was planned at each point and the gate audit
(`gate-audit.ts`) compares it against what ran — but it compares **points**, so
a point that ran three of its four actions passes. And a matrix nobody wrote
down is one nobody can read: `#61`'s own copy of it was wrong about `merge`
within three weeks of being written, because `#58` had landed in between.

## Decision

**§1. A point carries only the kinds it runs.** `KINDS_AT` in
`packages/recipe/src/recipe.ts` is the whole of it — thirty cells, five rows —
and `whyNoKindAt` is the sentence each refusal carries.

**§2. The refusal is at resolve time, and it is the recipe's.** Not a warning, a
skip, or a runtime throw mid-pass: the file does not resolve. So `lingtai
doctor`, `lingtai add` and the first moment of a pass all name it, before a
ticket is claimed, a worktree cut or an install paid for. `gatesFromRecipe` asks
the same table again for a caller that builds actions in code, and takes the
point as an argument for that reason.

**§3. `admit` carries nothing, and stays one of the five.** The closed set is
about the places in the loop, not about what is built today. The day something
runs a pipeline at `admit`, its row grows and no other rule moves. A question
that must be asked before anything is spent is `lingtai ask` (`#147`), which
holds the item in the queue and needs no worktree to be answered.

**§4. `prepared` carries `run:` and nothing else.** `agent:` and `watch:` are
refused because nothing has been committed — there is no diff to read and no
file list to match, which is a fact about the point rather than about the
dependencies the conductor happens to pass. `human:` is refused because a hold
there is turned into a release, and an approval that cannot be granted is worse
than no approval at all. Either make the ask before the claim, or make it at
`proposed`, where there is a diff to approve.

**§5. The matrix is a constant, and the document is checked against it.**
`doc/reference.md` carries the table and
`packages/conductor/unit/gate-matrix.test.ts` walks all thirty cells: each one
runs — the point's own consumer builds or resolves it, with the dependencies
that point's call site supplies — or refuses by name. The same test compares the
document's ticks to `KINDS_AT` cell for cell, and reads `run-once.ts` to pin the
dependencies each point passes. A new kind or a widened point cannot land with a
silent hole, and the document cannot drift from the code without a red test.

## Consequences

- **A recipe that declared one of the ten stops resolving**, and that is the
  point: it never did anything, and the whole project's commands refuse until
  the line is removed. Nothing in this repository's own recipe, the
  `pnpm-workspace` preset, or what `lingtai init` proposes declared one.
- **`end`'s resolver throws rather than skipping** an action with no `when:`.
  Unreachable from a recipe now, and left loud for the case an action list is
  built in code.
- **The ten cells are not built, they are closed.** This buys nothing new; it
  makes the extension surface's advertised size its actual size. `#61`'s
  argument stands: *"the set of points is closed forever" only sells the design
  if every point in the closed set is real.*

## What this does not decide

- **Whether `admit` should ever run something.** It should — `discover.ts`
  wants a reason there, and 0015 says the point may refuse. That is a ticket
  about building a pipeline, and this decision is what makes the day it lands
  visible instead of silent.
- **Whether `prepared` should be able to hold for a person.** It cannot today
  because a hold there is a release. Making the release a hold is a change to
  the pass, not to the schema, and §4 is the honest answer until somebody makes
  it.
