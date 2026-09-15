# 0045 — One team, one conductor, one recipe

**Status** accepted · 2026-09-15 · records a topology the code has assumed since
`#93` and no document has stated

## Context

Somebody reasonable, wanting to help, runs Lingtai on their own machine against
a repository the team's Lingtai already works. Nothing stops them, and nothing
tells them.

**The queue does not see the other installation.** `filter.ts` never reads
`lingtai:working`. `selectRunnable` is *what GitHub offers* minus *what my own
`task_view` says* — so Bob's Lingtai has no idea Alice's is working `#123`. The
label is written by `labelsFor` and read by nobody in the selection path.

**The lock does not span installations.** `lock.ts` takes
`pg_try_advisory_lock(hashtext($1))`, which is **scoped to one Postgres**.
[#93](https://github.com/steven-zhc/lingtai/issues/93) stops two conductors on
one log; two logs are two locks.

So both claim the issue, both cut `agent/123`, and both push to it. The only
thing that intervenes is `--force-with-lease`, which makes the second push fail
— **the collision is loud rather than prevented**, and both have already spent
an agent by then.

## Decision

**One Lingtai per team. Many people watching it, one conductor working.**

That is what the lock, the fold and the board were built for, and it is what the
absence of any cross-installation coordination means: there is no such thing as
*my* Lingtai beside *the team's*.

**One repository, one recipe**, and that follows. The recipe lives in the managed
repository ([0005](0005-config-in-target-repo.md)) and governs whatever conductor
reads it — so per-person recipes would not be a feature, they would be two
conductors, which the paragraph above rules out.

Even if the topology allowed it, it should not: the log records *who* approved a
merge, and a per-person recipe would make *under whose rules* unanswerable. The
reason is `AGENTS.md`'s reason — conventions live with the code, are reviewed
like code, and everyone who clones gets them.

## What legitimately varies per person

The secrets in `~/.lingtai/env/<project>.env`, per machine, at `0600`. **That is
the whole list.** Gates, kinds, limits and merge policy are facts about how this
team works on this repository, and they belong in the file the repository owns.

## Consequences

**`runtime.agent` in the recipe is correct, and is evidence for this decision.**
Whether `codex` is installed is a fact about a machine — which looks like a
modelling error until you notice there is only ever one machine conducting. The
team agrees which agent works this repository; that agreement belongs in the
repository. It is wrong only under a topology this ADR rules out.

**The wizard's words follow.** It onboards a repository into *the team's*
Lingtai, not *mine*, and `ProjectOnboardingStarted` records who asked for it.

**What is not decided here is authority.** Today `actor()` is
`human:${process.env.USER}` — whatever the OS says, unverifiable, and meaningless
across machines. The log's *shape* is already right: every decision carries
`by: human:<id>`. What is missing is proof that the `<id>` is who it claims to
be, and that is a separate epic. Its cheapest shape is GitHub OAuth on the board
with authority delegated to the repository — *can you push here? then you can
approve here* — which needs no event change, because `human:<id>` stays and the
`<id>` becomes true. The real cost of that epic is not OAuth: it is that a board
reachable from a network holds the App key and can merge code.

**Nothing stops the collision this ADR describes.** A document is not a guard. If
two installations against one repository ever stops being hypothetical, the shape
of the fix is that the queue reads `lingtai:working` on the offer side — a
label a *different* conductor wrote is a claim this one must respect. That is
cheap and not built, because the topology says it should never happen.
