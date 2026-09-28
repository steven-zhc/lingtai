# 0065 — The default at a step is a plugin, and an unconfigured step runs it

**Status** accepted · **Date** 2026-09-27 · **Changes**
[0061](0061-the-recipe-is-the-pipeline.md) §5's *what an omitted step resolves
to* · **Makes load-bearing** [0064](0064-a-plugin-declares-the-steps-it-implements.md) §5's
*absent is not empty*

The default workflow guarantees one thing: that the ten steps turn. No step has a
built-in implementation. Every function is a plugin's. A step the recipe says
nothing about runs that step's **default plugin**, which is how the default
behaviour arrives; a step the recipe declares something at runs what it declares,
and nothing else.

## 1. What is wrong today: the work is in two places, and only one of them is named

`runStep` runs a step's declared actions and then its body (`pass.ts:1443`,
`:1471`), and the body is where most steps keep their work:

```
claim      ports.take()                              admit     ports.cut(…)
design     ports.draft(briefOn("design", …))         implement ports.dispatch(briefOn("implement", …))
merge      ports.land(…)                             proposed  routes, in the body
prepared   —        build   —        review   —      end       resolves declared effects
```

Three bodies are empty, and those three are exactly the three steps a recipe can
describe completely. The other seven keep work a recipe cannot see, name, replace
or read. That is the asymmetry this repository has been living with: **the cold
reviewer is an `agent:` action a person can read and edit; the agent that writes
the code is `runtime.agent` in a machine config file.**

And the seam where a declared action becomes a runnable one already injects
actions the recipe never wrote — `conduct.ts:1494`:

```ts
const actionsAt = (step: Step, actions: readonly StepAction[]): readonly Action[] => {
  const declared = actionsFromRecipe(step, actions, stepDeps);
  return step === "merge" ? [...declared, ...alsoHeldAtMerge()] : declared;
};
```

`alsoHeldAtMerge` appends a `human:` for a pending repair and another for
`--no-merge`. So *the caller assembles the list, and it may put things in it that
the file did not* is not a new idea — it is load-bearing, and `--no-merge` is its
working precedent.

## 2. The decision

**A step's behaviour is its plugins', at all ten.** The default is not a code path
beside the plugin system; it is an entry in it.

- The recipe declares nothing at a step → `actionsAt` returns that step's default
  plugin, and the run records it by name like any other action.
- The recipe declares something → that runs, and the default does not.
- The recipe declares `[]` → **nothing runs.** This is the first thing 0064 §5's
  *absent is not empty* actually decides.

Each body then shrinks to `async () => ({ ending: "passed" })` as its work leaves
for a plugin, and the ten bodies become what `prepared`, `build` and `review`
already are.

## 3. Where the default lives

`conduct.ts`'s `actionsAt`, because that is already the one place that answers
*what actually runs here*:

```ts
const actionsAt = (step, actions) => {
  const declared = actionsFromRecipe(step, actions, stepDeps);
  const running = declared.length > 0 ? declared : defaultsAt(step);
  return step === "merge" ? heldBeforeTheLane(running) : running;
};
```

The last line was `[...running, ...alsoHeldAtMerge()]` while the landing happened
in `merge`'s body, after the whole pipeline. §8 is where it changed and why.

Not in the schema, and not in each plugin as a `default: true` flag. The schema's
job is *is this legal* (0064); asking it *and is this what runs when nothing is
written* would put two questions in one place, and the second one needs the
conductor's ports to answer.

`alsoHeldAtMerge` stays **outside** the substitution and keeps composing. That is
the distinction §6 turns on: a hold composes with whatever runs; a default
replaces what would have run.

## 4. The ten defaults — and four of them are already named

**`CALLED_DIRECTLY` is a list of defaults that are not plugins yet.** It was
written as an apology and reads, now, as a plan. `worktreePlugin`'s own comment
says so:

> It is 0061 §3's *name* for code the pass calls itself, so a recipe writing it
> anywhere is refused with `CALLED_DIRECTLY.worktree` — which says where the code
> is instead. **The day `admit` reads one, this gains a key and that entry goes,
> in the same diff.**

| step | default plugin | exists today |
|---|---|---|
| `claim` | `queue:` | `queuePlugin`, `at: {}` |
| `admit` | `worktree:` | `worktreePlugin`, `at: {}` |
| `prepared` | none — an empty step is honestly empty | — |
| `design` | an `agent:` that drafts | **new**: `agentPlugin` gains `design` |
| `implement` | an `agent:` that commits | **new**: `agentPlugin` gains `implement` |
| `build` | none | — |
| `review` | none | — |
| `proposed` | `judge:` | `judgePlugin`, `at: {}` |
| `merge` | `merge:` | `mergePlugin`, `at: {}` |
| `end` | none — `close:`/`labels:`/`refs:` already serve it | — |

So the work is: four `at` keys on plugins that already exist and already have
their fields, two steps where `agentPlugin` gains a key, and one `defaultsAt`
table. `backlogPlugin` is the fifth `CALLED_DIRECTLY` entry and needs a home
decided before it moves; it is not on this list.

## 5. What this fixes that was not the point

**A step can no longer be *configured and not run*.** Today an action declared at
a step nothing implements resolves, is recorded in `GatesResolved` as planned,
produces no verdict, and the board draws it `never-ran` — the mark reserved for
Lingtai's own bug (ADR 0016 §4). `#268`'s major finding is exactly that, for a
`worktree:` at `admit`. Under this decision the case cannot arise: a declared
action at a step is run by that step or the recipe did not resolve.

**And the skip stops being a state.** Six of the ten currently draw `skipped` on
every card *because nothing constructs a pipeline at them*. Under this decision
every step runs something, and a `skipped` segment means a person wrote `[]`.

## 6. The migration trap, and it is in this repository's own recipe

`merge: []` here means **"merge, and nothing holds it"**. Under this decision it
means **"do not merge"** — the merge is the default plugin, and `[]` says no
plugin. Same three characters, opposite behaviour, and the failure is silent: the
board would show a step that ran nothing and a branch that never landed.

So every `[]` in every recipe on the machine has to be read and re-decided, and
the diff that lands this must print the corrected block for both projects rather
than rely on anybody noticing. The two here today:

    admit: []       →  omit the key (the default cuts the worktree)
    merge: []       →  omit the key (the default merges); `[]` would stop merging
    proposed: []    →  omit the key once `judge:` is the default

A refusal is better than a re-read: `resolveRecipe` should refuse a v2 recipe
whose `[]` is indistinguishable from an omission until the file has been migrated,
rather than silently reinterpret it. The version number is the lever.

## 7. What it costs

**Every step becomes able to spend money.** Today `implement` dispatches an agent
because the body does; under this decision it dispatches one because the default
says so, and a person can replace that with something cheaper, more expensive, or
nothing. That is the point, and it is also the new footgun: a recipe declaring an
`agent:` at four steps buys four agents, and nothing in the schema knows that is
unusual. `runtime.limits` already bounds a pass's agent runs, and it becomes the
only thing that does.

**Two things must not both run.** The reason this is a decision and not a
refactor: `runStep` runs declared actions *before* the body and skips the body only
when they did not pass. So a half-migrated step — `agentPlugin.at.implement`
opened while `implement`'s body still dispatches — pays for **two agents on one
brief**, and the second spends a round bought for a fix. Each step moves in one
diff: the key opens, the default is registered, and the body empties, together.

## 8. The lane is the last action at `merge`, and a written `merge:` carries one

Added by [#270](https://github.com/steven-zhc/lingtai/issues/270), which is the
first step this decision opened whose action **changes something outside the
worktree**. The rule has two clauses, and the schema enforces both:

```
a `merge:` action is the last entry at its step,
and anything written after one is refused when the recipe resolves

a step that is written at all and that may land carries a `merge:`,
and a list of checks with no lane is refused when the recipe resolves

`merge: []` is neither of those. It is a step that runs nothing (§6),
and it resolves
```

**Nothing else here needed an ordering rule, and this one is not about order.** §2
says every declared action at a step runs and the step's ending is the pipeline's,
which is a complete account of a list of *checks*: they run, and the first that
does not pass is the step's answer. The lane is not a check. It moves `main`, and
once it has, the pass's ending is no longer a free variable — so a check written
after it runs on a change that has already landed, and its `no` is a verdict about
something nobody can now undo.

Concretely, before the refusal: `merge: [land the branch, {run: pnpm smoke}]` is
legal, the lane merges and pushes, `smoke` fails, `endingOf` reports `merge`
refused, `directionOf` returns null, the pass ends `blocked`. No `WorkItemLanded`
is appended, so `end`'s `when: landed` effects never run, the issue is never
closed, and the item goes back to the queue **with its diff on `main`** for a later
pass to work again. Two `merge:` entries reach the same state by the second lane
running over the first's merge. Neither is a bug in a step body; both are a list
the schema had no reason to refuse.

**The second clause is the expensive one, and it was missing while the first one
landed** (`3ef426b`, the cold reviewer's major on `#270`'s own diff). *Nothing
after the lane* is a rule about an entry that comes after the thing that lands, so
a list with no lane at all walked straight through it:

```yaml
merge:
  - name: smoke
    run: pnpm smoke
```

That resolved, ran, and **passed having landed nothing**. §2 again: every declared
action at a step runs and the step's ending is the pipeline's, so a list of green
checks with no lane reports `merge` passed — the pass routes it as merged, `end`
releases the claim, and the next pass buys a fresh agent for a diff still sitting
on the branch. Nothing red, nothing held, a bill every time. **That is why the
second clause is about money and the first is not**: the first leaves a diff on
`main` and a ticket blocked, which somebody eventually sees; this one leaves the
board saying merged while the same ticket is bought again, which nobody does.

**And `merge: []` is a different statement, which is why the rule cannot simply
require a non-empty list.** §6 gives the empty list its own meaning — a step that
runs nothing — and it is what this repository runs on. So the refusal asks *is
this step written, and does nothing in it land*, and an empty list is not written:
it resolves, as it always did.

**So the rule is at resolve and not at the seam.** `whyNoKindAt` answers *may this
step run this kind*, and these are questions about an action's neighbours — the
third and fourth such rules, beside `#268`'s *a step cuts one worktree or none*
and `#269`'s *a step takes one ticket or none*. All are in `actionsAt` in
`packages/recipe/src/recipe.ts`, all name the entry the other rule is about, and
all are refused before a ticket is claimed rather than discovered by a pass. The
second clause is scoped by `whyNoKindAt(step, "merge")` rather than by naming
`merge`, so it is the plugin's own `at` that decides where the rule applies (0064
§4) and a second step that lands does not get it silently skipped — and it is
asked only where every entry resolved, because a refused entry may have been the
lane.

**A hold is the caller's and composes ahead of the lane.** §3's snippet is
`heldBeforeTheLane` now rather than an append:

```ts
const heldBeforeTheLane = (running) => {
  const held = alsoHeldAtMerge();          // a pending repair, `--no-merge`
  if (held.length === 0) return running;
  const lands = running.findIndex((a) => a.kind === "merge");
  return lands === -1 ? [...running, ...held] : [...running.slice(0, lands), ...held, ...running.slice(lands)];
};
```

That keeps §3's distinction intact — a hold composes, a default substitutes —
while obeying this section: the hold goes after everything that checks and before
the thing that lands, which is what the old append *meant* while the landing was
in the body. Found by `kind` rather than by position, because a recipe may declare
its own checks before the lane and a `--no-merge` that silently stopped meaning
anything for such a recipe would be worse than one that refused.

**And a declared hold at `merge` is not the way to ask a person**, which is the
subtraction that makes the rule enough on its own. `humanPlugin.at` and
`watchPlugin.at` carried `merge` from before
[0058](0058-lingtai-is-a-development-pipeline.md); that ADR §3b gives `merge` three
ways out and the third is *anything else → `proposed`, **and only `proposed` may
send it to a person***. Both lose the key in `#270`, so the case this section is
about is narrowed to a check — and a person who wants the merge held writes the
`human:` at `proposed:`, which is before the lane and is where 0058's own open
question puts it.

## Related

- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 an `at` key is the
  declaration; §5 absent is not empty — reserved there, decided here.
- [0061](0061-the-recipe-is-the-pipeline.md) §3 named the code the pass calls
  itself; §5 said the file may omit a step and the resolved recipe may not. The
  second stands; what resolution *fills the omission with* is what changes.
- [0016](0016-the-settled-model.md) §4 configured and did not run is Lingtai's
  bug. §5 above is why this decision removes the case rather than guarding it.
- [0058](0058-lingtai-is-a-development-pipeline.md) §3 the ten steps and which
  four may refuse. Unchanged: this is about what runs at a step, not what a step
  may conclude.
