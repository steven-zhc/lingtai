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
115 test files
 18 import node:child_process — they start real OS processes
```

plus others that read the real `$HOME`, run `git`, or reach the network. The
directory most of them sit in is called `pure/`.

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
this machine, for a reason no diff can fix: `create-app.ts:456` falls back to
`process.env`, the test does not override it, and this machine has a real
GitHub App configured — so the call takes the *already configured* branch
instead of reaching the refusal the test is about. A `pure/` test reading the
developer's own machine.

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

### 1. Two categories, and the line is what the test did not create

```
unit          in-process. Starts no process, reads no real $HOME, runs no git,
              opens no socket, connects to no database. What it reads, it made.
              Its duration is bounded by CPU, never by a clock on a shared machine.

integration   everything else — including the whole of today's test:db half.
```

**The line is not "is it slow" and not "does it need Postgres".** It is
**whether the test can fail because of something it did not create**. That is
the property a gate needs, because it is exactly the property that makes a red
mean *this diff is wrong*.

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

**Some tests will be hard to classify, and the hard ones are the finding.**
`world.test.ts` asserts that an import graph does not reach Postgres — a real
claim about the code, expressed as a spawned process because module loading is
what it is measuring. Moving it to integration does not answer it. **A claim
worth making at a gate and only expressible by touching the world is a claim
whose subject is probably wrong** — the same shape `#179` spent eleven passes
finding.

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
- **The per-package mechanism.** `unit/` and `test/` by directory, or one
  config with a tag, is a question for whoever moves the files.

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
