# The task detail page, redesigned

**Status** proposal · 2026-09-09 · three directions, for choosing between

Mockups exist for all three, drawn at fidelity against `wi-lingtai-89` as it
stood at 04:12 UTC, in the board's own palette and faces. They are a private
artifact rather than a file here: they are for choosing between and are thrown
away once one direction wins.

Not an ADR. An ADR records a decision; this asks for one. What is settled here
is the problem and the evidence; the three directions are alternatives and at
most one survives.

## The job

One page explains one work item. It is the only place in Lingtai where a person
can find out what happened, and everything on it is folded from the event
stream when the page opens — nothing is maintained in a table
([0012](../decisions/0012-one-task-view.md)).

## What people actually arrive to ask

Not guessed. Taken from every time this page was opened, or wanted and not
opened, during the session of 2026-09-08:

| the question | how often | can the page answer it |
|---|---|---|
| **Why is this not moving?** | `#80` `#87` `#89` `#94` | **no** — the page never states the item's state |
| **What has it cost?** | `#84` ($26.53), `#89` ($13.04 over two runs) | **no** — not one figure appears |
| What did the agent actually do? | every investigation | half — the prompt is there, escaped into one line (`#101`) |
| **How many attempts, and how did each end?** | `#87` (3 claims), `#89` (2) | **no** — see below |
| What should I do now? | every blocked item | **no** |

Five questions; the page answers half of one.

## The structural defect: there is no run on this page

```ts
export interface TaskDetail {   // lib/task.ts:99
  runId: string | null;         // ← singular. Only the most recent.
  ...
  history: HistoryLine[];       // ← every run's events, flattened into one list
}
```

`wi-lingtai-87` was claimed three times; `wi-lingtai-89` twice. Their events
interleave into a single 30–80 row list, and the only marker of which attempt a
row belongs to is a 36-character uuid inside the row's collapsed body.

**The log keeps these separate — one stream per run.** The page flattens what
the log was careful to divide, and recovering the division is manual work every
reader repeats. Reconstructing it by hand is where most of the time went
diagnosing `#89`.

Two consequences follow from the same flattening:

- **Gates and Verdicts are page-level sections**, but a gate runs once *per
  attempt*. Attempt 1's failing `proposed` and attempt 2's have nothing to do
  with each other, and sit in one list.
- **Nothing is ever totalled.** `RunFinished` carries `costUsd`, `turns` and
  `durationMs` on every run. The page shows none of them, individually or
  summed — on a system whose entire risk is spend.

## What the page has to work with

Already on the log, already loaded, currently unused:

`costUsd` · `turns` · `durationMs` · `exitCode` · `failure.kind` ·
`failure.detail` · `RunTouchedFile` (path, op) · `RunPrompted.prompt` (since
`#88`) · `promptVersion` · `WorkItemClaimed.worker` · `RepairRequested.reason`
· `WorkItemBlocked.question` · every gate verdict with its `onSha`

Nothing below needs a new event.

## Three directions

Each organises the same facts differently, and each is best for a different
reader. They are alternatives, not layers.

### A — Attempts

The skeleton is the attempt. A status banner states the item's state and the
action; the ticket follows; then a ledger — *2 attempts · $13.04 · 147 turns ·
23m* — with one row per run that opens into that run's whole arc: its prompt,
its files, its gates, its outcome. History stays at the bottom, unchanged.

*Best for* understanding a history. *Costs* height, and a fresh item with one
attempt carries scaffolding it does not need.

### B — Triage

The page opens as an answer, not a record. A verdict block states in one
sentence what is wrong, what was done, and what is recommended, with the action
as the primary control and the failing evidence inline beneath it. Attempts are
a compact strip; history is collapsed.

*Best for* clearing a queue of blocked cards quickly. *Costs* depth — an
investigation needs two more clicks than in A, and the summary has to be right
or it is worse than no summary.

### C — Investigation

Two panes. A left rail lists the item and each run; the right pane is whatever
is selected, in full. Selecting a run scopes the history to that run rather
than filtering a global list.

*Best for* deep investigation and comparing two attempts. *Costs* the
single-scroll reading of the page, and it is the most work to build.

## Settled regardless of which direction wins

- **State first.** Whatever the layout, the item's state and its reason are the
  first thing on the page, not something inferred from the last row of a list.
- **History stays whole, and last.** It is *"what actually happened, in order,
  with who did it"*. Structure may lead a reader to it; nothing may replace it.
- **Documents render as documents** (`#101`) — real newlines, collapsed,
  allowed to break the 62rem measure that the prose keeps.
- **Times are relative and dated.** `h.at.slice(11, 19)` gives a bare
  `HH:MM:SS`: a run from three days ago is indistinguishable from one ten
  minutes old.
- **Money is shown.** Per attempt and totalled.

## The decision this asks for

1. Which direction — A, B or C.
2. Whether gates move under the attempt that ran them, or stay page-level. This
   is the largest single change and it is what makes A and C possible.
