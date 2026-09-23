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
   the verdict is the decision         proposed decides, and routes

   build and review are two            build is its own step, and a red one
   actions at one point                skips review

   ceilings inside run-once.ts         `rounds` on implement, `restarts` on
   (buyRound, passCeiling)             claim — on the step each one bounds

   recipe: four sections               recipe: `steps:`, ten names, read down
   per pass                            the file is the pipeline

   the gate runs whatever              the gate runs unit tests; integration
   `pnpm test` runs                    runs after the merge, elsewhere
```

## 2. This is a clean cut, and what that does and does not buy

**It is a rewrite of the core flow from the decisions, not a migration to
them.** No compatibility is owed — not by the recipe file
([0061](../decisions/0061-the-recipe-is-the-pipeline.md) §7), not by the log,
not by the code. What that removes is real and most of it is invisible work:

```
no upcaster for GatesResolved             the log is reset instead (§4, T5b)
no GatePoint kept beside Step             the five-name enum is deleted
no v1 recipe path                         a v1 file is refused by name
no flag, no dual-write, no bridge         one shape at a time, not two
```

**It does not remove the size limit on a diff**, and that limit is the thing
that actually shapes the plan below. It comes from the review loop, not from
history: a pass is one agent inside `turns: 150`, read by a cold reviewer whose
refusal buys a fix round at ~31 turns and ~$3.40
([012 §3](../experiments/012-where-the-turns-go.md)).
[#179](https://github.com/steven-zhc/lingtai/issues/179) is what a diff too big
to hold in one reading costs: eleven passes, its findings landing on a
different file each round.

So the shape of the work is **not** surgery on this:

```
packages/conductor/src/run-once.ts     2961 lines
```

It is: **write the new pass beside it, and delete it.** A clean cut is what
makes that legal, and it is a better ticket in both directions — new code a
reviewer reads against the ADR, then a deletion that is its own diff.

What survives from the old file is the one thing already the right shape:

```ts
runGatePipeline({ point, gates, context })      // packages/actions/src/gate.ts:237
```

That is *run this step's plugins* and it does not change.

## 3. The order, and why it is this order

**The recipe comes before the pass.** A step's behaviour *is* its plugins
([0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §2b), so the
pass reads `recipe.steps[name]` and runs what it finds. Writing the pass before
the schema means writing it twice.

**The behaviour changes are not tickets.** *`build` is its own step*, *`review`
returns findings*, *`proposed` routes*, *`merge` reports a reason*, *the
ceilings are universal keys the workflow enforces* — under a migration each is a ticket.
Under a clean cut they are simply what the new pass does, because it is written
from the ADR rather than bent towards it. **That is the largest saving here,
and it is why the list below is shorter than the one a migration needs.**

```
0   decide       T0b  the v2 recipe, written out                 ← the target

1   vocabulary   T1   Step replaces GatePoint
                 T2   the ten plugins, as one interface
                 T3   the recipe is `steps:`                     (0061)

2   the pass     T4a  pass.ts — the skeleton and the steps that cannot refuse
                 T4b  pass.ts — build, review, proposed, merge
                 T5b  013 — the log before the third reset       ← before T5
                 T5   the conductor runs pass.ts; run-once.ts is deleted
                 T6   the rail draws ten

3   configure    T7   init and add propose plugins for every step
                 T8   doctor names what every step will run

4   the new one  T9   design — a document, before any code

—   the gate's contents (0060), independent of all of the above:
                 T10  a root vitest config, unit and integration
                 T11  the full suite runs after the merge
```

**The queue enforces the order for free.** `source.kinds` is
`[bug, tech-debt, feature, documentation]` and the queue orders by kind and
then by number, so an open `bug` or `tech-debt` is taken before any `feature`.
**Chains go in GitHub's own *blocked by*, never in a ticket body** — it counts
open blockers, so a ticket returns to the queue on its own the pass after its
last blocker closes, with no hold to remove.

## 4. The tickets

### Phase 0 — decide

**T0 was here, and it is gone.** It asked for a model of plugins that are only
correct together. Reading the code retired it: `base` is not two settings that
must agree, it is **one value that flows** — `recipe.repo.base` is the only
place it is written, and `worktree.ts:133` and `integrate.ts:73` both take it
as a parameter. The disagreement the ticket existed to prevent cannot happen.
What is left is `prepared`'s `pnpm install` against `build`'s `pnpm typecheck`:
two free-text commands, where catching *npm in one and pnpm in the other* needs
a system that understands commands. **A plugin offers a capability; a person who
configures it wrongly gets an error.** What survives is one sentence, now in
[0061](../decisions/0061-the-recipe-is-the-pipeline.md) §4: *a setting has
exactly one home, and a step that needs another step's setting receives the
value rather than declaring it again.*

| | |
|---|---|
| **T0b** | The v2 recipe, written out |
| kind | `documentation` |
| what | The complete v2 file for this repository, every setting under its step per [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §4. Not an implementation — the target T3 is checked against. |
| watch out | It is 0061's own test: **if the v2 file is not plainly easier to read than the v1 it replaces, the ADR was wrong** and this is where that shows, before any code is written. |

### Phase 1 — the vocabulary

| | |
|---|---|
| **T1** | `Step` replaces `GatePoint` |
| kind | `tech-debt` |
| blocked by | — |
| what | One enum of ten (`events.ts:74`), and the five-name one is **deleted**, not kept beside it. `GatesResolved`'s `points: …length(5)` (`:514`) becomes ten. **No schema version bump and no upcaster** — the log is reset at T5. |
| watch out | `gatePointRenamed` in [`upcast.ts`](../../packages/domain/src/upcast.ts) (`diff` → `proposed`, ADR 0018) dies with the reset and can go. **The upcast mechanism stays**: 0001 built it before it was needed because *the first upcaster is written under time pressure against real history*, and a Lingtai somebody else runs has a log nobody may reset. Deleting one upcaster is not deleting the machinery. |

| | |
|---|---|
| **T2** | The ten plugins, as one interface |
| kind | `tech-debt` |
| blocked by | T1 |
| what | `run:` `agent:` `watch:` `human:` `close:` `labels:` `worktree:` `queue:` `judge:` `merge:` behind one contract, with the universal keys the workflow enforces on any of them (`timeout`, and `rounds`/`restarts` at `proposed`), with the step × plugin matrix and its refusal ([0061](../decisions/0061-the-recipe-is-the-pipeline.md) §8: **a step refuses a plugin it cannot run**, at resolve time, by name). |
| watch out | Four of the ten are new and each is a *name for code that already exists* — `worktree:` is `repo`'s worktree, `queue:` is `discover`/`claim`, `judge:` is `buyRound`'s decision, with `passCeiling`'s counting left to the workflow, `merge:` is the merge lane. **A plugin here should wrap, not reimplement**; where wrapping is awkward, that is a finding about the seam and belongs in the ticket, not in a rewrite. |

| | |
|---|---|
| **T3** | The recipe is `steps:` |
| kind | `tech-debt` |
| blocked by | T0b, T2 |
| what | [0061](../decisions/0061-the-recipe-is-the-pipeline.md), whole: `steps:` with ten names, each a list of plugins, Ansible's module-as-key; `rounds`/`restarts`/`turns`/`wall`/`base`/`kinds` move to the step that owns them; `version: 2` and a v1 file refused by name; a step omitted from the file resolves to `[]`. |
| watch out | **A plugin's configuration must be hashed into `configHash`**, or [0047](../decisions/0047-the-recipe-a-run-got-is-on-the-log.md)'s *what a run was given is on the log* loses everything that moved out of `runtime:` — `rounds` on `proposed` is exactly as load-bearing as an action's command. |

### Phase 2 — the pass

| | |
|---|---|
| **T4a** | `pass.ts` — the skeleton, and the steps that cannot refuse |
| kind | `tech-debt` |
| blocked by | T3 |
| what | The ten steps as data, driven by the recipe, **in a new file beside `run-once.ts`, wired to nothing.** This ticket does `claim`, `admit`, `prepared`, `implement`, `end`. |
| watch out | Nothing calls it yet, so it lands on its own tests. That is deliberate: **a reviewer reads it against the ADR rather than against a diff**, which is the one reading a cold reviewer is good at. |

| | |
|---|---|
| **T4b** | `pass.ts` — `build`, `review`, `proposed`, `merge` |
| kind | `tech-debt` |
| blocked by | T4a |
| what | The four steps that carry the behaviour changes, all of which are now just *what the new code does*: `build` is its own step and a red one skips `review`; `review` returns findings and judges nothing; `proposed` is the only step that routes: **one `judge:` per `when:`**, each choosing from the set the workflow offers it — only the `findings` direction is a judgement worth an agent, the mechanical ones are built in; `merge` reports a `reason` and a `detail` and decides nothing. **Every step that does not simply pass reports a `reason`, `implement`'s `needs-input` included** — an agent that stopped to ask did not finish, which is [0057](../decisions/0057-a-gate-that-did-not-finish.md)'s class rather than a refusal, and whether it is worth interrupting a person over is the judge's call. |
| evidence | `build` first **not because it is quick** — median 313s against review's 149s — but because it spends no tokens where a review spends an agent. `review` stops judging because **10% of its refusals in 14 days carried no findings at all**, 24 of them ([012 §4](../experiments/012-where-the-turns-go.md)). `merge` reports rather than decides because over the whole log it has refused 32 times: **26 `gate-failed`, 6 `conflict`** — the common failure is that somebody else's work landed and the diff stopped being true. |
| watch out | **Every path into `end` must have been through `build` and `review`**, which is what the edge from `merge` back to `build` buys: an agent that resolves a conflict writes code *after* the review passed. And the intent conflict is the row an agent must not take — two changes that edited the same decision differently produce text an agent can merge and an intent it cannot know. |

| | |
|---|---|
| **T5b** | 013 — the log before the third reset |
| kind | `documentation` |
| blocked by | T4b |
| what | Fold this log into a file before T5 resets it. [007](../experiments/007-the-log-before-the-reset.md) and [010](../experiments/010-the-log-before-the-second-reset.md) are the precedent and the format. |
| watch out | **A reset spends the measurements and nothing else** ([0061](../decisions/0061-the-recipe-is-the-pipeline.md) §7). [012](../experiments/012-where-the-turns-go.md) is a fold over this log — $0.104 a turn, the fix loop at 49% of everything, 231 review refusals against 74 accepts — and **none of it can be recomputed afterwards.** This ticket is what makes the reset cost nothing that was worth keeping. |

| | |
|---|---|
| **T5** | The conductor runs `pass.ts`; `run-once.ts` is deleted |
| kind | `tech-debt` |
| blocked by | T5b |
| what | The wiring, the deletion, and the reset. |
| watch out | **The largest single risk in this plan, and it is a Lingtai-runs-on-Lingtai risk rather than a code one.** The daemon holds the code it started with (0010), so the pass that lands this is running the old one; the reset happens under a stopped conductor and `lingtai restart` (0042) brings it back on the new code. Do not let this land unattended — it is the one ticket that should carry `agent:hold` until a person is at the keyboard. |

| | |
|---|---|
| **T6** | The rail draws ten steps |
| kind | `bug` |
| blocked by | T5 |
| what | `rail.tsx:109` draws `points.map(...)` — five segments — and highlights the one whose name matches the fold's label. During a fix round that label is `fixing round 1 of 3`, which is none of the five, so **no segment is marked and the eye lands on the last green one**. Observed on #179: the rail read as stopped at `prepared` while the run was eighteen minutes into a fix round at `proposed`. |

### Phase 3 — configure

| | |
|---|---|
| **T7** | `init` and `add` propose plugins for every step |
| kind | `feature` |
| blocked by | T3 |
| what | The repository is read and each step gets a proposed set — the package manager for `prepared`, the default branch for `admit`, the signed-in runtime for `implement`, the test script for `build`. [#161](https://github.com/steven-zhc/lingtai/issues/161) already does this for the five gate points. |
| watch out | **Detected is a default, not a replacement for being told** ([0046](../decisions/0046-lingtai-is-personal.md) §3), generalised from `runtime.agent` to every step. |

| | |
|---|---|
| **T8** | `doctor` names every plugin a step will run, and the one it cannot |
| kind | `feature` |
| blocked by | T3 |
| what | The step × plugin matrix as a row a person reads before a run: what each of the ten steps will do, and by name the plugin a step was given and cannot run. Not a dependency model — see the note where T0 used to be. |

### Phase 4 — the one genuinely new step

| | |
|---|---|
| **T9** | `design` — a document, before any code |
| kind | `feature` |
| blocked by | T5 |
| what | The only one of the ten with no trace on the log today. |
| why last | Five tickets have landed in one pass each after a design was written down; #179 without one took eleven. That is an anecdote, not a measurement — **it should be built when there is something to compare it against**, which is after the rest of this is running. |

### Independent — the gate's contents ([0060](../decisions/0060-the-gate-runs-unit-tests.md))

Neither of these blocks or is blocked by anything above. They can run at any
point, and the earlier the better: **they are what makes a red at `build` mean
the diff is wrong**, which every ticket above is then graded by.

| | |
|---|---|
| **T10** | A root vitest config, with `unit` and `integration` projects |
| kind | `tech-debt` |
| what | Twenty `vitest*.config.ts` files and no root config become one root config with two projects. The 44 files that leave the system move to `integration`; `pure/` becomes `unit/`. **Closes [#222](https://github.com/steven-zhc/lingtai/issues/222)** — one vitest run over every project reports every project, so there is no first-failure bail to be silent about. |
| watch out | **A tag does not stop a file being imported** — measured: a file whose every test is `@integration`, run under `--tagsFilter '@unit'`, still threw from module scope and still failed the run. Projects and include globs do the file-level split; tags are for the mixed file. And the `build` command lives in `~/.lingtai/lingtai/recipe.yml`, **outside every worktree, so an agent cannot change it** — a person does. |

| | |
|---|---|
| **T11** | The full suite runs after the merge |
| kind | `feature` |
| blocked by | T10 |
| what | A separate system, triggered by the merge into `main`, runs `integration`. A failure arrives as an issue with a `kind` label, which the queue takes on its next pass. |
| watch out | **`LINGTAI_TEST_DATABASE_URL` must not go through a pooler** ([#157](https://github.com/steven-zhc/lingtai/issues/157)) — on the pooler the same suite went `30 passed → 10 failed → 31 passed` on one commit inside an hour. And **`LINGTAI_DATABASE_URL` is never given to it**: that is this system's own log. |
| open | Whether that system opens the issue itself or a person does. The queue does not care; *who closes it* does. |

## 5. What is done when this is done

- [ ] A person reads `~/.lingtai/<project>/recipe.yml` downward and has read the pass
- [ ] `run-once.ts` does not exist
- [ ] The board's rail shows which of the ten steps a run is in, during a fix round included
- [ ] `rounds` is readable on `implement` and `restarts` on `claim` — the step each bounds — and no replaced `judge:` can widen either
- [ ] A red at `build` is a claim about the diff — no test in it leaves the system
- [ ] A `review` that returns nothing is a review that found nothing
- [ ] Every path into `end` has been through `build` and `review`
- [ ] A plugin a step cannot run is refused when the recipe resolves, by name
- [ ] Everything 012 measured is in a file before the log that carried it is reset

## 6. Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) — the ten
  steps, and the drawing.
- [0060](../decisions/0060-the-gate-runs-unit-tests.md) — what the `build` step
  runs, and why a test that leaves the system cannot be at a gate.
- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) — the file shape, and
  §7 for why nothing here is owed a migration.
- [012](../experiments/012-where-the-turns-go.md) — where the turns go. Most of
  the numbers quoted above come from here, and T5b is what preserves them.
- [`agent-runtimes-plan.md`](agent-runtimes-plan.md) — the other open epic
  (#198). It configures `implement`, so
  [0053](../decisions/0053-the-recipe-chooses-the-agent-for-each-role.md) is the
  pattern T3 generalises rather than something it replaces.
