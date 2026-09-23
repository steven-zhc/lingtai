# 0044 — A close is a terminal outcome, so `end` runs on it

**Status** accepted · 2026-09-14 · completes #151; widens the fourth outcome
[0016](0016-the-settled-model.md) §4 says a point must not be silent about

## Context

`#151` gave a work item a fourth ending. Three existed — `landed`, and the two
a run reaches, `blocked` and `failed` — and a ticket nobody was going to do had
none of them: closing it was `gh issue close` by hand, which appends nothing, so
the fold went on calling the item `backlog` and the board went on drawing the
card under *Queued*. `WorkItemClosed` fixed that half.

It did not reach `end`. `end` is described, in its own file, as *the point that
fires on every terminal outcome* — that sentence is why it lives in
`end-point.ts` rather than on one of the paths that reaches an ending:

> A point that fires on *any* terminal outcome cannot live on one of the paths
> that reaches one. It lives here, and every path calls it.

A fourth outcome that did not reach it made the sentence false, and made it
false in the way 0016 §4 calls Lingtai's bug rather than the operator's: the
point is configured, `GatesResolved` records that it is configured, and it
silently does not run. A recipe saying `when: any` went on saying *any*.

The cost was visible the day the close shipped. `lingtai close` on `#154` and
`#156` ended both tickets on the log and left both GitHub issues open, so the
`gh issue close` the whole mechanism exists to replace still had to be run by
hand — twice, on the same afternoon, by the person who had just built the
command.

## Decision

**`closed` is a terminal outcome everywhere the other three are.**

- `TerminalOutcome` is `landed | blocked | failed | closed`.
- A recipe's `when:` accepts `closed`, and **`any` includes it**. Any means any;
  an `any` that quietly excluded one outcome is the hole again, one layer down.
- `close()` resolves the point **in the same append as the outcome**, as
  `approve()` folds `landed`. One transaction, so a crash cannot leave a
  terminal with no record of what its point decided.
- **An unreadable recipe refuses and closes nothing** — `approve()`'s rule, for
  its reason: appending a terminal whose point could not be resolved is how the
  silence gets in. The recipe is read from the base branch, never an agent's
  ([0005](0005-config-in-target-repo.md)).
- The audit behind `lingtai doctor` and `lingtai end replay` reads both endings,
  and asks whether the point resolved **for this outcome** rather than whether
  it resolved at all.

`any` including `closed` is the part that changes existing recipes, and it is
the deliberate half of the decision. The alternative — a `closed` that only
explicit configuration reaches — keeps every recipe behaving as it did, at the
price of a point that is documented as universal and is not. That is the trade
this repository has refused before: a check present, reported, and not looking
at the thing you think it is.

## Consequences

**A recipe that closes its issue on landing does not close it on a close, and
should not.** The two are separate actions rather than one `when: any`, because
`any` also fires on `blocked` and `failed` — and closing an issue because a run
could not finish is the opposite of what those mean. This repository's own
recipe now declares both, and `packages/conductor/unit/close.test.ts` asserts
against that file rather than a fixture, so the distinction is pinned where it
is configured.

**The audit will name items it was silent about before.** Two widenings, one
cause: it read `WorkItemLanded` alone, and it asked only whether *an*
`EndActionsResolved` existed where the resolver itself dedupes per outcome. An
item that resolved `end` while it was blocked, came back, and then landed looked
settled and was not. Those items were always there; `lingtai end replay` is what
finishes them, and it now replays each for the outcome it actually reached
rather than for a hardcoded `landed`.

**`EndActionsResolved`'s own enum had to widen too**, and a test found that
rather than a reader — which is the argument for the outcome being named in the
event schema at all. One instance fixed and the class missed is this
repository's most-repeated bug; here the class was four places, and the fourth
was caught by running it.
