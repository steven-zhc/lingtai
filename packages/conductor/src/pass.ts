/**
 * The pass: the ten steps as data, and the loop that runs them.
 *
 * **Nothing imports this yet, and that is the ticket rather than an oversight**
 * (`#253`). `run-once.ts` is 2961 lines of five gate points wrapped around code
 * nobody can name or replace, and the shape of the work is not surgery on it —
 * it is *write the new pass beside it, and delete it*
 * ([the-pipeline.md](../../../doc/design/the-pipeline.md) §2). So this file
 * lands wired to nothing: a reviewer reads it against
 * [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) and
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) rather than
 * against a diff, and a mistake here cannot touch the conductor that is
 * running. The blast radius is zero until T5 wires it.
 *
 * ## What is here, and what is deliberately not
 *
 * Here: how a step is represented, how the recipe drives it, what a step hands
 * back, how a refusal stops the pass and what it reports. **The ten bodies are
 * empty** — `NOT_BUILT_YET` is all ten of them — because the bodies are the
 * next ticket and they are filling in a contract this file has already fixed.
 * That is the point of the split: whoever writes `claim`, `admit`, `prepared`,
 * `design`, `implement` and `end` has something that runs to write against, and
 * whoever writes `build`, `review`, `proposed` and `merge` after them has the
 * same.
 *
 * ## An empty step is a pass, not a skip
 *
 * A recipe may omit any step and the resolved recipe holds all ten
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §5,
 * `StepMap` in `@lingtai/recipe`), so the loop meets `[]` at nine steps out of
 * ten today — `KINDS_AT` accepts an action at four of them — and it must keep
 * going. **The one thing it must never do is `continue` past a step that *was*
 * configured**: four of `end`'s six cells were declarable, drawn, and silently
 * dropped by exactly that line (`#61`, and the comment at `end-step.ts`'s
 * kind guard). So there is no `continue` in this file. Every one of the ten is
 * visited, every one of the ten lands an entry in `PassResult.steps`, and a
 * configured step whose body does not exist yet **throws** rather than passing
 * quietly — *configured and did not run* must not look like *empty*
 * ([0016](../../../doc/decisions/0016-the-settled-model.md) §4).
 *
 * ## What survives from the old file
 *
 * ```ts
 * runActionPipeline({ step, actions, context, emit })   // packages/actions/src/action.ts
 * ```
 *
 * That is *run this step's plugins* and it does not change. The loop calls it
 * and does not reimplement it; what this file adds beside it is the one mapping
 * from a `PipelineResult` to a step's ending, so the five verdicts the pipeline
 * can produce are read in one place rather than at every call site.
 */
import { STEPS, type Step } from "@lingtai/domain";
import {
  actionsFromRecipe,
  runActionPipeline,
  type Action,
  type ActionContext,
  type ActionDeps,
  type ActionEvent,
  type PipelineResult,
} from "@lingtai/actions";
import type { Recipe, StepAction } from "@lingtai/recipe";

// ------------------------------------------------------- the ten, as data ----

/**
 * The four steps the workflow lets refuse, and no others
 * ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §2).
 *
 * **Refusal is not an ordinary return value**, which is why it cannot be a
 * plugin's to invent: in this codebase it buys a fix round — ~31 turns, ~$3.40
 * — holds the work item, and may reach a person. If a `claim` plugin could
 * refuse, not one of those consequences would have a meaning. So the set is
 * part of the fixed pipeline, and a plugin at a refusing step supplies the
 * *judgement*, never the *consequence*.
 *
 * It is a list here rather than a `refuses: true` on ten rows because the four
 * are also a **type** below, and a boolean per row could not be one.
 */
export const REFUSING_STEPS = ["prepared", "build", "proposed", "merge"] as const satisfies readonly Step[];

/** One of the four. `StepEnding`'s `refused` is reachable only from these. */
export type RefusingStep = (typeof REFUSING_STEPS)[number];

/**
 * One of the other six — `claim`, `admit`, `design`, `implement`, `review`,
 * `end`.
 *
 * They are not steps that always pass: `admit`, `design` and `implement` reach
 * `proposed` carrying `needs-input`, and `review` returns findings and judges
 * nothing (0058 §3b). **Arriving at the router and refusing are different
 * things, and only one of them is charged for.**
 */
export type SettlingStep = Exclude<Step, RefusingStep>;

/**
 * Whether a step's plugins produce verdicts or run for effect.
 *
 * Nine produce verdicts and go through `runActionPipeline`. `end` is the
 * exception and is the reason this is a field rather than an assumption: its
 * three kinds — `close:`, `labels:`, `refs:` — are effects, they never reach
 * the `Action` interface, and `actionsFromRecipe("end", …)` refuses them by
 * name. They are resolved by `resolveEndActions` and carried out by `tell.ts`.
 */
export type PluginsAre = "verdicts" | "effects";

/** One of the ten, and the two things about it the workflow fixes. */
export interface StepSpec {
  readonly step: Step;
  /** True for exactly `REFUSING_STEPS`. Derived, so the two cannot disagree. */
  readonly refuses: boolean;
  readonly plugins: PluginsAre;
}

/**
 * The ten steps, in the order the pass reaches them.
 *
 * Folded over `STEPS` rather than written out, for the reason that tuple is
 * exported at all: *each place writing its own list is how one of them ends up
 * missing a step and nobody notices* (`events.ts`). So the order here is the
 * enum's, and a step added to the vocabulary appears in the loop without an
 * edit to this file.
 */
export const PASS: readonly StepSpec[] = STEPS.map((step) => ({
  step,
  refuses: (REFUSING_STEPS as readonly Step[]).includes(step),
  // `end` alone, and named by the step rather than by a second list: one
  // exception written as a condition reads better than a table of nine `true`s.
  plugins: step === "end" ? "effects" : "verdicts",
}));

/** `end`'s row, which the loop needs by name because it runs on every ending. */
const END: StepSpec = { step: "end", refuses: false, plugins: "effects" };

// ------------------------------------------------- what a step hands back ----

/** Nothing to report. The pass moves to the next step. */
export interface StepPassed {
  readonly ending: "passed";
}

/**
 * A judgement about the change: something the recipe declared said no.
 *
 * Three fields because 0058 §3c asks for three — **which step** (the loop
 * stamps it, in `PassResult`), **what refused** (`at`, the action's own name),
 * and **a reason** (`because`, machine-readable, beside `detail`, which is the
 * words). A route that forgets is a person reading *waiting on you* with no way
 * to learn why without opening a run log.
 *
 * **`because` is a string and not an enum, on purpose.** The values belong to
 * the steps that produce them and the steps do not exist yet: `merge`'s four
 * are `RefusalReason`'s and are already on the log, and `prepared`'s, `build`'s
 * and `proposed`'s land with those bodies. A closed union written here before
 * anything produced a value would be `#61`'s shape one level up — a vocabulary
 * declared, recorded, drawn and never emitted — which is the failure this whole
 * file is arranged around. What this ticket fixes is the *shape*: a token
 * beside prose, because `proposed` routes on the first and `waiting` displays
 * the second ([0043](../../../doc/decisions/0043-evidence-is-plain-text.md)).
 */
export interface StepRefused {
  readonly ending: "refused";
  readonly because: string;
  /** The action that refused, or null where the step refused without one. */
  readonly at: string | null;
  readonly detail: string;
}

/**
 * Nothing is wrong and nothing may proceed until a person says so.
 *
 * Not a refusal: a `human:` action asking a question has judged nothing, and
 * folding it into `failed` would put *the build is broken* on a card whose
 * build is fine (`action.ts`, `needs-approval`). Which steps can reach it is
 * `KINDS_AT`'s answer — `human:` runs at `proposed` and `merge` today — and not
 * this type's, which is why `held` is not restricted to the four the way
 * `refused` is.
 */
export interface StepHeld {
  readonly ending: "held";
  readonly at: string;
  readonly question: string;
}

/**
 * The step ran and produced no judgement of any kind.
 *
 * **Kept apart from a refusal from the start, because it costs different
 * money** ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md)):
 * a refusal buys a fix round and holds the item, and this buys none of it. An
 * agent that started and ended with no receipt is one instance; an agent that
 * stopped to ask is the other, and 0058 §3c gives it the token `needs-input`
 * and sends it to `proposed` — which decides whether a person is worth
 * interrupting, or whether the agent should go round again stating its
 * assumption. Both reach the router; neither is charged for.
 *
 * `because` is a string for the reason `StepRefused`'s is.
 */
export interface StepDidNotFinish {
  readonly ending: "did-not-finish";
  readonly because: string;
  readonly at: string | null;
  readonly detail: string;
}

/**
 * The step was reached and its agent never started.
 *
 * A fifth ending and not a flavour of the fourth: `never-ran` is the wall that
 * is about the *account* rather than about the diff — a quota, a signed-out
 * runtime — and its consequence is that the conductor stands down and the item
 * goes back to the queue ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)
 * §3). `did-not-finish` is local to one crash and stands only the pass down
 * (0057 §3). A caller that had to read `detail` to tell them apart would be the
 * second reader of a sentence 0031 §1 exists to prevent.
 */
export interface StepNeverRan {
  readonly ending: "never-ran";
  readonly at: string;
  readonly detail: string;
}

/** The five ways a step ends. Exactly the five `runActionPipeline` can produce. */
export type StepEnding = StepPassed | StepRefused | StepHeld | StepDidNotFinish | StepNeverRan;

/**
 * **What a given step may hand back — the type, rather than a comment.**
 *
 * `refused` is subtracted for the six that may not refuse, so a `claim` body
 * returning one does not compile. That is 0058 §2's *the workflow fixes which
 * steps may refuse* said in the one place a body's author cannot read past.
 * The runtime says it too — `onlyTheFourMayRefuse` below — because a body
 * reached through `StepBodies[Step]` has been widened to the union and the
 * compiler has stopped looking.
 */
export type EndingAt<S extends Step> = S extends RefusingStep
  ? StepEnding
  : Exclude<StepEnding, StepRefused>;

// --------------------------------------------------------- the step bodies ----

/**
 * What the loop hands a step's body.
 *
 * `actions` is `recipe.steps[step]` verbatim, including the `[]` a recipe that
 * omitted the step resolves to — a body sees what was declared, and the loop
 * has already run it where the plugins produce verdicts. So a body is only ever
 * called after its own plugins passed, and its job is the step's *own* work:
 * cutting the worktree at `admit`, dispatching the agent at `implement`,
 * routing at `proposed`.
 */
export interface StepWork<S extends Step = Step> {
  readonly step: S;
  readonly actions: readonly StepAction[];
  /** Whether this step may refuse. The workflow's fact, never a plugin's. */
  readonly refuses: boolean;
  readonly context: ActionContext;
  readonly emit: (event: ActionEvent) => Promise<void> | void;
  readonly deps: ActionDeps;
}

export type StepBody<S extends Step = Step> = (work: StepWork<S>) => Promise<EndingAt<S>>;

/**
 * All ten, and all ten required.
 *
 * A `Partial` here would be the skip this file exists to make impossible: a
 * step whose body were absent would have to mean *pass*, and *nothing is
 * configured* and *something is configured and did not run* must not look the
 * same (0016 §4).
 */
export type StepBodies = { readonly [S in Step]: StepBody<S> };

/** The body of a step whose own work is nothing beyond its plugins. */
const nothingBeyondThePlugins = async (): Promise<StepPassed> => ({ ending: "passed" });

/**
 * The ten bodies, empty — and each one says what will be in it.
 *
 * This is the whole of what `#253` leaves for `#254` and T4b, written down
 * where somebody about to fill one in will meet it. Nine of them pass, because
 * the loop has already run their plugins by the time they are called and a step
 * with no own work has nothing left to do. `end`'s does not, and the reason is
 * the rest of this file: its effects are the one thing the loop cannot run.
 */
export const NOT_BUILT_YET: StepBodies = {
  /** Pick the ticket — `discover`/`claim`, and `queue:`'s four fields. */
  claim: nothingBeyondThePlugins,
  /** Start work on it; the worktree is cut here. May report `needs-input`. */
  admit: nothingBeyondThePlugins,
  /** The tree is ready to be worked in. **Refuses** — the cheapest one in the pass. */
  prepared: nothingBeyondThePlugins,
  /** A document, before any code — **or nothing, which is an answer** (0058 §3). */
  design: nothingBeyondThePlugins,
  /** One agent, in that worktree. May report `needs-input`. */
  implement: nothingBeyondThePlugins,
  /** **Refuses**, and a red one skips `review` — T4b. */
  build: nothingBeyondThePlugins,
  /** Reads the diff, returns findings, judges nothing — T4b. */
  review: nothingBeyondThePlugins,
  /** **Refuses**, and the only step that routes — T4b. */
  proposed: nothingBeyondThePlugins,
  /** **Refuses**, and reports a `reason` and a `detail` rather than deciding — T4b. */
  merge: nothingBeyondThePlugins,
  /**
   * Runs on every ending and cannot refuse — and its effects are **not**
   * actions.
   *
   * So this body cannot be `nothingBeyondThePlugins`: the loop did not run
   * `end`'s list, because there is no pipeline for an effect to be an action in
   * (`actionsFromRecipe`'s last refusal). A declared `close:` reaching here and
   * being answered *passed* would be the exact `#61` failure this file opens by
   * naming, so it throws. An `end` the recipe left empty passes, which is every
   * step a recipe omits.
   */
  end: async ({ actions }) => {
    if (actions.length === 0) return { ending: "passed" };
    throw new Error(
      `the \`end\` step has ${actions.length} effect(s) declared — ${actions
        .map((a) => `"${a.name}"`)
        .join(", ")} — and this pass has no body to carry them out. ` +
        "`resolveEndActions` resolves them onto the item's own stream and `tell.ts` does them; " +
        "throwing rather than passing, because a step that was configured and did not run must not " +
        "look like one that was empty (0016 §4, #61).",
    );
  },
};

// ------------------------------------------------------------- the loop ----

export interface PassOptions {
  /**
   * The resolved recipe. Only `steps` is read, and it holds all ten (0061 §5),
   * so `recipe.steps[step]` is a lookup that cannot miss.
   */
  readonly recipe: Pick<Recipe, "steps">;
  readonly context: ActionContext;
  /**
   * Every event the pipeline produces, in order, before the next action starts.
   *
   * Passed straight through: the pipeline does not touch the store and neither
   * does this, for the reason `PipelineOptions` gives — *an action that ran but
   * whose verdict was never recorded is the failure this design exists to
   * remove.*
   */
  readonly emit: (event: ActionEvent) => Promise<void> | void;
  /** What the four verdict kinds need. `actionsFromRecipe`'s own argument. */
  readonly deps?: ActionDeps;
  /** The ten bodies. All ten empty is the default, and is what lands today. */
  readonly bodies?: StepBodies;
  /**
   * How a step's declared list becomes actions that can run.
   *
   * `actionsFromRecipe` by default, which is where a cell `KINDS_AT` does not
   * run is refused by name. It is a seam because a `run:` action spawns a
   * process and an `agent:` one spends money, so a test that wants to exercise
   * the loop rather than the actions replaces it — which is what makes the
   * whole pass assertable in the half of the suite the `build` gate runs.
   */
  readonly actionsAt?: (step: Step, actions: readonly StepAction[]) => readonly Action[];
}

/** One step, and how it ended. `PassResult.steps` holds one per step reached. */
export interface StepReached {
  readonly step: Step;
  readonly ending: StepEnding;
}

export interface PassResult {
  /**
   * Every step the pass reached, in order, with how it ended — and `end` last,
   * always.
   *
   * The list is the anti-skip assertion: ten entries on a pass that got
   * through, and a `continue` anywhere in the loop would drop one.
   */
  readonly steps: readonly StepReached[];
  /**
   * Where the spine stopped, or null when every step passed.
   *
   * It names the step, which is the third of the three things 0058 §3c asks a
   * refusal to carry; the other two are on the ending. It is **not** set by
   * `end` failing after a stop: `end` runs on every ending, and what stopped
   * the pass is the step that did.
   */
  readonly stoppedAt: { readonly step: Step; readonly ending: Exclude<StepEnding, StepPassed> } | null;
}

/**
 * The ten steps, in order, driven by the recipe.
 *
 * ```ts
 * const result = await runPass({ recipe, context, emit });
 * result.steps;      // ten entries, in pass order
 * result.stoppedAt;  // null, or the step that stopped it and why
 * ```
 *
 * The whole of the control flow is: run each step; stop at the first one that
 * did not pass; run `end` whatever happened. Everything a step *does* is its
 * body's and its plugins', which is 0058 §2b — *the core is the sequence and
 * the outcome rules; everything that acts is a plugin.*
 */
export async function runPass(options: PassOptions): Promise<PassResult> {
  const bodies = options.bodies ?? NOT_BUILT_YET;
  const steps: StepReached[] = [];
  let stoppedAt: PassResult["stoppedAt"] = null;

  for (const spec of PASS) {
    const ending = await runStep(spec, options, bodies);
    steps.push({ step: spec.step, ending });
    if (ending.ending !== "passed") {
      stoppedAt = { step: spec.step, ending };
      break;
    }
  }

  // **`end` runs on every ending and cannot refuse** (0058 §3) — nothing can be
  // stopped once a merge has landed, and nothing can be left unfinished because
  // the pass stopped early either. A point that fires on *any* terminal outcome
  // cannot live on one of the paths that reaches one (`end-step.ts`): the loop
  // above reaches it only when every step passed, so this is the other nine
  // arrivals. The guard is for the one case where the loop already ran it — a
  // stop *at* `end` — which must not run it twice.
  if (stoppedAt !== null && stoppedAt.step !== "end") {
    steps.push({ step: "end", ending: await runStep(END, options, bodies) });
  }

  return { steps, stoppedAt };
}

/**
 * One step: its plugins, then its own work.
 *
 * Its plugins first because that is the order a refusal needs — at `prepared`
 * the install *is* the step, and a body asked to route on a refusal that had
 * not happened yet would be routing on nothing. A body is therefore called only
 * when the step's plugins passed, and never called at all is not a case: every
 * step's plugins either pass or end the pass.
 */
async function runStep(spec: StepSpec, options: PassOptions, bodies: StepBodies): Promise<StepEnding> {
  const actions = options.recipe.steps[spec.step];

  if (spec.plugins === "verdicts") {
    const build =
      options.actionsAt ?? ((step, list) => actionsFromRecipe(step, list, options.deps ?? {}));
    const result = await runActionPipeline({
      step: spec.step,
      actions: build(spec.step, actions),
      context: options.context,
      emit: options.emit,
    });
    const ending = endingOf(result);
    // Not `continue`, and not a swallowed failure: a step whose plugins did not
    // pass has ended, and the body does not run.
    if (ending.ending !== "passed") return onlyTheFourMayRefuse(spec, ending);
  }

  // The cast is the price of `StepBodies` being keyed by the literal step: read
  // at `bodies[spec.step]` with `spec.step: Step` it is a union of ten function
  // types, and calling a union wants the intersection of their parameters.
  // `EndingAt<Step>` distributes to `StepEnding`, so what comes back is checked
  // by `onlyTheFourMayRefuse` on the line below rather than by the compiler.
  const body = bodies[spec.step] as StepBody<Step>;
  const ending = await body({
    step: spec.step,
    actions,
    refuses: spec.refuses,
    context: options.context,
    emit: options.emit,
    deps: options.deps ?? {},
  });
  return onlyTheFourMayRefuse(spec, ending);
}

/**
 * The five verdicts `runActionPipeline` can produce, read once.
 *
 * Each of the four absences is asked for before `ok`, so a result that somehow
 * carries both cannot read as a pass — and a result carrying neither is a bug
 * in the pipeline rather than a step that quietly succeeded.
 */
function endingOf(result: PipelineResult): StepEnding {
  if (result.neverRanAt !== null) {
    return { ending: "never-ran", at: result.neverRanAt.action, detail: result.neverRanAt.detail };
  }
  if (result.didNotFinishAt !== null) {
    return {
      ending: "did-not-finish",
      // The pipeline's own name for it, and no finer word: it knows that an
      // agent started and left no receipt and nothing else. `needs-input` — the
      // token 0058 §3c gives a step that stopped to ask — is a body's to say,
      // because only a body knows a question was asked.
      because: "did-not-finish",
      at: result.didNotFinishAt.action,
      detail: result.didNotFinishAt.detail,
    };
  }
  if (result.heldAt !== null) {
    return { ending: "held", at: result.heldAt, question: evidenceFrom(result, result.heldAt) };
  }
  if (result.failedAt !== null) {
    return {
      ending: "refused",
      // `gate-failed` is the log's own word for *something the recipe declared
      // refused* — `RefusalReason` in `@lingtai/domain`, and 0058 §3c's own
      // example of a machine-readable reason. Not a new token, and #233 renames
      // it wherever it is written.
      because: "gate-failed",
      at: result.failedAt,
      detail: evidenceFrom(result, result.failedAt),
    };
  }
  if (result.ok) return { ending: "passed" };
  throw new Error(
    "runActionPipeline returned `ok: false` with no failed, held, never-ran or did-not-finish " +
      "action. That is a pipeline that stopped for a reason it did not name, and a pass cannot " +
      "report it — see `PipelineResult` in packages/actions/src/action.ts.",
  );
}

/** What the action said, which the pipeline carries beside its name. */
function evidenceFrom(result: PipelineResult, action: string): string {
  return result.results.find((r) => r.action === action)?.evidence ?? "";
}

/**
 * The runtime half of *only the four may refuse*.
 *
 * `EndingAt` says it to anybody writing a body and the compiler stops looking
 * once a body is read out of `StepBodies[Step]`. Throwing rather than
 * downgrading the refusal to something else: a refusal from `claim` is a
 * programming error about the workflow, and the consequences a refusal buys —
 * a fix round, a held item, a person — are exactly what must not be spent on
 * one nothing meant.
 */
function onlyTheFourMayRefuse(spec: StepSpec, ending: StepEnding): StepEnding {
  if (ending.ending === "refused" && !spec.refuses) {
    throw new Error(
      `the \`${spec.step}\` step refused, and only ${REFUSING_STEPS.join(", ")} may refuse ` +
        `(0058 §2): "${ending.because}" — ${ending.detail}. A step that did not finish reports ` +
        "`did-not-finish` and reaches `proposed` without buying a fix round (0057).",
    );
  }
  return ending;
}
