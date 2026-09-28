/**
 * Where a setting lives — the one place that knows, so that moving one is a
 * change to this file and not to sixty.
 *
 * **These accessors read today's shape and exist for tomorrow's.**
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4 puts
 * every setting on the step that owns it: what a pass may spend belongs to
 * `implement`, the branch belongs to `worktree:`, which kinds are taken belongs
 * to `queue:`. None of that has moved yet. What has moved is *who asks* — a
 * caller now says `limitsFor(recipe, "implement")` rather than reaching into
 * `recipe.runtime.limits`, and the day the value moves, every one of those
 * callers is already asking the right question.
 *
 * **The `step` argument is not read, and that is the point.** A function that
 * took no step would have to grow one later, which is the sixty-file change
 * this exists to avoid; a caller that passes the step it is *at* is correct
 * both before and after the move. `limitsFor(recipe, "build")` and
 * `limitsFor(recipe, "implement")` return the same object today and are not the
 * same question.
 *
 * Nothing here is a default or a fallback. A recipe is resolved before it
 * reaches any of these, so every value is present and an absent one is a bug in
 * the schema rather than something to paper over here.
 *
 * **`baseOf` and `submodulesOf` are the first two to have actually moved, and
 * they are still one question each** (`#268`, 0065). A recipe may write them at
 * `admit` as `worktree:`'s fields or under `repo:`, which is the same setting's
 * v1 spelling — so these two read the step first and `repo:` second, and that is
 * a **spelling** rather than a fallback: both are present on a resolved recipe,
 * and which of them a file wrote is exactly the knowledge this file exists to
 * hold alone. Every reader asks the accessor, so the merge lane lands on what
 * the tree was cut from whichever spelling was used, and there is no place for
 * the two to disagree.
 *
 * **There is one accessor per setting 0061 §4 moves, and the set is closed by
 * that list rather than by what a caller happened to need.** It was three for a
 * while — `limitsFor`, `baseOf`, `kindsOf` — and the other three settings in
 * the same five-line table were read by hand in nine files: `repo.submodules`
 * at `conduct.ts` and the wizard, `source.exclude` at `discover.ts`, the
 * filter, the wizard and the board, `source.backoff` at four more. A half-set
 * is worse than none, because the guard below reads as *nothing reaches past
 * the accessors* while three of the six settings have nothing to reach past.
 * `#231` is what found it: the move is a change to this file only if every
 * setting it moves has a home here first.
 *
 * **It is seven now, because 0063 §3 added one to that list rather than to
 * this file.** `assignee` is a field of `queue:` and not a plugin beside it, so
 * it is a setting that moves onto a step exactly as the other six are, and
 * `assigneeOf` is here for the same reason `kindsOf` is.
 *
 * **And four more have actually moved, on `baseOf`'s terms** (`#269`).
 * `kindsOf`, `excludeOf`, `backoffOf` and `assigneeOf` read a `queue:` declared
 * at `claim` first and `source:`/`runtime:` second, which is the same **spelling**
 * distinction `cutAt` draws and not a fallback: both are present on a resolved
 * recipe, and which one a file wrote is exactly the knowledge this file exists to
 * hold alone. So a recipe that declares its queue at the step gets the filter, the
 * wizard, the board, `lingtai add` and the pass reading the same four values —
 * which is the failure `#231` found, arriving through a half-moved setting rather
 * than through a reader.
 */
import type { Step } from "@lingtai/domain";
import type { QueueSettings, Recipe } from "./recipe.ts";

/** What one agent run at `step` may spend. */
export function limitsFor(recipe: Recipe, step: Step): Recipe["runtime"]["limits"] {
  void step;
  return recipe.runtime.limits;
}

/**
 * The `worktree:` this recipe declares at `admit`, or null where it declares
 * none and `repo:` is what says it.
 *
 * `find` and not a reduction over several, because a step cuts one worktree or
 * none: `StepMap` refuses a second `worktree:` at a step by name when the recipe
 * resolves, so *the first one* and *the only one* are the same entry here.
 */
function cutAt(recipe: Recipe): { base: string; submodules: boolean } | null {
  const declared = recipe.steps.admit.find((action) => "worktree" in action);
  return declared === undefined ? null : declared.worktree;
}

/** The branch a pass cuts from and lands on. */
export function baseOf(recipe: Recipe): string {
  return cutAt(recipe)?.base ?? recipe.repo.base;
}

/**
 * **Which line of this recipe says the base**, for the three readings that print
 * the key beside the value (`#268`).
 *
 * `baseDivergence`'s refusal, `lingtai doctor`'s base row and `lingtai add`'s
 * disagreement all name a key so that an operator knows which line to edit, and
 * all three said `repo.base` unconditionally. Against a recipe that has moved the
 * setting onto `admit` that sends a person to a line the conductor does not read
 * — the one failure mode this whole file exists to prevent, arriving through a
 * message rather than through a reader.
 */
export function baseWrittenAt(recipe: Recipe): string {
  return cutAt(recipe) === null ? "repo.base" : "steps.admit's worktree.base";
}

/**
 * Whether the worktree a pass is cut into gets the submodules.
 *
 * `baseOf`'s sibling and it moved with it: both are `worktree:`'s fields under
 * 0061 §4, and a caller that asks for one usually asks for the other in the
 * next line (`conduct.ts`'s `repo.provision` call is exactly that pair).
 *
 * **A declared `worktree:` must name it** — `worktreePlugin`'s schema has no
 * default for `submodules`, so there is no third answer between *the step said*
 * and *`repo:` said*. A block that named only its base would otherwise take
 * `false` from a schema while `repo.submodules: true` sat two blocks up unread,
 * and the symptom of that is every test that imports a submodule failing in a
 * way that reads as the agent's fault.
 */
export function submodulesOf(recipe: Recipe): boolean {
  return cutAt(recipe)?.submodules ?? recipe.repo.submodules;
}

/**
 * The `queue:` this recipe declares at `claim`, or null where it declares none
 * and `source:`/`runtime:` are what say it (`#269`).
 *
 * `cutAt`'s sibling and written for its reason: `find` and not a reduction over
 * several, because a step takes one ticket or none — `StepMap` refuses a second
 * `queue:` at a step by name when the recipe resolves, so *the first one* and
 * *the only one* are the same entry here.
 */
function takeAt(recipe: Recipe): QueueSettings | null {
  const declared = recipe.steps.claim.find((action) => "queue" in action);
  return declared === undefined ? null : declared.queue;
}

/**
 * The kinds the queue takes, **in priority order** — the order is the
 * meaning, so this returns the list rather than a set.
 */
export function kindsOf(recipe: Recipe): Recipe["source"]["kinds"] {
  return takeAt(recipe)?.kinds ?? recipe.source.kinds;
}

/**
 * The labels that keep the agent off a ticket.
 *
 * A list and not a set, for the reason `kindsOf` is one: what the recipe wrote
 * is what the wizard offers back and what a refusal names, and the one caller
 * that wants matching — `considerIssue` — lowercases into a `Set` of its own,
 * because the match is case-insensitive and that is the *matcher's* rule rather
 * than this list's.
 */
export function excludeOf(recipe: Recipe): Recipe["source"]["exclude"] {
  return takeAt(recipe)?.exclude ?? recipe.source.exclude;
}

/**
 * How long a failed attempt keeps its own ticket out of the queue — **as it was
 * written**, so a reading can print `1h` rather than `3600000`.
 *
 * `parseDuration` stays at the call sites that want milliseconds. Returning the
 * number here would make the two readers that show it to a person reconstruct
 * the string, and 0028's whole point is that the value is the repository's own
 * and is read back by whoever set it.
 */
export function backoffOf(recipe: Recipe): Recipe["source"]["backoff"] {
  return takeAt(recipe)?.backoff ?? recipe.source.backoff;
}

/**
 * Whose tickets this machine takes — **`queue:`'s fourth field**, and the one
 * whose v1 name is not `source:`'s
 * ([0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3).
 *
 * The other three are written under `source:` and this is written under
 * `runtime:`, by the machine file rather than by the recipe (0046 §3), and
 * that difference is exactly what an accessor is for: 0063 §4 moves where a
 * person writes it and this is the file that move edits. Until it lands,
 * `#244` is the ticket that found the readers — `assigneeSkip`'s caller in
 * `discover.ts`, `describeFilter` and the board's reading — each reaching in
 * by hand.
 *
 * Absent is `both`, and it is returned absent rather than filled in: what an
 * absent rule means belongs to `assigneeSkip` and to `describeAssignee`, which
 * say it in their own words, and 0046 §2's *a wrong login shows itself* wants
 * the reading to be able to say *nothing was written* rather than *both*.
 *
 * **A declared `queue:` must name it**, so the `??` below is a spelling and not
 * a fallback, exactly as `submodulesOf`'s is: there is no third answer between
 * *the step said* and *the machine file said*, and a block that named only its
 * kinds cannot silently hand this machine somebody else's tickets (`#269`).
 */
export function assigneeOf(recipe: Recipe): Recipe["runtime"]["assignee"] {
  return takeAt(recipe)?.assignee ?? recipe.runtime.assignee;
}

/**
 * **All four at once** — what `claim`'s `queue:` action carries, and what the
 * code that picks a ticket is handed (`#269`).
 *
 * The four accessors above are still the one place each setting's spelling is
 * known; this is them read together, because `considerIssue` and `runnableNow`
 * in `packages/conductor/src/discover.ts` apply all four in one pass over one
 * GitHub response (0063 §3: *they answer one question*). A caller that has only
 * a recipe asks this; a caller that is running a declared action already has the
 * block and must **not** ask, so that the ticket a pass takes is the one the
 * reading of the recipe says it took.
 *
 * **`assignee` is the one value this fills in, because the block requires it and
 * `runtime.assignee` does not exist on every machine.** `EVERYONE` is what an
 * absent rule has always meant at the one place that reads it — `assigneeSkip`'s
 * `rule?.take ?? "both"` — so writing it here selects identically and says out
 * loud what a pasted `queue:` must then write. The *reading* of an absent rule is
 * still `assigneeOf`'s, which returns it absent: *nothing was written* and
 * *everyone* are one filter and two sentences, and only the filter is here.
 */
export function queueOf(recipe: Recipe): QueueSettings {
  return {
    kinds: kindsOf(recipe),
    exclude: excludeOf(recipe),
    backoff: backoffOf(recipe),
    assignee: assigneeOf(recipe) ?? EVERYONE,
  };
}

/**
 * What an unwritten `runtime.assignee` selects — **every issue, whoever it is
 * assigned to**, which is how the queue behaved before it read an assignee at
 * all (`assigneeSkip`).
 */
const EVERYONE = { take: "both" } as const;
