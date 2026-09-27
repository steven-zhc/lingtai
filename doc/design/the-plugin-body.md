# The plugin body — what stands between `at`'s keys and `at`'s values

**Status** a finding, not a plan — and one of its four is answered
([#274](https://github.com/steven-zhc/lingtai/issues/274): the `judge:` **key** is
open at `proposed` and a lookup reads it; `at`'s *value* is still `notBuiltYet`,
which is what the rest of this page is about) · **Date** 2026-09-26 ·
**About**
[0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §§2–3, 5,
7 and the two tickets that were to build them
([#262](https://github.com/steven-zhc/lingtai/issues/262),
[#267](https://github.com/steven-zhc/lingtai/issues/267))

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

**The ticket after it was `#267`**, and it narrowed the subject from the four
runnable kinds to one plugin — `judge:` at `proposed`, 0064 §7. That clears two
of the three (§4) and finds a fourth thing the narrower subject makes visible:
**a step has exactly one body, and `proposed` already has four plugins declaring
themselves at it** (§5). So `at`'s value is not one kind of function, and that is
the decision, rather than the cycle being the only obstacle. `#267`'s own *watch
out* — the budget half — needed none of it and is landed.

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
`StepPassed` and `StepFailed` carry them onto the log (`action.ts:303`).

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

## 4. `judge:` at `proposed` asks the same three questions, and answers two of them

`#267` is `#262` narrowed to one plugin: *move `pass-steps.ts`'s `proposed` body
into `judgePlugin`'s `at.proposed`*. It is a better-chosen subject than the four
runnable kinds, and it says so by clearing two of the three above.

- **§1 does not bite.** `judge:` never becomes an `Action` (0064 §2 lists it
  among the eight that are not), so nothing in it translates a `PipelineResult`
  and nothing in it decides what its own `failed` means. Its answer genuinely
  *is* an `EndingAt<"proposed">`: `StepRouted { to, why }`, which is the type
  0064 §7 points at, and the evidence and findings it reads arrive on
  `StepWork.reached` rather than needing somewhere on an ending to sit.
- **§2 does not bite in its own form.** The four runnables need *which entry am
  I*, because `runActionPipeline` calls one per declared entry. A judge does not:
  `proposed` holds **one `judge:` entry per `when:`** (`judgePlugin`, 0061 §3),
  and the body's job is to pick the entry matching the direction the arrival
  came by. So it wants the whole declared list, which `StepWork.actions` already
  carries verbatim.
- **§3 bites unchanged.** `StepBody` is `packages/conductor/src/pass.ts`;
  `judgePlugin` is `packages/recipe/src/recipe.ts`; `@lingtai/recipe` depends on
  `@lingtai/domain`, `@lingtai/env`, picomatch, yaml and zod. A body that is a
  value of `judgePlugin.at.proposed` has to be written where `judgePlugin` is
  written, and that package cannot see `StepWork`, `EndingAt` or the
  `ActionContext` and `ActionFinding` they are built from. §3's two ways out are
  the same two ways out.

## 5. And one `#267` finds that `#262` did not: a step has one body and `proposed` has four plugins

This is the one that makes *`at`'s value is `StepBody<thatStep>`* wrong rather
than merely unreachable.

`StepBodies` is `{ readonly [S in Step]: StepBody<S> }` (`pass.ts:547`) and
`runStep` calls `bodies[spec.step]` **once** per visit. A step has exactly one
body, by construction and on purpose: *a step whose body were absent would have
to mean pass* (0016 §4).

A step does not have one plugin. Since `#261` the keys say so, read off the
twelve `at`s and not off a table:

```
claim design implement         —                                      0
admit                          worktree                              1   ← #268
prepared                       run                                    1
build                          run                                    1   ← T5d
review                         agent                                  1   ← T5d
proposed                       run · agent · watch · human · judge    5   ← #274
merge                          run · agent · watch · human            4
end                            close · labels · refs                  3
```

So three of the ten steps have more than one plugin declaring themselves
there, and `#274` made `proposed` five — the case this section predicted, arrived.
**`at`'s value cannot be the
step's body**, because four of those five are not bodies of the step at all:

- a `run:` or an `agent:` at `proposed` is **an action's** function — called once
  per declared entry, by `runActionPipeline`, producing an `ActionResult` whose
  meaning the step then decides (§1);
- a `close:` at `end` is an **effect** — not called by any pipeline, resolved
  against the outcome by `resolveEndActions` and carried out by `tell.ts`;
- a `judge:` at `proposed` would be the **step's** function — called once per
  visit, producing the ending itself. Which is why `#274` did not put one there:
  `at.proposed` carries `notBuiltYet` like every other key, and the thing that
  reads the declaration is a lookup the *router* calls (`judgeDeclaredAt`). The
  cell is open and this decision is still open with it.

Three kinds of function under one key, and 0064 §3 says there is one. That is not
a typing difficulty to be worked around with a union: the three differ in *how
often they are called and by whom*, so a call site that read `at[step]` and
invoked it would have to know which kind it had — and knowing that from the key
alone is the table 0064 deleted, read down a third axis.

**The decision `#267` needs, stated so it can be made:** `at`'s value is one of
two things, and the plugin says which. Either the record is keyed by kind —
`at: { proposed: { step: … } }` against `at: { "*": { action: … } }` — or the
step-body plugins are a separate declaration from the action plugins, and
`servesStep` answers a different question for each. The second matches what is
true today: `judge:`, `queue:`, `merge:` and `backlog:` are not actions and never
were, and 0064 §2 opens by saying exactly that. **`worktree:` was the fifth on
that list and `#268` settled it the other way**: it *is* an action — a
`WorktreeActionDeps` and an `ActionResult` like the other four kinds — so the cut
runs once per declared entry through `runActionPipeline`, and what made it look
like a step's own function was only that `admit`'s body used to call it.

### And an agent judge has no dispatch on that side of the line

`JudgeName` was `BUILT_IN_JUDGES | RuntimeId` — `same-worktree`, `claude-code`,
`codex`. A declared `judge: same-worktree` is a pure function and could live
anywhere. A declared `judge: claude-code` is **an agent, paid for a judgement**,
and dispatching one needs a `Runtime` from `@lingtai/agent` and a prompt: it is
§3's *what the caller binds into the plugin's function*, which is the clause that
makes `at`'s value a constructor rather than a body. `ports.judge` is that seam,
in `conduct.ts`.

So a `judge:` that only answered the built-ins would accept `judge: claude-code`
at resolve and run nothing for it — `#61`, through the door this repository has
decided it will not leave open.

**`#274` resolved that by narrowing the enum, which is the same rule read the
other way.** `JudgeName` is `z.enum(BUILT_IN_JUDGES)` now: one legal name,
answered by a synchronous function, and a runtime refused at the line it is
written. *The enum says what the code does, and grows when the code does*
(`BUILT_IN_JUDGES`), so the day the dispatch lands the runtimes go back in with
it. The cost is stated where an operator reads it — `doc/reference.md`
§`judge:` — and it is the direction 0061 §3 calls the judgement: **`findings`
has no built-in, so it still reaches a person.**

**What that did *not* need is either decision above.** The reader is
`judgeDeclaredAt` in `packages/conductor/src/judge.ts` and it is a lookup — *the
one entry whose `when:` matches* — so `at.proposed` carries `notBuiltYet` like
every other key, `judgePlugin` stays where the twelve are declared, and §§1–3 and
§5 are all still open. The body did not move; the key opened, and something read
it. `pass-steps.ts`'s `proposed` still decides, which is what keeps `chose` and
the spent ceiling on the card (`#271`).

## What is landable before either decision

**`#274` is the answer to this section and is landed**: `judge:` is declarable at
`proposed`, and nothing below had to be decided for it. What made that possible is
that the ticket wanted *the cell reachable* and read the body's move as the way to
get there; the key and a reader are the way to get there, and the body is a
separate question this page is still about.

Nothing else. Nothing in `#262`'s *Done when* list, and nothing in `#267`'s
second row.
`#262`'s first three are the decision in §1 and §3; its fourth — *a test asserts
the call site is never reached with an absent body* — needs a body to be absent
from. `#267`'s remaining one is §3 and §5. `at`'s values are `notBuiltYet` still, and
that symbol is doing the job 0064 §5 asks of it: it cannot be called, by the type
and by the runtime.

**`#267`'s *watch out* is landable on its own, and it is landed.** 0064 §7's
other half — *the plugin chooses; the workflow still bounds what the choice
costs* — is the pass's and touches no plugin: `onOffer` answers an `Offer` of
`reachable` and `affordable`, `ceilingFor` reads which ceiling the subtraction
between them was, and the sentence a person gets names it. That had to be true
**before** a plugin could return any destination, and it is the half a plugin
must never be given.

**T5d was not blocked by any of this and has landed.** It added `build` to
`runPlugin.at` and `review` to `agentPlugin.at` — two keys — on 2026-09-27
(`a417908`), and `#268` added `admit` to `worktreePlugin.at` the same way. Neither
needed any of §5's decision, which is the evidence for the paragraph above: a key
opens and the step's body empties, and what `at`'s *value* should be is a separate
question that only a step-body plugin forces.

## The block a person pastes, now that the key is open

`#267` asked for this and `#274` opened the cell it needed; both ask for the
recipes not to be edited: they are
`~/.lingtai/<project>/recipe.yml`, one per project on the machine that conducts,
outside every worktree, and an agent cannot reach them. There are two on this
machine — `lingtai` and `nextloom-ai-admin`.

**The sequence is *code, restart, paste*, and the restart is not optional.**
`PLUGINS` and each plugin's `at` are module constants the daemon loaded at start
(0010: *the source runs unbuilt* removes the build, not the restart), while the
recipe is read on every pass. So a recipe naming a plugin at a step the running
daemon's `at` does not carry is refused at resolve — **every** pass, until it
restarts, which is `conduct.ts` answering `stage: "recipe"` and taking nothing
at all.

    pnpm lingtai restart "picking up the judge at proposed"

**That restart is the whole of what stands between `#274` landing and these
blocks working**, and it is now the ordinary case rather than the hypothetical
one. `judgePlugin.at` carries `proposed` in the merged code; a daemon that
started before the merge has the `{}` it loaded, and under 0064 §4 that is a
declaration and not an omission — *no step reads a `judge:` action* — so
`resolveRecipe` refuses the entry, `conduct.ts` answers `stage: "recipe"`, and it
takes **no ticket at all** until either the process restarts or the block comes
back out. Paste before the restart and the queue stops; that is why the sequence
is *code, restart, paste*, in that order.

**`lingtai` — what the default already does, said out loud.** Both entries are
the mechanical directions and `BUILT_IN_FOR` answers both identically, so this
changes no behaviour. That is the point: it is the first version of these two that
a person can *edit* — and what the log says changes, because the route names the
entry rather than the built-in (`#274`).

**And since `a417908` this block is the whole of `proposed:` rather than an
addition to it.** T5d landed: the build is at `build:` and the cold reviewer at
`review:`, which is not a tidy-up — it is what makes these entries reachable at
all. `ARRIVE_AT_THE_ROUTER` (`pass.ts:913`) lists the seven steps whose refusal
*travels* to the router, and `proposed` is not one of them, because it **is** the
router. So a build refusing at `proposed:` set `stoppedAt` and broke the loop
before `ports.judge` was ever called (`pass.ts:1330`) — the judge could not have
been asked no matter what was written here. Refusing at `build:` arrives.

```yaml
proposed:
  - name: a red build is the agent's to fix, in the worktree it is already in
    judge: same-worktree
    when: red
  - name: a merge whose re-verify went red is the same fix on a moved base
    judge: same-worktree
    when: verify-failed
```

`conflict`, `needs-input` and `findings` are left undeclared, and that is this
repository choosing what it already has: no built-in answers them, so each
reaches a person, and `findings` is the one 0061 §3 measured at 231 refusals and
calls the one judgement worth an agent — it wants `judge: claude-code`, which
wants the dispatch §5 says is not there yet.

**`nextloom-ai-admin` — every refusal reaches a person, which is what a managed
repository that is not Lingtai should almost certainly say.** And it is the one
block `#274` did **not** make pastable: 0064 §7's own worked example names
`judge: always-waiting`, and `BUILT_IN_JUDGES` has one entry and it is not that.
Nothing in that project's recipe is the wrong shape — the name is simply one no
code answers, and *that* is what the schema refuses.

```yaml
proposed:
  - name: everything comes to me
    judge: always-waiting   # ← not a name the schema accepts yet
    when: red
  # …and one per `when:`, because `when:` is required and undefaulted…
```

*The enum says what the code does, and grows when the code does*
(`BUILT_IN_JUDGES`). So a ticket adds one more built-in beside it — a `BuiltIn`
returning a person, which is synchronous and therefore spends nothing by its type
— or that project writes `rounds: 0` instead, which 0064 §7 is careful to say is
**not** the same thing: a ceiling makes every spending choice unaffordable, and a
plugin choosing a person is a choice. It is also what that project has today by
declaring nothing at all, which is the cheapest of the three: with no entry for a
direction the router falls to `BUILT_IN_FOR`, and a person is the floor under
`conflict`, `needs-input` and `findings` (0064 §5 — absent is not empty, and here
they read the same).

## Related

- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §§2, 3,
  5, 6, 7 — the decision. §6 names the cost of the move and reserves the
  workflow's half; §1 above is that reservation meeting `endingOf`. §7 is
  `#267`'s subject, and its *What does not move* is the half that landed:
  `offering` stopped being a menu.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §2 — *the
  workflow fixes which steps may refuse*, which is why a verdict and an ending
  are not one type.
- [writing-a-plugin.md](../writing-a-plugin.md) — the page whose *half built*
  note is what §§1–3 are the other half of.
- [the-pipeline.md](the-pipeline.md) — T5d, and the `endingOf` finding at T5.
- [reference.md](../reference.md) §`judge:` — what an operator may write there
  today, and the sentence `#274` owes them: one legal name, and the judgement
  still a person's.
