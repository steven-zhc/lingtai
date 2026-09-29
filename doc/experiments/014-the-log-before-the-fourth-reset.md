# 014 — The log before the fourth reset, and the one written by an agent that could not read it

**2026-09-29.** The log starts empty for the fourth time, because
[0068](../decisions/0068-a-step-that-asked-is-not-a-step-that-crashed.md) splits
`StepDidNotFinish` into two event types and
[0061](../decisions/0061-the-recipe-is-the-pipeline.md) §7 allows no migration for
one. The three earlier cuts each have a page written before them
([007](007-the-log-before-the-reset.md),
[010](010-the-log-before-the-second-reset.md),
[013](013-the-log-before-the-third-reset.md)) and this is the fourth, for 013's
reason: **the habit is what makes a reset a decision rather than a loss.**

**This page has no numbers, and the reason is the finding.** The change was made
by an agent Lingtai dispatched, and an agent is never given
`LINGTAI_DATABASE_URL` — *every name Lingtai reads for itself begins `LINGTAI_`*,
and the one planted in a worked ticket's environment is
`LINGTAI_TEST_DATABASE_URL`, which points at a database the suite appends to and
resets. So the fold 013 computed cannot be computed from here. Writing plausible
totals would have been worse than leaving the table out: a page of invented counts
in the shape of one that was measured is the failure
[0043](../decisions/0043-evidence-is-plain-text.md) and this whole directory exist
to prevent.

What is here instead is what can be said without the rows, and the exact queries
that answer the rest.

## What is known without asking the log

| | |
|---|---|
| opened | **2026-09-27**, when the database moved to its own host ([013](013-the-log-before-the-third-reset.md)) |
| held at the cut | **about two days** |
| what is in it | this epic's own passes — `#256` onward — and nothing older |
| what was already spent | the eight `Gate*` names (`#247`) and the 13,481 events 013 folded, which are in the *previous* database and still queryable |

The two days are the reason no transcript is attempted and the reason the cut is
cheap. Every ticket in that window is Lingtai's own machinery, and every one of
them is a GitHub issue — which is the durable citation and is not reset
([1.0](../design/1.0.md)). What the rows add over the issues is the *shape* of the
passes: how many rounds, where they stopped, what they cost.

## What a person should run before the cut

Against the live log, the way 013's fold was computed — `log.queries`, and
`lingtai status` for the board's own reading. Written out so that the answer is a
paste rather than a reconstruction:

- **the fold**: event count, distinct types, and stream counts by kind. 013's table
  is the format, and the comparison worth having is against 013's own numbers: two
  days of this epic against a month of the one before it.
- **`endedWithoutEndActions()`**, which must return 0. It is the one invariant 013
  checked before a cut, for the reason it gave: *an item that ended and whose `end`
  point silently did not run* is
  [0016](../decisions/0016-the-settled-model.md) §4's shape and the thing this
  system is most careful about.
- **`StepDidNotFinish` rows, split by hand into the two halves the reset is for.**
  This is the one query that only matters at *this* cut. `because` was the pass's
  field and never reached the event, so the split cannot be made by a program — but
  a person reading `detail` can tell a question from a crash, and *how many of each
  there were in two days* is the number that says whether 0068 was worth an event
  type. Nobody has it.
- **`RunFinished` turns and dollars**, summed. Unasked at every cut so far, which
  013 named as the most valuable thing the rows still hold.

## What this did not ask

Every item on the list above, and for one reason rather than four: the agent that
wrote this page cannot reach the database, and it said so rather than guessing.

Two more that are not on it, because the old databases still hold them:

- **Nothing over time.** 013 flagged this and nothing has been done about it. Three
  databases are now retained, covering roughly six weeks, and whether the pass
  rate, the spend per landed item or the fix-loop frequency improved across them is
  still unasked.
- **`PluginFailed`.** 188 of them in 013's window and nobody has read one.

## Why there is no transcript

For 013's reason and one more. The previous databases are kept and are queryable,
so nothing is lost by not copying rows here; and two days of one epic's passes is
not a thing anybody reads.

[0055](../decisions/0055-two-implementations-chosen-at-init.md) §3 is why a new
store starts empty rather than carrying rows over, and 0061 §7 is why a shape
change spends the log rather than upcasting it. **0068 §5 is where that stops being
free**: after 1.0 a split of this kind needs the discriminant on the event before
the split lands, and the answer becomes an upcaster.
