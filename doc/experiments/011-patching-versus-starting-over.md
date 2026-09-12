# 011 — When a reviewer keeps refusing, is another round or a fresh start cheaper?

**Run** 2026-09-12 · **Result** the fresh start, decisively — and it needed none
of the rounds it was given

## Why

[0039](../decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §2 built the
inner loop on one sentence:

> The first is cheap because the work is still there.

That is plainly true of a conflict and of a red build: the branch is finished,
the remedy is mechanical, and re-implementing it would be absurd. It was assumed
to be true of a refused **review** as well, and a refused review is a different
kind of thing — the reviewer may be saying *this line is wrong*, or it may be
saying *this approach is wrong*, and `rounds` cannot tell those apart.

`#144` produced both arms of the comparison by accident, on the same ticket,
against the same cold reviewer, within two hours.

## What happened

**Arm A — patch in place.** `rounds: 2`, worktree cut from `main`.

| | |
|---|---|
| implementer | 56 turns · $5.18 · build passed |
| review 1 | **refused** — `health.ts:55`, a `starting` beacon that never ages out |
| round 1 | 36 turns · $3.18 |
| review 2 | **refused** — `lingtai.ts:303`, the beat still misses the longest stretch of startup, *and three comments now claim it does not* |
| round 2 | 34 turns · $3.13 |
| review 3 | **refused** — `daemon.ts:124`, `startBeacon` now sits between the lock and the try/catch that releases it: a failed first beat exits holding the conductor lock |
| outcome | ceiling spent, asked a person, **nothing landed** |
| cost | **~$12** |

**Arm B — start over, carrying the findings.** `rounds: 10`, worktree cut from
`main`, `requeue`d by hand.

| | |
|---|---|
| implementer | 62 turns · $6.56 · build passed |
| review 1 | **passed** |
| outcome | **landed `b8c583d` on `main`**, unattended |
| rounds used | **0 of 10** |
| cost | **$6.56** |

Half the money, and it landed.

## The reading

**Each refusal in arm A was about the code the round before it had written.**
Not the original diff seen more harshly — new defects, in new lines, introduced
by the fix. Review 3's finding is a deadlock that did not exist before round 2
created it. That is not a reviewer converging slowly on a stubborn diff; it is a
fixer patching a design that was wrong underneath, and each patch making a new
place to be wrong.

**`rounds` bounds depth, and the failure in arm A was breadth.** A round buys
another attempt at *this* approach. When the approach is the defect, every round
spends money getting further from a fix, and the ceiling's only contribution is
deciding when to stop paying for that.

**Arm B was not a lucky sample; it was better informed.** The fresh implementer
was handed everything arm A learned. `attempts.ts` already does this, and the
prompt it built is more generous than anyone had claimed:

```
### What attempt 1 produced

11 file(s), +685 −44, committed on `agent/144` at `8634c5d`.

**Your worktree is cut fresh from the base branch, so those commits are not in it.**
If building on them beats starting over, `git fetch origin agent/144` and take
what is worth keeping from `8634c5d`; if it does not, ignore them.

### What refused attempt 1
  major packages/daemon/src/daemon.ts:124 — …
  minor packages/daemon/src/control.ts:370 — …
```

It is told the branch exists, given its sha, told how to fetch it, and handed
the judgement explicitly. It chose to start over — and the diff it produced
addresses the finding from arm A's *first* review as well as the last, which
means it read all of them and not just the one that stopped the pass.

## What this does not show

**n = 1.** One ticket, one reviewer, one pair of arms. Arm B being cheaper may be
this ticket's shape rather than a law: `#144` was a design question with a small
surface, and a ticket whose approach is right and whose execution is fiddly would
plausibly run the other way — that is the case `rounds` was built for and this
experiment did not produce one.

**Arm B's own reviewer passed on the first read**, so this says nothing about
whether a *second* fresh start would help. The interesting failure — two fresh
starts both exhausting their rounds — has not been observed.

**The restart was a person's.** `requeue` is what moved it, which means this
compares two things the system can already do, not a mechanism it has.

## What follows

`#146` is the mechanism this suggests: when rounds are exhausted, release rather
than ask, and let the next claim be a fresh pass — bounded by a second ceiling,
with a person at the end of *that*. The evidence above is the argument for it and
the `n = 1` is the argument for proving it on more than one ticket first.

`#145` was written before this and claimed the branch was unreachable by the
system. It is not: the prompt above is what makes arm B work at all. It has been
corrected.
