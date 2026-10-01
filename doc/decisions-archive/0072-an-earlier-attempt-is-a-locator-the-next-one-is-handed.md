# 0072 — An earlier attempt's work is a locator the next attempt is handed, and the cut does not move

**Status** accepted · **Date** 2026-09-29 · **Decides** what a new pass may do
with the branches its predecessors left, which nothing has ever read ·
**Depends on** [0066](0066-a-large-answer-is-a-locator-on-the-log.md) §4, *the
locator is a string and only the plugin that wrote it reads it*, which is the
shape borrowed here · **Leaves
[0039](0039-the-worktree-is-the-whole-of-a-pass.md) §1 alone** — the worktree is
still cut detached, at the base, once per pass

## 1. Thirty-one branches nobody reads

Every attempt pushes twice: to `agent/<n>`, the branch a ticket's passes own,
and to `agent/<n>-attempt-<k>` — an **arm**, a sibling ref per attempt
(`armBranch` in `packages/conductor/src/branches.ts`). The remote carries 31 of
them. `refs:` at `end` deletes an item's arms once it lands (`#240`) — and its
`branch:` is `false` by default, so `agent/<n>` itself stays: after a merge its
commits are reachable from `main`, but it is the ref a person follows from the
merge commit. An arm is therefore meant to outlive exactly the passes that might
read it.

**Meant to. This repository had not declared `refs:` at all** until 2026-09-29,
so nothing was swept and the 31 above are what a fortnight of accident looks
like. Declining the plugin is done by not declaring it (0061 §2), which is a
good rule and is indistinguishable from forgetting.

**And nothing reads one either**, which is the separate half and the one this
file is about. The next attempt is cut from `origin/<base>` and is told about
its predecessors in prose: `priorAttempts` gives the brief `n`, `runId`, how it
`ended`, the integrator's `refusal` and the `outcome` — **and no ref.** So the
agent learns that an attempt happened and what it cost, and never where the code
went.

The bill for that is ordinary and was paid twice on 2026-09-29: `#314`'s pass was
killed by an account quota after its `design` step had produced a note for
**58 turns and $5.18**, and the requeued pass wrote a new one from nothing. The
old one was on `agent/314-attempt-1` the whole time, byte-identical to
`agent/314`.

## 2. What the cut's reason actually is, and what it is not

`provisionWorktree` cuts detached at the base:

    await git(["worktree", "add", "--force", "--detach", path, baseSha], …)

The docblock beside it argues **`--detach`** at length and never argues
`baseSha`:

> This used to be `-B <branch>`, which checks `agent/<n>` out here — and git
> refuses to update a ref that some worktree has checked out … The merge lane
> fetches exactly that ref before it merges … **Nothing needed the branch to be
> checked out here.** The push below has always been `HEAD:refs/heads/<branch>`

That is a rule about **checking out a ref**, not about **which commit the tree
starts at**. The two are separable: a worktree cut detached at an arm's sha is
still detached, and still collides with nothing. *Start from the base* has been
in force since 0039 and has never been the subject of a decision.

This file does not change it either. It records that the choice is open, so the
next reader does not mistake the collision argument for one about content.

## 3. Three situations wear one rule

A pass reaches its end in more than one way, and today all the ways that produce
a *next* pass are treated alike:

| | today | and it is |
|---|---|---|
| a fix round inside a pass | same worktree, work continues | right, and untouched |
| a `restart` inside a pass | from the base, carrying what refused it | **right** — a restart means the approach was wrong |
| a requeue, a new pass | from the base | **the question** |

And the third divides again by why the pass ended:

- **it was refused** — a reviewer found something the approach cannot fix. From
  the base is correct; that is what starting over is for.
- **it was interrupted** — a quota, a killed agent, a wall clock, an operator's
  Ctrl+C. **The work was never judged.** Starting from the base discards what
  nothing found fault with.
- **it stopped for a person** and the person changed something else.

[0068](0068-a-step-that-asked-is-not-a-step-that-crashed.md) split the first two
endings apart on the log the same day, so the distinction exists and is readable.

## 4. The decision: the arm is a locator, and the brief carries it

The next attempt is handed **the name of its predecessor's arm**, the way a
`file-brief:` is handed a path: a string the agent may read and the core does not
interpret. It is derived rather than stored — `armBranch(agentBranch(issue), n)`
from the `n` a `PriorAttempt` already carries — so nothing new goes on the log.

What the agent does with it is the agent's. `git show agent/314-attempt-1:…`
works from any worktree in the clone; so does a diff against it. A brief that
says *attempt 1's work is at this ref* costs one line and buys back a design, or
a survey, or the knowledge that the last attempt had already tried the obvious
thing.

**The cut does not move.** Every pass still begins at the base, every step still
reads the diff against it, and a pass that ignores the ref behaves exactly as it
does today.

**A ref that was never pushed is not offered.** An attempt that died before it
committed has no arm, and a brief naming a ref that does not resolve is worse
than one that says nothing: it sends the agent to spend turns on a failing
command. The line appears only where the ref exists.

## 5. Why not simply continue from the arm

The obvious cheaper answer — cut the next worktree at the arm and carry on — is
refused here, and the reason is not cost.

**It makes starting over impossible.** A refused approach would accrete: every
subsequent attempt would begin inside the shape a reviewer had already rejected,
and the only way out would be a person deleting a branch. `restart` exists
precisely to say *that was the wrong shape, begin again*, and it is spelled
**from the base carrying what refused it**. A rule that always continues deletes
that verb's meaning while leaving the word.

The cheap continuation is a real option for the **interrupted** case alone —
§3's second row — and that is deferred rather than rejected; see below.

## 6. What is deferred, and what decides it

**Cutting an interrupted attempt's successor at its arm.** The shape is right and
the log can already tell interrupted from refused (0068). What is missing is
whether it is worth it, and the honest answer is that nobody knows yet:

- **how often a pass is interrupted rather than judged.** One instance on
  2026-09-29 is a sample of one.
- **whether continuing is actually cheaper.** The comparison this decision would
  most like to cite — `#265`'s second attempt at 24 turns and $1.78 against a
  first at 151 and $20.48 — **cannot support it**, because by the code as it
  stands that second attempt also started from the base. Whatever made it cheap,
  it was not continuing from a branch.

Experiment [015](../experiments/015-does-a-design-make-the-implementing-run-smaller.md)
is running for a fortnight and records every dispatch's turns and cost, so both
numbers arrive without anybody instrumenting anything for them.

## 7. What it costs

**One line in a brief, and a derivation.** No event grows, no schema changes, no
ref is created that is not created today, and `refs:`'s sweep removes them on
the ticket that lands — once a recipe declares it.

**A wrong turn the agent can take.** An arm is the work of an attempt that did
not land, and some of those were refused for good reasons. An agent that reads
one uncritically inherits a rejected shape. The brief has to say which ending the
attempt had beside the ref — which `PriorAttempt.ended` and `.refusal` already
carry, so the cost is wording rather than plumbing.

**Nothing for a ticket on its first attempt**, which is most of them.

## What this does not decide

- **Where the worktree is cut.** §2 records that the argument for the base was
  never made, and leaves it made-by-default. Changing it is §6's deferred
  question.
- **Whether the agent should read the arm.** The brief offers; it does not
  instruct. A prompt that ordered the agent to build on a refused attempt would
  be the accretion §5 refuses, arriving by another route.
- **Arms as a durable record.** They are swept at `end` and that stays. What
  survives a landed ticket is the commits on `main` and the log, as before.

## Related

- [0066](0066-a-large-answer-is-a-locator-on-the-log.md) §4 — the locator is a
  string and the core does not parse it. An arm's name is one more of those, and
  §4 is why handing it over costs nothing.
- [0039](0039-the-worktree-is-the-whole-of-a-pass.md) §1 — the worktree is the
  whole of a pass, cut once and released at the end. Unchanged.
- [0068](0068-a-step-that-asked-is-not-a-step-that-crashed.md) — the ending split
  that makes §6's deferred question answerable at all.
- [#240](https://github.com/steven-zhc/lingtai/issues/240) — `refs:` sweeps an
  item's arms at `end`, and its branch too where `branch: true` says so. That is
  why an arm outlives exactly the passes that might read it, in a recipe that
  declares the plugin.
- [#82](https://github.com/steven-zhc/lingtai/issues/82) — the brief that quotes
  earlier attempts. This adds a field to what it quotes and changes nothing else.
