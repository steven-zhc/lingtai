# Lingtai

An event-sourced scheduler for autonomous code agents, which runs on itself:
tickets here are worked by agents Lingtai dispatched.

**[doc/architecture.html](doc/architecture.html)** answers *which process am I
in* — four diagrams: the processes that exist, who appends to the log, who is
told when it changes, and where each piece of state lives. Read it before
changing anything that crosses a process boundary.
[doc/README.md](doc/README.md) indexes the ADRs, which are append-only in
spirit: a decision that turns out wrong gets a superseding file, not an edit.

## The log settles it

Behavioural claims are settled by reading `events`, not by reasoning about the
code. A finding that cites a seq number is worth more than one that argues.

`task_view` is the one projection, and the way to correct it is
`lingtai projection rebuild task_view` — replay, never a repair by hand. It is
now a fold and nothing else: the outbox and the queue cache are gone (0022), so
nothing writes to it but the projection.

## Opening an issue

An issue needs a **kind** label or the queue never sees it. The recipe's
`source.kinds` in `.lingtai/config.yaml` decides which — currently `bug`,
`tech-debt`, `feature`. The other labels in this repo (`enhancement`,
`documentation`, …) are invisible to the conductor.

Add **`agent:hold`** unless you mean an agent to take it now. Self-hosting runs
one unheld ticket at a time, so an unheld ticket is one you are asking the next
queue pass to claim.

The body becomes the agent's prompt, so it is written to be worked from rather
than filed. House style, as in #52, #55, #58:

- Lead with the evidence — the seq numbers, the log excerpt, the exact output.
- Say **why it stayed hidden**, when it did. That is usually the real finding.
- Cite `file.ts:line`, and quote the comment or doc that makes the claim.
- `## Done when`, as checkboxes each of which a person or a test can check.
- `## Related`, saying what the related ticket *decided* — not just its number.

## Running Lingtai on Lingtai

Pass `--no-merge`, by hand, every time. The `merge` gate point does not execute
(#58), so a run without the flag merges itself into `main` unapproved.

The board follows a bare `lingtai run` live: **every process that appends holds
a projector while it runs** (0022), so there is nothing to start in a second
terminal and nothing to wait for at the end. The chip in the bar says whether
that is actually true — it reports the projection's lag and the daemon's
beacon, not whether the socket is open, which is the distinction #64 turned on.
A second chip appears beside it while the conductor is paused, naming who and
why with a Resume on it: being current and being stopped are independent facts,
and for four days the board only said the first (#77).

A daemon is still what takes work unattended, and it is the *only* other
conductor: `lingtai run` takes the same advisory lock the daemon does (#93), so
one conducts at a time and the second is turned away rather than racing for the
same ticket. Beside a pass already in flight,

    pnpm lingtai daemon --no-conduct

exits immediately with `another daemon holds the lock — nothing to do`. It used
to be described here as safe, on the grounds that two projectors on one log
converge — which is true, and is not what the lock is about. There is nothing
to start anyway: the run in flight is already holding a projector.

**A running daemon holds the code it started with.** 0010's *the source runs
unbuilt* removes the build, not the restart: Node caches a module at import, so
a merge into `main` reaches the CLI, the gates, the board and the recipe and
does not reach the process that is conducting. `#88` landed thirty-nine minutes
after a daemon started and never once ran, costing 52 prompts (#98). The beacon
now carries the commit the daemon started at; `lingtai doctor`'s
`daemon: currency` and a chip on the board say how far behind `origin/main` that
is. Neither restarts it — that is still yours, and whether it should be is open.

**The restart is now safe to perform** (0030). `pnpm lingtai shutdown "why"`
appends, returns, and the daemon finishes the pass in flight before it exits —
the pass, not the agent, so the gates and the merge lane run too. That waits as
long as `runtime.limits.wall`, `1h` here, and the command says so rather than
looking hung. Ctrl+C does the same and tells you what a second one costs;
`lingtai resume` lifts a request nothing acted on. An agent left behind by a
second Ctrl+C or a `--timeout` is killed by the next conductor before it
releases the claim, guarded on the host and the process's own argv.

**What a run is doing, while it does it**, is `pnpm lingtai attach <runId>`, or
the *run log* inside that attempt's row on the task page. Both are a tail of
`~/.lingtai/runs/<project>/<runId>.log` (0034) and both start at the beginning
however late you arrive. Neither asks the daemon or the database anything, so
they answer on a stopped system — and a run that landed has no log, because the
file is kept only while something is still owed an explanation. It is a trace
and never a record: what happened is `lingtai status` and the board, off
`events`.

The board's Queued column asks GitHub on render; every other column is the
fold.

The suite appends real events and refuses to run without
`LINGTAI_TEST_DATABASE_URL`. `LINGTAI_DATABASE_URL` is this system's own log,
and an agent is never given it. **Every name Lingtai reads for itself begins
`LINGTAI_`** (#63) — a project's own file keeps its own names, so `DATABASE_URL`
there is the project's application, never this one.

## Commits

One line, lower case, stating what is now true rather than what was done —
`fix(end): the point runs on every outcome, not just an inline merge`. An ADR
lands as `NNNN: <the decision, as a sentence>`. `git log` is the reference.
