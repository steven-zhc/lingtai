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
 * Here: how a step is represented, how the recipe drives it, what a step is
 * handed and what it hands back, **where a step that did not pass goes**, and
 * what it reports when it rests. **The ten bodies are empty** — `NOT_BUILT_YET`
 * is all ten of them — because the bodies are the next ticket and they are
 * filling in a contract this file has already fixed. That is the point of the
 * split: whoever writes `claim`, `admit`, `prepared`, `design`, `implement` and
 * `end` has something that runs to write against, and whoever writes `build`,
 * `review`, `proposed` and `merge` after them has the same.
 *
 * **The routing is here and the judgement is not**, and that division is 0061
 * §3's in as many words: *`judge:` decides which step is next. The workflow
 * decides which steps it may choose from.* So the loop knows that a step which
 * did not pass arrives at `proposed`, it works out **the set of destinations on
 * offer**, it counts the rounds spent, it refuses a destination it did not
 * offer, and it moves the pass where it is told. Which of the offered
 * destinations is right for a given `reason` is a `judge:` plugin at `proposed`,
 * and that is T4b. Until one exists, `NOT_BUILT_YET.proposed` answers
 * `waiting` — every refusal goes to a person, which is what a system with no
 * judge built should do.
 *
 * ## An empty step is a pass, not a skip
 *
 * A recipe may omit any step and the resolved recipe holds all ten
 * ([0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §5,
 * `StepMap` in `@lingtai/recipe`), so the loop meets `[]` at nine steps out of
 * ten today — `KINDS_AT` accepts an action at four of them — and it must keep
 * going. **The one thing it must never do is `continue` past a step that *was*
 * configured**: four of `end`'s six cells were declarable, drawn, and silently
 * dropped by exactly that line (`#61`, and the comment at `end-step.ts`'s kind
 * guard). So every step the pass reaches runs its declared list and lands an
 * entry in `PassResult.steps`, and a configured step whose body does not exist
 * yet **throws** rather than passing quietly — *configured and did not run* must
 * not look like *empty* ([0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4). The loop reports that throw as the step's own ending rather than losing
 * the pass to it, which is the same rule once more: a pass that vanished must
 * not look like one that never started.
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
  runActionPipeline,
  type Action,
  type ActionContext,
  type ActionEvent,
  type ActionVerdict,
  type PipelineResult,
} from "@lingtai/actions";
import type { Recipe, StepAction } from "@lingtai/recipe";
import type { TerminalOutcome } from "./end-step.ts";

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
 * **The only step that routes** (0058 §3, §3b).
 *
 * A type of one, so that `StepRouted` is reachable from `proposed`'s body and
 * from no other — the same trick `RefusingStep` plays for the four. That
 * `proposed` is two jobs merged, the inspection and the router, is 0058's own
 * *What is not decided*; this file keeps them merged and tells them apart by
 * **how `proposed` was reached** — see `StepWork.arriving`.
 */
export type RoutingStep = "proposed";

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

/** One of the ten, and the three things about it the workflow fixes. */
export interface StepSpec {
  readonly step: Step;
  /** True for exactly `REFUSING_STEPS`. Derived, so the two cannot disagree. */
  readonly refuses: boolean;
  /** True for `proposed` alone. Derived, for the same reason. */
  readonly routes: boolean;
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
  routes: step === "proposed",
  // `end` alone, and named by the step rather than by a second list: one
  // exception written as a condition reads better than a table of nine `true`s.
  plugins: step === "end" ? "effects" : "verdicts",
}));

/** The ten rows by name, because the loop moves by name rather than by index. */
const SPEC: Readonly<Record<Step, StepSpec>> = Object.fromEntries(
  PASS.map((spec) => [spec.step, spec]),
) as Record<Step, StepSpec>;

/**
 * The step after this one on the spine, or `null` at `end`.
 *
 * The spine is `STEPS` and nothing else — *the order in the file is the order of
 * the pass* (0061 §1). Every departure from it is a route, and a route is
 * `proposed`'s to choose.
 */
function after(step: Step): Step | null {
  return STEPS[STEPS.indexOf(step) + 1] ?? null;
}

// ------------------------------------------------- what a step hands back ----

/** Nothing to report. The pass moves to the next step on the spine. */
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
 *
 * The one exception is `NEEDS_INPUT`, and it is an exception because the
 * **workflow** reads it rather than a judge.
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
 *
 * **And it does not go to the router.** 0058 §3b says `waiting` has exactly one
 * way in and that it is `proposed`'s to choose; a declared `human:` action is
 * not a second way in, it is the recipe having already decided that this pass
 * asks a person. Handing it to a judge would be asking whether to ask, after
 * the question was put.
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
 * a refusal buys a fix round and holds the item, and this buys none of it.
 *
 * Two unlike things end this way and the difference is the whole of `because`:
 *
 * - **an agent that stopped to ask** — `RunAwaitingInput`, and 0058 §3c's
 *   `needs-input`. It reaches `proposed`, which decides whether a person is
 *   worth interrupting or whether the agent should go round again stating its
 *   assumption. The token is `NEEDS_INPUT` and the loop reads it;
 * - **an agent that started and left no receipt**, a crash, a spent turn
 *   budget, a body that threw. 0057 §2 is the rule for those and it is *the
 *   pass stops*: there is no question for anybody to answer and nothing for a
 *   judge to route.
 *
 * Neither buys a fix round. Only the first has anywhere to go.
 */
export interface StepDidNotFinish {
  readonly ending: "did-not-finish";
  readonly because: string;
  readonly at: string | null;
  readonly detail: string;
}

/**
 * **The one `because` the workflow itself reads**, and the reason it must be a
 * constant rather than a string spelled out at two call sites.
 *
 * 0058 §3c gives `admit`, `design` and `implement` this token for *the step
 * stopped and asked*, and it is the only `did-not-finish` with a destination:
 * the judge's call is `waiting` with the question, or that step again with
 * *state your assumption*. Every other value of `because` belongs to the step
 * that produced it and the judge that reads it — see `StepRefused`.
 */
export const NEEDS_INPUT = "needs-input";

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
 *
 * **It does not go to the router either**, and for a reason the other four
 * cases make loud: the only judge worth an agent is itself an agent (0061 §3),
 * and an account that has just refused one agent will refuse the next. Paying
 * to ask *what shall we do about the quota* is the one route that cannot work.
 */
export interface StepNeverRan {
  readonly ending: "never-ran";
  readonly at: string;
  readonly detail: string;
}

/**
 * Where a pass that did not simply pass goes next — a step, or a person.
 *
 * `Step | "waiting"` rather than the four the drawing names, because **which
 * four are on offer is a fact the workflow computes per arrival** and not a
 * fact about the type (0061 §3: *the workflow decides which steps it may choose
 * from*). `onOffer` is that computation and `offering` is what a judge is
 * handed; a destination outside it is refused by name, which is 0061 §8's rule
 * used once more — *a step refuses a destination it did not offer.*
 *
 * `waiting` is not a step (0058 §3): it is where a pass rests until a person
 * moves it, and 0058 §3b's property worth keeping is that it has exactly one
 * way in.
 */
export type Destination = Step | "waiting";

/**
 * `proposed` sent the pass somewhere — **the only ending that is a decision
 * rather than a report**, and reachable from `proposed`'s body alone.
 *
 * `to` is one of the destinations the workflow offered. `why` is the judge's own
 * words and is what `waiting` displays beside the arriving step's `detail`;
 * [0043](../../../doc/decisions/0043-evidence-is-plain-text.md) already says
 * evidence is plain text and not a structure to be parsed.
 */
export interface StepRouted {
  readonly ending: "routed";
  readonly to: Destination;
  readonly why: string;
}

/** The six ways a step ends: five reports, and `proposed`'s one decision. */
export type StepEnding = StepPassed | StepRefused | StepHeld | StepDidNotFinish | StepNeverRan | StepRouted;

/** The five a step *reports*. Exactly the five `runActionPipeline` can produce. */
export type StepReport = Exclude<StepEnding, StepRouted>;

/**
 * **What a given step may hand back — the type, rather than a comment.**
 *
 * `refused` is subtracted for the six that may not refuse, so a `claim` body
 * returning one does not compile; `routed` is added for `proposed` alone, so no
 * other body can move the pass. That is 0058 §2's *the workflow fixes which
 * steps may refuse* and §3's *the only step that routes*, said in the one place
 * a body's author cannot read past.
 *
 * The runtime says both too — `theWorkflowsToSay` below — because a body reached
 * through `StepBodies[Step]` has been widened to the union and the compiler has
 * stopped looking.
 */
export type EndingAt<S extends Step> = S extends RoutingStep
  ? StepReport | StepRouted
  : S extends RefusingStep
    ? StepReport
    : Exclude<StepReport, StepRefused>;

// --------------------------------------------------------- the step bodies ----

/** One action's verdict, with the findings behind it, as the pipeline reports it. */
export type ActionOutcome = PipelineResult["results"][number];

/**
 * One visit to a step, and how it ended — with everything its plugins said.
 *
 * It is both what `PassResult.steps` holds and what a later step's body reads.
 * `results` is carried here rather than left on the log because the reader acts
 * on it: `proposed` is *the only step that routes* (0058 §3c) and it routes on
 * `build`'s verdict and `review`'s findings, neither of which is a `StepEnding`
 * — a review that found a blocker and a review that found nothing both end
 * `passed`. That is the reason `PipelineResult.results` carries findings rather
 * than leaving them on `GateFailed`, one layer up: reading the log back to
 * discover what the action just said would be a second source of truth for one
 * sentence.
 *
 * **A visit and not a step**, because a pass may reach one step twice: a round
 * back to `implement` visits `implement`, `build`, `review` and `proposed`
 * again. `PassResult.steps` is therefore in *visit* order and may repeat a name.
 *
 * `results` is `[]` at `end`, whose list is effects and never reaches a
 * pipeline; at any step whose list was empty; and at a `proposed` the pass
 * arrived at by routing, whose plugins are not re-run — see `StepWork.arriving`.
 */
export interface StepReached {
  readonly step: Step;
  readonly ending: StepEnding;
  readonly results: readonly ActionOutcome[];
}

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
  /**
   * Every visit the pass has already made, in order, with how each ended and
   * what its plugins said. Empty at `claim`; nine long at `end` on a pass that
   * sailed through, and longer on one that took a round.
   *
   * **A body that cannot see backwards cannot route**, and `proposed` is the
   * one step whose whole job is routing (0058 §3c): it decides on `build`'s
   * verdict and `review`'s findings. `emit` is write-only and `context` is
   * `{ runId, onSha, cwd, env, log?, round? }`, so without this the router
   * would have to read the log back for a sentence the pass is holding in
   * memory — which is the second source of truth `PipelineResult.results`
   * exists to avoid one layer down.
   */
  readonly reached: readonly StepReached[];
  /**
   * **The step that did not pass and sent the pass here — at `proposed`, and
   * nowhere else.**
   *
   * It is the whole of what tells `proposed`'s two jobs apart, which 0058's own
   * *What is not decided* says are merged in one station:
   *
   * - `null` — the pass reached `proposed` **on the spine**, after `review`
   *   passed. This is the inspection: the declared `watch:`, `human:` and
   *   tamper plugins have just run, and the body's answer is `passed` (on to
   *   `merge`) or one of the reports. 0058 §3b wants this visit for its own
   *   sake — *`proposed` runs on the way through as well as on the way back, so
   *   a pass that sailed through has a recorded decision saying it did*;
   * - a `StepReached` — the pass arrived **by routing**, carrying that step's
   *   `reason` (0058 §3c: *what happened has to arrive intact*). The body must
   *   answer with a `StepRouted`, and **`proposed`'s own plugins are not
   *   re-run**: they are verdicts about a diff, and the step that arrived did
   *   not pass, so there is no new diff to inspect. Re-running them would put a
   *   declared `human:` approval in front of a person once per round.
   */
  readonly arriving: S extends RoutingStep ? StepReached | null : null;
  /**
   * **The destinations the judge may choose from — at `proposed`, and nowhere
   * else**, and empty there on a spine visit, where there is nothing to route.
   *
   * 0061 §3, and the sentence the whole split rests on: *`judge:` decides which
   * step is next. The workflow decides which steps it may choose from.* The
   * workflow counts the rounds and restarts spent, works out what is reachable
   * from where the pass actually got to, and hands the judge the result as a
   * fact. **A judge is never asked to know which step it is answering for** —
   * it answers *which of these*, never *what is legal* — and when `rounds` is
   * spent, `implement` is simply not in the set.
   *
   * `onOffer` is the computation and its doc comment is the rule, cell by cell.
   */
  readonly offering: S extends RoutingStep ? readonly Destination[] : readonly [];
  /**
   * **Which ending the pass reached — at `end`, and nowhere else.**
   *
   * `end` is the one step whose declared effects are filtered by `when:`, and
   * `resolveEndActions(events, end, outcome)` takes that outcome as its third
   * argument (`end-step.ts`). A body handed no value for it could only run
   * every declared cell on every ending — `agent:hold` on an item that landed
   * — or run none of them, which is the declared-drawn-never-fired failure
   * (`#61`) this file opens by naming.
   *
   * The type says *at `end`, and nowhere else*: it is `TerminalOutcome` for
   * `StepWork<"end">` and `null` for the other nine. So `end`'s body needs no
   * narrowing to pass it on, and no other body can read an outcome that has
   * not been decided yet — the outcome is *where the pass came to rest*, and
   * only `end` runs after that is known. `outcomeOf` is the rule.
   */
  readonly outcome: S extends "end" ? TerminalOutcome : null;
  readonly context: ActionContext;
  readonly emit: (event: ActionEvent) => Promise<void> | void;
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
 * This is the whole of what `#253` leaves for T4b, written down where somebody
 * about to fill one in will meet it. Eight of them pass, because the loop has
 * already run their plugins by the time they are called and a step with no own
 * work has nothing left to do. Two do not, and both for the same reason: they
 * are the two places where *pass* would be a lie the loop cannot detect.
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
  /**
   * **Refuses**, and the only step that routes — and the router is the half of
   * it that cannot be empty.
   *
   * On the spine it passes, which is *nothing was declared and nothing said no*
   * and is the whole of today's behaviour at a point with no actions. On a
   * routing arrival it answers `waiting`: **a pass with no judge built sends
   * every refusal to a person.** That is not a placeholder standing in for a
   * decision — it is the correct decision while `rounds` can buy nothing,
   * because the alternative readings are both wrong. `passed` would carry a
   * refused change on to `merge`, and any step back would be the workflow
   * inventing the judgement 0061 §3 reserves for a plugin.
   *
   * T4b replaces it with one `judge:` per `when:` — `red` and `gate-failed`
   * mechanically back to `implement`, `findings` the one worth an agent — each
   * choosing from `offering` and nothing else.
   */
  proposed: async ({ arriving, offering }) =>
    arriving === null
      ? { ending: "passed" }
      : {
          ending: "routed",
          to: "waiting",
          why:
            `no \`judge:\` is built yet (T4b), so the \`${arriving.step}\` step's ` +
            `${arriving.ending.ending} goes to a person rather than to ` +
            `${offering.filter((d) => d !== "waiting").join(" or ") || "any step"}`,
        },
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
  end: async ({ actions, outcome }) => {
    if (actions.length === 0) return { ending: "passed" };
    throw new Error(
      `the \`end\` step has ${actions.length} effect(s) declared — ${actions
        .map((a) => `"${a.name}"`)
        .join(", ")} — and this pass has no body to carry them out. ` +
        // The outcome is quoted into the call the body will make, because it is
        // the argument a body had no value for until `StepWork` carried one:
        // the effects are filtered by `when:`, and a body that cannot read the
        // outcome can only run every cell or none, which is `#61` either way.
        `\`resolveEndActions(events, end, "${outcome}")\` resolves them onto the item's own stream ` +
        "and `tell.ts` does them; " +
        "throwing rather than passing, because a step that was configured and did not run must not " +
        "look like one that was empty (0016 §4, #61).",
    );
  },
};

// ---------------------------------------------------------- what is on offer ----

/**
 * What the workflow may spend on the back edges, as two numbers.
 *
 * **They are handed in rather than read off the recipe, and that is 0061 §4's
 * rule rather than a shortcut**: *a setting has exactly one home, and a step
 * that needs another step's receives the value rather than declaring it again.*
 * 0061 §2 puts `rounds` on `implement` and `restarts` on `claim` — the steps
 * each one bounds, *though the step that counts both is `proposed`* — and T3
 * has not moved them out of `runtime.limits` yet. So the pass takes the values;
 * it does not care which key they came from, and it will not need editing when
 * they move.
 */
export interface Ceilings {
  /**
   * How many times this pass may go back into the spine — a fix round, and what
   * `passCeiling` prices at *up to `rounds + 1` agent runs*
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
   *
   * **This is what makes the loop bounded**, and the bound is structural rather
   * than a guard: every back edge spends one, and when they are spent `onOffer`
   * stops offering a step. A judge that answers `implement` anyway is refused
   * by name.
   */
  readonly rounds: number;
  /**
   * How many restarts this **item** has left — its history, not this pass's, so
   * the caller counts it off the item's stream and the pass is told the answer.
   *
   * Zero means `claim` is not on offer and a spent pass rests with a person.
   * Above zero it may be chosen, and choosing it **ends this pass**: a restart
   * is a requeue (0058 §3b), the item is released, and the queue's next pass
   * orders by kind and then by number as it always does — so *the next ticket
   * taken may not be this one*.
   */
  readonly restartsLeft: number;
}

/** Nothing on the back edges, which is what a caller that says nothing gets. */
const NOTHING_SPARE: Ceilings = { rounds: 0, restartsLeft: 0 };

/**
 * The destinations a judge may choose from, given what arrived and what is left
 * to spend.
 *
 * **The set depends on how far the pass got, not only on what is left**
 * (0061 §3, and T4b's own *watch out*). Cell by cell:
 *
 * ```
 * waiting              always. A person can always be the answer, and 0058 §3b
 *                      keeps it to exactly one way in: this one
 * claim                while the item has a restart left. Choosing it requeues
 *                      and ends the pass
 * the arriving step    for a `needs-input` — 0058 §3c's *that step again with
 *                      "state your assumption"*. `admit`, `design` and
 *                      `implement` are the three that can ask
 * implement            for a refusal at `implement` or after it. **Not at
 *                      `prepared`**: a failed install refuses before any agent
 *                      has run, so there is no diff and no error in one to fix,
 *                      and a judge that knows nothing about `prepared` still
 *                      cannot choose wrongly
 * build                for a refusal at `merge` — a conflict an agent resolved
 *                      is code written *after* `review` passed, so it goes back
 *                      through both (0058 §3c). It is what buys the invariant
 *                      *every path into `end` has been through `build` and
 *                      `review`*
 * ```
 *
 * Both step edges want a round, because both buy another agent run.
 */
export function onOffer(arriving: StepReached, ceilings: Ceilings, roundsSpent: number): Destination[] {
  const offer: Destination[] = ["waiting"];
  if (ceilings.restartsLeft > 0) offer.push("claim");
  if (roundsSpent >= ceilings.rounds) return offer;

  const ending = arriving.ending;
  if (ending.ending === "did-not-finish" && ending.because === NEEDS_INPUT) {
    // The step that asked, asked again — carrying *state your assumption*. It is
    // the arriving step itself and never a neighbour: nothing else knows the
    // question.
    offer.push(arriving.step);
    return offer;
  }

  // A refusal. `implement` is on offer once the pass has got as far as an agent
  // having written something for a refusal to be about.
  if (AFTER_AN_AGENT.includes(arriving.step)) offer.push("implement");
  if (arriving.step === "merge") offer.push("build");
  return offer;
}

/**
 * The steps a refusal can arrive from with a diff behind it.
 *
 * `implement` itself is in the list because a refusal *at* `implement` is one
 * its own next run can answer. `prepared` is not, and that omission is the
 * whole of 0061 §3's worked example.
 */
const AFTER_AN_AGENT: readonly Step[] = ["implement", "build", "review", "merge"];

/**
 * The seven steps whose non-pass arrives at `proposed` — 0058 §3b's second
 * drawing, node for node.
 *
 * ```
 * a step that did not pass
 * admit · prepared · design · implement · build · review · merge   →   proposed
 * ```
 *
 * The three that are not on it are not omissions, and each is left off for its
 * own reason. **`claim`** has picked nothing, so there is no item, no worktree
 * and no diff for a judge to be handed — and 0058 §2 is why it is a rectangle at
 * all: *if a `claim` plugin could refuse, not one of those consequences would
 * mean anything.* **`proposed`** is the router, and a visit that did not pass
 * there has nowhere above it to appeal to, so `waiting` is where it rests.
 * **`end`** runs after the decision rather than before it.
 */
export const ARRIVE_AT_THE_ROUTER = [
  "admit",
  "prepared",
  "design",
  "implement",
  "build",
  "review",
  "merge",
] as const satisfies readonly Step[];

/**
 * Whether an ending has anywhere to go, or is where the pass rests.
 *
 * The other half of the drawing above, read off the ending rather than off the
 * step. What does **not** arrive is written on the endings themselves —
 * `StepHeld` (the recipe already asked a person), `StepNeverRan` (the account,
 * not the diff) — and one half of `did-not-finish`: 0057 §2's crash has no
 * question in it for a judge to answer, where `needs-input` is nothing but a
 * question.
 */
function goesToTheRouter(ending: StepEnding): ending is StepRefused | StepDidNotFinish {
  if (ending.ending === "refused") return true;
  return ending.ending === "did-not-finish" && ending.because === NEEDS_INPUT;
}

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
  /** The ten bodies. All ten empty is the default, and is what lands today. */
  readonly bodies?: StepBodies;
  /** What the back edges may spend. Nothing, when a caller says nothing. */
  readonly ceilings?: Ceilings;
  /**
   * How a step's declared list becomes actions that can run.
   *
   * **Handed in, and required.** `actionsFromRecipe` is what does it, and its
   * three dependencies — a reviewer, the diff's file list, an environment
   * resolver — are all things only a caller with a machine under it can build;
   * they are what `run-once.ts` assembles as `stepDeps` today. So turning a
   * declared list into a runnable action is neither the sequence nor the
   * outcome rules, and by 0058 §2b it is therefore not the pass's. Two things
   * follow and both are wanted: a cell `KINDS_AT` does not run is refused by
   * `actionsFromRecipe`, at the caller, by name — and a test can exercise the
   * whole loop without spawning a process, paying an agent or asking a person,
   * which is what puts this file's tests in the half of the suite the `build`
   * point runs (0060 §1).
   */
  readonly actionsAt: (step: Step, actions: readonly StepAction[]) => readonly Action[];
}

/** One decision `proposed` made, in the order it made them. */
export interface RouteTaken {
  /** The step that did not pass. `proposed` itself on a spine visit. */
  readonly from: Step;
  readonly to: Destination;
  readonly why: string;
}

/** Where a pass came to rest, when it did not simply get through. */
export type Rest = "waiting" | "requeued";

export interface PassResult {
  /**
   * Every **visit**, in order, with how it ended — and `end` last, always.
   *
   * Ten entries on a pass that got through, and more on one that took a round;
   * the list is the anti-skip assertion either way, since a `continue` anywhere
   * in the loop would drop one.
   */
  readonly steps: readonly StepReached[];
  /**
   * Where the pass stopped, or null when every step passed.
   *
   * It names the step, which is the third of the three things 0058 §3c asks a
   * refusal to carry; the other two are on the ending. On a routed pass it is
   * the step that **did not pass**, not the `proposed` that routed it: what a
   * person on *Waiting on you* needs is the install that failed, and the route
   * that brought it to them is `routes`.
   *
   * It is **not** set by `end` failing after a stop: `end` runs on every ending,
   * and what stopped the pass is the step that did. **Nor by `end` failing after
   * a pass that got through**, which is the same sentence from the other side:
   * the nine before it passed, so the merge landed and `end`'s body was handed
   * `landed` and has already resolved its `when: landed` effects. Naming `end`
   * here would make `outcomeOf` read `blocked` off the very pass those effects
   * closed the issue for, and a caller appending from it would write
   * `WorkItemBlocked` for an item whose `main` moved.
   *
   * **How `end` itself ended is `end`'s own entry in `steps`**, which is the
   * only place it is written down and the only place to read it.
   */
  readonly stoppedAt: { readonly step: Step; readonly ending: StepReport } | null;
  /**
   * Every route `proposed` chose, in order — the pass's own audit of the loops
   * it bought.
   *
   * Empty on a pass that sailed through. One entry per round, plus the last one
   * if the pass rested, so `routes.length` is the rounds spent and the reason
   * each was spent on.
   */
  readonly routes: readonly RouteTaken[];
  /**
   * Where the pass rests, when `proposed` sent it somewhere that is not a step.
   *
   * `null` covers both a pass that got through and one that stopped without
   * reaching the router at all — a `never-ran`, a crash, a `proposed` whose own
   * plugins refused. `stoppedAt` is what tells those apart from a landing.
   */
  readonly rested: Rest | null;
}

/**
 * The ending the pass reached, in the vocabulary `end` filters its effects on.
 *
 * **This is the pass's to say and not a body's** — 0058 §2b, *the core is the
 * sequence and the outcome rules.* The mapping is the one the conductor already
 * runs, read off its call sites rather than invented here:
 *
 * - nothing stopped the spine, so `merge` ran and the work landed — `landed`
 *   (`run-once.ts:3423`), and that stays true where `end`'s own body then
 *   stumbled: `main` moved either way, and `end` is never what stopped a pass
 *   (`PassResult.stoppedAt`);
 * - a refusal a person now holds, a question put to one, or an agent that
 *   started and left no receipt — `blocked`. All three end with a person
 *   holding the question and the item on *Waiting on you* (`run-once.ts:3383`,
 *   `:3274`, and `:2229`, whose own comment is *blocked rather than released*);
 * - an agent that never started, and **a restart** — `failed`, the two endings
 *   that ask nobody. The wall is about the account rather than the diff, so the
 *   claim is released and the item goes back to the queue
 *   ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3); a
 *   requeue releases it for the opposite reason, having decided a fresh
 *   approach is worth more than another round (0040). Both are what `failed`
 *   means at `end-step.ts` — *a run that ended without a diff worth merging and
 *   put the item back in the queue.*
 *
 * `closed` is the fourth and no pass produces it: it is a person deciding the
 * ticket is over ([0044](../../../doc/decisions/0044-a-close-is-a-terminal-outcome.md)),
 * and `close.ts` resolves `end` for it on its own path.
 */
export function outcomeOf(pass: Pick<PassResult, "stoppedAt" | "rested">): TerminalOutcome {
  if (pass.rested === "requeued") return "failed";
  if (pass.stoppedAt === null) return "landed";
  return pass.stoppedAt.ending.ending === "never-ran" ? "failed" : "blocked";
}

/**
 * The ten steps, in order, driven by the recipe.
 *
 * ```ts
 * const result = await runPass({ recipe, context, emit, actionsAt });
 * result.steps;      // one entry per visit, in order, `end` last
 * result.stoppedAt;  // null, or the step that stopped it and why
 * result.routes;     // what `proposed` decided, each time it decided
 * ```
 *
 * The control flow is four sentences and nothing else:
 *
 * 1. walk the spine — `STEPS`, in order — running each step's plugins and then
 *    its body;
 * 2. a step that did not pass goes to **`proposed`**, carrying its reason. All
 *    seven of them, which is 0058 §3b's second drawing;
 * 3. `proposed` answers with a destination from the set the workflow offered it:
 *    a step, and the walk resumes there having spent a round; or `waiting`; or
 *    `claim`, which requeues and ends the pass;
 * 4. `end` runs, whatever happened.
 *
 * Everything a step *does* is its body's and its plugins', which is 0058 §2b —
 * *the core is the sequence and the outcome rules; everything that acts is a
 * plugin.*
 *
 * **It terminates**, and structurally rather than by a guard: the only edges
 * that re-enter the spine are the ones `onOffer` offers, it offers none once
 * `roundsSpent` reaches `ceilings.rounds`, and a destination it did not offer
 * is refused. So the walk is at most `rounds + 1` laps long.
 */
export async function runPass(options: PassOptions): Promise<PassResult> {
  const bodies = options.bodies ?? NOT_BUILT_YET;
  const ceilings = options.ceilings ?? NOTHING_SPARE;
  const steps: StepReached[] = [];
  const routes: RouteTaken[] = [];
  let stoppedAt: PassResult["stoppedAt"] = null;
  let rested: Rest | null = null;
  let roundsSpent = 0;

  /** Where on the spine the walk is. `null` once there is nothing left but `end`. */
  let at: Step | null = "claim";

  while (at !== null && at !== "end") {
    // The spine visit: the step's own plugins, then its own body. Nothing has
    // arrived, so nothing is on offer and there is nothing to route.
    const reached = await runStep(SPEC[at], options, bodies, [...steps], {
      arriving: null,
      offering: [],
      // Nothing but `end` is told the outcome, because nothing but `end` runs
      // after it is known.
      outcome: null,
    });
    steps.push(reached);
    const ending = reached.ending;

    if (ending.ending === "passed") {
      at = after(at);
      continue;
    }

    if (ending.ending === "routed") {
      // Nothing arrived at a spine visit, so `theWorkflowsToSay` has already
      // refused any route from one — this is the guard that says so rather than
      // a case. Reported as an ending, for the reason `threw` gives: what an
      // escape from here takes with it is `end`.
      stoppedAt = {
        step: at,
        ending: threw(SPEC[at], new Error(`a spine visit routed the pass to \`${ending.to}\``)),
      };
      break;
    }

    // A step that did not pass, and is not one of the seven the drawing takes to
    // the router — either by which step it is, or by which of the five endings
    // it reported.
    if (!(ARRIVE_AT_THE_ROUTER as readonly Step[]).includes(at) || !goesToTheRouter(ending)) {
      stoppedAt = { step: at, ending };
      break;
    }

    // **Every one of the other seven arrives at `proposed`, carrying its
    // reason** — 0058 §3b, and §3c's *what happened has to arrive intact*. This
    // is a second visit to `proposed` in the pass rather than a branch inside
    // the spine walk, and it runs the router without the inspection: see
    // `StepWork.arriving`.
    const offering = onOffer(reached, ceilings, roundsSpent);
    const router = await runStep(SPEC.proposed, options, bodies, [...steps], {
      arriving: reached,
      offering,
      outcome: null,
    });
    steps.push(router);

    if (router.ending.ending !== "routed") {
      // The router itself did not answer — its body threw, or `theWorkflowsToSay`
      // refused what it answered. What stopped the pass is then `proposed`, and
      // the step that arrived is in `steps` one entry above it.
      stoppedAt = { step: "proposed", ending: router.ending };
      break;
    }

    const route = router.ending;
    routes.push({ from: reached.step, to: route.to, why: route.why });

    if (route.to === "waiting" || route.to === "claim") {
      rested = route.to === "claim" ? "requeued" : "waiting";
      // What a person reads is the step that did not pass, never the router that
      // sent it to them; where it was sent is `routes`.
      stoppedAt = { step: reached.step, ending };
      break;
    }

    // Back into the spine, and a round is what that costs.
    roundsSpent += 1;
    at = route.to;
  }

  // **`end` runs on every ending and cannot refuse** (0058 §3) — nothing can be
  // stopped once a merge has landed, and nothing can be left unfinished because
  // the pass stopped early either. A point that fires on *any* terminal outcome
  // cannot live on one of the paths that reaches one (`end-step.ts`), so it is
  // here, once, after the walk, whichever of the four ways the walk ended.
  const outcome = outcomeOf({ stoppedAt, rested });
  steps.push(
    await runStep(SPEC.end, options, bodies, [...steps], { arriving: null, offering: [], outcome }),
  );

  return { steps, stoppedAt, routes, rested };
}

/**
 * The three fields a visit is handed that depend on *how* it was reached rather
 * than on which step it is.
 *
 * Kept together and computed by `runPass` alone, because each is the workflow's
 * own answer and none is derivable inside `runStep`: `outcome` needs where the
 * pass rested, and `arriving`/`offering` need what the last step said and what
 * has been spent.
 */
interface Reaching {
  readonly arriving: StepReached | null;
  readonly offering: readonly Destination[];
  readonly outcome: TerminalOutcome | null;
}

/**
 * One visit: its plugins, then its own work.
 *
 * Its plugins first because that is the order a refusal needs — at `prepared`
 * the install *is* the step, and a body asked to route on a refusal that had
 * not happened yet would be routing on nothing. A body is therefore called only
 * when the step's plugins passed, and never called at all is not a case: every
 * step's plugins either pass or end the visit.
 *
 * **And it does not throw.** Whatever a body, an `actionsAt` or a workflow
 * assertion raises comes back as an ending, because the one thing that must
 * survive every way a step can go wrong is the pass reaching `end` — see
 * `threw` below.
 */
async function runStep(
  spec: StepSpec,
  options: PassOptions,
  bodies: StepBodies,
  reached: readonly StepReached[],
  reaching: Reaching,
): Promise<StepReached> {
  const actions = options.recipe.steps[spec.step];
  let results: readonly ActionOutcome[] = [];

  try {
    // A routing arrival runs the router and not the inspection — `StepWork
    // .arriving` is the whole argument, and it is why this is `=== null` rather
    // than an unconditional call.
    if (spec.plugins === "verdicts" && reaching.arriving === null) {
      const result = await runActionPipeline({
        step: spec.step,
        actions: options.actionsAt(spec.step, actions),
        context: options.context,
        emit: options.emit,
      });
      // Carried out whatever the step then did, because the verdicts are what a
      // later body routes on and a refusal's are the ones it most needs: a
      // `proposed` handed only *`build` refused* cannot tell a findings-bearing
      // refusal that buys a fix round from one that has nothing to fix.
      //
      // Assigned before the body runs, so a body that throws still reports what
      // its own plugins said.
      results = result.results;
      const ending = endingOf(spec, result);
      // Not `continue`, and not a swallowed failure: a step whose plugins did
      // not pass has ended, and the body does not run.
      if (ending.ending !== "passed") {
        return { step: spec.step, ending, results };
      }
    }

    // The cast is the price of `StepBodies` being keyed by the literal step:
    // read at `bodies[spec.step]` with `spec.step: Step` it is a union of ten
    // function types, and calling a union wants the intersection of their
    // parameters. `EndingAt<Step>` distributes to `StepEnding`, so what comes
    // back is checked by `theWorkflowsToSay` on the line below rather than by
    // the compiler.
    const body = bodies[spec.step] as StepBody<Step>;
    const ending = await body({
      step: spec.step,
      actions,
      refuses: spec.refuses,
      reached,
      // `StepWork<Step>`'s three conditional fields distribute to
      // `X | null` and `readonly Destination[]`, so none of them needs a cast.
      arriving: reaching.arriving,
      offering: reaching.offering,
      outcome: reaching.outcome,
      context: options.context,
      emit: options.emit,
    });
    return { step: spec.step, ending: theWorkflowsToSay(spec, ending, reaching), results };
  } catch (error) {
    return { step: spec.step, ending: threw(spec, error), results };
  }
}

/**
 * A step that threw is a step that did not finish, and the pass carries on.
 *
 * `action.ts` does this one layer down and says why — *the alternative is an
 * exception escaping the pipeline and a run ending with no verdict at all* —
 * and up here the same escape costs more, because what it takes with it is
 * `end`: the point 0058 §3 says runs on **every** ending, and the guarantee
 * this whole file is arranged around. An `implement` body whose agent runtime
 * raises, a `merge` whose `git push` throws, an `actionsAt` that refuses to
 * build a cell, or one of this file's own workflow assertions firing would
 * otherwise end the pass with no `PassResult`, no resolved `end` effects and no
 * terminal outcome on the item at all — the silent `return 1` that
 * `RefusalReason`'s doc says the old loop was built to remove. A run that
 * vanishes is the one shape an unattended pipeline cannot report.
 *
 * **`did-not-finish` at every one of the ten, and never `refused`**: a crash is
 * not a judgement about the change, so it buys no fix round and stands only the
 * pass down (0057 §1–3). `because` is `"threw"` rather than `NEEDS_INPUT`, and
 * that is not cosmetic: it is what stops a crash reaching the router, since
 * there is no question in it for a judge to answer. *The step threw* and *an
 * agent started and left no receipt* are likewise told apart by a caller
 * reading a field rather than a sentence (0031 §1) — and the message the
 * assertion wrote is on `detail`, which is where a person reads it.
 */
function threw(spec: StepSpec, error: unknown): StepDidNotFinish {
  return {
    ending: "did-not-finish",
    because: "threw",
    // No action to name: `runActionPipeline` has already turned a throwing
    // action into a verdict, so what arrives here is the step's own body or the
    // building of its list.
    at: null,
    detail: `the \`${spec.step}\` step threw: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * The five verdicts `runActionPipeline` can produce, read once.
 *
 * Each of the four absences is asked for before `ok`, so a result that somehow
 * carries both cannot read as a pass — and a result carrying neither is a bug
 * in the pipeline rather than a step that quietly succeeded.
 *
 * The step is read alongside the verdicts because one of the five means
 * different things at different steps: see `failedAt` below.
 */
function endingOf(spec: StepSpec, result: PipelineResult): StepReport {
  if (result.neverRanAt !== null) {
    return { ending: "never-ran", at: result.neverRanAt.action, detail: result.neverRanAt.detail };
  }
  if (result.didNotFinishAt !== null) {
    return {
      ending: "did-not-finish",
      // The pipeline's own name for it, and no finer word: it knows that an
      // agent started and left no receipt and nothing else. It is deliberately
      // not `NEEDS_INPUT` — nobody was asked anything, so there is nothing for
      // the router to route and 0057 §2's *the pass stops* is the rule.
      because: "did-not-finish",
      at: result.didNotFinishAt.action,
      detail: result.didNotFinishAt.detail,
    };
  }
  if (result.heldAt !== null) {
    return { ending: "held", at: result.heldAt, question: evidenceFrom(result, "needs-approval") };
  }
  if (result.failedAt !== null) {
    const said = {
      // *Something the recipe declared refused*, which is all the pipeline
      // knows. The log spells this `gate-failed` today — `RefusalReason` in
      // `@lingtai/domain`, and 0058 §3c's own example of a machine-readable
      // reason — and that spelling is the retired vocabulary `#232`'s allowlist
      // is down to nothing on, with `#233` renaming the value itself. Writing
      // it here would put a fifth word back on a list that may only shrink, so
      // this says the same thing in the vocabulary that replaced it: a step is a
      // step and an action is an action.
      because: "action-refused",
      at: result.failedAt,
      detail: evidenceFrom(result, "failed"),
    } as const;
    // **Which step ran it decides what a `failed` verdict means** (0058 §2).
    // At one of the four it is a refusal, with everything a refusal buys. At
    // the other six an action saying no is an ordinary plugin verdict and not a
    // programming error: `review`'s whole job is a reviewer that finds
    // blockers, and its verdict for one is `failed` — so the day `KINDS_AT`
    // opens that row (`recipe.ts:783`) the first blocker anybody finds arrives
    // on this line. Reported as a `did-not-finish` whose `because` is the
    // action's refusal: no fix round is spent at a step the workflow does not
    // let refuse, nothing the action said is dropped, and it does not reach the
    // router, because *a step that may not refuse has not refused* and there is
    // no judgement to route.
    return spec.refuses ? { ending: "refused", ...said } : { ending: "did-not-finish", ...said };
  }
  if (result.ok) return { ending: "passed" };
  throw new Error(
    "runActionPipeline returned `ok: false` with no failed, held, never-ran or did-not-finish " +
      "action. That is a pipeline that stopped for a reason it did not name, and a pass cannot " +
      "report it — see `PipelineResult` in packages/actions/src/action.ts.",
  );
}

/**
 * What the action the pipeline stopped at said.
 *
 * **Asked for by verdict, never matched by name.** Nothing makes an action's
 * name unique within a step — `actionsAt` (`recipe.ts:1093`) validates the
 * plugin and the kind, and no refinement in `recipe.ts` or `resolve.ts` refuses
 * a second `check` beside the first — so a lookup by name returns whichever was
 * declared first. A step declaring `check` twice, the first green and the
 * second red, would then report *refused at `check` — tests green*: a refusal
 * carrying the passing check's evidence, and at `needs-approval` a person asked
 * a question nobody asked.
 *
 * The pipeline stops at the first action that did not pass, so the one that
 * ended it is the only result with that verdict and is also the last;
 * `run-once.ts:2648` reads its refusal the same way and says why — *by verdict
 * rather than by position: the pipeline stops at the first one, so it is also
 * the last result — and asking for the verdict says what is meant.*
 */
function evidenceFrom(result: PipelineResult, verdict: ActionVerdict): string {
  return result.results.filter((r) => r.verdict === verdict).at(-1)?.evidence ?? "";
}

/**
 * The runtime half of the two rules the workflow keeps for itself, and **a
 * body's alone**.
 *
 * `EndingAt` says both to anybody writing a body, and the compiler stops
 * looking once a body is read out of `StepBodies[Step]` — which is the whole of
 * what this catches, and the whole of what its throws are right for. Three
 * things a body may not do, each a programming error about the workflow rather
 * than a thing that happened to a diff:
 *
 * - **refuse at one of the six** (0058 §2). The consequences a refusal buys —
 *   a fix round, a held item, a person — are exactly what must not be spent on
 *   one nothing meant;
 * - **route from anywhere but `proposed`** (0058 §3). `waiting` has exactly one
 *   way in and that is the property worth keeping: *is this worth interrupting
 *   somebody over* is asked in one place;
 * - **route somewhere it was not offered** (0061 §3, §8). The offer is how the
 *   workflow keeps the loop bounded while every plugin stays replaceable, so a
 *   judge that answers `implement` after `rounds` is spent is refused by name
 *   rather than obeyed.
 *
 * A plugin's `failed` verdict at one of the six is none of these and never
 * reaches here: `endingOf` reads it against the step and reports
 * `did-not-finish`, so a reviewer finding a blocker is answered rather than
 * treated as a bug.
 *
 * Every throw is caught by `runStep` and reported as the visit's ending,
 * because a programming error is the case where an unattended run most needs
 * `end` to run and the item to carry a terminal outcome. The message is what a
 * person reads on `detail`; what it no longer does is take the pass with it.
 */
function theWorkflowsToSay(spec: StepSpec, ending: StepEnding, reaching: Reaching): StepEnding {
  if (reaching.arriving !== null && ending.ending !== "routed") {
    // **A visit the loop routed into must answer with a route.** There is no
    // spine under it: the step before it did not pass, so `passed` would carry a
    // refused change onward and any report would be a second reason on top of
    // the one that arrived. The four answers are 0058 §3b's, and `waiting` is
    // always one of them, so there is no arrival a judge cannot answer.
    throw new Error(
      `\`proposed\` was handed the \`${reaching.arriving.step}\` step's ` +
        `${reaching.arriving.ending.ending} and answered \`${ending.ending}\` rather than a route. ` +
        `A step that did not pass is routed, not reported on again: choose one of ` +
        `${reaching.offering.join(", ")} (0058 §3b, 0061 §3).`,
    );
  }
  if (ending.ending === "refused" && !spec.refuses) {
    throw new Error(
      `the \`${spec.step}\` step refused, and only ${REFUSING_STEPS.join(", ")} may refuse ` +
        `(0058 §2): "${ending.because}" — ${ending.detail}. A step that may not refuse reports ` +
        "`did-not-finish` instead, which buys no fix round (0057) and is not routed.",
    );
  }
  if (ending.ending === "routed") {
    if (!spec.routes) {
      throw new Error(
        `the \`${spec.step}\` step routed the pass to \`${ending.to}\`, and \`proposed\` is the ` +
          "only step that routes (0058 §3). A step that did not pass reports its reason and the " +
          "loop takes it to `proposed`, which is what keeps `waiting` to one way in.",
      );
    }
    if (reaching.arriving === null) {
      throw new Error(
        `\`proposed\` routed the pass to \`${ending.to}\` on a visit nothing arrived at it — ` +
          `${ending.why}. A spine visit is the inspection and not the router: the change has just ` +
          "passed `build` and `review`, so what is there to route is `passed` on to `merge`. A " +
          "route is an answer to a step that did not pass (0058 §3b).",
      );
    }
    if (!reaching.offering.includes(ending.to)) {
      throw new Error(
        `\`proposed\` routed the pass to \`${ending.to}\`, which was not on offer — ` +
          `${reaching.offering.join(", ") || "nothing was"} (0061 §3). A judge answers *which of ` +
          "these*, never *what is legal*: the workflow counts the rounds and restarts spent and " +
          "hands it the set, so a destination outside the set is refused by name (0061 §8).",
      );
    }
  }
  return ending;
}
