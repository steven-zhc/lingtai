# The task detail page, settled

**Status** settled · 2026-09-09 · the design the tickets implement

Mockups exist at fidelity, drawn against `wi-lingtai-89` as it stood at 04:12
UTC in the board's own palette and faces. They are a private artifact rather
than a file here — a picture of a decision, not the decision.

## What people arrive to ask

Not guessed. Taken from every time this page was opened, or wanted and not
opened, during 2026-09-08:

| the question | can the page answer it today |
|---|---|
| **Why is this not moving?** | no — the state is never stated |
| **What has it cost?** | no — not one figure appears |
| What did the agent actually do? | half — the prompt is there, escaped into one line |
| **How many attempts, and how did each end?** | no |
| What should I do now? | no |

Five questions; half of one answered.

## The structural defect

```ts
export interface TaskDetail {   // lib/task.ts:99
  runId: string | null;         // ← singular. Only the most recent.
  history: HistoryLine[];       // ← every run's events, flattened into one list
}
```

`#87` was claimed three times, `#89` twice. **The log keeps one stream per run
and the page flattens what the log divided**, so every reader rebuilds that
division by hand. Two things follow: gates are page-level sections though a
gate runs once *per attempt*, and nothing is ever totalled although
`RunFinished` carries `costUsd`, `turns` and `durationMs` on every run.

## The page, in two halves

**A decision column** — no frame, marked by a single amber rule, ending in the
thing that will actually run:

```
┃ BLOCKED │ 4h 12m
┃ waiting on you · since 04:12 UTC        from attempt 2 of 2 · run-706151d7
┃ ────────────────────────────────────────────────────────────────
┃ <the question, verbatim — a diagnosis and a recommendation once #83 lands>
┃ ▍proposed / build · exit 2   error TS2741 …          in attempt 1 ↓
┃ ┌ WILL BE SENT ─────────┐  ┌ DISCUSSION ───────────┐
┃ │ the prompt, editable  │  │ reads log and code    │
┃ └───────────────────────┘  └───────────────────────┘
┃ [Send attempt 3]  [Reject]  [Leave blocked]
```

**A record**, organised the way the log already is:

```
TICKET      #89 · bug · 2,140 bytes
ATTEMPTS    2 attempts + 3 discussions · 147 turns · 23m 25s · $14.10
HISTORY     36 events · grouped by run
```

## The decisions, and why

### 1. The skeleton is the attempt

The ledger, and the history grouped by run. The log already divides them;
the page agrees. Everything else follows — money totals because there is
something to total on, and gates land under the run that ran them.

### 2. Evidence is a pointer, not a copy

The verdict carries the one deciding line and names the attempt it came from;
that attempt holds the whole of it. Printing the failing gate twice is how two
copies of one fact come to disagree.

### 3. The verdict has two renderings, and degrades

Today: state, age, the question verbatim, the actions. Once `#83` lands, two
fields fill into the same component. **A block with no diagnosis renders
exactly as it does today** — `#83`'s own requirement.

### 4. The control is the prompt, editable

A recommendation is the system's sentence about what it intends; the prompt is
what runs. Editing it turns approval from *yes / no* into *yes, but*.

- **The version names the edit** — `ticket@1924+failure@1c5708ba+human@a91f2e`,
  hashing the final text. Unedited, it falls back to today's form. One field
  still answers "what produced this prompt" alone.
- **`PromptEdited` on the work item stream.** A force-push voids an approval by
  `onSha` arithmetic; the edit outlives it, because an edit is about *what to
  do*, not *which diff to merge*.
- **It applies to the next run only**, whoever starts it. Something meant to
  last belongs in the GitHub ticket, where everyone can see it and it versions
  as `ticket@NNNN`. A durable override living only inside Lingtai is a shadow
  ticket body.

### 5. The discussion assistant is a third kind of agent

Not a run agent, not a gate agent. Scoped to one work item, and its conclusion
is one of the two artefacts §4 already defines — an edit for the next run, or
an addition to the ticket. It introduces no third carrier.

- **Reads the log, the ticket, and files from the mirror** (`main` and the
  attempt's branch). **No command execution.** Commands would make it a run,
  and runs have worktrees, hooks and gates for reasons.
- **Hosted by the daemon**, requested over `ctl-conductor` like `pause` and
  `now`. [0013](../decisions/0013-daemon-hosts-the-work.md)'s line does not
  move.
- **No spend limit; a meter instead.** A run is unattended and needs a hard
  bound; a discussion is attended and the person is the loop. But a person can
  only be the limit if the person can see the number, so the running cost is on
  screen and the total is in the ledger.
- **The conversation is its own stream** (`chat-<id>`); the work item gets one
  `DiscussionHeld { chatId, costUsd, outcome }`. The ticket's history grows by
  two lines, not forty, and no money is spent without a record.

### 6. Markdown by source, never by sniffing

| content | render |
|---|---|
| ticket body — a GitHub issue body | **rendered**, sanitised, no raw HTML, remote images blocked |
| the prompt | **raw by default**; the log's copy is the record and the edit box is raw text |
| gate output, `RunFailed.detail`, `RepairRequested.detail` | **never** — markdown eats `_`, `#` and `{}`; a log rendered as markdown is not that log |

A build log is not markdown. The rule is per-source, and a hand-rolled subset
renderer is the wrong tool for an untrusted issue body.

### 7. What the page must not pretend

- **The assistant says what it cannot do.** Reading the bundle reaches
  "`error_max_turns` is among the subtypes" and no further; proving the binary
  accepts a flag needs a command it does not have. Guessing from `--help` is
  what cost `#89` two attempts and cost this session an hour.
- **An attempt may have left no branch.** `worktree.ts` resets it with `-B` on
  every run, and an attempt that committed nothing never had one. The assistant
  must say *"attempt 2 left no branch; I am reading main"* — that blind spot is
  what killed the repair, and it must not be reproduced silently.

## Not in this design

- **No `blocked` lane.** `waiting` already means *will not be taken again*.
  What reads alike is three states inside Queued, which is `#100`.
- **No two-pane investigation view.** Right for an item with fifty runs;
  Lingtai's worst so far is three.

## Layout notes worth keeping

- The decision column has **no frame** — one amber rule states its extent.
  Inside it only two objects are boxed: the outgoing prompt and the discussion.
- **Amber appears once per screen.** It means "a human is being waited on" and
  a second decorative use dilutes it, so every divider is neutral.
- Section labels are display-scale mono caps with the section's one fact at the
  right of the same rule — which is why there is no separate summary band.
- The prose measure stays. Documents and logs may break it; paragraphs may not.

## What 2026-09-10 added

Four things, found in one afternoon on this repository's own tickets, each by
somebody who had to be told where to look. The draft is at
`claude.ai/code/artifact/4e5641f9-1f6b-49ae-a371-4e33785e357c` — again a
picture, not the decision. **#132** is the work.

One judgement behind all four:

> **What the page already has must appear at the moment it is needed, rather
> than waiting to be found.**

**The block ranks: state · reason · move · coordinates.** The reason is new. It
sits second, and it is **the gate's own evidence, quoted, never paraphrased** —
the page names who said it and gets out of the way. A summary may sit under the
quote; it may not stand in for it.

*A gate's name is not a reason.* On `#121` the block said `the review gate
refused it`, which reads as *a reviewer read this diff and found problems*; the
reviewer had never started. `the build gate refused it` is worth less than
`pnpm typecheck && pnpm test exited 1 after 117.0s`, for every gate, every time.

**This is not a stylesheet change.** `run-once.ts`'s `diagnosis` carries
`raw: null` with a comment saying the verdicts are on the task's own page with
their evidence — true, three ranks down and behind a disclosure. The block does
not have the words to quote, so it says the only thing it has.

**A running attempt is a different object from a finished one.** It opens on
load and its run log opens with it, following. Only the running one: `#110`'s
reason for closing them — *a page with six attempts would otherwise follow six
files nobody asked to see* — is right and survives.

**The discussion answers as it writes.** `discussion.tsx` awaits one value
behind a `busy` flag, so the whole reply appears when the agent exits. That is
the defect [0034](../decisions/0034-the-run-log.md) opens with, solved for runs
and not for discussions — and a discussion is where silence costs most, because
[0033](../decisions/0033-the-third-kind-of-agent.md) §4 makes *the person the
loop*. A loop with no feedback is one where sixty seconds of thinking is
indistinguishable from death, and the answer is to ask again and pay twice.

**The pair gets one fixed height and each pane scrolls inside it.** Not
alignment: the moves sit under both, so a pane that grows with its content
pushes the button you are deciding with off the screen — a long conversation
costing you the decision it was meant to inform.
