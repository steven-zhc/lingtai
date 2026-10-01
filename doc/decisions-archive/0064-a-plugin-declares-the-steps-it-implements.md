# 0064 — A plugin declares the steps it implements, and that is what makes it legal there

**Status** accepted · **Date** 2026-09-26 · **Supersedes** `KINDS_AT` as a
hand-written legality table, and `Action`'s single signature · **Completes**
[0058](0058-lingtai-is-a-development-pipeline.md) §2b

A plugin carries one function per step it can serve, typed by that step. A recipe
may declare it at a step when it has a function for that step, and nowhere else.
There is no table.

## 1. What is wrong with the table

`KINDS_AT` is a hundred and twenty cells saying which of the twelve plugin kinds
each of the ten steps runs. It was written for a real failure —
[#61](https://github.com/steven-zhc/lingtai/issues/61): ten cells were accepted,
resolved into the plan, printed at onboarding, drawn on the board, and never
called, and two changes merged with nobody's approval because of it.

**But it answers two different questions with one table, and only one of them is
about meaning.**

- *Is this plugin's output read at this step?* A `judge:` at `implement` produces
  a destination, and `implement` does not route, so the answer is discarded. That
  cell is **meaningless**, and refusing it is right.
- *Has this step been built yet?* Six rows are empty today because their bodies
  did not exist. That is **progress**, not meaning.

Using one table for both is how
[#231](https://github.com/steven-zhc/lingtai/issues/231) died: it tried to put
configuration on steps whose rows were empty for a reason that had nothing to do
with what it was asking for. The table cannot tell *not yet* from *not ever*, so
neither can anybody reading it.

## 2. What is wrong with one signature

```ts
export interface Action {
  readonly name: string;
  readonly kind: "run" | "agent" | "watch" | "human";
  run(context: ActionContext): Promise<ActionResult>;
}
```

**Four of the twelve plugins are runnable and eight are not.** `close`, `labels`,
`refs`, `worktree`, `merge`, `queue`, `judge` and `backlog` are never `Action`s:
they are data, read directly by whichever part of the pass needs them. So the
"plugin system" covers a third of the plugins, and the rest are configuration
that happens to share a schema helper.

**And one signature cannot say what a step has.** `claim` runs before there is a
work item; `admit` is where a worktree first exists; `end` alone knows the
outcome; `proposed` alone has an arriving ending and a set of destinations. A
single `ActionContext` either omits all of that — so a plugin cannot use it — or
carries all of it, so most fields are null at most steps and the plugin cannot
tell *absent here* from *absent today*.

## 3. The shape

**The per-step types already exist**, in `pass.ts`:

```ts
type StepBody<S extends Step = Step> = (work: StepWork<S>) => Promise<EndingAt<S>>;
```

`StepWork<S>` narrows what the step has — `outcome` is `TerminalOutcome` for
`end` and `null` for the other nine — and `EndingAt<S>` narrows what it may
return, so only the four refusing steps can refuse and only `proposed` can
route. What is missing is that a **plugin** cannot supply one. Today the ten
bodies come from `bodiesFor(ports)`, hard-coded, and a step's behaviour is
therefore *not* its plugins.

So a plugin gains an `at`:

```ts
definePlugin("queue", {
  fields: { … },
  at: { claim: pickTheItem },          // implements one step, legal at one step
});

definePlugin("run", {
  fields: { … },
  at: { "*": runAProcess },            // step-agnostic, legal wherever a process runs
});
```

**`at`'s value at a step is `StepBody<thatStep>`.** The compiler checks that a
plugin written for `end` reads an outcome that exists and that one written for
`claim` does not.

**`"*"` is not a loophole, it is a second true thing.** `run:` at `build` and
`run:` at `proposed` are the same work with the same inputs; ten identical
implementations would be a worse lie than one. Some plugins care which step they
are at and some do not, and the shape should be able to say both.

## 4. Legality is read, not written

A recipe may declare a plugin at a step when `at` has that step — or `"*"` — and
the resolve refuses it otherwise, **by name**, naming the plugin and the step.

That is the same refusal `KINDS_AT` produces today, from a different source: the
plugin's own declaration rather than a table beside the schema. Two consequences,
both wanted:

- **Adding a plugin edits one file.** No table elsewhere to keep in step, and no
  `doc/reference.md` copy for a test to check against the constant.
- **It cannot encode *not yet*.** A step nobody has implemented has no plugin
  declaring it, and the refusal says *no plugin implements `claim`* rather than
  *`claim` takes nothing*, which is a sentence somebody can act on.

### And there is no `plugins:` node

Neither inside a step nor at the top level.

**Inside a step**, the key is the plugin —
[0063](0063-every-setting-is-the-recipes.md) §2, and it does not reopen here.
Wrapping entries in a `plugins:` list buys a level of nesting and no information:
the key already says which plugin an entry is, and `pluginNaming` refuses an
entry carrying zero or two of them.

**At the top level**, a node listing which plugins this recipe uses would list
exactly what `PLUGINS` already contains. `PLUGINS` is a closed set in the tree
and every plugin in it is available to every recipe, so the node would be
written, believed, and connected to nothing — which is the argument
[0063](0063-every-setting-is-the-recipes.md) §1 used to keep a
`runtimes: [claude-code]` out of the machine file, and it is this project's
most-repeated defect.

**The day it is needed it will be answering a different question.** When a plugin
can be loaded from outside the tree, a recipe will have to say *where this one
comes from* — a source, a version, something to check it against. That is not
*which plugins do I use*, which the keys already answer, and it should be named
for the question it does answer. Ansible's `collections:` is the same
distinction: it does not list the modules a task uses, it says where to install
them from.

## 5. Absent and empty stay different

**An `at` without this step is refused; an `at` with this step that does nothing
is a bug the author wrote.** The distinction this decision must not lose is
[0016](0016-the-settled-model.md) §4's, and it is the one thing an optional
method makes easy to lose: a call site that does `plugin.at[step]?.()` accepts a
plugin that does not implement the step and quietly runs nothing, which is #61
again in a new costume.

So the check is at **resolve**, on the declaration, not at the call site on the
function. By the time a body is called, the recipe has already been refused if
the plugin could not serve that step.

## 6. What this costs

**`Action` and `runActionPipeline` are rewritten, and everything that builds an
`Action` moves.** `actionsFromRecipe(step, actions, deps)` currently maps a
declaration onto one of four constructors; it becomes a lookup into the plugin's
`at`. The three dependencies it takes — a reviewer, a file list, an environment
resolver — do not go away; they move into what a `StepWork` carries or into what
the caller binds into the plugin's function.

**The ten bodies in `pass-steps.ts` are the migration, one step at a time.** Each
is *move this step's hard-coded work into a plugin's `at.<step>`, and let the
recipe declare it*. The pass keeps running them in order; what changes is where
each one comes from.

**Not every body moves, and `end` is the case that shows the line.** Its effects
are already declared — both recipes write `close:` at `end` and the pass carries
them out — and what its body does is *resolve which of them apply to this
outcome*. That is the workflow's, exactly as `proposed`'s routing mechanics are
the workflow's while the destination is the plugin's (§7). A migration ticket
must say, for its step, which half is moving; one that moves the workflow's half
into a plugin has given away something no recipe should be able to get wrong.

**And the four runnable kinds lose nothing.** `run`, `agent`, `watch` and `human`
become plugins with `at: { "*": … }` and behave exactly as they do now.

## 7. Routing is the plugin's return value; the budget is not

`StepBody<"proposed">` may already return `StepRouted { to: Destination }`, so a
plugin that implements `at.proposed` **decides the route**. That is the point:
where a refusal goes is a workflow's design, and a project should be able to
change it.

A project that wants every refusal to reach a person writes it:

```yaml
proposed:
  - name: everything comes to me
    judge: always-waiting
```

**That is today's behaviour becoming declarable.** The current stub answers
`waiting` on every routing arrival, and its own comment argues that is correct
rather than a placeholder: `passed` would carry a refused change on to `merge`,
and any step back would be the workflow inventing the judgement 0061 §3 reserves
for a plugin. After this decision the same policy is a line in a recipe instead
of a fallback in the code.

### What does not move

**The plugin chooses; the workflow still bounds what the choice costs.** A
plugin that may return any destination can construct a loop, and the money is
somebody else's. So a route that spends is checked against the ceiling, and a
route that cannot be afforded goes to a person **naming the ceiling that is
spent** rather than being silently refused.

`offering` therefore stops being a menu. Today it is *reachable* and *affordable*
in one set, which is why it cannot say **why** a destination is missing — no
meaning, or no money — and those are different messages to whoever reads the
card.

**`waiting` is the one destination that costs nothing**, so the budget never
refuses it. That is what makes it the right answer both when a plugin chooses it
and when a ceiling is spent: the two arrive at the same place for different
reasons, and the pass says which.

### `rounds` and the plugin are not two ways to write one thing

`rounds: 0` already means *every refusal goes straight to a person*
([0039](0039-the-worktree-is-the-whole-of-a-pass.md) §4), and an always-`waiting`
plugin says something that looks identical. They are not redundant, and the
difference is worth keeping:

- **`rounds` is a ceiling, and it is the workflow's.** A plugin cannot count its
  own rounds — every plugin would have to implement counting, and one that got it
  wrong would loop on somebody's money until the wall.
- **The plugin is the choice, and it is the project's.**

`rounds: 0` makes every spending choice unaffordable, so whatever the plugin
chooses falls through to `waiting`. That is a ceiling doing what a ceiling does,
not a second spelling of the same policy.

## Related

- [0058](0058-lingtai-is-a-development-pipeline.md) §2b — *a step's behaviour is
  its plugins*. This is the decision that makes that sentence true rather than
  aspirational: until a plugin can supply a step's body, a step's behaviour is
  its hard-coded body and its plugins are a list it also happens to run.
- [0061](0061-the-recipe-is-the-pipeline.md) — `steps:` and the twelve plugins.
  The schema half is kept; what changes is what a plugin is on the running side.
- [0016](0016-the-settled-model.md) §4 — a key silently dropped and a key that
  does not exist are different facts. §5 above is that rule applied to a method.
- [#61](https://github.com/steven-zhc/lingtai/issues/61) — the failure `KINDS_AT`
  was written for. The guard survives this decision; only its source moves.
- [#231](https://github.com/steven-zhc/lingtai/issues/231) — closed because its
  landing sites were empty rows. §1 above is why that was the table's fault as
  much as the ticket's.
