# 013 — The log before the third reset, folded rather than archived

**2026-09-27.** The log moves to a new database and starts empty for the third
time. Unlike [007](007-the-log-before-the-reset.md) and
[010](010-the-log-before-the-second-reset.md), **this one transcribes nothing.**

Those two were written because each was *the only copy*. This is not: **the old
database is kept and is still queryable**, so anything here can be asked again,
properly, against the rows themselves. What this file is for is the opposite of an
archive — it is the note that says *the rows are still there, here is roughly what
is in them, and here is what nobody has asked yet.*

At 13,481 events a transcript was not an option either. 010 held 56.

## The fold

Computed against the live log on 2026-09-27, through `log.queries` — the numbers
are read, not carried over from
[012](012-where-the-turns-go.md).

| | |
|---|---|
| events | **13,481** |
| distinct types | **51** |
| work-item streams | **184** |
| run streams | **344** |
| integration streams | 2 |
| control streams | 3 |
| project streams | 2 |

**`endedWithoutEndActions()` returns 0.** Every item that reached a terminal
resolved its `end` actions. That is the one invariant worth checking before a cut,
because the failure it would report — an item that ended and whose `end` point
silently did not run — is [0016](../decisions/0016-the-settled-model.md) §4's
shape and the thing this system is most careful about. It holds across all 184.

### Where the events are

Six types are 56% of the log.

| events | type | |
|---|---|---|
| 3,590 | `RunTouchedFile` | 27% of the log on its own |
| 1,302 | `GateStarted` | |
| 1,300 | `GateRequested` | |
| 1,009 | `IssueUpdated` | |
| 932 | `GatePassed` | |
| 521 | `RunProducedDiff` | |

The next tier, 250–500: `RunPrompted` 461, `GateFailed` 348, `WorkItemClaimed`
344, `GatesResolved` 341, `RunStarted` 341, `EndActionsResolved` 313,
`RunFinished` 303, `RunProposedCompletion` 287, `FixRequested` 261, `FixApplied`
259.

Then: `IntegrationAttempted` 198, `PluginFailed` 188, `IntegrationSucceeded` 166,
`WorkItemLanded` 166, `WorkItemBlocked` 113, `WorkItemReleased` 95,
`ApprovalRequested` 92, `WorkItemUnblocked` 73, `Reconciled` 51.

And the tail, all under 40: `ConductorStarted` 38, `ConductorShutdownRequested`
37, `RunFailed` 36, `FixDeclined` 33, `IntegrationRefused` 32, `ApprovalGranted`
31, `OutboxDelivered` 31, `ConductorResumed` 24, `RunRefsPublished` 22,
`PassRestarted` 19, `RepairRequested` 18, `WorkItemClosed` 16,
`ConductorShutdownWithdrawn` 14, `RepairDeclined` 10, `ConductorPaused` 9,
`RunRequested` 9, `DiscussionAnswered` 7, `DiscussionAsked` 7,
`DiscussionRequested` 7, `GateWaived` 5, `ProjectRecovered` 5, `ProjectRefused`
5, `GateDidNotFinish` 4, `PassRouted` 3, `ProjectConfigured` 3,
`ApprovalRevoked` 2.

### Four things the ratios say, and each is a question rather than a finding

**`RunTouchedFile` is a quarter of the log.** 3,590 across 344 runs — about ten
files a run. It is the only type whose volume is a function of diff size rather
than of anything the pipeline decides, and it is the first place to look if the
log's size ever becomes the problem.

**Gate verdicts were 73% pass.** 932 passed against 348 failed. That is the ratio
the fix loop and the cold reviewer were arguing about all month; whether it moved
over time is exactly the question this fold cannot answer and the old database
can.

**The fix loop ran often.** `FixRequested` 261 against 344 runs. `FixApplied` 259
and `FixDeclined` 33 do not sum to it, which means the three are not one-per-fix
and the relationship needs reading rather than dividing — flagged here so nobody
divides.

**`PassRouted` is 3.** It landed on 2026-09-27 (`#271`), hours before this cut, so
the new log starts with routing traceable from its first event. That is the one
number here that is small because the feature is new rather than because the thing
is rare.

## What this did not ask

Named so that a later analysis knows what to go back to the old database for, and
so that nobody mistakes this page for having asked it:

- **Nothing over time.** Every number is a total. Whether the pass rate, the spend
  per landed item, or the fix-loop frequency improved across the month is
  unasked, and it is the most valuable thing the rows still hold.
- **No money.** Turns and dollars are in `RunFinished` payloads and were not
  summed. [012](012-where-the-turns-go.md) did this for a window; nobody has
  done it for the whole log.
- **No per-ticket outcome.** 166 `WorkItemLanded` against 184 item streams, and
  which 18 did not land — and why — is not here.
- **`PluginFailed` 188 was not read.** That is a subscriber or an extension
  failing, 188 times, and no one has looked at what they were.
- **The 41 runs with no `RunFinished`.** 344 run streams, 303 `RunFinished`. The
  difference is runs that were killed, timed out, or crashed, and the shape of
  those is unexamined.

## Why there is no transcript

The old database is not deleted. Nothing is lost by not copying it here, and a
copy would have been worse: 13,481 rows in a markdown file is not a thing anybody
reads, and it would have made this page look like the answer to questions it
never asked.

[0055](../decisions/0055-two-implementations-chosen-at-init.md) §3 is why the new
store starts empty rather than carrying the rows over — choosing a different store
begins a new log, deliberately. The rename it unblocks is
[#247](https://github.com/steven-zhc/lingtai/issues/247): the eight `Gate*` event
types, which could not move while a log held payloads under their old names.
