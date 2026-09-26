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

**And the four runnable kinds lose nothing.** `run`, `agent`, `watch` and `human`
become plugins with `at: { "*": … }` and behave exactly as they do now.

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
