# 0033 — The third kind of agent: one that reads, and cannot run

**Status** accepted · 2026-09-09 · extends
[0007](0007-dual-runtime.md)'s containment argument to an agent that needs none
of it

## Context

Lingtai dispatches agents in two shapes today, and both are containers:

- **the run agent** — a disposable worktree, a filtered environment, a
  fail-closed hook on every tool call, and five gate points around it
- **the gate agent** — a reviewer, given a diff and asked for a verdict

There is no shape for *asking a question about what happened*. When an item is
blocked, the only thing a person can do is read the log themselves. Diagnosing
`#89` on 2026-09-08 took an hour — reading events, then `claude-code.ts`, then
one test fixture — and the conclusion was four lines long.

The obvious answer is a discussion, scoped to one work item. The reason it
needs a decision rather than an implementation is that **it is a third kind of
agent**, and the two that exist are defined by their containment.

## Decision

### 1. It reads. It does not run.

Its inputs are the log, the ticket, and **files from the mirror** — `main` and
the attempt's branch. It has no worktree, no hook, and **no command
execution**.

The line is drawn there because a command is what makes a run a run. The
worktree exists so an agent's writes are disposable; the hook exists so a tool
call is refusable; the gates exist so nothing it produced reaches `main`
unchecked ([0007](0007-dual-runtime.md)). An agent that only reads needs none
of those, and an agent that executes needs all of them — so allowing commands
would not extend this shape, it would make it the first one under a different
name.

The cost is real and is accepted: reading files answers most of `#89` and
cannot answer *"does the binary accept `--max-turns`?"* — see §5.

### 2. Its conclusion is one of two artefacts that already exist

**Use for the next run** → `PromptEdited` ([0032](0032-the-page-is-organised-by-attempt.md) §5).
**Add to the ticket** → the issue body, which versions as `ticket@NNNN` (§6).

It introduces no third carrier for an instruction. A discussion is a way of
arriving at one of the two things a person could already have written; it does
not create a new kind of thing to write.

### 3. The daemon hosts it

The board requests it over `ctl-conductor`, the stream `pause` and `now`
already use; the daemon starts the agent.
[0013](0013-daemon-hosts-the-work.md)'s line — *the daemon holds the work, the
UI controls it* — does not move.

It is arguable the other way. Two of 0013's three reasons (an orphaned
worktree, a claim somebody waits out) do not apply to a read-only agent, and
the board already streams over SSE ([0008](0008-nextjs-board.md)). What decides
it is the third reason: it spends money, and everything that spends money in
this system starts in one place, where the accounting already is.

### 4. No spend limit — a meter instead

A run is unattended and needs a hard bound; a discussion is attended, and the
person is the control loop. That asymmetry is the justification, not
convenience.

**But a person can only be the limit if the person can see the number.** So the
running cost is on screen while the conversation happens, and the total reaches
the ledger. Without the meter, "the human is the limit" is a limit that cannot
see what it is limiting.

### 5. It says what it cannot do

Reading the shipped bundle gets as far as *"`error_max_turns` is among the
result subtypes"*. Proving the binary **accepts** the flag needs a command it
does not have, and it must say so rather than conclude.

This is not a nicety. `#89` cost two attempts and $13.04 because
`--max-turns` is absent from `claude --help` and present in the binary, and
because two agents in a row concluded absence from the help text meant absence
from the CLI. **An assistant that repeats that inference is worse than no
assistant**, because it would launder a guess into an answer.

The same rule covers the second known blind spot: `worktree.ts` resets an
attempt's branch with `-B` on every run, and an attempt that committed nothing
never had one. Asked about such an attempt it must say *"attempt 2 left no
branch; I am reading main"* — reading `main` silently is precisely what killed
the repair it is being asked to explain.

### 6. The conversation is its own stream

`chat-<id>` holds the exchange. The work item gets **one** event:
`DiscussionHeld { chatId, costUsd, outcome }`.

Both halves matter. A forty-turn exploration appended to the work item would
drown the history that the detail page exists to show, and the log is
append-only, so it would drown it permanently. But discarding the conversation
would leave *"why does this prompt say that?"* unanswerable and — given §4 —
money spent with no record. The pointer keeps the ticket's history at two lines
and loses nothing.

## What this does not decide

- **Cross-ticket discussion.** This one is scoped to a work item, and the
  evidence it reasons over is that item's.
- **Writing to the repository**, or starting runs of its own. Each is a
  separate decision, and each would move the line in §1.
- **Whether the containment in §1 is enough for a repository Lingtai does not
  own.** Reading `main` of a managed repository is reading code somebody else
  wrote; that is already true of every run agent, but this is the first agent
  whose *only* capability is reading it.

## Consequences

- A third actor appears on the log: `agent:chat-<id>`.
- `ControlState` folds a request shape it does not have today.
- The ledger on the task page counts discussions beside attempts —
  `2 attempts + 3 discussions · $14.10` — because they come out of the same
  budget and hiding one of them would misstate the other.
- Implemented by [`#105`](https://github.com/steven-zhc/lingtai/issues/105).
