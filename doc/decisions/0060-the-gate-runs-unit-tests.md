# 0060 — The gate runs unit tests, and integration runs after the merge

**Status** accepted · 2026-09-22 · **first instance of
[0058](0058-lingtai-is-a-development-pipeline.md) §3's `build` step being a
thing the recipe decides the contents of** · extends
[012](../experiments/012-where-the-turns-go.md)'s postscript from one test to
the rule behind it

A gate is a claim about the diff. A test that can go red for a reason the diff
cannot cause is not that claim, and putting one at a gate spends fix rounds
answering questions nobody asked. **So the `build` step runs unit tests only**,
and the tests that talk to the world run after the merge, on something that is
not the conductor.

## Context

### The split we have is drawn on the wrong axis

`pnpm test` against `pnpm test:db` divides on **does this need Postgres**. That
was the right question for #157 — a pooled connection was dropping under the
suite and a red gate had stopped meaning anything — and it is not the question
a gate asks. Counted on 2026-09-22, the half the `build` step runs:

```
115 test files, of which 44 leave the system (38%)

  40  make a scratch directory        18  start an OS process
  38  write a file                     1  reads the real $HOME
                                       1  reaches the network
```

A further 24 read files out of the checkout, which is the system reading
itself and stays unit. So **71 of the 115 are unit already** and the split is
not a rewrite — it is a line drawn through a set that is mostly on the right
side of it. The directory most of the other 44 sit in is called `pure/`.

### It has already refused three diffs that were fine

**`apps/cli/pure/world.test.ts`** spawns a child `node` that type-strips the
daemon's whole import graph and asserts an exit status and two lines of stdout
— nothing about time. Its bound was vitest's 5000ms default, which nobody
chose. Idle, the probe takes ~0.5–1.9s; under `pnpm -r` beside `apps/release`'s
binary builds the same pass reported `import 66.28s` against 25–32s idle, and
it timed out. It refused [#215](https://github.com/steven-zhc/lingtai/issues/215),
then refused [#196](https://github.com/steven-zhc/lingtai/issues/196) at 5686ms
— on a branch cut from `main` **110 seconds before** the fix that raised the
bound was pushed. Neither diff went near that import graph.

**`packages/conductor/pure/create-app.test.ts`** is red on `main` today, on
this machine, for a reason no diff can fix — and it is the better example of
the two, because **the test tried**. It passes `env: {}` (`:191`), closing the
`process.env` door by hand. It does not pass `envFile`, so
`create-app.ts:457` falls back to `join(repoRoot(), ".env.local")`, and this
repository's own `.env.local` carries `LINGTAI_GITHUB_APP_ID`. The call takes
the *already configured* branch and never reaches the refusal the test is
about.

**Closing one door by hand is not the same as being unit.** There were two, the
author saw one, and nothing in the arrangement was going to mention the other.
That is the argument for a boundary a tool can check rather than a habit each
test keeps for itself.

Both cost the same way. A refusal at `build` is evidence about the change to
every mechanism downstream: it buys a fix round — 31 turns, ~$3.40 measured
([012 §3](../experiments/012-where-the-turns-go.md)) — and the round is spent
looking for a defect that is not there.

And `pnpm -r` stops at the first failing package
([#222](https://github.com/steven-zhc/lingtai/issues/222)), so one such test
also hides every package after it: `#196`'s refusal said nothing about
`packages/actions` (125 passed), `packages/conductor` (387) or `apps/board`
(437) — the run never reached them.

## Decision

### 1. Two categories, and the line is the system's external dependencies

**A test is integration when it exercises a dependency outside the system.**
Everything else is unit. That is the ordinary meaning of the two words and it
is deliberately the ordinary meaning: a rule a reader already knows is a rule
that survives being applied by somebody who did not read this file.

The system is the code in this repository. Outside it:

```
Postgres · the GitHub API · the `git` binary · any OS process
the filesystem · the network · the real $HOME · the wall clock
```

```
unit          touches none of them. Reaches only this repository's own code
              and values the test itself constructed.

integration   touches any one of them — including the whole of today's
              test:db half, and the 18 files that spawn a process.
```

**The line is not "is it slow" and not "does it need Postgres".** Slowness is a
symptom and Postgres is one dependency out of eight. Naming the boundary
instead of one crossing of it is what makes the rule decide the cases nobody
has met yet — and it settles the ones already on the table without argument:
a temporary directory is still the filesystem, and a spawned `node` is still a
process, however carefully the test cleans up after itself.

**Why this boundary and not another.** A dependency outside the system is
exactly a thing the diff does not control. It can be busy, missing,
pre-configured by whoever owns this machine, or simply slower today — and every
one of those is a red that says nothing about the change. Inside the system,
red means the change.

### 2. The `build` step runs unit, and nothing else

This is [0058](0058-lingtai-is-a-development-pipeline.md) §2b in its first real
instance: `build` is a step, and what runs there is the recipe's to say. What
it says here is the unit category.

The reason is not that unit tests matter more. It is that **a gate's verdict is
bought with an agent**: a false refusal is not a wasted minute, it is a fix
round, a round off the ceiling, and a reviewer's attention spent on a file that
was never wrong.

### 3. Integration runs after the merge, on something that is not the conductor

The full suite runs on a separate system, triggered by the merge into `main`.
**A failure there arrives the way every other defect arrives — as an issue with
a `kind` label**, which the queue picks up on its next pass.

This is the honest trade and it should be stated as one: an integration
regression **can land**, and is caught minutes later rather than before the
merge. That is affordable because the thing it protects is not the branch, it
is the loop: a conductor that stops for a reason the diff cannot cause stops
for every diff.

It also keeps the conductor out of a job it is bad at. Lingtai merges its own
work unattended, so the system that runs the full suite must not be the system
that decided to merge.

### 4. `pure/` is renamed `unit/`

The name has been carrying 18 process-spawning tests, and a name that is wrong
is worse than no name: three separate agents diagnosed `world.test.ts`
correctly, and all three had to work out from scratch that a file under `pure/`
was not pure.

### 5. What this does not change

- **`prepared` still asks whether the base is green**, and whether it should is
  [0058](0058-lingtai-is-a-development-pipeline.md)'s open question, not this
  one.
- **The contract tests stay** — `packages/event-store/test/contract.ts` runs
  against the real store and the memory one, which is what makes
  `createMemoryEventStore()` safe to use in a unit test
  ([0055](0055-two-implementations-chosen-at-init.md)). The contract is
  integration; the tests that rely on it are unit.
- **Nothing here is about coverage.** A test moved to integration is still run,
  still required to pass, and still somebody's to fix.

## Consequences

**A red `build` becomes worth reading again.** That is the whole return. Today
a refusal carries `pnpm -r`'s first failing package and a reader cannot tell a
loaded-machine timeout from a broken tree; after this, a red at `build` is a
claim about the diff and can be treated as one.

**Classifying is easy; what it costs is that some real claims lose their gate.**
`world.test.ts` spawns a process, so §1 answers it in one word — and the claim
it makes is a good one: *the daemon's import graph does not reach Postgres*.
That claim now runs after the merge. **A claim worth making at a gate and only
expressible by leaving the system is a claim whose subject is probably wrong**
— here, that *does this module load* was ever the question, when what #179 was
actually about was when a store is opened. The rule does not lose such claims;
it makes the awkward ones visible as a list, which is more than the present
arrangement does.

**The `main` branch is no longer proven green by the thing that merged into
it.** Branch protection is where a team would put this; here the answer is the
separate system in §3, and until it exists the integration half is run by a
person.

## What is not decided

- **Which system runs §3**, and whether its failure opens the issue itself or a
  person does. The queue does not care which, but *who closes it* does.
- **Whether `merge` should hold for the run in §3.** It cannot here —
  `gates.merge` is `[]` and this repository merges unattended — but a managed
  repository with a human at `merge` could wait for it.
- **The per-package mechanism**, though vitest 4 narrows it and one measurement
  settles most of it. There are twenty `vitest*.config.ts` files here and no
  root config, and two candidates:

  **Tags are real** — vitest 4.1.11 has `tags` in the config, `{ tags: [...] }`
  on a `describe` or an `it` (a suite's tag is inherited), `--tagsFilter` with
  `&&`/`||`/`!`, `--listTags`, and `strictTags` on by default, so a typo in a
  tag name is an error rather than a test that silently never runs. Probed
  directly on the installed version rather than taken from the docs.

  **And a tag does not stop the file being imported**, which is the fact that
  decides this. Probed: a file whose every test is `@integration`, run under
  `--tagsFilter '@unit'`, still threw from module scope and still failed the
  run. A tag filters *tests*; the file is loaded to find them. So for a file
  that is integration all the way down — a pool at import, a spawn in
  `beforeAll` — the tag buys nothing and the cost is paid anyway.

  Which leaves: **projects (or include globs) to keep an integration file out
  of the gate's run entirely, and tags for the mixed file** that is mostly unit
  with two cases that reach out. A root config with `unit` and `integration`
  projects also **retires `pnpm -r`'s first-failure bail
  ([#222](https://github.com/steven-zhc/lingtai/issues/222))**, because one
  vitest run over every project reports every project.
- **Whether the boundary is checkable rather than remembered.** A lint rule
  that refuses `node:child_process`, `node:fs`, `node:net` and a live client
  inside `unit/` would make §1 a thing the tree enforces — which is the only
  version of this that does not rot, since `pure/` rotted exactly here.

## Related

- [012](../experiments/012-where-the-turns-go.md) — the postscript this
  generalises: *a gate can go red for a reason the diff cannot cause, and when
  it does, every mechanism downstream treats it as evidence about the diff*.
- [0057](0057-a-gate-that-did-not-finish.md) — the same disease at the other
  gate: a reviewer that crashed is not a refusal. 10% of `review` refusals.
- [0058](0058-lingtai-is-a-development-pipeline.md) §2b — a step's contents are
  a plugin. This is the first one chosen on evidence.
- [#157](https://github.com/steven-zhc/lingtai/issues/157) — the pooler, which
  is why the existing split is drawn where it is.
