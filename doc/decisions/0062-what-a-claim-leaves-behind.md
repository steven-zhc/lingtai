# 0062 — What a claim leaves behind, and what takes it away

**Status** accepted · **Date** 2026-09-24 · **Builds on**
[0039](0039-the-worktree-is-the-whole-of-a-pass.md),
[0040](0040-rounds-bound-depth-restarts-bound-breadth.md) ·
**Built by** [#239](https://github.com/steven-zhc/lingtai/issues/239),
[#240](https://github.com/steven-zhc/lingtai/issues/240)

0039 decided **where** a pass works: one worktree, and a refusal is answered
inside it. 0040 decided **when a pass starts over**: rounds bound depth,
restarts bound breadth, and a restart cuts fresh from the base. Neither decided
**what is still there afterwards**, and the gap cost a ticket its whole run.

## 1. A claim that produced commits leaves a ref — whatever ending it had

An agent works in a worktree cut `--force --detach` from the base. Its edits are
working-tree changes until the agent itself runs `git commit`, and
`removeWorktree` deletes the directory when the pass's scope closes. The only
push inside a pass is after a refusal is handled.

`run-once.ts` already adds one more push, and its comment states the rule:

> **the ending that promises the branch is the ending that has to put it there**

It made that push under `if (second.restart)` alone. **Every other ending that a
later attempt will read promises the branch just as much.** A pass handed to a
person is one `lingtai requeue` away from being attempt *k+1*, and `attemptBrief`
will tell that agent to `git fetch origin agent/<n>` — for a ref nobody made.

So the condition is the *promise*, not the restart.

**An ending with no commits publishes nothing.** A ref to an empty branch would
be a worse lie than the absence, and `attemptBrief` already has the honest word
for it: *Nothing. It committed no change, so there is no branch to build on.*

## 2. The ref is `agent/<n>-attempt-<k>`, and it is the only arm-ref scheme

`armBranch` named arms `agent/<n>-restart-<k>`, with `k` folded over the work
item — so it never collided. **The problem was never collision; it is that the
number does not always exist.** A claim that ran out of turns never restarted,
so there is no restart ordinal to name it by.

`attempts.ts` counts one attempt per `WorkItemClaimed` with a new `runId`, and
**a restart releases the claim and claims again — so every restart is also an
attempt, and the reverse does not hold.** The attempt ordinal is defined for
every claim and subsumes the one it replaces.

Keeping both would give one set of commits two names: a pass's first restart is
`agent/<n>-restart-1` *and* `agent/<n>-attempt-2`, and a reader would have to
know which counter produced a name before knowing what it points at. One axis.

`agent/<n>` keeps its meaning — the newest — and is force-pushed as before.

## 3. The agent commits as the work stands, not when it is finished

The only `commit` instruction in the prompt sat in the **fix-round** prompt, and
read as *commit when you are done*. An implementing run was told nothing. An
agent that spends its last turn still working therefore leaves a worktree full
of uncommitted edits and a deletion behind it.

**An unreviewed intermediate commit on an arm costs nothing, and this design
already says so**: the restart publish force-pushes arms it has *just judged
wrong*. `main` is held by the gates, never by a branch being clean.

## 4. A landing deletes the history refs, and that is a plugin

Nothing ever deleted a branch. `origin` carries **150 `agent/*` refs**, bounded
only by how many issues the repository has had.

Deleting them is an effect on a terminal outcome, which is what the `end` step
is ([0058](0058-lingtai-is-a-development-pipeline.md) §3) — beside `close:` and
`labels:`, and unable to refuse. It is a **plugin** rather than something the
pass does, because a team that keeps every branch for audit has to be able to
say no, and not declaring it is how they say it
([0061](0061-the-recipe-is-the-pipeline.md) §2).

**`when: landed`, and that is the whole safety argument.** For an item that did
not land, those refs are the only surviving account of what was tried — §1 exists
to create them for exactly that reason. A cleanup on any other ending destroys
what the rest of this decision was written to preserve.

## 5. What this does not change

**Rounds still share the worktree** (0039). A refusal is answered by the agent
standing in it; nothing here gives a round a ref of its own.

**A restart still cuts fresh from the base** (0040), and still *offers* rather
than imposes the abandoned work: the prompt says fetch it *if building on them
beats starting over*. That judgement stays the agent's. §1 only makes the offer
true more often.

## 6. What it cost to not have decided this

[#237](https://github.com/steven-zhc/lingtai/issues/237), 2026-09-23. Receipt
`error_max_turns · 151 turns · $20.81`, against 115 Bash, 34 Edit and 2 Write
calls. Seventy-one seconds before the wall it ran

```
23:31:44  Bash  rtk git status --short && echo ---- && rtk git diff --stat
```

— a diff of **uncommitted** changes. `git ls-remote --heads origin
refs/heads/agent/237` returns nothing.

**Both failures had to happen.** The agent never committed, *and* an
`out-of-turns` ending is not `second.restart`, so a committed one would have had
no ref either. Its second attempt landed in 85 turns and $8.37 — starting from
nothing, because nothing was there.

## Related

- [0039](0039-the-worktree-is-the-whole-of-a-pass.md) — where a pass works.
- [0040](0040-rounds-bound-depth-restarts-bound-breadth.md) §2 — the restart
  prompt *is* the restart mechanism, which is why the ref it names must exist.
- [0057](0057-a-gate-that-did-not-finish.md) — a did-not-finish buys nothing.
  This decision is what a did-not-finish should nonetheless *leave*.
- [012](../experiments/012-where-the-turns-go.md) — turns cost ~$0.10 each, so
  a lost 151-turn run is a lost $15–28 and not only lost time.
