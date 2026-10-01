# 0103 — The pipeline: a pass is ten fixed steps, four may refuse, and only `proposed` routes

**Status** accepted · 2026-10-01

Lingtai is a development pipeline, not a workflow builder. Every pass walks the
same ten steps in the same order; what each step *does* is the plugins the
recipe declares there, or that step's default plugin when it declares nothing.
The workflow keeps exactly three things for itself: the order, which four steps
may refuse (and what a refusal buys), and the rule that every step which does
not simply pass arrives at `proposed`, the one step that routes. A judge chooses
the next step from a set the workflow computed; it never sets the bounds.

## Context

What Lingtai runs is git-, diff- and issue-shaped: an issue is taken, a worktree
is cut, an agent commits to a branch, a build and a reviewer read the diff, the
branch is merged into a base, the issue is closed. Calling those stations
generic "extension points" hid half of them and made every one look equally
configurable. A refusal is not an ordinary return value — it buys a fix round
(roughly 31 agent turns), holds the ticket and may reach a person — so it
cannot be a plugin's to invent. And a pass must be bounded: if any step could
send work anywhere, a misconfigured plugin would loop on somebody's money and
never report a fault.

## Decision

1. **There are ten steps, in a fixed order, and the set is closed.** `claim`,
   `admit`, `prepared`, `design`, `implement`, `build`, `review`, `proposed`,
   `merge`, `end` — `Step`/`STEPS` in `packages/domain/src/events.ts`, and the
   spine the loop walks is that tuple and nothing else (`PASS` in
   `packages/conductor/src/pass.ts`). The UI, the recipe's `steps:` keys and the
   log share these names. `waiting` is not a step: it is where a pass rests until
   a person moves it. A step's contents are the recipe's; its existence is not.

2. **Every step is one kind of thing: a list of plugins.** A step's behaviour is
   the plugins at it, run in the recipe's order by `runActionPipeline`
   (`packages/actions/src/action.ts`); the first action that does not pass stops
   the list and the remaining entries are recorded as skipped. Nine steps run
   verdict-producing actions; `end` runs effects (`close:`, `labels:`, `refs:`)
   resolved against the pass's outcome, and runs on every outcome. Every verdict
   is stamped with `onSha`, the commit it is about, by the core rather than by
   the plugin; a step that moves the tree reports the new head. What a plugin
   is, and which plugins exist, is
   [0105](0105-a-plugin-is-a-declaration-and-an-implementation.md).

3. **Exactly four steps may refuse: `prepared`, `build`, `proposed`, `merge`.**
   `REFUSING_STEPS` in `pass.ts`, and only those can produce the `refused`
   ending. A plugin at a refusing step supplies the judgement, never the
   consequence. An action that says no at any of the other six is reported as
   `did-not-finish` with `because: "action-refused"`: no round is bought and
   nothing is routed. `review` is the deliberate exception to that: it returns
   findings and judges nothing, so a reviewer's `failed` makes `review` *pass*
   carrying its findings, and `proposed` judges them.

4. **A step ends one of seven ways, and the type says which go anywhere.**
   `StepEnding` in `pass.ts`:
   - `passed` — the pass moves to the next step on the spine.
   - `refused` — `{ because, at, detail }`: a machine-readable reason beside the
     words; only the four refusing steps.
   - `asked` — `{ at, detail }`, the question in the agent's words and no
     `because`. Only `admit`, `design` and `implement` can ask.
   - `did-not-finish` — `{ because, at, detail }`: a crash, a spent turn budget,
     a body that threw (`because: "threw"`), or a mechanical decline. It has no
     destination; the pass stops and a person looks.
   - `held` — a declared `human:` (or `watch:`) asked a person; the recipe has
     already decided, so it rests at `waiting` without a judge.
   - `never-ran` — the agent never started (quota, signed-out runtime); the
     conductor stands down rather than routing.
   - `routed` — `proposed`'s one decision: `{ to, why }`.

5. **Asked and crashed are different endings, not one ending and a string.**
   `asked` reaches the router; `did-not-finish` does not. The `NEEDS_INPUT` token
   is compared once, inside `runActionPipeline`, which answers `askedAt` beside
   `didNotFinishAt`; above it nothing branches on a `because` string to decide
   where a pass goes. They are separate events too: `StepAsked` and
   `StepDidNotFinish`. Neither buys a fix round.

6. **Every step that does not simply pass arrives at `proposed`.** A `refused`
   or `asked` ending at any of `ARRIVE_AT_THE_ROUTER` — `admit`, `prepared`,
   `design`, `implement`, `build`, `review`, `merge` — travels to `proposed`
   carrying its reason intact. `claim` has nothing to route (no item yet), `end`
   runs after the decision, and a `proposed` that refuses has nowhere above it to
   appeal to, so it rests at `waiting`. `proposed` also runs on the way through:
   a pass that sailed past has a recorded decision saying so, and that visit is
   where `review`'s findings are judged.

7. **The workflow computes the offer; the judge picks from it.** `onOffer` in
   `pass.ts` (mirrored by `stepsOnOffer` in `packages/conductor/src/judge.ts`)
   works out which destinations are *reachable* from where the pass got to, then
   which are *affordable* against two ceilings — `rounds` per pass and `restarts`
   per ticket (`runtime.limits.rounds`, `runtime.limits.restarts`):
   - `waiting` — always, and free, so every arrival is answerable.
   - `implement` — from `implement` or any later step; never from `prepared`,
     because no agent has written anything yet. Costs a round.
   - `build` — from `merge`: a conflict an agent resolved is new code written
     after review, so it goes back through `build` and `review`. That edge is
     what keeps *every path into `end` has been through `build` and `review`*.
   - `claim` (a requeue, ending this pass) — only on `proposed`'s way-through
     visit, the `findings` direction, and only while a restart is left. A red
     build or a conflict never buys a fresh worktree.
   - the step that asked — after `asked`, and nothing else, because only it knows
     the question.

   A judge is handed the set and never the counts. An answer outside the set is
   refused by name and the pass goes to a person (`askJudge`).

8. **Judges are declared at `proposed`, one per direction.** `judge:` is legal
   only at `proposed`. The direction (`JudgeWhen`) is read off the arriving
   ending by `directionOf` in `packages/conductor/src/pass-steps.ts`: `red` (any
   refusal before `merge`), `verify-failed` and `conflict` (from the merge lane),
   `needs-input` (an `asked` ending) and `findings` (`review`'s, judged on the way
   through). `judgeDeclaredAt` takes the first entry whose `when:` matches. A
   judge is either a built-in — `same-worktree`, a synchronous function that
   spends nothing (back to `implement` if offered, else a person) — or a runtime
   (`claude-code`, `codex`), which is an agent dispatched and paid for one
   answer, with optional `model:` and `limits:`. Where nothing is declared,
   `BUILT_IN_FOR` answers: `red` and `verify-failed` get `same-worktree`;
   `conflict`, `needs-input` and `findings` go to a person.

9. **Only `proposed` may send a pass to a person.** `waiting` has one way in. A
   `human:` or `watch:` is legal at `proposed` and nowhere else, so a hold
   declared there is reached on every pass one step before anything lands.
   A refusal with nothing an agent could be held to, or an answer nobody could
   parse, goes to a person whatever is declared.

10. **A step's default is a plugin, and an unconfigured step runs it.** No step
    has a built-in implementation. In `conduct.ts`, `actionsAt` runs the declared
    list when there is one and otherwise `defaultsAt(step)`: `claim` →
    `queue:` ("take the ticket"), `admit` → `worktree:` ("cut the branch"),
    `implement` → an `agent:` work action on `runtime.agent` ("write the
    change", prompt `""`), `merge` → `merge:` with `strategy: merge-commit`
    ("land the branch"). The other six default to nothing: an unconfigured
    `design` drafts nothing and `implement` is briefed from the issue alone; an
    unconfigured `proposed` answers with `BUILT_IN_FOR`. A declared list replaces
    the default entirely; an injected hold (`--no-merge`, a pending repair)
    composes with whatever runs, inserted before the lane.

11. **Legality is the plugin's own `at`, checked when the recipe resolves.** A
    recipe may declare a plugin at a step only if that plugin's `at` names the
    step (or `"*"`). `whyNoKindAt` in `packages/recipe/src/recipe.ts` refuses
    anything else by name, saying which steps the plugin does serve. There is no
    step × kind table; `packages/conductor/unit/step-matrix.test.ts` walks every
    cell and holds *accepted ⇒ runs*. A refused recipe takes no ticket at all:
    `conduct.ts` answers `stage: "recipe"` for every one.

12. **Rules about a step's neighbours are also refused at resolve.** At `claim`,
    one `queue:` or none; at `admit`, one `worktree:` or none. At `merge`, the
    `merge:` lane is the last entry and anything after it is refused (a check
    there would judge a change already on the base), and a written `merge:` list
    with checks but no lane is refused (it would pass having landed nothing).

13. **Configured and did not run is Lingtai's bug.** Every pass records its plan
    in `StepsResolved`, all ten steps with the action names the recipe declared at
    each, beside the `configHash`, so a declared
    action that produced no verdict is detectable by comparing plan to verdicts.
    A configured step whose body cannot run throws, and the loop reports that as
    the step's own `did-not-finish` rather than losing the pass, so `end` still
    runs.

## Consequences

- The system can propose a configuration at `lingtai init`/`lingtai add`,
  because it knows what each step is for; detected values are defaults the
  person may override.
- Every loop passes through `proposed`, so every loop is bounded by two numbers
  the workflow owns. A replaced or paid judge can choose badly, but it costs one
  pass and stops at a person; it cannot widen a ceiling it never sees.
- A recipe that declares an `agent:` at several steps buys several agents; the
  schema does not flag that, and `runtime.limits` is the only bound.
- Replacing a default replaces the work: a `merge:` step that omits the lane
  lands nothing, and a recipe that declares its own `claim` list decides which
  tickets are taken.
- `build` runs before `review` and a red build skips the reviewer: a diff that
  does not compile is never paid to be reviewed.
- An ending's discriminant lives on the event type (`StepAsked` vs
  `StepDidNotFinish`), so a future split of an ending needs its discriminant on
  the event before the split, or an upcaster has nothing to read.

## Not built yet

- **`[]` meaning "run nothing".** The recipe's `StepMap` resolves an explicit
  `[]` and an omitted key to the same value, so `admit: []` still cuts a
  worktree and `merge: []` still merges. The accepted rule is that `[]` runs
  nothing, landed together with a resolve-time refusal (keyed on a recipe
  version) for any recipe whose `[]` has not been re-decided.
- **A plugin's `at` carrying the step body.** `at`'s keys decide legality today;
  every value is the `notBuiltYet` placeholder, and what runs is built by
  `actionsFromRecipe` (`packages/actions/src/from-recipe.ts`) with ports from
  `conduct.ts`. The ten step bodies stay in `packages/conductor/src/pass-steps.ts`.
  See [the-plugin-body.md](../design/the-plugin-body.md).
- **An `ask-or-assume` built-in judge for `needs-input`.** Only `same-worktree`
  exists; `needs-input` reaches a person unless a runtime judge is declared.

---
*Replaces archived 0014, 0015, 0016, 0018, 0058, 0059, 0064, 0065, 0068 in [decisions-archive](../decisions-archive/).*
