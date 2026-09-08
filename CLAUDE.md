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

A daemon is still what takes work unattended, and

    pnpm lingtai daemon --no-conduct

is still safe beside a pass already in flight — two projectors on one log
converge, because `apply` is idempotent and the checkpoint moves inside the
same transaction as its writes.

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
