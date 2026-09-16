# 0046 — Lingtai is personal; the repository is the team's

**Status** accepted · 2026-09-16 · **supersedes
[0045](0045-one-team-one-conductor.md)** in whole and
[0005](0005-config-in-target-repo.md)'s surviving half

Each person runs their own Lingtai, on their own machine, against their own log.
The repository is shared. Lingtai is not.

## Context

[0045](0045-one-team-one-conductor.md) was written eight days ago and concluded
the opposite: *one Lingtai per team, many people watching it, one conductor
working*. It reasoned from what the code assumed rather than from what the
product is, and it was right about the code:

- `filter.ts` never reads `lingtai:working`, so one installation cannot see
  another's claim.
- `pg_try_advisory_lock` is scoped to one Postgres, so two logs are two locks.
- Therefore two installations against one repository both claim, both cut
  `agent/123`, and `--force-with-lease` makes the collision loud rather than
  prevented.

All three observations stand. **What changed is the answer to *what is this
for*.** Lingtai is a personal platform for working with coding agents — the tool
a developer runs on their own machine, the way they run an editor. A shared
conductor is a different product, and not this one.

0045 anticipated its own reversal and named the fix:

> If two installations against one repository ever stops being hypothetical, the
> shape of the fix is that the queue reads `lingtai:working` on the offer side —
> a label a *different* conductor wrote is a claim this one must respect.

That fix is not what this ADR adopts, and the reason is in §2.

## 1. One person, one Lingtai, one log

A team of five working one repository is five Lingtais and five logs. Nothing is
shared between them except GitHub.

**The local lock stays, and its job shrinks to what it can actually do.** It
answers *not twice on this machine* — `lingtai run` typed while a daemon is up,
which `#93` was opened for and which is still a real mistake. It does not and
cannot answer *not twice across the team*, and under this topology
`pg_try_advisory_lock` would be a guard that returns `ok: true` while the real
competitor is on somebody else's laptop.

So the lock moves to the filesystem, beside the log, for both storage options.
`flock(2)` is held by the file descriptor and released by the kernel when the
holder dies — the same liveness property `lock.ts` praises in the session-level
advisory lock, and not the pid file that comment rightly refuses.

**[0027](0027-the-lease-is-deleted.md)'s premise does not survive this, and §2 is
why it does not need to.** The lease was deleted because *a process holding this
lock knows no other conductor exists, so every foreign claim it finds is dead*.
Across machines that sentence is false: a foreign claim may be a colleague, alive.

## 2. A claim is GitHub's assignee, and therefore not a lock at all

**The issue's assignee decides whose work it is.**

This is not a better lock. It is the observation that there was never a race to
arbitrate:

| | a `lingtai:working` label | the assignee |
|---|---|---|
| written by | a machine, at claim time | **a person, when planning** |
| means | a conductor is running this now | **this is Alice's to do** |
| goes stale when | the machine dies | never — it is still Alice's |
| needs an expiry | yes, and that is [0027](0027-the-lease-is-deleted.md)'s lease returning | **no** |
| a conflict is | a race | **a conversation, and GitHub already renders it** |

Alice's laptop sleeping does not block Bob, because the ticket was never Bob's.
Moving it is a reassignment — a thing people already do, in a place everyone
already looks. **The lease does not come back because the problem it solved does
not occur.**

**Unassigned work is taken by default.** A ticket nobody has claimed is
available, which is how the queue behaves today and what a person working alone
expects. A team that wants strict separation sets its machine to take only what
is assigned to it; that is a per-machine setting and never a repository one.

`lingtai:working` keeps a job and loses its authority: it says *Alice's Lingtai
is running this right now*, which is information. A stale one misinforms and
blocks nobody, and that is a failure this system can carry.

**It costs nothing to ask.** `assignees` arrives on the object `listOpenIssues`
already fetches, exactly as `issue_dependencies_summary` does and for the reason
written beside it in `client.ts`.

**This makes `actor()` mean something.** 0045 complained that
`human:${process.env.USER}` is whatever the OS says, unverifiable. A machine that
names its own GitHub login in order to match assignees is still not *proof* of
identity — but it is self-correcting, because a wrong one hands you somebody
else's tickets on the next pass.

## 3. The recipe lives in `~/.lingtai/`, not in the repository

[0005](0005-config-in-target-repo.md) put it in the managed repository and gave
one positive reason:

> Onboarding a repository should be: give a repo path and GitHub permissions.
> That argues for `<repo>/.lingtai/config.yaml`, the way GitHub Actions uses
> `.github/workflows/`.

**Under a personal tool that reason inverts.** Using Lingtai on a team
repository would require committing a file to that repository first — a pull
request, a review, and the team's agreement, before one person can run one
agent on one ticket. A personal tool that must be adopted by a committee before
it can be tried is not a personal tool.

0005's defensive half is answered rather than argued with. It worried that
*putting gate definitions in the repository hands the exam paper to the
candidate*, and solved that by reading the recipe from `origin/<base>`. Moving
the recipe out of the repository solves it more completely: the agent's blast
radius is the worktree, and `~/.lingtai/` is not in it. **See §4.**

What the team genuinely shares was never the recipe, and 0005 said so itself:

> Which checks are *required*, and who may approve, are **not in the repository
> at all — they are branch protection**.

So the division is:

| | holds | enforced by |
|---|---|---|
| `~/.lingtai/` | my gates, my limits, my agent, my log | me, before I push |
| branch protection | what must pass to reach `main` | GitHub |
| `AGENTS.md` | how to work in this codebase | the agent reads it |

**Lingtai's gates are a pre-flight, not a contract.** They are what I choose to
run before I push, and calling them the team's quality bar was always a
borrowing from a topology this ADR removes.

**A recipe that can be derived need not be stored.**
[#161](https://github.com/steven-zhc/lingtai/issues/161) proposes a recipe by
reading the repository — its scripts, its labels, its default branch. The
repository holds the facts; the recipe is one reading of them, and the reading is
mine.

### The placement rule, which is 0021's sentence one field wider

[0021](0021-the-recipe-decides-the-environment.md) is titled *the recipe decides
the environment; the machine only holds it*. Generalised:

**The repository holds facts about itself. Everything else is mine.**

`runtime.agent` was the counter-example hiding in plain sight — which CLI is
installed is a fact about a machine, sitting in a file meant to describe a
project. 0045 defended it *because there was only ever one machine conducting*;
that defence dies here. It does not move, it **goes**: `lingtai doctor` already
detects which runtime is signed in, so it is a fact to observe rather than a
value to hold.

`runtime.limits` goes too, and for a reason worth stating: more rounds does not
lower quality, because the gates are what decide quality. More rounds costs more
money. **That is the spender's call.**

## 4. `tamper` loses its subject

[#31](https://github.com/steven-zhc/lingtai/issues/31) built a watch that holds
any diff touching the recipe, the gates, or the packages that load them, so an
agent could not weaken its own gates in one merge. The agent's own prompt states
the boundary it relies on:

> **The directory you are in is the blast radius.** It is a worktree cut from
> `origin/<base>`, and it is yours. **Nothing outside it is yours.**

With the recipe in `~/.lingtai/`, an agent cannot reach it. The guard is not
switched off — **it has nothing left to guard**. The capability and its path
list stay ([doc/tamper-watch.md](../tamper-watch.md)), because a managed
repository may still hold things worth watching, and because deleting a control
is a different decision from removing its subject.

## Consequences

**What gets simpler.** `currentRecipe` reads a local file instead of
`client.fileAt(path, ref)` — no request, works offline, and 0005's *read from the
base branch, never the agent's branch* protects against something that can no
longer happen. Onboarding a repository writes nothing to that repository at all,
which removes the pull request from the end of
[#165](https://github.com/steven-zhc/lingtai/issues/165) and a step from
[#164](https://github.com/steven-zhc/lingtai/issues/164).

**What is genuinely lost, and it is real.** Nothing in the repository says
Lingtai is in use. `.lingtai/config.yaml` was a visible artifact a newcomer would
find on clone; now there is none. This is a regression in discoverability
accepted for what §3 buys, and it is recorded here rather than argued away.

**Two people's recipes will drift.** Alice runs `pnpm test`, Bob runs
`pnpm test && pnpm test:db`, and nothing reconciles them. That is the same
condition as two developers with different local habits, and what must not drift
is held by branch protection.

**SQLite becomes the obvious default.** Each log belongs to one person on one
machine, so it never needs to be reached from another — which is the whole of
the argument for a server. Postgres remains for whoever wants it, selected by
the presence of `LINGTAI_DATABASE_URL` and nothing else. **That rule must not
reach the test variables**: `env/index.ts:145` refuses to run the suite without
`LINGTAI_TEST_DATABASE_URL`, and a fallback there would let a suite that exists
to assert Postgres pass against SQLite.

**What is not decided here.** Whether a team ever wants a shared conductor. This
ADR says Lingtai is not that today; it does not say the product could never grow
one, and if it does, 0045 is where that argument already is.
