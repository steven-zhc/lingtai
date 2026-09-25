# Lingtai

An event-sourced scheduler for autonomous code agents, which runs on itself:
tickets here are worked by agents Lingtai dispatched.

**[doc/architecture.html](doc/architecture.html)** answers *which process am I
in* — four diagrams: the processes that exist, who appends to the log, who is
told when it changes, and where each piece of state lives. Read it before
changing anything that crosses a process boundary.
**[doc/the-pass.html](doc/the-pass.html)** answers the other question —
*how does one ticket get built* — the ten steps, what each word on them means,
what a person writes in the recipe, and where a ticket goes when a step will
not let it past. **It is written for somebody about to point Lingtai at a
repository**, so it carries no ADR history and no before-and-after; it
describes [0058](doc/decisions/0058-lingtai-is-a-development-pipeline.md) and
[0061](doc/decisions/0061-the-recipe-is-the-pipeline.md), which are accepted
and are being built — **the code still runs five gate points, and that gap is
[the plan](doc/design/the-pipeline.md), not something the page pretends
away.** Both drawings come from `scripts/the-pass.py`; the HTML is generated.

[doc/README.md](doc/README.md) indexes the ADRs, which are append-only in
spirit: a decision that turns out wrong gets a superseding file, not an edit.

## The log settles it

Behavioural claims are settled by reading `events`, not by reasoning about the
code. A finding that cites a seq number is worth more than one that argues, and
that stays true. What a `seq` is not is a **durable citation** — that is a
GitHub issue number, never a seq ([1.0](doc/design/1.0.md)) — because the log is
a file somebody may reset. This one has been reset twice already
([007](doc/experiments/007-the-log-before-the-reset.md),
[010](doc/experiments/010-the-log-before-the-second-reset.md)), and
[0055](doc/decisions/0055-two-implementations-chosen-at-init.md) §3 makes
choosing the other store start an empty one rather than carry the history over.
So: quote the seq where you are proving what happened, and cite the issue where
somebody has to follow you there later.

There are two projections, `task_view` (the board) and `finding_backlog` (the
minors passing gates raised, #137), and the way to correct either is
`lingtai projection rebuild <name>` — one rebuild per projection, since each has
its own table and checkpoint; replay, never a repair by hand. Both are folds and
nothing else: the outbox and the queue cache are gone (0022), so nothing writes
to them but the projection.

## Opening an issue

An issue needs a **kind** label or the queue never sees it. The recipe's
`source.kinds` decides which — currently `bug`, `tech-debt`, `feature`,
`documentation`, in that order, which is priority order: **`documentation` is a
kind since 2026-09-22 and is last on purpose**, because the documents are the
product's front page ([design/1.0.md](doc/design/1.0.md)) and so are work
rather than tidying, but a doc ticket must never be taken ahead of a bug. That
is the conducting machine's `~/.lingtai/lingtai/recipe.yml` since #180, and
**not** `.lingtai/config.yaml`: nothing reads the repository's copy, so a label
added there and merged stays invisible, and says nothing — and that copy still
says three kinds for exactly that reason. The other labels in this repo
(`enhancement`, `question`, …) are invisible to the conductor.

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

Setting one, and **the id is not the issue number**:

    # #164 is blocked by #161 — `issue_id` is the blocker's numeric `.id`,
    # and `-F` rather than `-f`: `-f` sends a string and the API answers
    # `Invalid property /issue_id: "5467364530" is not of type integer`.
    gh api repos/steven-zhc/lingtai/issues/164/dependencies/blocked_by \
      -F issue_id=$(gh api repos/steven-zhc/lingtai/issues/161 --jq .id)

    gh api repos/steven-zhc/lingtai/issues/164/dependencies/blocked_by \
      --jq '.[] | "#\(.number)  \(.title)"'          # read it back

An issue carries three identifiers and only one of them works here: `number`
(161), `id` (5466453198), and `node_id` (`I_kwDO…`, GraphQL's). The endpoint
wants `id`, and a `number` in that field either 404s or silently names a
different repository's issue.

`blockedBy` counts **open** blockers, not total (`discover.ts:155`,
`client.ts:323`) — so a chain whose groundwork has landed reads
`total_blocked_by: 2, blocked_by: 0` and runs. It arrives on the issue listing
the pass already fetches, so asking costs no extra request. **Null is not
zero**: a GitHub that says nothing about dependencies degrades to the behaviour
from before this existed rather than passing everything over.

**A ticket has two readers and they want opposite things.** The body becomes the
agent's prompt, so it is written to be worked from rather than filed — and a
person deciding what to work next reads twenty of them. **A four-row table, then
the evidence.** The table is the person's; everything under it is the agent's,
and none of it is cut to make room.

    | | |
    |---|---|
    | **Problem** | one sentence, and the failure rather than the area |
    | **Want** | what is true when this is done |
    | **Fix** | the shape of it, not the diff |
    | **Watch out** | the trap — what costs money, or fails silently, or has already been got wrong once |

`Watch out` is the row that earns the table. It holds what used to sit in the
third paragraph, where a tired reader never reached it: *this opens a second
discussion and buys a second agent*, *tail-only fixes vitest and breaks tsc*.
Leave the row out when there is no trap; never leave the trap in the prose.

Then, under a rule, the evidence — house style as in #52, #55, #58:

- Lead with the evidence — the seq numbers, the log excerpt, the exact output.
  The seq proves it on the spot; the thing a reader follows later is an issue
  number, because the log under a seq may have been reset by then.
- Say **why it stayed hidden**, when it did. That is usually the real finding.
- Cite `file.ts:line`, and quote the comment or doc that makes the claim.
- `## Done when`, as checkboxes each of which a person or a test can check.
- `## Related`, saying what the related ticket *decided* — not just its number.

## Running Lingtai on Lingtai

**This repository merges its own work unattended, and that is configuration
rather than a gap.** `gates.merge` is `[]` — nothing is declared there, so
nothing holds. Declare a `human:` action there and the point runs it: #58 was
fixed, and the test that pins it is `conductor/integration/run-once.test.ts`'s
*holds at a human action at the merge point, with no --no-merge anywhere*, which
asserts the base branch does not move. `--no-merge` remains the way to hold a
run whose recipe asks for nothing.

So the question to ask before a run is not *did I pass the flag* but *what does
`merge:` say today*, and `lingtai add` prints the answer.

**There is no exception, and `tamper` is not one.** What stands between an agent
and `main` here is `proposed` — the build and the cold reviewer — and neither is
a person. `merge: []` means nothing holds at the merge point; `proposed` holds
nothing for a *person* either.

`tamper` (#31) is built, tested, and **has lost its subject**: since #180 the
recipe is `~/.lingtai/<project>/recipe.yml`, outside every worktree, so there is
no gate file in the repository for an agent to weaken (0046 §4). Before that it
was **deliberately not wired in this repository**. It watches a workspace package the conductor or the CLI loads, the
board, a `package.json`, the lockfile, the workspace file, a `tsconfig`, a
vitest config, or `.lingtai/config.yaml` itself — so that an agent cannot weaken
its own gates in one merge. Within one night of being switched on it held six
consecutive items at `proposed` with `build=passed review=passed`: every ticket
in this queue is about Lingtai's own machinery, so nearly every diff touches a
watched path and self-hosting became supervised-by-default. This repository is
choosing machine time over review time while it learns what the loop does
unattended.

The block is [doc/tamper-watch.md](doc/tamper-watch.md), and
`packages/actions/unit/tamper-watch.test.ts` reads the list *from that file* —
because the recipe does not carry it — so the capability and its list stay
correct though what they guarded has moved out of reach. **A managed repository that is not Lingtai should almost certainly have it
on**: there a watched path is rare, and a hold means something.

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
conductor: `lingtai run` takes the same lock the daemon does (#93) — a file under
`~/.lingtai/locks/` since #193, never Postgres, so
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
asked for is theirs to lift. The commit and worktree are checked again after
the wait. Where `lingtai service` keeps the daemon, the drain and the start are
the supervisor's and every refusal is still the restart's: the same checks,
`service shutdown`'s drain holding the lock through the unload, the checks
again, and `service start` — which, like every service verb that starts a
process, exits 0 on that start only once the daemon has recorded
`ConductorStarted` (0048). Where the supervisor was already running one,
`service start` and `service install` start nothing, say so and exit 0 — and
that exit confirms nothing: the process may have lost the lock, and `lingtai
doctor` says who holds it. A terminal daemon
beside a supervised one would be two conductors taking turns.
`RESTART_GUARDS` in `apps/cli/src/restart.ts` is the table of what each path
refuses, and a test fails on a row with one side (#167). Every start that takes work appends `ConductorStarted` with who,
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

**The suite is in two halves and the line is 0060 §1, not Postgres** (#225).
*A test is integration when it exercises a dependency outside the system* —
Postgres, the GitHub API, the `git` binary, any OS process, the filesystem, the
network, the real `$HOME`, the wall clock. Everything else is unit. **A
temporary directory is still the filesystem and a spawned `node` is still a
process**, however carefully the test cleans up after itself; that is where the
old `pure/` went wrong, and it is why `pure/` is now `unit/`.

There is **one root `vitest.config.ts`** with a `unit` project and an
`integration` project, and no per-package config. Each package holds `unit/`,
`integration/` or both, plus a `test/` for the shared contract suites and
fixtures that are not themselves tests.

    pnpm test               # `vitest run --project unit` — 90 files, ~1200 tests
    pnpm test:integration   # the other 76, and `pnpm test:db` is the old name
    pnpm test:all           # both projects in one run

**Nobody runs the integration half as part of doing a ticket.** It takes 803
seconds, and an agent's background task is killed at 600 — `#249` did the work,
started `pnpm test:integration`, stopped to wait for it, and was terminated with
90 turns and $8.95 spent and **no commit at all**. A `Done when` that asks for it
is a `Done when` an agent cannot reach. Ask for `pnpm test` and `pnpm typecheck`,
and commit as the work stands.

**It is not given up, it moves.** The integration half runs on a separate system
after the merge — [0060](doc/decisions/0060-the-gate-runs-unit-tests.md)'s other
half, and `the-pipeline.md`'s **T11**. What a ticket must not do is wait for it.

So one check is out of reach while a change is being made rather than absent:
`apps/release/integration/build.test.ts`, the Next build, which is the only thing
that sees a server-only import reaching a `"use client"` graph — `tsc` cannot.
That one is caught after the merge instead of before it, and `#230` is what it
looks like when it is caught late.

`pnpm test` is what the `build` gate runs, so **a red there is a claim about the
diff** ([0060](doc/decisions/0060-the-gate-runs-unit-tests.md)). It is one
vitest run rather than `pnpm -r`, which stopped at the first failing package and
hid every package after it (#222). `HOME=/nonexistent pnpm test` is green, and
that is the claim rather than a habit — run it that way when you have touched
what a test reaches for.

What the integration half asserts is Postgres itself — the projections,
`LISTEN`/`NOTIFY`, two clients racing — and everything that spawns, writes or
fetches. A test that only *records* events gets `createMemoryEventStore()` from
`@lingtai/event-store/memory`, which is held to the same contract as the real
store — `packages/event-store/test/contract.ts` runs against both, so a
divergence is a failing test rather than a surprise.

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

**Never write `close`, `closes`, `fixes` or `resolves` next to a `#number` unless
you mean to close it** — GitHub's auto-linker does not read the sentence around
it. `1a7267f`'s body said *"**This does not close #231.**"* and closed #231.
A negation, a quotation and a code fence's prose all close it just the same, so
the only way to mention the relationship is to not use the verb: write *#231 is
not done by this* or *see #231*.

One line, lower case, stating what is now true rather than what was done —
`fix(end): the point runs on every outcome, not just an inline merge`. An ADR
lands as `NNNN: <the decision, as a sentence>`. `git log` is the reference.
