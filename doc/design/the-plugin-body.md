# The plugin body — what stands between `at`'s keys and `at`'s values

**Status** a finding, not a plan · **Date** 2026-09-26 · **About**
[0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §§2–3, 5
and the ticket that was to build them
([#262](https://github.com/steven-zhc/lingtai/issues/262))

`#261` landed 0064's first half: `at`'s **keys** are what make a plugin legal at
a step, `definePlugin` takes them, `whyNoKindAt` reads them, and the table is
gone. `#262` was to land the second half — *`at`'s value is the function, typed
for that step: `StepBody<S>`* — and it was written on the premise that **the
types already exist**.

They exist. What does not exist is a shape a runnable plugin can return through
them, and **three separate things say so.** None of the three is a difficulty in
the rewrite; each is a decision 0064 defers and `#262` assumes. They are written
down here so that the ticket after this one starts from the decision rather than
from the discovery.

## 1. An action's verdict is not an `EndingAt<S>`, and the difference is the workflow's

This is the one that cannot be plumbed around.

`endingOf` (`packages/conductor/src/pass.ts:1473`) maps a `PipelineResult` onto a
`StepReport`, and **it is keyed on the step, not on the verdict**:

- a `failed` at `review` becomes `{ ending: "passed" }` — *a reviewer returns
  findings with a severity and no verdict* (0058 §3);
- a `failed` at one of `REFUSING_STEPS` becomes `refused`, with everything a
  refusal buys — a fix round, a held item, possibly a person;
- a `failed` anywhere else becomes `did-not-finish`, because *a step that may
  not refuse has not refused*.

[the-pipeline.md](the-pipeline.md) already records this as the finding T5 needed:
*`review` judges nothing only because `endingOf` says so, and that is not a
body.*

**So a plugin whose `at["*"]` returned `EndingAt<S>` would be deciding what its
own `failed` means.** That is the half 0064 §6 reserves in as many words — *a
migration ticket must say, for its step, which half is moving; one that moves the
workflow's half into a plugin has given away something no recipe should be able
to get wrong.* A `run:` action that exits 1 knows it exited 1. Whether that is a
refusal is `spec.refuses`, and no plugin may hold that.

**And `EndingAt` has nowhere to put the two things the verdict carries.**
`StepPassed` is `{ ending: "passed" }` and an optional `head`; there is no
`evidence` and no `findings` on any of the six endings. Both are carried on
`PipelineResult.results` (`packages/actions/src/action.ts:203`) *on purpose*, and
`pass.ts:409` says why: `proposed` routes on `build`'s verdict and `review`'s
findings, **neither of which is a `StepEnding`** — a review that found a blocker
and a review that found nothing both end `passed`. `findingsIn`
(`pass.ts:1346`) reads them off `results` to build the next lap's `recheck`, and
`GatePassed` and `GateFailed` carry them onto the log (`action.ts:303`).

A body returning `EndingAt<S>` and nothing else drops both. That is not a
refactor with a behavioural side effect; it is *an action that ran but whose
verdict was never recorded*, which `#262`'s own watch-out names as the failure
the design exists to remove.

**The way out is a decision, and it is one of two.** Either the six endings grow
the two fields an action's verdict carries — at which point `EndingAt<S>` is the
plugin's return type and `endingOf`'s step-keyed translation has to move to
somewhere a plugin cannot reach — or a **runnable** plugin's body is typed by
something that is not `StepBody`, and 0064 §3's *`at`'s value at a step is
`StepBody<thatStep>`* is true of the ten step bodies and not of the four
runnable plugins. The second is smaller and says less; the first is what 0064 §2
is actually arguing for. Neither is `#262`'s to pick unasked.

## 2. A body is not told which declared entry it is

`StepWork` (`pass.ts:440`) carries `actions` — *everything the recipe declared
here, including you* — and no field saying **which** of them this call is for.
One `at["*"]` therefore cannot serve two `run:` actions at one step, and
[writing-a-plugin.md](../writing-a-plugin.md) tells a plugin author the opposite:
*do not assume that it is the only action at its step.*

`runActionPipeline` emits one event per action and `#262` requires that not to
change, so the per-entry call has to exist. So either `StepWork` gains the entry
— the ticket's own *they move into what a `StepWork` carries* — or `at`'s value
is a constructor over the entry and `StepBody<S>` is its **return**, which is the
ticket's other clause, *what the caller binds into the function*. The ticket says
both and they are different types.

## 3. The plugins are declared a package below the types

`StepBody` is `packages/conductor/src/pass.ts:532`. The twelve plugins are
`packages/recipe/src/recipe.ts`, and `@lingtai/recipe` depends on
`@lingtai/domain`, `@lingtai/env`, picomatch, yaml and zod — nothing else.
`@lingtai/actions` depends on `@lingtai/recipe`; `@lingtai/conductor` depends on
both. So typing `at`'s value as `StepBody<S>` where the plugins are declared
needs `@lingtai/recipe` to see `StepWork` and `EndingAt`, which need
`ActionContext`, `ActionEvent` and `PipelineResult` from `@lingtai/actions` and
`TerminalOutcome` from `conductor/src/end-step.ts`. That edge is a cycle.

Moving the **bodies** has the same shape and is larger: `createProcessAction`
wants `runCommand` and a child process, `createAgentAction` wants a `Runtime`
from `@lingtai/agent`. [writing-a-plugin.md](../writing-a-plugin.md) already
tells an author their plugin *lives in the tree: `packages/recipe/src/` beside
the twelve that exist*, so the page has picked a side; the package graph has not
been moved to match it.

**Two ways, and they are opposite.** Either the pass's type vocabulary moves
*down* into `@lingtai/recipe` — the endings and `Destination` are plain data over
`Step` and cost nothing, but `ActionContext` drags `RunTrace` and
`@lingtai/agent` behind it — or the twelve declarations move *up* out of
`@lingtai/recipe` into a package that can see the pass, which means `StepMap` and
`actionsAt` stop being module-level schemas bound to `PLUGINS` and become
functions of a plugin set. The second matches the layering (`recipe` is the
schema package; the pass is above it) and is the bigger diff, because
`RecipeFile` is built on `StepMap`.

## What is landable before either decision

Nothing in `#262`'s *Done when* list. Its first three rows are the decision in
§1 and §3; its fourth — *a test asserts the call site is never reached with an
absent body* — needs a body to be absent from. `at`'s values are `notBuiltYet`
until then, and that symbol is doing the job 0064 §5 asks of it: it cannot be
called, by the type and by the runtime.

**T5d is not blocked by any of this.** It adds `build` to `runPlugin.at` and
`review` to `agentPlugin.at` — two keys, and the keys half is built.

## Related

- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §§2, 3,
  5, 6 — the decision. §6 names the cost of the move and reserves the workflow's
  half; §1 above is that reservation meeting `endingOf`.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §2 — *the
  workflow fixes which steps may refuse*, which is why a verdict and an ending
  are not one type.
- [writing-a-plugin.md](../writing-a-plugin.md) — the page whose *half built*
  note is what §§1–3 are the other half of.
- [the-pipeline.md](the-pipeline.md) — T5d, and the `endingOf` finding at T5.
