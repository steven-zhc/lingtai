# 0034 — A run leaves a log you can watch, and it is a trace, not a record

**Status** accepted · 2026-09-09

## Context

There is no way to see what a running agent is doing. `#105` ran for four
minutes and the only observable was `ps`.

Three facts decide the shape of the answer.

**The agent produces nothing until it exits.** `claude-code.ts` accumulates:

```ts
stdio: ["ignore", "pipe", "pipe"],
let out = "";
child.stdout.on("data", (c: Buffer) => (out += c.toString()));
```

and `--output-format json` emits one object at the end regardless. Attaching to
that today shows a blank screen until the process is over.

**The hook socket already sees every tool call, live.** `hook-socket.ts` runs on
each `PreToolUse` and already calls `options.onDecision?.(...)`. Nothing
consumes it for display. The events it produces are deliberately *not* appended
as they happen — `run.touched` is buffered and flushed at the end, because the
board wants what the agent changed rather than every read it made.

**So a live picture exists and is thrown away**, while the thing people assume
they want — the agent's prose — is the part that needs a format change.

## Decision

### 1. A run has a log file, and the conductor names it

```
~/.lingtai/worktrees/<project>/<runId>/     already
~/.lingtai/runs/<project>/<runId>.log       new
```

The same shape, deliberately: `reconcile` already walks
`join(home, "worktrees")` as `<project>/<runId>`, so reaping the second is the
same code in the same function rather than a second mechanism.

**The conductor decides the path; the adapter is handed it** as
`RunRequest.logPath`, beside `cwd`, `env` and `settingsPath`.
`packages/agent` does not learn the home layout — that is the seam 0022 drew,
and a runtime adapter that knows where `~/.lingtai` is has crossed it.

### 2. Not in the worktree

The worktree was the obvious home and is the wrong one, for two reasons that
are both fatal.

**It is removed before the merge.** `run-once.ts:681` is a scoped release, and
its comment says why it cannot be relaxed: *"the worktree holds `agent/<n>`
checked out against the same mirror, and git refuses to update a ref some
worktree has checked out."* So a log inside it dies **before the run has an
outcome** — and the log worth reading is always the one from the run that just
failed.

**The agent commits from it.** `packages/repo` contains no `git add`; the agent
does its own committing, and one running `git add -A` sweeps its own log into
the diff, through the review gate and onto `agent/<n>`.

Neither applies to the daemon writing outside the checkout. **The daemon owns
the child's stdout, so the file has no reason to be in the tree at all.**

### 3. The content is a composed trace, not a pipe

The file carries the hook socket's live view — each tool call, its decision,
each lifecycle hook — **and** the agent's own output where the runtime offers
it. It is written by the process that already sees both.

This is what makes the file useful before anything else changes. The tool-call
trace answers *what step is it on* today, from a signal already arriving:

```
14:22:31  Read   packages/agent/src/claude-code.ts
14:22:39  Edit   packages/agent/src/claude-code.ts
14:22:41  Bash   pnpm typecheck
```

The agent's prose joins it when the output format changes, which is its own
decision because it rewrites the path that produces `RunFinished`.

### 4. The keep-or-delete decision happens where the worktree is removed

`run-once.ts:681` runs on **every** outcome — landed, failed, crashed. It
already deletes the worktree there. It gains one more judgement:

> **Landed → delete. Did not land → keep.**

The diff is on the branch and the events are on the log, so an agent's prose
about a successful run has the least marginal value of anything here. What is
kept is exactly the investigable set, and **the rule needs no timer, no sweeper
and no retention period.**

The cost is real and accepted: `#84` cost $26.53 and, once landed, what it was
thinking is gone. The diff and the events remain.

### 5. A work item reaching a terminal state takes its logs with it

These files exist to explain *why an item is not done*. When it lands and its
issue closes, there is nothing left to explain.

### 6. `reconcile` reaps what the release missed

A daemon killed mid-run never reaches §4, so the file lingers — the same
failure that leaves an orphaned worktree, caught at the same moment by the same
pass.

Its existing rule applies verbatim, and must:

> a worktree whose run never got as far as saying what it was for is **a
> mystery, and deleting mysteries is how you stop being able to explain them**

A log file with no run stream behind it is reported, not removed.

### 7. Mode 0600, and a size cap that is written down

The file holds **whatever the agent printed** — values it read from its
environment, contents of files it opened. Today that output is parsed and
discarded; persisting it is a **new exposure**, and `agent-env` already sets
the standard with `ENV_FILE_MODE = 0o600`.

A single run can produce tens of megabytes once the agent's own stream is in
it, so the file is capped and says in itself where it was truncated.

**That number goes into `doc/reference.md`'s policy section on the day it is
written.** `#96` was filed because `DIFF_LIMIT_BYTES`, `EVIDENCE_CHARS` and
four others decide behaviour and appear in no document. This is the first such
constant added after that finding, and it does not get to repeat it.

### 8. It is a trace, not a record

**Decisions live on the event log, and only there.** This file explains; it
never settles. Nothing may read it to determine what happened — that is what
`events` is for, and a second source of truth is what the outbox was deleted
for ([0022](0022-the-seams.md)).

The distinction has a test: if some behaviour would change depending on the
file's contents, the design is wrong.

## Consequences

- `RunRequest` gains `logPath`; the adapter writes, the conductor chooses.
- `reconcile` gains a fourth thing to walk, in the shape of the first.
- `lingtai attach <runId>` becomes a tail, and the board's live view a tail over
  the SSE it already has — neither needs a new protocol.
- The hook socket's `onDecision` and `onLifecycle` gain their first consumer.
- Changing `--output-format` to `stream-json` is **not** decided here. It
  rewrites the parse path that produces `RunFinished`'s turns and cost — the
  accounting — and `#89` is recent evidence for how exacting that path is.
