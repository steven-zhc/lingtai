# The pipeline — the design, the roadmap and the tickets

**Status** design agreed, implementation not started · 2026-09-22 ·
**Decisions** [0058](../decisions/0058-lingtai-is-a-development-pipeline.md)
(ten steps, everything that acts is a plugin) ·
[0060](../decisions/0060-the-gate-runs-unit-tests.md) (the gate runs unit
tests) · [0061](../decisions/0061-the-recipe-is-the-pipeline.md) (the recipe is
the pipeline)

Those three say what is true when this is done. **This file says how to get
there without stopping the system that is doing the work** — because Lingtai
schedules its own development, and every ticket below is worked by an agent
Lingtai dispatched, one unheld ticket at a time.

## 1. What changes, in one screen

```
            today                              after

   five gate points                    ten steps, in order
   the other stations unnamed          every step named, and configurable

   review returns a verdict            review returns findings
   the verdict is the decision         proposed decides

   build and review are two            build is its own step, and a red one
   actions at one point                skips review

   ceilings inside run-once.ts         a `route:` plugin at proposed
   (buyRound, passCeiling)             a person can read

   recipe: four sections               recipe: `steps:`, ten names, read down
   per pass                            the file is the pipeline

   the gate runs whatever              the gate runs unit tests; integration
   `pnpm test` runs                    runs after the merge, elsewhere
```

## 2. The obstacle, named early

```
packages/conductor/src/run-once.ts     2961 lines
```

It holds the sequence, `buyRound` (`:1761`), `passCeiling`, the restart
decision and all three `runGatePipeline` calls. **Every ticket below wants to
edit it**, and a 3000-line file is the shape that took
[#179](https://github.com/steven-zhc/lingtai/issues/179) eleven passes to land.

The good news is that the plugin runner already exists:

```ts
runGatePipeline({ point, gates, context })      // packages/actions/src/gate.ts:237
```

What does not exist is **the sequence as data**. That is why T2 is where it is:
it is the smallest change that gives every later ticket a boundary to work
inside, and it changes no behaviour at all.

## 3. The roadmap

Six phases. Phases 1 and 2 are independent of each other and can run in either
order; everything after phase 2 is a chain.

```
0   decide          T0   plugins that must agree      ← blocks phase 5
                    T0b  the v2 recipe, written out   ← the target every ticket aims at

1   name it         T1   Step, ten, in @lingtai/domain
                    T2   the pass's sequence is a list      ← the keystone
                    T3   the rail draws ten

2   the gate        #224 the .env.local leak                ← open, unheld
    (0060)          T4   root vitest config, unit/integration, closes #222
                    T5   the post-merge full suite

3   split           T6b  013 — the log before the third reset   ← a reset spends the numbers
                    T6   GatesResolved grows to ten            ← the log is reset, not upcast
                    T7   build is its own step
                    T8   review returns findings, not a verdict

4   route           T9   the ceilings leave run-once.ts
                    T10  proposed routes: lines or approach
                    T11  merge reports a reason; a resolved conflict re-enters at build

5   configure       T12  the recipe is `steps:` (0061)
                    T13  init proposes plugins per step
                    T14  doctor checks cross-step agreement

6   the new one     T15  design — a document, before any code
```

**The order enforces itself.** `source.kinds` is
`[bug, tech-debt, feature, documentation]` and the queue orders by kind and
then by number, so an open `bug` or `tech-debt` is always taken before any
`feature`. Phases 1–4 are mostly the first two kinds and phases 5–6 are
features: a later phase cannot jump the queue while an earlier one is open.
Nothing has to enforce this by hand.

**Chains go in GitHub's own *blocked by*, never in a ticket body.**
`blockedBy` counts **open** blockers, so a ticket comes back to the queue on
its own the pass after its last blocker closes, with no hold to remove.

## 4. The tickets

Each row is one ticket. **Kind** decides queue priority; **blocked by** is set
with the API, not written in the body.

### Phase 0 — decide

| | |
|---|---|
| **T0** | Plugins that are only correct together |
| kind | `documentation` — lands as an ADR |
| blocked by | — |
| what | `admit`'s `worktree:` and `merge`'s `merge:` must agree about one repository, branch and base; `prepared`'s install and `build`'s command must agree about one package manager. A model that lets either be swapped alone lets a person assemble a pipeline that is legal, passes `doctor`, and breaks on the first merge. The shape of the answer is probably `gatesFromRecipe(…, deps)`'s refusal-by-name widened from within-a-step to across-steps. |
| why first | [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) calls it *the largest open question here*, and phase 5 cannot be built without it. It blocks nothing before that, so it can be argued while phases 1–4 run. |

| | |
|---|---|
| **T0b** | The v2 recipe, written out |
| kind | `documentation` |
| blocked by | — |
| what | The complete v2 file for this repository, with every setting placed under its step per [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §4. Not an implementation — **the target every other ticket aims at.** |
| watch out | It is also 0061's own test: if the v2 file is not plainly easier to read than the v1 it replaces, the ADR was wrong and this is where that shows. |

### Phase 1 — name it

| | |
|---|---|
| **T1** | `Step` — the ten, in `@lingtai/domain` |
| kind | `tech-debt` |
| blocked by | — |
| what | A `Step` enum of the ten names beside `GatePoint`, plus the map from today's events to steps. Eight of the ten already append events ([0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §Context). |
| watch out | **Pure addition. `GatePoint` is not touched** — it is on nine event payloads and in an upcast (`events.ts:74`, `upcast.ts:29`). Widening it here is T6's job, under its own version. |

| | |
|---|---|
| **T2** | The pass's sequence is a list |
| kind | `tech-debt` |
| blocked by | T1 |
| what | `run-once.ts` declares the ten steps as data; **each step's body stays exactly where it is**. One test asserts the declared list equals `STEPS`. |
| watch out | **Zero behaviour change, and the review should be able to check that claim cheaply.** This is the keystone: every ticket in phases 3 and 4 edits one step's body, and without this each of them is a diff in the middle of 2961 lines. |

| | |
|---|---|
| **T3** | The rail draws ten steps |
| kind | `bug` |
| blocked by | T1, T2 |
| what | `rail.tsx:109` draws `points.map(...)` — five segments — and highlights the one whose name matches the fold's label. During a fix round that label is `fixing round 1 of 3`, which is none of the five, so **no segment is marked and the eye lands on the last green one**. Observed on #179: the rail read as stopped at `prepared` while the run was eighteen minutes into a fix round at `proposed`. |
| watch out | Needs no schema change — eight of the ten are on the log today. It is also the cheapest test of §3's names: **if `implement` or `proposed` reads wrong on a card, learning that now is far cheaper than after the recipe carries the word.** |

### Phase 2 — the gate's contents ([0060](../decisions/0060-the-gate-runs-unit-tests.md))

| | |
|---|---|
| **#224** | A `pure/` test reads this repository's own `.env.local` |
| kind | `bug` · **open, not held** |
| what | Red on `main` today and no diff can clear it. The test closed `process.env` by hand and left `envFile` open. |

| | |
|---|---|
| **T4** | A root vitest config, with `unit` and `integration` projects |
| kind | `tech-debt` |
| blocked by | #224 |
| what | Twenty `vitest*.config.ts` files and no root config become one root config with two projects. The 44 files that leave the system move to `integration`; `pure/` becomes `unit/`. **Closes [#222](https://github.com/steven-zhc/lingtai/issues/222)** — one vitest run over every project reports every project, so there is no first-failure bail to be silent about. |
| watch out | **A tag does not stop a file being imported** — measured: a file whose every test is `@integration`, run under `--tagsFilter '@unit'`, still threw from module scope and still failed the run. Projects and include globs do the file-level split; tags are for the mixed file. And the `build` command lives in `~/.lingtai/lingtai/recipe.yml`, **outside every worktree, so an agent cannot change it** — a person does. |

| | |
|---|---|
| **T5** | The full suite runs after the merge |
| kind | `feature` |
| blocked by | T4 |
| what | A separate system, triggered by the merge into `main`, runs `integration`. A failure arrives as an issue with a `kind` label, which the queue takes on its next pass. |
| watch out | **`LINGTAI_TEST_DATABASE_URL` must not go through a pooler** ([#157](https://github.com/steven-zhc/lingtai/issues/157)) — on the pooler the same suite went `30 passed → 10 failed → 31 passed` on one commit inside an hour. And **`LINGTAI_DATABASE_URL` is never given to it**: that is this system's own log. |
| open | Whether that system opens the issue itself or a person does. The queue does not care; *who closes it* does. |

### Phase 3 — split `build` from `review`

| | |
|---|---|
| **T6** | `GatesResolved` grows from five to ten |
| kind | `tech-debt` |
| blocked by | T1 |
| what | `points: …length(5)` (`events.ts:514`) is a hard assertion and the one concrete break in [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §5. The shape changes; **no upcaster is written** ([0061](../decisions/0061-the-recipe-is-the-pipeline.md) §7) — this log is reset instead, for the third time. |
| watch out | **Do not delete `upcast.ts`.** Not owing an upcaster here is not the same as not needing the mechanism: 0001 built it before it was needed because *the first upcaster is written under time pressure against real history*, and a Lingtai somebody else runs has a log nobody may reset. |
| before it | **T6b — fold the log into a file first.** A reset spends every measurement: [012](../experiments/012-where-the-turns-go.md) is a fold over this log and none of its numbers can be recomputed afterwards. [007](../experiments/007-the-log-before-the-reset.md) and [010](../experiments/010-the-log-before-the-second-reset.md) are the two precedents and the format. |

| | |
|---|---|
| **T7** | `build` is its own step, and a red one skips `review` |
| kind | `feature` |
| blocked by | T2, T6 |
| what | Two actions at `proposed` become two steps. |
| watch out | **Not because build is quick** — measured over 14 days it is the slower of the two, median 313s against review's 149s. Because it spends no tokens where a review spends an agent. And the agent still runs the build itself while it works, 1–9 times in a pass that lands: that is a tool, not the step. The step's run is the independent one. |

| | |
|---|---|
| **T8** | `review` returns findings and judges nothing |
| kind | `feature` |
| blocked by | T7 |
| what | The verdict moves to `proposed`. |
| watch out | **10% of `review` refusals in 14 days carried no findings at all** — 24 of them ([012 §4](../experiments/012-where-the-turns-go.md)): a reviewer that crashed, recorded as a refusal of the diff, buying a fix round to answer a question nobody asked. [0057](../decisions/0057-a-gate-that-did-not-finish.md)'s narrow fix stays correct and stops being load-bearing. |

### Phase 4 — `proposed` routes

| | |
|---|---|
| **T9** | The ceilings leave `run-once.ts` |
| kind | `tech-debt` |
| blocked by | T2, T8 |
| what | `buyRound` (`:1761`) and `passCeiling` become a module a person can read, ahead of becoming the `route:` plugin in T12. |
| watch out | Behaviour-preserving. [0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)'s split is the contract: `rounds` bounds depth in the same worktree, `restarts` bounds breadth from the base. A refactor that blurs them changes what a refusal costs. |

| | |
|---|---|
| **T10** | `proposed` routes: the lines are wrong, or the approach is |
| kind | `feature` |
| blocked by | T9 |
| what | **Reshapes [#223](https://github.com/steven-zhc/lingtai/issues/223)**, which was *add a field to the reviewer's contract*. It becomes *that judgement is a plugin at `proposed`* — better, because the reviewer keeps one job. |
| evidence | 60% of a later round's findings are in files the last round flagged, 40% in files it read and passed over ([012 §5](../experiments/012-where-the-turns-go.md)). **Rounds work when the refusal is about a line and fail expensively when it is about the approach**, and nothing currently reads which kind a refusal is. |

| | |
|---|---|
| **T11** | `merge` reports a reason; a resolved conflict re-enters at `build` |
| kind | `feature` |
| blocked by | T10 |
| what | `merge` stops deciding: it reports `reason` (machine-readable) and `detail` (the words), and `proposed` routes on it. |
| evidence | Over the whole log `merge` has refused 32 times: **26 `gate-failed`, 6 `conflict`.** The common failure is that somebody else's work landed and the diff stopped being true — a clean textual merge that then fails its build, which wants an ordinary fix round against the new base. |
| watch out | An agent resolving a conflict writes code **after `review` passed**, so it goes back to `build`. That is what makes the invariant say itself: *every path into `end` has been through `build` and `review`*. And the intent case is the row an agent must not take — two changes that edited the same decision differently produce text an agent can merge and an intent it cannot know. |

### Phase 5 — the recipe ([0061](../decisions/0061-the-recipe-is-the-pipeline.md))

| | |
|---|---|
| **T12** | The recipe is `steps:` |
| kind | `feature` |
| blocked by | T0, T0b, T6 |
| what | `gates:` becomes `steps:` with ten names; every step is a list of plugins; the six action kinds become six of the ten built-in plugins; `rounds`/`restarts`/`turns`/`wall`/`base`/`kinds` move to the step that owns them. `version: 2`, and a v1 file is refused by name. |
| watch out | **A plugin's configuration must be hashed into `configHash`**, or 0047 loses everything that moved out of `runtime:` — `route:`'s `rounds` is exactly as load-bearing as an action's command. |

| | |
|---|---|
| **T13** | `init` and `add` propose plugins for every step |
| kind | `feature` |
| blocked by | T12 |
| what | The repository is read and each step gets a proposed set — the package manager for `prepared`, the default branch for `admit`, the signed-in runtime for `implement`, the test script for `build`. [#161](https://github.com/steven-zhc/lingtai/issues/161) already does this for the five gate points. |
| watch out | **Detected is a default, not a replacement for being told** ([0046](../decisions/0046-lingtai-is-personal.md) §3), generalised from `runtime.agent` to every step. |

| | |
|---|---|
| **T14** | `doctor` checks that plugins across steps agree |
| kind | `feature` |
| blocked by | T0, T12 |
| what | T0's answer, enforced. |

### Phase 6 — the one genuinely new step

| | |
|---|---|
| **T15** | `design` — a document, before any code |
| kind | `feature` |
| blocked by | T12 |
| what | The only one of the ten with no trace on the log today. |
| evidence | Five tickets have landed in one pass each after a design was written down; #179 without one took eleven. That is an anecdote, not a measurement — and it is the reason this step is last rather than first: **it should be built when there is something to compare it against.** |

## 5. What is done when this is done

- [ ] A person reads `~/.lingtai/<project>/recipe.yml` downward and has read the pass
- [ ] The board's rail shows which of the ten steps a run is in, during a fix round included
- [ ] `rounds` and `restarts` are readable beside the step that spends them
- [ ] A red at `build` is a claim about the diff — no test in it leaves the system
- [ ] A `review` that returns nothing is a review that found nothing
- [ ] Every path into `end` has been through `build` and `review`
- [ ] `GatesResolved` records all ten steps, so what a run was given is still on the log
- [ ] Everything 012 measured is in a file before the log that carried it is reset
- [ ] A plugin a step cannot run is refused when the recipe resolves, by name

## 6. Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) — the ten
  steps, and the drawing.
- [0060](../decisions/0060-the-gate-runs-unit-tests.md) — what the `build` step
  runs, and why a test that leaves the system cannot be at a gate.
- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) — the file shape.
- [012](../experiments/012-where-the-turns-go.md) — where the turns go. Most of
  the numbers quoted above come from here.
- [`agent-runtimes-plan.md`](agent-runtimes-plan.md) — the other open epic
  (#198). It configures `implement`, so [0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md)
  is the pattern T12 generalises rather than something it replaces.
