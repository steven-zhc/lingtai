# The shape for #314 — one dispatch group, a ceiling that only narrows, and a step that dispatches

## Where it goes

| | |
|---|---|
| grows | `packages/recipe/src/recipe.ts` — the group beside `agentPlugin` (`:186`), embedded by `judgePlugin` (`:1194`); the narrowing check on `Recipe` |
| **stops voiding its argument** | `packages/recipe/src/settings.ts:65` — `limitsFor(recipe, step)`, plus one new accessor beside it |
| changes subject | `packages/conductor/src/conduct.ts:277` — `agentRefusal`; `:538` its call; `:553` the sentence |
| dispatches | `conduct.ts:1984` (`stepDeps.agent`), `:2020` (`stepDeps.work`), `:1617` (`askTheAgent`), `:2352`/`:2627` (`spend`) |
| passes the field on | `packages/actions/src/from-recipe.ts:196–210` — the block that today drops `action.agent` |
| grows a sentence | `packages/conductor/src/ceiling.ts`, and its five callers |
| corrected | `apps/cli/src/doctor.ts:1494` (`agentRemedy`), `:1907` (`limitsRow`'s capabilities) |
| rewritten | `packages/conductor/unit/conduct-before-the-claim.test.ts:213` and `:256` — both assert the refusal this ticket deletes |
| reworded | `doc/reference.md:911`, whose `agent:` row ends *per-step dispatch is not built* |

**#313 already built the mechanism.** `RUNTIMES`/`createRuntime` (`packages/agent/src/runtimes.ts`) is total over `RuntimeId`, synchronous and pure, and `apps/cli/src/conduct.ts:135` and `run.ts:254` already construct from `resolved.recipe.runtime.agent`. Nothing about *starting* a second runtime is this ticket's work; what is missing is (a) a field to carry the bound, (b) a place to refuse a widening one, and (c) a caller that asks the table twice.

## 1. The group is three field schemas exported together, not one spread

`definePlugin` (`packages/recipe/src/plugin.ts`) takes `fields: Record<string, z.ZodType>` and builds `z.strictObject({ name, ...fields })`. So "embedding the group" is spreading a `const`. Declare it in `recipe.ts` beside `agentPlugin` rather than in a file of its own: 0064 §4 makes a plugin's fields the plugin's own to declare, and half a declaration living elsewhere is the thing that rule is against.

```ts
/** What one paid call is: which model, what it is handed, what it may spend (0070 §3). */
const DISPATCH = {
  model: z.string().optional(),
  prompt: z.string(),
  limits: z.strictObject({ turns: …optional(), wall: …optional(),
                           rounds: boundsThePass("rounds"), restarts: boundsThePass("restarts") }).optional(),
} as const;
```

**`agentPlugin` embeds all three; `judgePlugin` embeds `model` and `limits` and not `prompt`.** 0070 §3 names three fields and its own *what this does not decide* leaves `judge:`'s `prompt:` open — a spread of all three decides it by accident, and gives an operator a way to rewrite the one question `judgePrompt` (`judge-agent.ts`) exists to ask. What is shared is each field's schema and its docblock; the plugin picks which it pays for.

**`rounds` and `restarts` are declared inside `limits` in order to be refused by name.** `z.strictObject` alone answers *Unrecognized key: "rounds"*, which is not the Done-when box. `z.never({ error: "…bounds the pass and not one call (0040) — write it at runtime.limits" }).optional()` passes an absent key and refuses a present one in the recipe's own voice.

**Nothing gets a `.default()`.** An absent `limits:` must stay absent on the resolved recipe: `configHash` is the hash of the *resolved* form (`resolve.ts`), and a `.default({})` would change every project's hash — including the one in every stored `RunStarted`/`StepsResolved` — for a file nobody edited. Absent ≠ empty (0064 §5) is load-bearing here.

## 2. The narrowing refusal has to be on `Recipe`, because nothing smaller sees both numbers

The per-step list schema `actionsAt(step)` (`recipe.ts`, the schema `StepMap:2387` is built from) is where the existing cross-action refusals live — *the step is written … and none of them is the lane*. It cannot serve here: `steps` and `runtime` are sibling keys of `Recipe` and zod parses them independently, so `runtime.limits` is not in scope. Put the check on `Recipe` itself (`recipe.ts:2512`), where both are parsed, with `path: ["steps", step]` so the message lands on the line:

> `steps.implement`'s "write the change" asks for 300 turns; `runtime.limits.turns` is 150, and a step may only narrow it

Two things to check while doing it, both of which `tsc` answers immediately:

- `LIMIT_DEFAULTS` at `recipe.ts:2867` is `Recipe.shape.runtime.shape.limits.parse(undefined)`. Zod 4 keeps refinements inside the schema, so `.check()`/`.superRefine()` on a `ZodObject` should still expose `.shape`. If it does not, do **not** rewrite `LIMIT_DEFAULTS` — put the check in `resolveRecipe` (`resolve.ts`), which already collects `path: message` problems into `RecipeInvalidError`. Either site is *at resolve, before the money*, which is what 0016 §4 and 0070 §7 ask for.
- `wall` compares as milliseconds. `parseDuration` throws; `positiveDuration` (`recipe.ts:2878`) is the predicate the schema already uses. Compare parsed values, and let the field's own `.refine` catch a malformed duration first so this rule never sees one (#218 is what that ordering is about).

A built-in `judge:` carrying `model:` or `limits:` is the same kind of refusal, one plugin over, and belongs in the same check: *`same-worktree` is a function the router applies and spends nothing, so it has no model to name* (0070 §3).

## 3. `limitsFor` stops ignoring its `step` — this is the day it was written for

`settings.ts:65` is:

```ts
export function limitsFor(recipe: Recipe, step: Step): Recipe["runtime"]["limits"] {
  void step;
  return recipe.runtime.limits;
}
```

and its file's docstring says why: *"The `step` argument is not read, and that is the point. A function that took no step would have to grow one later, which is the sixty-file change this exists to avoid … the day the value moves, every one of those callers is already asking the right question."* **Spend that.** `limitsFor(recipe, step)` returns `runtime.limits` with `turns`/`wall` replaced by the narrowest thing declared at that step. Its nine callers — `filter.ts:209`, `wizard-page.ts:384`, `onboard.ts:327`, `local.ts:505`, `apps/board/src/lib/recipe.ts:729`, `finish.ts:118`, `conduct.ts:558` — keep compiling and start being right.

**But enforcement is per-action, not per-step**, because a step may hold two `agent:` entries with different bounds. The bound travels the way `model` already does: `from-recipe.ts:196` builds `{ name, prompt, ...model }` and drops everything else — it gains `...limits` and `...agent`, `AgentActionSpec` (`agent-action.ts:67`) and `WorkActionSpec` (`work-action.ts:71`) gain the optional field, and `createAgentAction` resolves `spec.limits ?? deps.limits` at the one place it builds `RunRequest.limits` (`agent-action.ts:460`). `limitsFor(recipe, step)` is then the *reading* (§6) and the default for anything dispatched at a step that is not a declared action.

Two consumers come along for free, and both are worth naming so nobody threads a second parameter to them:

- **the fix round.** `fixRound` (`conduct.ts:2557`) is handed `spec: { prompt, model? }` — the `implement` action's own spec — and reaches for the pass-wide `limits` at `:2627`. Widen that inline type once (it is written out in three places: `conduct.ts:2020`, `conduct.ts:2559`, `work-action.ts:73`) and a round is bounded by the dispatch it is another call of, which is what `rounds` counts.
- **the judge.** `judgeDeclaredAt` (`judge.ts:104`) returns `{ runtime, named }` and throws the rest of the entry away; it carries `model` and `limits` too, and `askTheAgent` (`conduct.ts:1617`) reads them instead of `limits.turns` at `:1669`. That is #300's $0.42 judgement getting a cheap model, which is the ticket's first payoff.

## 4. `agentRefusal` keeps its loop and changes what it does inside it

`conduct.ts:277` walks every action in every step and returns on the first `agent:`/non-built-in `judge:` that disagrees with `dispatched`. The loop is right; the `return` is what was standing in for the missing mechanism (`:261`: *"Per-step dispatch is not built; until it is, the only honest answer … is to say so"*).

**Keep the `runtime.agent` clause** — #313's comment at `:544` already reclassified it as an assertion that the caller picked correctly. **Delete the step clause's refusal** and replace the whole function's step half with a question that can still fail: *is this a runtime this machine can actually dispatch?* That is `checkAuth`, not the table — `RUNTIMES` is total over `RuntimeId`, so a "has a row" test can never fail and would be a refusal in name only.

Which makes the shape of the surviving refusal the one real decision here:

- **The set to ask about is `new Set` of every runtime the recipe names**, `runtime.agent` included, asked once per pass.
- **Ask it where the answer is already bought.** `signedInProbe` (`projects.ts:110`) memoises for 60s and `signedInHere` is its instance; `resolveLocalRecipe` is already handed a `SignedIn` for detection (`local.ts:198`). Hand the same function to the refusal rather than spawning a fresh `claude auth status` + `codex login status` before every claim. A probe that answers nothing (`checkAuth` absent) must not refuse — *a runtime that cannot be asked cheaply must not pretend* (`doctor.ts:726`), and the safe direction is to dispatch and let the runtime's own `never-started` stand the conductor down (0031 §3).
- **It stays before the claim**, in `runOnce`'s stage-`recipe` return, because the whole point of the position is that nothing is claimed and no worktree is cut.

`agentRemedy` (`doctor.ts:1494`) says *"per-step dispatch is not built (#309 T2), so a step's `agent:` has to be the runtime `runtime.agent` already chose"* twice; both halves become *sign in to `<id>`, or name one you are signed in to*. `AgentRefusal.key`/`at` (`conduct.ts:234`) still carry which key and which file, and are still worth their docblocks.

## 5. Dispatching a second runtime: a table on the options, defaulted, never constructed behind a test's back

`RunOnceOptions.runtime` (`conduct.ts:318`) stays exactly what it is — the pass's runtime, what `runtime.agent` names, what the tier is matched against, what every existing test injects. Add beside it:

```ts
/** The runtime a step named, or the pass's. Defaulted so a caller that names one runtime supplies one. */
runtimes?: (id: RuntimeId) => Runtime;
```

defaulting to `id === options.runtime.capabilities.id ? options.runtime : createRuntime(id)`, memoised per pass. `conductor` already depends on `@lingtai/agent` and `projects.ts:138` already imports a value from it, so this is not a new edge.

Why an options field rather than `conduct.ts` reaching for `createRuntime` directly: a unit test that proves the ticket needs **two stand-ins in one pass**, and `conduct-a-whole-pass.test.ts` builds passes out of injected fakes. A conductor that constructed the second runtime itself would make the only test that can prove this change spawn a real `codex`. With the default in place, no existing test path changes — a recipe naming nothing gets `options.runtime` by identity.

The three dispatch sites then read the table instead of the field: `stepDeps.agent.runtime` (`conduct.ts:1987`) becomes per-action and moves into `from-recipe.ts`'s build — the deps gain `runtimeFor(id)` and `createAgentAction` resolves `spec.agent ?? deps.runtime`; `askTheAgent` reads the entry's runtime at `:1632`, where the comment *"Which runtime the entry named is not read here"* is the thing being cashed in; and `dispatch`'s `options.runtime.run(...)` at `:2440` and `.invocation?.(...)` at `:2355` take the `implement` action's. `RunStarted.runtime` (`:2404`) must then be the **dispatched** id and not `options.runtime.capabilities.id`, or the log records the wrong agent for every `implement: codex` pass.

## 6. The log has to say which runtime ran a review, and today it cannot

This is the part with no line in the ticket, and it is the part that makes the first `Done when` box checkable at all.

`RunStarted` carries `runtime` and `model` (`events.ts:348`, `:387`) and is appended only by the `implement` dispatch. Every other dispatch — the cold reviewer, the drafting agent at `design`, the fixing agent — emits `StepStarted`, which is `z.object(stepBase)` (`events.ts:748`), and `stepBase` is `{ step, action, runId, onSha }` (`events.ts:641`). **Nothing on the log says which runtime reviewed a diff.** While `agentRefusal` guaranteed one runtime per pass that was fine, because `RunStarted.runtime` answered for the whole pass. Deleting the refusal deletes that guarantee, and what is left is exactly the silent pick 0046 §3 refuses: a `review: codex` that quietly ran on Claude Code would be indistinguishable in `events` from one that did not.

So: **`StepStarted` gains optional `runtime` and `model`**, additive to a `z.object` with no `schemaVer` bump — the precedent is `EndActionsResolved`'s third member (`events.ts:734`: *"Additive to the union, so no stored event is rewritten and no version is bumped"*). It is filled from a new optional `readonly dispatch?: { runtime: RuntimeId; model?: string }` on `Action` (`action.ts:453`, beside `kind`, which `heldBeforeTheLane` already reads the same way), spread into `base` at `action.ts:618`. `createAgentAction`/`createDraftAction`/`createWorkAction` set it; every other action leaves it absent, and absent means *the pass's runtime*, which is what every stored event meant.

The run log will also say it (`runLog.note`), and that is not a substitute: `~/.lingtai/runs/…` is a trace kept only while something is owed an explanation (0034), so a claim resting on it is a claim about a file that is deleted on a landing.

## 7. `lingtai status`: the sentence only grows when something narrowed

`passCeiling` (`ceiling.ts:36`) takes `{rounds, restarts, turns, wall, wallMs}` and is called by `filter.ts:280` (`lingtai status`, `lingtai daemon`'s startup, `lingtai doctor`'s recipe row), `onboard.ts:326`, `wizard-page.ts:566` (the browser, as dials move) and two tests. Give it a second, defaulted argument — the pass's dispatches in step order — and **leave the no-narrowing output byte-identical**:

```ts
passCeiling(limits, dispatches = [])   // dispatches empty ⇒ today's sentence, character for character
```

`filter.test.ts:254–313` pins phrases like *"up to 3 agent runs"*, *"15m and 150 turns each"* and *"at most 30m"*, and `wizard-page.ts`'s dials have no steps to read; both keep passing unchanged, and a project that declares no `limits:` anywhere keeps a one-line reading. Only a recipe that narrowed pays for the longer form:

    a pass — design 150t/1h · implement 60t/30m · review 50t/1h,
    then 3 round(s) at implement's bound — so at most 3h20m

The arithmetic, stated so it is one answer rather than a judgement made twice: **Σ (each dispatch's wall, once, in step order) + `rounds` × (the `implement` dispatch's wall)**, and `restarts` multiplies the whole of it, exactly as the last clause does today. The round takes `implement`'s number because `fixRound` re-runs the `implement` spec (§3).

The list comes from a new accessor next to `limitsFor` — `dispatchesIn(recipe)`, returning `{step, name, turns, wall, wallMs}` for every declared `agent:` and every non-built-in `judge:`, each already narrowed. **It must also emit a synthetic `implement` row at the pass's limits when `steps.implement` is empty**, because an unconfigured `implement` still buys the most expensive agent in the pass — `defaultsAt`'s `createWorkAction({ name: "write the change", prompt: "" })` (`conduct.ts:2197`). That is a second copy of one of `defaultsAt`'s rows and it is the honest cost of the reading; pin it with a test that fails if the two disagree, in the spirit of `step-matrix.test.ts`.

## 8. The tier, and what a narrowed `turns:` does not promise

Two facts that are true after this lands and are not obvious from the ticket:

**The tier is per-pass (0070 §8) and is checked against one runtime today** — `missingForTier(options.runtime.capabilities, tier)` at `conduct.ts:622`, which appends `DispatchRefused` and stops before the claim. With a second runtime dispatched at a step, that check has to run over the same set §4 collects, keeping the one event and the one sentence and naming the runtime that could not carry it. Leaving it as it is means a `tier: sandboxed` pass whose `review:` runs on a runtime that provides less, which is the silent downgrade 0007 forbids by name.

**A narrowed `turns:` on a Codex dispatch is declared and not enforced.** `codex.ts:123` declares `enforces: ["wall"]` — there is no `--max-turns` — against `claude-code.ts:83`'s `["turns", "wall"]`. Do not add counting-and-killing here; #313 settled that (*counting is not stopping*). What this ticket owes is that the existing reading stays true per project: `limitsRow` (`doctor.ts:1907`) asks `createRuntime(recipe.runtime.agent).capabilities`, and once a step may name another runtime it has to ask about each runtime the recipe names, or a Codex `review:` under a Claude Code `runtime.agent` goes unreported.

## 9. What the tests can say, and the one box that is not the agent's

`pnpm test` is the `build` gate and runs the unit project only; nothing here needs Postgres or a process, so all of it belongs in `unit/`:

- **the group** — `agentPlugin.declares` and `judgePlugin.declares` both contain `model` and `limits`, and only `agentPlugin` contains `prompt`. That is the "one shape" claim as something that fails when somebody adds a fourth paid plugin and writes its own field list.
- **the three refusals**, each by its sentence, at resolve and against a whole recipe: a widening `turns`, a widening `wall`, `rounds`/`restarts` inside a dispatch's `limits:`, and `model:` on a built-in judge.
- **the dispatch** — the box's own claim, in `conduct-a-whole-pass.test.ts`'s idiom: a recipe whose `implement` names one stand-in and whose `review` names another, asserting each was handed to the right action and that `StepStarted` for the review carries the second id. `conduct-before-the-claim.test.ts:213` and `:256` are rewritten from *refuses* to *dispatches*, and one of them survives inverted: a runtime nothing is signed into is still refused before the claim, with a stub `SignedIn` answering `[]`.
- **nothing changes for a file nobody edited** — this repository's own recipe shape resolving to the same `configHash` as before, and `passCeiling(limits)` returning today's exact string with no dispatches. `agentPlugin`'s promise is the test of §1's "no defaults", not a hope about it.

**The first box cannot be closed from inside the pass, and the ticket should be finished anyway.** *A pass whose `review` ran on a different runtime from its `implement`* needs an edit to `~/.lingtai/lingtai/recipe.yml` — outside every worktree since #180 — a machine signed in to both runtimes, and `pnpm lingtai restart`, because a running daemon holds the code it started with. It is T11-shaped, like #313's own last box and like the Next build. Deliver the unit proof above, say in the commit which half was exercised against stand-ins and which was not, and leave the live pass for whoever restarts the daemon. Do not tick it with a mocked pass.

## Related

- [0070](../decisions/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) §5 is the narrowing rule, §7 the three refusals, §8 what must not change. Nothing here contradicts it; §6 above adds a record it does not mention, because deleting the refusal removes the thing that made `RunStarted.runtime` speak for the whole pass.
- [0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) — why `turns`/`wall` may move to a step and `rounds`/`restarts` may not; §1's `boundsThePass` is that sentence as a refusal.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin declares its own fields, which is why the group is a spread beside the plugins rather than a file over them; §5 — absent is not empty, which is why nothing in the group is defaulted.
- `doc/design/this-change.md` (#313) §5–6 — the table these dispatches read, and the three sentences it already made false.
