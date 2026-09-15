# Lingtai

An event-sourced scheduler for autonomous code agents, which runs on itself:
tickets here are worked by agents Lingtai dispatched.

**[doc/architecture.html](doc/architecture.html)** answers *which process am I
in* — four diagrams: the processes that exist, who appends to the log, who is
told when it changes, and where each piece of state lives. Read it before
changing anything that crosses a process boundary.
**[doc/the-pass.html](doc/the-pass.html)** answers the other question —
*where does a refusal go* — one pass from `claim` to `end` with the five points
on it. It draws 0039 — built on 2026-09-11, so it is the code and not a
proposal — and marks what it replaced. Both drawings come from
`scripts/the-pass.py`; the HTML is generated.

[doc/README.md](doc/README.md) indexes the ADRs, which are append-only in
spirit: a decision that turns out wrong gets a superseding file, not an edit.

## The log settles it

Behavioural claims are settled by reading `events`, not by reasoning about the
code. A finding that cites a seq number is worth more than one that argues.

There are two projections, `task_view` (the board) and `finding_backlog` (the
minors passing gates raised, #137), and the way to correct either is
`lingtai projection rebuild <name>` — one rebuild per projection, since each has
its own table and checkpoint; replay, never a repair by hand. Both are folds and
nothing else: the outbox and the queue cache are gone (0022), so nothing writes
to them but the projection.

## Opening an issue

An issue needs a **kind** label or the queue never sees it. The recipe's
`source.kinds` in `.lingtai/config.yaml` decides which — currently `bug`,
`tech-debt`, `feature`. The other labels in this repo (`enhancement`,
`documentation`, …) are invisible to the conductor.

Add **`agent:hold`** unless you mean an agent to take it now. Self-hosting runs
one unheld ticket at a time, so an unheld ticket is one you are asking the next
queue pass to claim.

**A chain goes in GitHub's own *blocked by*, never in the body.** The queue
orders by kind and then by number, so a dependent ticket of a higher-priority
kind is taken first — `#123` was, ahead of the two `feature` tickets it needed,
with the chain sitting in `#126`'s body as a table for people to read (#131).
The queue passes over anything with an open blocker and counts it as
`blocked-by`; a closed one holds nothing, and the ticket comes back on its own
the pass after the last blocker closes, with no hold to remove.

The body becomes the agent's prompt, so it is written to be worked from rather
than filed. House style, as in #52, #55, #58:

- Lead with the evidence — the seq numbers, the log excerpt, the exact output.
- Say **why it stayed hidden**, when it did. That is usually the real finding.
- Cite `file.ts:line`, and quote the comment or doc that makes the claim.
- `## Done when`, as checkboxes each of which a person or a test can check.
- `## Related`, saying what the related ticket *decided* — not just its number.

## Running Lingtai on Lingtai

**This repository merges its own work unattended, and that is configuration
rather than a gap.** `gates.merge` is `[]` — nothing is declared there, so
nothing holds. Declare a `human:` action there and the point runs it: #58 was
fixed, and the test that pins it is `conductor/test/run-once.test.ts`'s *holds
at a human action at the merge point, with no --no-merge anywhere*, which
asserts the base branch does not move. `--no-merge` remains the way to hold a
run whose recipe asks for nothing.

So the question to ask before a run is not *did I pass the flag* but *what does
`merge:` say today*, and `lingtai add` prints the answer.

The one exception is at `proposed`, not `merge`: the `tamper` watch (#31) holds
any diff touching a workspace package the conductor or the CLI loads, the board
(which appends a person's approval), a `package.json`, the lockfile, the workspace file, a `tsconfig`, a vitest config,
or `.lingtai/config.yaml` itself — including a file moved out of one of those —
so an agent cannot weaken its own gates in one merge.

The board follows a bare `lingtai run` live: **every process that appends holds
a projector while it runs** (0022), so there is nothing to start in a second
terminal and nothing to wait for at the end. The health dot in the bar says
whether that is actually true — it reports the projection's lag and the daemon's
beacon, not whether the socket is open, which is the distinction #64 turned on.
Green and silent is the whole of the ordinary case; when it is not, the sentence
beside it carries the fault and the command that fixes it. A chip appears next
to it while the conductor is paused, naming who and why with a Resume on it:
being current and being stopped are independent facts, and for four days the
board only said the first (#77).

The bar answers two questions and no third — *is anything waiting on me?* and
*is the system doing what the code says?* — and carries four objects to do it
(#134, [doc/design/the-bar.md](doc/design/the-bar.md)). **A chip is not free,
and the row is the unit**: it reached eleven objects because six tickets each
added one true fact and none of them argued about the row. Spend and the pass
limits are on `/spend`, one click from the reading.

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
`daemon: currency` and the board's health dot say how far behind `origin/main`
that is — the same dot #64 put there, because *is this current* and *is it
running the code we merged* are one question to a reader (#134). Neither
restarts it, and a daemon still does not restart itself when `main` moves; what
closed is the gap between noticing and acting:

    pnpm lingtai restart "picking up #88"

**One command drains, waits and starts** (0042). It refuses first and drains
second, because a refusal after the drain is a system that is down: a `HEAD` the
tracking remote does not have is refused by name, and nothing overrides that — a
process holds its code for hours, and `582a0f8` was rebased out of existence
twenty minutes after a daemon started from it. A dirty worktree is named in the
same refusal (`--dirty`), `lingtai doctor` has to pass (`--despite-doctor`,
except for a failure whose own remedy is the restart), and a drain somebody else
asked for is theirs to lift. In a terminal the commit and worktree are checked
again after the wait; under `lingtai service` they are not — the supervisor's
respawn starts whatever is on disk the moment the old daemon exits, so a pull
during the drain is not refused, and the restart only exits non-zero afterwards
when the commit that started is not the one it checked. Nothing is withdrawn between the drain and the start (0045): a daemon
reads the control stream from its own start, so a restart is `shutdown` and then
`start` in control state. Where `lingtai service` keeps the daemon, the start is
the supervisor's: the restart's request carries a handoff naming the checked
commit, and the restart runs `service start` and waits for the start to be
recorded — a terminal daemon beside a supervised one would be two conductors
taking turns. Every start that takes work appends `ConductorStarted` with who,
why and the commit, so *who restarted it at 23:06* is a question the log
answers. What makes it never two daemons is still the lock, not the ordering:
if something else takes it first the restart starts nothing and exits non-zero,
and `lingtai doctor` says whether a daemon is up.

**The drain underneath it is safe on its own** (0030). `pnpm lingtai shutdown
"why"` appends, returns, and the daemon finishes the pass in flight before it
exits — the pass, not the agent, so the gates and the merge lane run too. That
waits as long as `runtime.limits.wall`, `1h` here, and both commands say so
rather than looking hung. Ctrl+C does the same and tells you what a second one
costs; during a `restart`'s wait it leaves the drain standing, the next
`restart` by the same person picks that request up rather than refusing it, and
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

The suite is in two halves since #158. `pnpm test` is the tests that need no
database — 87 files, under 30s, not one connection — and `pnpm test:db` is the
ones that do. The recipe's `build` runs both. What is left in the second half
asserts Postgres itself: the projections, the advisory locks, `LISTEN`/`NOTIFY`,
two clients racing. A test that only *records* events gets
`createMemoryEventStore()` from `@lingtai/event-store/memory`, which is held to
the same contract as the real store — `packages/event-store/test/contract.ts`
runs against both, so a divergence is a failing test rather than a surprise.

**Neither test connection string may go through a pooler** (#157). Both pointed
at `aws-0-us-east-1.pooler.supabase.com` for months and the suite failed often
enough that a red gate meant nothing — `30 passed → 10 failed → 31 passed` on
one commit inside an hour, every failure a dropped connection and not an
assertion. On the direct host, `db.<project-ref>.supabase.co:5432`, the same
suite runs ten times in a row green at 480–502s. The dashboard offers the
pooler first, which is how this happens; `.env.example` says it at the line
where it matters.

The suite appends real events and refuses to run without
`LINGTAI_TEST_DATABASE_URL`. `LINGTAI_DATABASE_URL` is this system's own log,
and an agent is never given it. **Every name Lingtai reads for itself begins
`LINGTAI_`** (#63) — a project's own file keeps its own names, so `DATABASE_URL`
there is the project's application, never this one.

## Commits

One line, lower case, stating what is now true rather than what was done —
`fix(end): the point runs on every outcome, not just an inline merge`. An ADR
lands as `NNNN: <the decision, as a sentence>`. `git log` is the reference.
