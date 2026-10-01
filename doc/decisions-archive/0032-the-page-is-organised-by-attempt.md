# 0032 — The task page is organised by attempt, and its control is the prompt

**Status** accepted · 2026-09-09 · the page half of
[doc/design/task-detail-page.md](../design/task-detail-page.md)

## Context

One page explains one work item. It is the only place a person can find out
what happened, and on 2026-09-08 five questions brought people to it:

| the question | could the page answer it |
|---|---|
| Why is this not moving? | no — the state was never stated |
| What has it cost? | no — not one figure appeared |
| What did the agent actually do? | half — the prompt was there, escaped into one line |
| How many attempts, and how did each end? | no |
| What should I do now? | no |

Half of one. The first question was asked of `#80`, `#87`, `#89` and `#94` on a
single day, and answered wrongly four times — including once where the item was
not stuck at all and would have returned by itself.

### The defect underneath

```ts
export interface TaskDetail {   // apps/board/src/lib/task.ts:99
  runId: string | null;         // ← singular. Only the most recent.
  history: HistoryLine[];       // ← every run's events, flattened into one list
}
```

`wi-lingtai-87` was claimed three times; `wi-lingtai-89` twice. **The log keeps
one stream per run and the page flattens what the log was careful to divide**,
so the only marker of which attempt a row belongs to is a uuid inside the row's
collapsed body. Diagnosing `#89` took an hour, most of it spent rebuilding that
division by hand.

Two things follow from the same flattening: gates are page-level sections
though a gate runs once *per attempt*, and nothing is ever totalled although
`RunFinished` carries `costUsd`, `turns` and `durationMs` on every run — on a
system whose entire risk is spend.

## Decision

### 1. The skeleton is the attempt

`TaskDetail` carries **runs**, not a `runId`. A ledger gives one row per
attempt, opening into that attempt's arc: its prompt, its files, its gates, its
outcome. History is grouped by run and stays whole, and last.

The log already divides them. The page agrees. Everything else follows —
money totals because there is something to total on, and a gate verdict lands
under the run that produced it.

### 2. Evidence is a pointer, not a copy

The verdict carries the single deciding line and **names the attempt it came
from**; that attempt holds the whole of it and is marked in the ledger.

Printing the failing gate twice — at the top and inside its attempt — is how
two copies of one fact come to disagree. `#100` is the same defect on the card:
a reason that exists in the log and never reaches the person.

### 3. State first, in two values

The state and **how long it has held** are the first thing on the page, as two
readings of equal weight. The duration is not an annotation on the state: *how
long you have been the bottleneck* is its own fact, and it is the one that
decides whether you act now.

### 4. The verdict block has two renderings, and degrades

Today: state, age, the question verbatim, the actions. When
[`#83`](https://github.com/steven-zhc/lingtai/issues/83) lands, a diagnosis and
a recommended action fill into the same component. **A block with no diagnosis
renders exactly as it does today** — `#83`'s own requirement, and the reason
the two are one component rather than a rewrite.

### 5. The control is the prompt, editable

A recommendation is the system's sentence about what it intends. **The prompt
is what runs.** Showing it before it is sent turns approval from *yes / no*
into *yes, but* — the answer a person usually has and today cannot give.

Three parts, and the first cannot be skipped:

- **The version names the edit.** `promptVersion` becomes
  `ticket@1924+failure@1c5708ba+human@a91f2e`, hashing the **final text** —
  hashing the diff would give one id to the same words applied to different
  bases. Unedited it falls back to today's form, so one field still answers
  *what produced this prompt* alone. Without this, two runs share a
  `promptVersion` and did not share a prompt, **and the log is lying about what
  produced a result.**
- **`PromptEdited` lives on the work item stream.** Not on the approval:
  `approve()` binds to `onSha` and a force-push voids it by arithmetic, while
  an edit is about *what to do*, not *which diff to merge*.
- **It applies to the next run only**, whoever starts it. `reduceWorkItem` sets
  `pendingPrompt`; the next `WorkItemClaimed` consumes it.

### 6. Anything durable belongs in the GitHub ticket

An instruction meant to outlive one attempt is edited into the issue body,
where it versions as `ticket@NNNN`, is visible to everyone, and is read by
every subsequent attempt.

A persistent override living only inside Lingtai would be **a shadow ticket
body** — a long-lived instruction nobody outside can see. So the two mechanisms
get one job each: `PromptEdited` says *this attempt needs an extra sentence*;
the ticket says *the instruction itself is wrong*.

This also removes a failure mode rather than mitigating one. A durable edit
would need the page to guard against a stale instruction being sent unseen; a
one-shot edit cannot go stale.

### 7. Markdown is decided by source, never by sniffing

| content | render |
|---|---|
| the ticket body — a GitHub issue body | rendered, sanitised, no raw HTML, remote images blocked |
| the prompt | **raw**; a rendered view is a toggle, and the edit box is always raw |
| gate output, `RunFailed.detail`, `RepairRequested.detail` | **never** |

A build log is not markdown: `_` becomes emphasis, `#` becomes a heading, and
`{ }` contents are eaten. **A log rendered as markdown is not that log.**

The prompt stays raw because `#88`'s justification is that the log holds the
*exact* document the agent was given, and because under §5 the edit box is what
will actually run, byte for byte.

The ticket body is **untrusted input** — anyone who can file an issue on a
managed repository writes it, and the board renders it on the operator's
origin. Its renderer needs a real sanitiser, not a hand-rolled subset.

## What this does not add

**No `blocked` lane.** `waiting` already means *will not be taken again*.
What actually reads alike is three states inside Queued — never tried, failed
and returning at a stated time, and the conductor stopped — which is `#100` and
[0016](0016-the-settled-model.md) §8's reason for not making the board wider
without making it say more.

**No two-pane investigation view.** Right for an item with fifty runs;
Lingtai's worst so far is three, and a rail listing three things should have
been a list.

## Consequences

- `TaskDetail` changes shape; `lib/task.ts` folds runs rather than a run.
- `RunPrompted` gains nothing — the prompt is already on it since `#88`. What
  changes is `promptVersion`'s grammar and a new `PromptEdited`.
- The section label carries its section's one fact, which is why there is no
  separate summary band to disagree with it.
- Times become relative and dated. `h.at.slice(11, 19)` gave a bare `HH:MM:SS`,
  so a run from three days ago read like one from ten minutes ago.
- Implemented by `#102`, `#103`, `#104` and `#106`, with `#101` sequenced into
  the first: they are one component and landing them separately means writing
  the same file twice.
