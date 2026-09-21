# 0056 — The store is a written choice; absence decides nothing at open time

**Status** accepted · 2026-09-21 · **supersedes
[0055 §2](0055-two-implementations-chosen-at-init.md)'s *"its absence means
SQLite"*** and the same sentence in
[0046 §Consequences](0046-lingtai-is-personal.md) — *selected by the presence of
`LINGTAI_DATABASE_URL` and nothing else*. §1–§4 of 0055 stand unchanged.

Which store this machine runs is a value written in `~/.lingtai/config.yml`.
Every process reads it. Nothing infers it from a variable being unset, because
*unset* is not a fact a process can establish.

## Context

0055 §2 said the right thing and left one word undefined:

> `LINGTAI_DATABASE_URL` remains the way Postgres is named, and **its absence
> means SQLite** — for the system, not only for the log.

**Absence where?** The URL has three sources
(`packages/env/src/index.ts`): a real environment variable, `.env.local` at the
repository root, and `database.url` in `~/.lingtai/config.yml`. The second is
found by walking up from `packages/env/src` — so whether it exists *depends on
where the process was started*.

[#179](https://github.com/steven-zhc/lingtai/issues/179) implemented the
sentence literally, and its ninth pass was refused with this
([seq 10350](https://github.com/steven-zhc/lingtai/issues/179), `review`,
blocker):

> On a machine whose Postgres is named only in the checkout's `.env.local`,
> absence is read as a choice by every process that cannot read that file, so it
> silently opens a second, empty SQLite log and reports every append into it as
> success — **where the same process was refused by name before this diff.**

The reviewer is right, and **this machine is the case**:

```
~/.lingtai/config.yml    no `database` key at all
.env.local               LINGTAI_DATABASE_URL=…      ← the only source
```

So `pnpm lingtai` from the checkout finds Postgres, and the installed binary, a
daemon started from `~`, a launchd job and an agent's worktree would each find
*nothing* — and, under that diff, would each conclude SQLite and open an empty
log at `~/.lingtai/lingtai.db`. Appends succeed. Nothing warns.

**For a system whose first rule is that the log settles it, two logs and no
error is the worst failure available.** It is worse than the refusal it
replaced, and the refusal was the behaviour before the change.

### Why nine passes

The findings moved every round — `install.ts:537`, `install.ts:617`,
`init.ts:391`, `env/index.ts:568` — which is the shape of a set nobody has
enumerated, read out one item at a time. That is the same diagnosis
[#179](https://github.com/steven-zhc/lingtai/issues/179) already carries about
its first eight, and the set here is *every place a process might ask whether
something is absent*. It has no end, because the question is wrong.

0055 §2's own words are the cure, and the implementation inverted them:

> **One selection, made when a machine is set up**, and every store resolves
> through it.

A selection *made once* and a predicate *evaluated everywhere* are different
systems. #179's own `Done when` forbids the second in as many words — *the
selection happens **once**, and a second place that decides again does not
exist* — and deriving it from absence makes every reader a second place.

## Decision

### 1. The choice is a written value, and `init` is what writes it

```yaml
# ~/.lingtai/config.yml — written by lingtai init, mode 0600
database:
  store: postgres        # or: sqlite
  url: postgres://…      # only with store: postgres
```

**An explicit `store`, not the presence of `url`.** Presence would be the same
predicate again, merely in a better place — and it cannot tell *SQLite was
chosen* from *`init` never ran*, which
[0016 §4](0016-the-settled-model.md) says must never collapse into one state.
It also makes [#215](https://github.com/steven-zhc/lingtai/issues/215)'s bug a
contradiction a machine can see: choosing SQLite while a `url` is still in the
file is now two keys disagreeing, rather than a screen and a file disagreeing
with nobody watching.

### 2. Four answers, and three of them are refusals

| `config.yml` | then |
|---|---|
| no `database` key | **refuse by name**: this machine has not been set up — `lingtai init` |
| `store: sqlite` | SQLite, under `~/.lingtai/` |
| `store: postgres` with a URL | Postgres |
| `store: postgres`, no URL anywhere | **refuse by name**, saying where a URL is looked for |
| `store: sqlite` beside a `url` | **refuse by name**, quoting both |

**The unset case is a refusal, not a default.** That is the whole of this ADR:
a machine that has not been set up is not a machine that chose SQLite, and the
only honest thing to do with a question nobody answered is to ask it.

### 3. A real environment variable still wins, and it is the only other source

`LINGTAI_DATABASE_URL` exported into a process selects Postgres and supplies the
URL, whatever the file says. This is what makes CI, launchd and a container work
with no file at all, and `.env.example` already states it as the rule everywhere
else here.

It wins *and says so*: `lingtai doctor` already prints where each value came
from, and this is one of the lines it must name.

### 4. `.env.local` is not a source for the selection

It remains a source for every other name, including `LINGTAI_TEST_DATABASE_URL`
and the App's credentials — nothing about the development setup changes except
that a checkout no longer decides, **for a machine**, which store that machine
runs.

This is the sentence the whole ADR exists for. A file whose visibility depends
on the current working directory can carry a convenience. It cannot carry a
fact that four different processes have to agree about.

**`LINGTAI_TEST_DATABASE_URL` is untouched**, and 0046's reason stands word for
word: a fallback there would let a suite that exists to assert Postgres pass
against SQLite.

## Consequences

**This machine needs one edit before any of this lands**, and it is the same
shape as [#180](https://github.com/steven-zhc/lingtai/issues/180)'s recipe move
— done once, by hand, not by a command built to be run once:

```yaml
database:
  store: postgres
  url: <the one already in .env.local>
```

`init` writes `config.yml` at `0600` (`init.ts:131`). **The copy on this machine
is `0644`, because it was written by hand** — it holds no secret today and will
hold one after this edit, so the mode is part of the edit.

**The ticket order inverts, and that is the point.**
[#215](https://github.com/steven-zhc/lingtai/issues/215) — *choosing a store
reports it without writing it* — is the ticket that makes the choice a recorded
fact, and it is currently **blocked by
[#179](https://github.com/steven-zhc/lingtai/issues/179)**. It is the
prerequisite, not the follow-up. With the choice written, #179 stops being
*derive a decision everywhere* and becomes *read one value*, which has an
enumerable end — the property that made
[#219](https://github.com/steven-zhc/lingtai/issues/219),
[#220](https://github.com/steven-zhc/lingtai/issues/220) and
[#221](https://github.com/steven-zhc/lingtai/issues/221) each land on their
first pass.

**A machine that upgrades into this gets the refusal, once.** Every existing
installation has no `database` key, so the first command after the upgrade says
so and names `lingtai init`. That is louder than a silent migration and is
chosen deliberately: the alternative is inferring the answer, which is what this
ADR removes.

**What this does not decide.** Whether `store` may be changed by editing the
file rather than re-running `init`. 0055 §3 already says switching is a new
database; whether the edit alone is enough to mean it is #215's to settle.
