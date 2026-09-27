# The plugin body — what stands between `at`'s keys and `at`'s values

**Status** a finding, not a plan · **Date** 2026-09-26, §6 added 2026-09-27 ·
**About**
[0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §§2–3, 5,
7 and the three tickets that were to build them
([#262](https://github.com/steven-zhc/lingtai/issues/262),
[#267](https://github.com/steven-zhc/lingtai/issues/267),
[#268](https://github.com/steven-zhc/lingtai/issues/268))

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
claim design implement         —                        0
admit                          worktree                      1   ← #268
prepared                       run                           1
build review                   —                        0   ← T5d
proposed                       run · agent · watch · human   4
merge                          run · agent · watch · human   4
end                            close · labels · refs         3
```

So three of the ten steps already have more than one plugin declaring themselves
there, and `#267` would make `proposed` five. **`at`'s value cannot be the
step's body**, because four of those five are not bodies of the step at all:

- a `run:` or an `agent:` at `proposed` is **an action's** function — called once
  per declared entry, by `runActionPipeline`, producing an `ActionResult` whose
  meaning the step then decides (§1);
- a `close:` at `end` is an **effect** — not called by any pipeline, resolved
  against the outcome by `resolveEndActions` and carried out by `tell.ts`;
- a `judge:` at `proposed` would be the **step's** function — called once per
  visit, producing the ending itself.

Three kinds of function under one key, and 0064 §3 says there is one. That is not
a typing difficulty to be worked around with a union: the three differ in *how
often they are called and by whom*, so a call site that read `at[step]` and
invoked it would have to know which kind it had — and knowing that from the key
alone is the table 0064 deleted, read down a third axis.

**And `#268` found a fourth that is not a function at all** (§6): a `worktree:`
at `admit` is a **setting** — the base a pass is cut from — read by
`settings.ts` when the recipe resolves and acted on by code that was already
running. It is the one kind that needs no decision, because nothing calls it.

**The decision `#267` needs, stated so it can be made:** `at`'s value is one of
two things, and the plugin says which. Either the record is keyed by kind —
`at: { proposed: { step: … } }` against `at: { "*": { action: … } }` — or the
step-body plugins are a separate declaration from the action plugins, and
`servesStep` answers a different question for each. The second matches what is
true today: `judge:`, `queue:`, `worktree:`, `merge:` and `backlog:` are not
actions and never were, and 0064 §2 opens by saying exactly that.

### And an agent judge has no dispatch on that side of the line

`JudgeName` is `BUILT_IN_JUDGES | RuntimeId` — `same-worktree`, `claude-code`,
`codex`. A declared `judge: same-worktree` is a pure function and could live
anywhere. A declared `judge: claude-code` is **an agent, paid for a judgement**,
and dispatching one needs a `Runtime` from `@lingtai/agent` and a prompt: it is
§3's *what the caller binds into the plugin's function*, which is the clause that
makes `at`'s value a constructor rather than a body. `ports.judge` is that seam
today, in `conduct.ts`, and it answers `noJudge` because the schema refuses the
cell.

So a `judge:` body that only answered the built-ins would accept
`judge: claude-code` at resolve and run nothing for it — `#61`, through the door
this repository has decided it will not leave open.

## 6. `worktree:` at `admit`, and the half of a step that can move without either decision

`#268` is `#262` narrowed a third time — *move `pass-steps.ts`'s `admit` body
into `worktreePlugin`'s `at.admit`* — and it is the first of the three where
something shipped. What shipped is **not** the body. It is worth separating the
two, because the ticket's own *Problem* row is about the half that did move:

> `admit` cuts the worktree, from `repo.base` and `repo.submodules` at the
> recipe's top level. A project cannot say *cut it differently* because there
> is nowhere to say it.

**That half is configuration, and it needed no decision at all.** `worktree:`
declares `at: { admit: notBuiltYet }`, so a recipe may write the base and the
submodules on the step that owns them; `baseOf` and `submodulesOf` in
`packages/recipe/src/settings.ts` read the declaration and fall back to
`repo:`, which is therefore the v1 spelling of those two fields rather than a
second home for them. Nothing else changed — not `conduct.ts`'s
`repo.provision` call, not the eleven callers that ask for a base — because
`settings.ts` exists for exactly this move and says so at its head.

**The other half is the body, and it is blocked where `#267` was blocked.**

- **§1 does not bite.** `worktree:` never becomes an `Action` — it is one of
  0064 §2's eight — so nothing in it translates a `PipelineResult` and nothing
  decides what its own `failed` means.
- **§2 does not bite in its own form.** `admit` holds one `worktree:` entry,
  and `settings.ts` takes the first: a pass cuts one tree, so there is no
  reduction over several to invent.
- **§3 bites harder than it did for `judge:`.** A built-in judge is a pure
  function and could live anywhere; an `admit` body cannot. It has to call
  `provisionWorktree` in `@lingtai/repo` and `host.unhookedSettings` in
  `@lingtai/agent`, and return an `EndingAt<"admit">` from
  `@lingtai/conductor`. `@lingtai/recipe` depends on `@lingtai/domain`,
  `@lingtai/env`, picomatch, yaml and zod. So this is §3's *what the caller
  binds into the plugin's function* demonstrated rather than predicted: `at`'s
  value here is a **constructor over the worktree provisioner**, never a body
  that could be written beside the schema.
- **§5 bites in its weakest form and its strongest at once.** `admit` has one
  plugin, so there is no *which of the four am I* to answer — and the type that
  would have to change is `PluginSteps`, which all twelve plugins share, so
  opening `at`'s value for `admit` opens it for `run:`'s `"*"` in the same
  line. The decision is not avoidable by picking a narrow step.

### The fourth kind, and why `#61`'s guard survives it

So `admit` is now a step whose **setting** a recipe declares and whose work is
still the pass's own. That is a kind §5 did not have: not an action's function,
not an effect, not the step's body — a value read once when the recipe
resolves, by code that was already running.

The guard that has to survive is `#61`'s — *accepted, resolved, drawn, and
never called.* It survives because the declaration genuinely has a reader, and
`packages/conductor/unit/step-matrix.test.ts` is where that is held: `runsAt`
had two doors, the action pipeline and `end`'s resolver, and it has a third
now. The cell asserts `baseOf` answers with the declaration **and** that it
differs from what `repo:` says underneath, so a reader that quietly ignored the
step would fail rather than pass by agreeing.

`actionsFromRecipe` is where the shape shows: it drops a `worktree:` entry
rather than building an `Action` for it and rather than throwing, which is the
one thing in this diff that reads as the rule at the head of that file being
bent. It is not — *an action that is silently absent is worse than a run that
will not start* is about a declaration with **no** reader, and this one has one
named two lines above it.

### The blocks a person pastes, and what they change

**Nothing, and that is the point.** Both blocks below say what each recipe's
`repo:` block already says, so the first pass after pasting cuts the same tree
from the same branch. What they buy is that the value is now on the step that
owns it, and editable there.

The recipes are `~/.lingtai/<project>/recipe.yml`, one per project on the
machine that conducts, outside every worktree; an agent cannot reach them and
`#268` did not edit them. **The sequence is *code, restart, paste*** and the
restart is not optional: `PLUGINS` and each plugin's `at` are module constants
the daemon loaded at start, so a recipe naming `worktree:` at `admit` is
refused at resolve by a daemon that has not restarted — **every** pass, with
`conduct.ts` answering `stage: "recipe"` and taking nothing at all.

    pnpm lingtai restart "picking up the base at admit"

**Unlike §5's judge blocks, these two can actually be pasted** once that
restart has happened: the key exists in the code and `settings.ts` reads it.

`lingtai` — the values are `main` and `false`, which is what
[`.lingtai/config.yaml`](../../.lingtai/config.yaml) records as the reason each
is what it is:

```yaml
admit:
  - name: cut the branch from main, without submodules
    worktree:
      base: main
      submodules: false
```

`nextloom-ai-admin` — **the same block with that project's own two values**,
and they are to be copied from its file's `repo:` block rather than assumed: a
base written from memory is a pass cut from the wrong branch, which is the one
failure at this step that is loud on the first run rather than quiet
(`#268`'s *watch out*).

```yaml
admit:
  - name: cut the branch
    worktree:
      base: <whatever that file's `repo.base` says>
      submodules: <whatever that file's `repo.submodules` says>
```

**`repo:` stays in both files for now.** It is what a recipe that declares
nothing at `admit` falls back to, so deleting it is a separate step that wants
the schema to stop requiring it — and that is the ticket that finishes 0063 §2
for these two fields rather than this one.

## What is landable before either decision

Nothing in `#262`'s *Done when* list, and nothing in `#267`'s first two rows.
`#262`'s first three are the decision in §1 and §3; its fourth — *a test asserts
the call site is never reached with an absent body* — needs a body to be absent
from. `#267`'s are §3 and §5. `at`'s values are `notBuiltYet` until then, and
that symbol is doing the job 0064 §5 asks of it: it cannot be called, by the type
and by the runtime.

**`#267`'s *watch out* is landable on its own, and it is landed.** 0064 §7's
other half — *the plugin chooses; the workflow still bounds what the choice
costs* — is the pass's and touches no plugin: `onOffer` answers an `Offer` of
`reachable` and `affordable`, `ceilingFor` reads which ceiling the subtraction
between them was, and the sentence a person gets names it. That had to be true
**before** a plugin could return any destination, and it is the half a plugin
must never be given.

**T5d is not blocked by any of this.** It adds `build` to `runPlugin.at` and
`review` to `agentPlugin.at` — two keys, and the keys half is built.

**And neither is a plugin whose step reads it as a setting**, which is what
`#268` landed at `admit` — §6.

## The block a person pastes, the day the body lands

`#267` asks for this and for the recipes not to be edited: they are
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

**Neither block below can be pasted today, and the restart is not what is
missing.** `judgePlugin`'s `at` is `{}` (`packages/recipe/src/recipe.ts:624`),
which under 0064 §4 is a declaration and not an omission — *no step reads a
`judge:` action* — so `resolveRecipe` refuses one **anywhere**, naming
`CALLED_DIRECTLY.judge` to say where the code is instead, and `conduct.ts`
answers `stage: "recipe"` and takes no ticket at all until the block comes back
out. The failure the restart above answers is the *other* one: an `at` that
gained a key in code the running daemon has not loaded. This is a key no version
of the code has yet — which is why the sequence is *code, restart, paste*, and
why the code is first.

**`lingtai` — what the default already does, said out loud.** Both entries are
the mechanical directions and `BUILT_IN_FOR` answers both identically, so on the
day the body lands this changes no behaviour. That is the point: it is the first
version of these two that a person can *edit*.

```yaml
proposed:
  # …the build and the cold reviewer stay here until T5d…
  - name: a red build is the agent's to fix, in the worktree it is already in
    judge: same-worktree
    when: red
  - name: a merge whose re-verify went red is the same fix on a moved base
    judge: same-worktree
    when: gate-failed
```

`conflict`, `needs-input` and `findings` are left undeclared, and that is this
repository choosing what it already has: no built-in answers them, so each
reaches a person, and `findings` is the one 0061 §3 measured at 231 refusals and
calls the one judgement worth an agent — it wants `judge: claude-code`, which
wants the dispatch §5 says is not there yet.

**`nextloom-ai-admin` — every refusal reaches a person, which is what a managed
repository that is not Lingtai should almost certainly say.** This block carries
a second reason on top of the empty `at`: 0064 §7's own worked example names
`judge: always-waiting`, and `BUILT_IN_JUDGES` has one entry and it is not that.

```yaml
proposed:
  - name: everything comes to me
    judge: always-waiting   # ← not a name the schema accepts yet
    when: red
  # …and one per `when:`, because `when:` is required and undefaulted…
```

*The enum says what the code does, and grows when the code does*
(`BUILT_IN_JUDGES`). So the ticket that lands the body lands one more built-in
beside it — a `BuiltIn` returning a person, which is synchronous and therefore
spends nothing by its type — or that project writes `rounds: 0` instead, which
0064 §7 is careful to say is **not** the same thing: a ceiling makes every
spending choice unaffordable, and a plugin choosing a person is a choice.

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
