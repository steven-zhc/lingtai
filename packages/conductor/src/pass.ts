/**
 * The pass: the ten steps as data, and the loop that runs them.
 *
 * **`conduct.ts` calls this, and has since `#256`.** It landed importing
 * nothing and imported by nothing, and that was the ticket rather than an
 * oversight (`#253`): the old engine was 2961 lines of five gate points wrapped
 * around code nobody could name or replace, and the shape of the work was never
 * surgery on it — it was *write the new pass beside it, and delete it*
 * ([the-pipeline.md](../../../doc/design/the-pipeline.md) §2). So it landed
 * wired to nothing: a reviewer read it against
 * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) and
 * [0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) rather than
 * against a diff, and a mistake here could not touch the conductor that was
 * running. The blast radius was zero until T5 wired it.
 *
 * ## What is here, and what is deliberately not
 *
 * Here: how a step is represented, how the recipe drives it, what a step is
 * handed and what it hands back, **where a step that did not pass goes**, and
 * what it reports when it rests. **The ten bodies in this file are empty** —
 * `NOT_BUILT_YET` is all ten of them, and the two that do more than pass do only
 * what the loop cannot let them leave unsaid — because the bodies are their own
 * tickets and they are filling in a contract this file has already fixed. That is
 * the point of the split: whoever writes `claim`, `admit`, `prepared`, `design`,
 * `implement` and `end` has something that runs to write against, and whoever
 * writes `build`, `review`, `proposed` and `merge` after them has the same.
 *
 * **All ten are now written, beside this file rather than in it** — `bodiesFor`
 * in [`pass-steps.ts`](pass-steps.ts) (`#259`, then `#254`), which is what a
 * caller hands `bodies` below. That object stays the default, because *nothing
 * was handed in* must go on doing the thing with no consequences rather than the
 * thing with a GitHub client and a paid judge behind it.
 *
 * **The routing is here and the judgement is not**, and that division is 0061
 * §3's in as many words: *`judge:` decides which step is next. The workflow
 * decides which steps it may choose from.* So the loop knows that a step which
 * did not pass arrives at `proposed`, it works out **the set of destinations on
 * offer**, it counts the rounds spent, it refuses a destination it did not
 * offer, and it moves the pass where it is told. Which of the offered
 * destinations is right for a given `reason` is a `judge:` plugin at `proposed`,
 * and it is asked by `bodiesFor`'s body rather than by anything here. Where no
 * judge is handed in, `NOT_BUILT_YET.proposed` sends a refusal to a person and
 * lets a clean way through past — every refusal is yours and nothing else is
 * held, which is what a system with no judge built should do.
 *
 * ## An empty step is a pass, not a skip
 *
 * A recipe may omit any step and the resolved recipe holds all ten
 * ([0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) §5,
 * `StepMap` in `@lingtai/recipe`), so the loop meets `[]` at nine steps out of
 * ten today — a plugin declares itself at four of them — and it must keep
 * going. **The one thing it must never do is `continue` past a step that *was*
 * configured**: four of `end`'s six cells were declarable, drawn, and silently
 * dropped by exactly that line (`#61`, and the comment at `end-step.ts`'s kind
 * guard). So every step the pass reaches runs its declared list and lands an
 * entry in `PassResult.steps`, and a configured step whose body does not exist
 * yet **throws** rather than passing quietly — *configured and did not run* must
 * not look like *empty* ([0016](../../../doc/decisions-archive/0016-the-settled-model.md)
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
  NEEDS_INPUT,
  NO_DESIGN,
  runActionPipeline,
  type Action,
  type ActionContext,
  type ActionEvent,
  type ActionFinding,
  type ActionVerdict,
  type PipelineResult,
  type SentBack,
  type TheDesign,
} from "@lingtai/actions";
import type { Recipe, StepAction } from "@lingtai/recipe";
import type { TerminalOutcome } from "./end-step.ts";

// ------------------------------------------------------- the ten, as data ----

/**
 * The four steps the workflow lets refuse, and no others
 * ([0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §2).
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

/**
 * **Where the step left the worktree — the one seam by which `onSha` advances**,
 * and it is on every ending because it is a fact about the tree rather than
 * about the judgement.
 *
 * `onSha` is *the commit this verdict is about, and the only thing that makes it
 * stale* (`ActionContext`), and `stepsOn()` (`packages/domain/src/run.ts`) shows
 * a verdict only where it equals the item's head. So a pass that judged `A`
 * while the tree stood at `B` has paid for every verdict and can show none of
 * them. The workflow cannot work the value out — it runs no git — and the caller
 * cannot either, because the commit happens in the middle of the walk: the agent
 * at `implement` makes it, and `admit` is where the worktree is cut at all. So
 * the step that moved the tree says so, and the loop carries it to every visit
 * after it.
 *
 * Absent is *the tree did not move*, which is eight of the ten and all but one
 * of the endings the pipeline produces. **The exception is `admit`'s, and it is
 * `#268`'s** — the cut is a `worktree:` action now (0065 §4), so the one action
 * that *makes* a tree rather than judging one reports where it left it on
 * `ActionResult.head` and `endingOf` carries it here. Every other verdict is
 * about the head it was handed and sets nothing.
 */
export interface LeftTheTreeAt {
  /** The commit the step's own work left the worktree at, when it moved it. */
  readonly head?: string;
}

/**
 * **What `design`'s own plugins wrote**, and absent at the other nine (`#265`).
 *
 * `LeftTheTreeAt`'s sibling and it is here for that field's reason: the pass runs
 * no agent of its own, so the one action that produced a document is the only
 * thing that knows what it says, and `implement`'s brief needs it one step later.
 * Carried on the ending rather than remembered in a closure, because `reached` is
 * this pass's own record and a variable beside it would be a second one.
 *
 * **Only on a pass, and only ever `design`'s.** A step whose plugins did not pass
 * produced no document — a draft that did not finish is `did-not-finish`, and its
 * design is the `""` the pass came in with — so this rides on `StepPassed` alone
 * rather than on every ending the way `head` does.
 *
 * Absent and `""` are different facts and both are kept: *nothing here drafted*
 * is the nine steps and every unconfigured `design`, and *the agent answered that
 * this change needs none* is a document it wrote. `implement` is briefed
 * identically either way (0058 §3), and a person reading the card is not.
 *
 * **Three facts since `#297`, and the third is where the document was kept.**
 * `TheDesign` is the shape, and the paragraph deciding what crosses this
 * boundary is on it: the document *and* the locator travel, the document is the
 * source of truth, and nothing above the plugin that wrote the locator reads it
 * (0066 §3, §4). The key here still carries *drafted at all*; the value carries
 * the other two.
 *
 * **Still in memory and still not on an event.** This is the visit's ending,
 * which `runPass` holds; what reaches the log is `evidence`, and 0066 §3's whole
 * point is that a locator is what belongs there. Widening this widens nothing a
 * replay pays for.
 */
export interface WroteTheDesign {
  /**
   * What the step's own work produced and where it kept it, when it produced
   * something. `TheDesign`.
   */
  readonly design?: TheDesign;
}

/** Nothing to report. The pass moves to the next step on the spine. */
export interface StepPassed extends LeftTheTreeAt, WroteTheDesign {
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
 * the second ([0043](../../../doc/decisions-archive/0043-evidence-is-plain-text.md)).
 *
 * **No value of `because` decides where the pass goes**, and since `#296` that
 * is a property of the types rather than a claim in a comment: the one that did
 * — `NEEDS_INPUT` on a `did-not-finish` — is the `StepAsked` ending. Every token
 * left is read by a judge and by a person, and neither of them needs it
 * enumerated here.
 */
export interface StepRefused extends LeftTheTreeAt {
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
 * the `human:` plugin's `at` — `proposed` alone since `#270` — and not
 * this type's, which is why `held` is not restricted to the four the way
 * `refused` is.
 *
 * **And it does not go to the router.** 0058 §3b says `waiting` has exactly one
 * way in and that it is `proposed`'s to choose; a declared `human:` action is
 * not a second way in, it is the recipe having already decided that this pass
 * asks a person. Handing it to a judge would be asking whether to ask, after
 * the question was put.
 */
export interface StepHeld extends LeftTheTreeAt {
  readonly ending: "held";
  readonly at: string;
  readonly question: string;
}

/**
 * The step ran and produced no judgement of any kind, and there is **no
 * question in it**.
 *
 * **Kept apart from a refusal from the start, because it costs different
 * money** ([0057](../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md)):
 * a refusal buys a fix round and holds the item, and this buys none of it.
 *
 * What ends this way is *an agent that started and left no receipt* — a crash, a
 * spent turn budget, a body that threw — and the several mechanical declines
 * that are nobody's judgement either: `claim`'s `passed-over`, `not-claimed` and
 * `claim-unconfirmed`, `end`'s `END_UNRESOLVED`, and a `failed` at one of the
 * five steps the workflow does not let refuse. 0057 §2 is the rule for all of
 * them and it is *the pass stops*: there is nothing for a judge to route.
 *
 * **`StepAsked` was inside this type until `#296`**, told apart by
 * `because === NEEDS_INPUT`. That is why `because` is still here and why it is no
 * longer read for control flow: every value it carries now is for a judge and a
 * person, and the one the *workflow* branched on is the ending below.
 */
export interface StepDidNotFinish extends LeftTheTreeAt {
  readonly ending: "did-not-finish";
  readonly because: string;
  readonly at: string | null;
  readonly detail: string;
}

/**
 * **The step stopped and asked something** — 0058 §3c, and the one report with a
 * destination.
 *
 * `admit`, `design` and `implement` can reach it: an agent stopped mid-flight
 * through the hook (`RunAwaitingInput`), or answered a question where a document
 * was asked for. It arrives at `proposed`, whose call is `waiting` with the
 * question or *that step again, stating its assumption* — and nothing but the
 * step that asked knows the question, which is why `onOffer` offers that step
 * and no other from here.
 *
 * **It cost 0057's grouping nothing to split it out** (`#296`). This buys no fix
 * round either, so by *cost* it is still `did-not-finish`'s twin and 0057 §1–3
 * covers both; what it does not share is *destination*, and that was a
 * `did-not-finish` whose `because` happened to equal `NEEDS_INPUT`. `because` is
 * a plain `string` carrying a dozen unlike words, so the compiler could not tell
 * the one the workflow branched on from the ones only a person reads: a token
 * spelled `needs input`, a plugin that set none, an action that forgot — each is
 * a legal `string` and each silently loses the destination and stops a pass that
 * had a question in it. `#279` is the same class caught after it cost $8.97.
 *
 * **No `because`.** *It asked* is the whole of the reason, and a field that could
 * only ever hold one value is the free-form string this ending exists to be rid
 * of. `detail` is the question, in the agent's own words (0043).
 */
export interface StepAsked extends LeftTheTreeAt {
  readonly ending: "asked";
  /** The action whose agent asked, or null where the step's own work did. */
  readonly at: string | null;
  /** The question. */
  readonly detail: string;
}

/**
 * **The token an action says *it asked* with, and the direction a `judge:` is
 * declared at** — no longer a value the workflow compares anything to (`#296`).
 *
 * It is `ActionResult.because` on the way up: the two `agent` actions that can be
 * asked a question set it, `runActionPipeline` reads it *once* and answers
 * `askedAt`, and `endingOf` turns that into `StepAsked`. Above the pipeline
 * nothing spells it to decide where a pass goes; what is left is `directionOf`
 * handing it to `proposed` as the `when:` a recipe writes, which is a name in a
 * vocabulary rather than a branch.
 *
 * **It moved to `@lingtai/actions` in `#266` and is re-exported here**, because
 * the agent at `implement` is a plugin and a second definition of one word is the
 * drift `worktree-action.ts` names.
 */
export { NEEDS_INPUT, NO_DESIGN, type SentBack, type TheDesign };

/**
 * The step was reached and its agent never started.
 *
 * A fifth ending and not a flavour of the fourth: `never-ran` is the wall that
 * is about the *account* rather than about the diff — a quota, a signed-out
 * runtime — and its consequence is that the conductor stands down and the item
 * goes back to the queue ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md)
 * §3). `did-not-finish` is local to one crash and stands only the pass down
 * (0057 §3). A caller that had to read `detail` to tell them apart would be the
 * second reader of a sentence 0031 §1 exists to prevent.
 *
 * **It does not go to the router either**, and for a reason the other four
 * cases make loud: the only judge worth an agent is itself an agent (0061 §3),
 * and an account that has just refused one agent will refuse the next. Paying
 * to ask *what shall we do about the quota* is the one route that cannot work.
 */
export interface StepNeverRan extends LeftTheTreeAt {
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
 * [0043](../../../doc/decisions-archive/0043-evidence-is-plain-text.md) already says
 * evidence is plain text and not a structure to be parsed.
 */
export interface StepRouted extends LeftTheTreeAt {
  readonly ending: "routed";
  readonly to: Destination;
  readonly why: string;
  /**
   * Where the decision **wanted** to go, where that is not where it went — and
   * absent everywhere else, which is every route that got what it asked for.
   *
   * It is deliberately not held to `offering`: the whole of what it records is a
   * choice the offer did not contain, and `theWorkflowsToSay` checks `to` for
   * that reason. Which limit refused it is not a body's to say either — the
   * workflow counts the rounds and the restarts (0061 §3) — so `take` names the
   * ceiling and this says only what was wanted (`RouteTaken`, `#271`).
   */
  readonly chose?: Destination;
}

/** The seven ways a step ends: six reports, and `proposed`'s one decision. */
export type StepEnding =
  | StepPassed
  | StepRefused
  | StepHeld
  | StepDidNotFinish
  | StepAsked
  | StepNeverRan
  | StepRouted;

/** The six a step *reports*. Exactly the six `runActionPipeline` can produce. */
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
 * than leaving them on `StepFailed`, one layer up: reading the log back to
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
   *
   * A route is legal on both, and that is what makes `review` able to judge
   * nothing: it passes carrying findings, and the visit that reads them is the
   * `null` one. What is legal only on the second is *anything but* a route.
   */
  readonly arriving: S extends RoutingStep ? StepReached | null : null;
  /**
   * **What is on offer — at `proposed`, and nowhere else.** Never empty on
   * either of its visits, because a judge may hold a change back on the way
   * through as well as answer a refusal on the way back.
   *
   * 0061 §3, and the sentence the whole split rests on: *`judge:` decides which
   * step is next. The workflow decides which steps it may choose from.* The
   * workflow counts the rounds and restarts spent, works out what is reachable
   * from where the pass actually got to, and hands the body the result as a
   * fact. **A judge is never asked to know which step it is answering for** —
   * it answers *which of these*, never *what is legal* — and when `rounds` is
   * spent, `implement` is simply not in `affordable`.
   *
   * **Two sets and not a menu** (0064 §7, `Offer`): the body routes against
   * `affordable` and hands a judge that list alone, and `reachable` is there so
   * that a decision the offer refused can be reported as *no money* or as *no
   * meaning* rather than as one indistinguishable absence.
   *
   * `onOffer` is the computation and its doc comment is the rule, cell by cell.
   */
  readonly offering: S extends RoutingStep ? Offer : NoOffer;
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
  /**
   * **This visit's context, and the same object its plugins were just run
   * with** — so a body dispatching an agent and the pipeline that judges what
   * the agent wrote are talking about one commit, in one round.
   *
   * Three of its fields move as the pass walks and the loop rebuilds them per
   * visit: `onSha` (the head, which a body advances by returning one on its
   * ending — `LeftTheTreeAt`), `round` (the pass's own count of the rounds it
   * bought), and `recheck` (what this round was bought on, 0038 §2). The rest is
   * the caller's and never changes.
   */
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
 * This is what `#253` left for the two tickets after it, written down where
 * somebody about to fill one in will meet it. Eight of them pass, because the
 * loop has already run their plugins by the time they are called and a step with
 * no own work has nothing left to do. Two do not, and both for the same reason:
 * they are the two places where *pass* would be a lie the loop cannot detect.
 *
 * **All ten are written and are not here** — `bodiesFor` in
 * [`pass-steps.ts`](pass-steps.ts) (`#259`, then `#254`) — and this object is
 * still all ten, still the default, and still what runs when a caller hands
 * nothing in. So the rows below say what the step is *for*, which has not
 * changed, rather than what any running body does: not one of them is still
 * waiting to be written somewhere.
 */
export const NOT_BUILT_YET: StepBodies = {
  /** Pick the ticket — `discover`/`claim`, and `queue:`'s four fields. */
  claim: nothingBeyondThePlugins,
  /**
   * Start work on it; the worktree is cut here, so this is where the `head` a
   * pass is judged against first has a value. May report `needs-input`.
   */
  admit: nothingBeyondThePlugins,
  /** The tree is ready to be worked in. **Refuses** — the cheapest one in the pass. */
  prepared: nothingBeyondThePlugins,
  /** A document, before any code — **or nothing, which is an answer** (0058 §3). */
  design: nothingBeyondThePlugins,
  /**
   * One agent, in that worktree — and **it reports the `head` it committed**,
   * which is the whole of what moves `onSha` on a fix round. May report
   * `needs-input`.
   */
  implement: nothingBeyondThePlugins,
  /**
   * **Refuses**, and a red one skips `review` — which is the loop's doing
   * rather than this body's: a refusal here goes to `proposed`, so `review` is
   * never reached and no agent is paid to read a diff that does not compile.
   */
  build: nothingBeyondThePlugins,
  /**
   * Reads the diff, returns findings, judges nothing — the findings are its
   * plugins' and travel on `StepReached.results`; `endingOf` is where *no
   * verdict of its own* is enforced.
   */
  review: nothingBeyondThePlugins,
  /**
   * **Refuses**, and the only step that routes — and the router is the half of
   * it that cannot be empty.
   *
   * On its own way through it passes, which is *`build` and `review` said
   * nothing that stops this* and is today's behaviour at a point whose actions
   * all passed: no judge is reading the findings, so nothing holds the change
   * back. On a routing arrival it answers `waiting`: **a pass with no judge built
   * sends every refusal to a person.** That is not a placeholder standing in for
   * a decision — it is the correct decision while `rounds` can buy nothing,
   * because the alternative readings are both wrong. `passed` would carry a
   * refused change on to `merge`, and any step back would be the workflow
   * inventing the judgement 0061 §3 reserves for a plugin.
   *
   * **The body that asks a judge is `bodiesFor`'s** ([`pass-steps.ts`](pass-steps.ts),
   * `#254`) — one `judge:` per `when:`, `red` and `verify-failed` mechanically
   * back to `implement`, `findings` the one worth an agent, each choosing from
   * `offering` and nothing else. What it keeps is this row's floor: an arrival
   * no judge can answer still reaches a person.
   */
  proposed: async ({ arriving, offering }) =>
    arriving === null
      ? { ending: "passed" }
      : {
          ending: "routed",
          to: "waiting",
          why:
            `no \`judge:\` is built yet in these bodies (\`bodiesFor\`'s ask one), so the ` +
            `\`${arriving.step}\` step's ` +
            `${arriving.ending.ending} goes to a person rather than to ` +
            `${offering.affordable.filter((d) => d !== "waiting").join(" or ") || "any step"}`,
        },
  /**
   * **Refuses**, and reports a `reason` and a `detail` rather than deciding —
   * the lane is `bodiesFor`'s port, and over the whole log it has refused 32
   * times: 26 `verify-failed`, 6 `conflict`. Somebody else's work landed and the
   * diff stopped being true, which is a fact about the world rather than a
   * verdict about the change.
   */
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
   *
   * The body that *can* carry them out is `bodiesFor`'s
   * ([`pass-steps.ts`](pass-steps.ts)), and it makes exactly the call this throw
   * names.
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
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md)).
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
 * What `proposed`'s own visit is judging: nothing refused.
 *
 * Named because `onOffer` takes an ending and the way-through visit has not
 * reached one: `runPass` asks it what would be on offer *if nothing refused*
 * before the body runs, then asks again with the ending the body returned. A
 * bare `{ ending: "passed" }` at the first of those two calls would not say
 * which of the two questions it is asking.
 */
const PASSED_THROUGH: StepPassed = { ending: "passed" };

/**
 * **What is on offer, and it is two sets rather than one** (0064 §7).
 *
 * `offering` used to be a single list mixing two unlike facts, and the whole
 * cost of that was that **it could not say why a destination was missing**: *no
 * meaning* and *no money* read identically, and they are different messages to
 * whoever ends up on the card. `implement` is off a `prepared` refusal's offer
 * because no agent has run — no number a person could raise would put it back —
 * and off a spent pass's offer because the rounds are gone, which is exactly a
 * number a person could raise.
 *
 * So the two are named separately and the difference between them is the
 * budget's, by construction: `affordable` is `reachable` minus what the ceilings
 * refuse, and `ceilingFor` reads which ceiling that was off the pair rather than
 * re-deriving it. **`waiting` is in both, always** — it is the one destination
 * that costs nothing, so no ceiling can take it out, which is what makes it the
 * right answer both when a decision chooses it and when a ceiling is spent.
 *
 * **A judge is handed `affordable` and never this object.** It answers *which of
 * these*, never *what is legal*, and the reachable set is the workflow's own
 * arithmetic about money — `Judging` in [`pass-steps.ts`](pass-steps.ts) carries
 * the one list, and 0064 §7's *the plugin chooses; the workflow still bounds what
 * the choice costs* is that line drawn.
 */
export interface Offer {
  /**
   * Everything the arrival could mean, whatever is left to spend — *how far the
   * pass got*, and the half no ceiling participates in.
   */
  readonly reachable: readonly Destination[];
  /**
   * Those of them this pass can pay for. **This is the set, and the only one a
   * decision is held to** (`theWorkflowsToSay`).
   */
  readonly affordable: readonly Destination[];
}

/**
 * Nothing on offer — the nine steps that do not route, said as two empty sets
 * rather than as an absent field.
 *
 * Its own type, so `StepWork.offering` goes on saying *at `proposed`, and
 * nowhere else* in the type rather than in a comment.
 */
export interface NoOffer {
  readonly reachable: readonly [];
  readonly affordable: readonly [];
}

/** The one value of `NoOffer`, so the nine visits share it. */
export const NO_OFFER: NoOffer = { reachable: [], affordable: [] };

/**
 * **Which ceiling took a destination off the offer, or null** — and null is a
 * real answer twice over.
 *
 * Read off the pair rather than by asking `onOffer` a second question with a
 * fabricated budget, which is what this replaces: a destination in `reachable`
 * and not in `affordable` differs from an affordable one *by the budget and by
 * nothing else*, so the subtraction is the answer and the arithmetic is which
 * number pays for that edge — `claim` is the item's restarts and every other
 * edge is this pass's rounds (`Ceilings`).
 *
 * Null where the destination was affordable, and null where it was never
 * reachable: the second is the one worth naming, because a refusal that named a
 * ceiling there would send a person to raise a limit that will refuse the same
 * route again.
 */
export function ceilingFor(to: Destination, offer: Offer): Ceiling | null {
  if (offer.affordable.includes(to) || !offer.reachable.includes(to)) return null;
  return to === "claim" ? "restarts" : "rounds";
}

/**
 * The destinations a judge may choose from, given what arrived and what is left
 * to spend.
 *
 * **The set depends on how far the pass got, not only on what is left**
 * (0061 §3, and T4b's own *watch out*). `at` is where the pass is and `ending`
 * is what it reported there — `passed` on `proposed`'s own way through, which is
 * a routing opportunity too. Cell by cell:
 *
 * ```
 * waiting              always. A person can always be the answer, and 0058 §3b
 *                      keeps it to exactly one way in: this one
 * claim                **on `proposed`'s own way through, and nowhere else**,
 *                      while the item has a restart left. That visit is the
 *                      `findings` direction — every other arrival at the router
 *                      is one of the mechanical four (`directionOf`) — and
 *                      0039 §2's rule is that a restart needs a *judgement*: a
 *                      red build and a conflict leave the work still there and
 *                      their remedy is mechanical, so starting over throws a
 *                      branch away for nothing. **No number a project writes
 *                      down should make a typecheck error buy a fresh
 *                      worktree, and no judge should be able to either.**
 *                      Choosing it requeues and ends the pass
 * that step again      for a `needs-input` — 0058 §3c's *that step again with
 *                      "state your assumption"*. `admit`, `design` and
 *                      `implement` are the three that can ask, and nothing but
 *                      the step that asked knows the question
 * implement            from `implement` or anywhere after it. **Not from
 *                      `prepared`**: a failed install refuses before any agent
 *                      has run, so there is no diff and no error in one to fix,
 *                      and a judge that knows nothing about `prepared` still
 *                      cannot choose wrongly
 * build                from `merge` — a conflict an agent resolved is code
 *                      written *after* `review` passed, so it goes back through
 *                      both (0058 §3c). It is what buys the invariant *every
 *                      path into `end` has been through `build` and `review`*
 * ```
 *
 * Both step edges want a round, because both buy another agent run.
 *
 * **`stepsOnOffer`'s other rule has no cell here because the loop already keeps
 * it.** That function also takes `claim` off the set when something else on the
 * pass has asked for a person — releasing the item would throw their question
 * away — and in this loop nothing can have: a `human:` action, a `watch:` that
 * saw a migration and a repair all end their step `held`, `goesToTheRouter`
 * lets no `held` past, and the pass rests there without ever reaching a judge.
 * So the rule is a fact about the walk rather than a line in this function, and
 * `alsoAsked` has no counterpart on `Judging` for the same reason.
 *
 * **The cells above are `reachable`, and `affordable` is what the two ceilings
 * then leave of it** (0064 §7). Every one of them but `waiting` re-enters the
 * spine and so buys an agent run, which is what they cost: `claim` spends the
 * item's restart and each of the others spends one of this pass's rounds. That
 * subtraction is the whole of the second set, and it is why the offer can say
 * which half refused a destination without being asked a second question.
 */
export function onOffer(at: Step, ending: StepEnding, ceilings: Ceilings, roundsSpent: number): Offer {
  const reachable: Destination[] = ["waiting"];
  // The way-through visit, which is the `findings` direction and the only one a
  // restart is offered for — see the table above. **Reachable whatever the item
  // has left**: having no restart to spend is the budget's answer and not this
  // half's, which is the distinction the two sets exist to keep.
  if (at === "proposed" && ending.ending === "passed") reachable.push("claim");

  if (ending.ending === "asked") {
    // The step that asked, and nothing else: nobody but it knows the question,
    // so the edges below are not reachable from a question either.
    reachable.push(at);
  } else {
    // `implement` is on offer once the pass has got as far as an agent having
    // written something for the decision to be about.
    if (AFTER_AN_AGENT.includes(at)) reachable.push("implement");
    if (at === "merge") reachable.push("build");
  }

  const round = roundsSpent < ceilings.rounds;
  const restart = ceilings.restartsLeft > 0;
  return {
    reachable,
    // `waiting` costs nothing, so no ceiling can take it out — which is what
    // keeps the set non-empty and therefore keeps every arrival answerable.
    affordable: reachable.filter((to) =>
      to === "waiting" ? true : to === "claim" ? restart : round,
    ),
  };
}

/**
 * The places a pass can be judged from with a diff behind it.
 *
 * `implement` itself is on the list because a refusal *at* `implement` is one
 * its own next run can answer, and `proposed` is on it because **`proposed`
 * routes on the way through as well as on the way back** (0058 §3b) — a `review`
 * that passed with findings above the bar is judged at that visit, and its
 * answer is *the lines or the approach* (0061 §3). `prepared` is not on the
 * list, and that omission is the whole of 0061 §3's worked example.
 */
const AFTER_AN_AGENT: readonly Step[] = ["implement", "build", "review", "proposed", "merge"];

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
 * not the diff), `StepDidNotFinish` (0057 §2's crash has no question in it for a
 * judge to answer).
 *
 * **Two `ending` values and no `because`** (`#296`). It read
 * `ending === "did-not-finish" && ending.because === NEEDS_INPUT` until *asked*
 * was its own ending, which is one control-flow decision taken on a free-form
 * string: nothing in the type system said that a plugin spelling the token
 * differently, or forgetting it, would send a pass with a question in it to a
 * stop instead of to a judge.
 */
function goesToTheRouter(ending: StepEnding): ending is StepRefused | StepAsked {
  return ending.ending === "refused" || ending.ending === "asked";
}

// ------------------------------------------------------------- the loop ----

export interface PassOptions {
  /**
   * The resolved recipe. Only `steps` is read, and it holds all ten (0061 §5),
   * so `recipe.steps[step]` is a lookup that cannot miss.
   */
  readonly recipe: Pick<Recipe, "steps">;
  /**
   * **What the walk starts from, and not what every visit is handed.**
   *
   * `runId`, `cwd`, `env` and `log` are the pass's throughout. The other three
   * move while it runs and the loop rebuilds them per visit, so a caller sets
   * them once and never again: `onSha` is the base until a step says it moved
   * the tree (`LeftTheTreeAt`), `round` is replaced by the pass's own count of
   * the rounds it bought, and `recheck` is replaced at every route back into the
   * spine by what that round was bought on (`contextFor`).
   *
   * A frozen context here was `#253`'s first refusal, and it is worth naming:
   * every verdict a fix round pays for is stamped with the head *before* the fix,
   * so `stepsOn()` filters all of them out and the board shows a change with no
   * build and no review — while `PassResult.steps` says ten steps passed.
   */
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
  /**
   * The ten bodies.
   *
   * `bodiesFor` in [`pass-steps.ts`](pass-steps.ts) is what a caller with a
   * machine under it hands here — all ten of them.
   * **`NOT_BUILT_YET` is the default and stays it**: a pass handed nothing must do
   * the thing with no consequences, not the thing with a GitHub client behind it,
   * so *forgot to pass them* cannot claim a ticket.
   */
  readonly bodies?: StepBodies;
  /** What the back edges may spend. Nothing, when a caller says nothing. */
  readonly ceilings?: Ceilings;
  /**
   * How a step's declared list becomes actions that can run.
   *
   * **Handed in, and required.** `actionsFromRecipe` is what does it, and its
   * three dependencies — a reviewer, the diff's file list, an environment
   * resolver — are all things only a caller with a machine under it can build;
   * they are what `conduct.ts` assembles as `stepDeps` today. So turning a
   * declared list into a runnable action is neither the sequence nor the
   * outcome rules, and by 0058 §2b it is therefore not the pass's. Two things
   * follow and both are wanted: a cell no plugin declares itself at is refused by
   * `actionsFromRecipe`, at the caller, by name — and a test can exercise the
   * whole loop without spawning a process, paying an agent or asking a person,
   * which is what puts this file's tests in the half of the suite the `build`
   * point runs (0060 §1).
   */
  readonly actionsAt: (step: Step, actions: readonly StepAction[]) => readonly Action[];
}

/**
 * One decision `proposed` made, in the order it made them — **and the log's own
 * shape for it** (`PassRouted`, `#271`).
 *
 * Every field here is appended, so this is what *why the pass took this path*
 * says after the run log is deleted. The two that are not a body's answer are
 * `chose` and `ceiling`, and both are the workflow's for one reason: a route is
 * a plugin's decision and the budget it is spent against is not (0061 §3, 0064
 * §7).
 */
export interface RouteTaken {
  /**
   * The step whose outcome was judged — the one that did not pass, or `proposed`
   * itself where the judgement was made on the way through, which is where a
   * `review`'s findings are read.
   */
  readonly from: Step;
  /**
   * Where the decision wanted to go — `to` on every route nothing intervened in.
   *
   * It differs where the destination was not on offer: the built-in that answers
   * a red build wants `implement` and settles for a person when the rounds are
   * spent, and a declared judge that answers outside the set is overruled. Both
   * read as `waiting` on `to` alone, and they are not the same thing to somebody
   * deciding what to do about it.
   */
  readonly chose: Destination;
  readonly to: Destination;
  readonly why: string;
  /**
   * Which ceiling refused `chose`, or null — including on every route that went
   * where it wanted.
   *
   * Named here because this is where both halves are known: the choice arrives
   * on the ending and the offer it was made against is the loop's. Null with
   * `chose !== to` is a choice nothing this loop bounds refused — a judge
   * answering a step the arrival never reached, which the offer refuses on its
   * own grounds. `ceilingFor` is the reading, off `Offer`'s two sets.
   */
  readonly ceiling: Ceiling | null;
}

/** The two limits that take a destination off the offer. */
export type Ceiling = "rounds" | "restarts";

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
   * **The step that reported something the pass stopped for**, or null where
   * nothing did.
   *
   * It names the step, which is the third of the three things 0058 §3c asks a
   * refusal to carry; the other two are on the ending. On a routed pass it is
   * the step that **did not pass**, not the `proposed` that routed it: what a
   * person on *Waiting on you* needs is the install that failed, and the route
   * that brought it to them is `routes`.
   *
   * **Null is two unlike things and `rested` tells them apart.** A pass that got
   * through has nothing to report; so does one the router sent to a person on the
   * way through, where `build` and `review` both passed and what `proposed`
   * judged was `review`'s findings — nothing refused, and the findings are on
   * `review`'s own entry in `steps`. `rested` is `null` for the first and
   * `waiting` for the second.
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
   * Every decision `proposed` made, in order — the pass's own audit of the loops
   * it bought.
   *
   * Empty on a pass that sailed through and was let past. One entry per
   * judgement, so the ones whose `to` is a step are the rounds spent and the
   * reason each was spent on.
   */
  readonly routes: readonly RouteTaken[];
  /**
   * Where the pass came to rest, when `proposed` sent it somewhere that is not a
   * step.
   *
   * `null` covers both a pass that got through and one that stopped without a
   * decision being made about it at all — a `never-ran`, a crash, a `proposed`
   * whose own plugins refused, a judge that answered something it was not
   * offered. `stoppedAt` is what tells those apart from a landing.
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
 *   (`conduct.ts`, the landed ending), and that stays true where `end`'s own body then
 *   stumbled: `main` moved either way, and `end` is never what stopped a pass
 *   (`PassResult.stoppedAt`);
 * - a refusal a person now holds, a question put to one, an agent that started
 *   and left no receipt, or the router deciding a person is next — `blocked`.
 *   All four end with a person holding the question and the item on *Waiting on
 *   you* (`conduct.ts`, the blocked ending — where the item is blocked rather
 *   than released). `rested` is read before `stoppedAt`,
 *   because the router may send a pass that refused nothing to a person: a
 *   `review`'s findings above the bar are a reason for a person without being a
 *   report by any step;
 * - an agent that never started, and **a restart** — `failed`, the two endings
 *   that ask nobody. The wall is about the account rather than the diff, so the
 *   claim is released and the item goes back to the queue
 *   ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §3); a
 *   requeue releases it for the opposite reason, having decided a fresh
 *   approach is worth more than another round (0040). Both are what `failed`
 *   means at `end-step.ts` — *a run that ended without a diff worth merging and
 *   put the item back in the queue.*
 *
 * `closed` is the fourth and no pass produces it: it is a person deciding the
 * ticket is over ([0044](../../../doc/decisions-archive/0044-a-close-is-a-terminal-outcome.md)),
 * and `close.ts` resolves `end` for it on its own path.
 */
export function outcomeOf(pass: Pick<PassResult, "stoppedAt" | "rested">): TerminalOutcome {
  if (pass.rested === "requeued") return "failed";
  if (pass.rested === "waiting") return "blocked";
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
 *    seven of them, which is 0058 §3b's second drawing — and `proposed` may
 *    route on its own way through too, which is where a `review`'s findings are
 *    judged;
 * 3. a route is a destination from the set the workflow offered: a step, and the
 *    walk resumes there having spent a round; or `waiting`; or `claim`, which
 *    requeues and ends the pass;
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

  /**
   * The three fields of the context that move while the pass runs, and the one
   * place any of them is written.
   *
   * `onSha` is the head the tree stands at — the base the caller handed in until
   * a step says it moved it. `roundsSpent` is `round`. `recheck` is what the
   * round the pass is in was bought on, and is empty on the first lap because
   * nothing has been refused yet.
   */
  let onSha = options.context.onSha;
  let recheck: readonly ActionFinding[] = options.context.recheck ?? [];
  /** Where in `steps` the current lap started, so that `recheck` can be read off it. */
  let lapStart = 0;

  /**
   * What this visit is judged against — rebuilt per visit, never shared.
   *
   * The same object goes to the step's plugins and to its body, because they are
   * judging the same tree in the same round: a `review` handed a different
   * `onSha` from the pipeline that just ran at `build` would be two verdicts
   * about two commits on one card.
   */
  const contextFor = (): ActionContext => ({ ...options.context, onSha, round: roundsSpent, recheck });

  /**
   * One visit, recorded — and the head it left the tree at, if it moved it.
   *
   * Read here rather than in `runStep`, because `onSha` is the walk's and not
   * one visit's: what a step that committed changes is what **every** visit
   * after it is judged against.
   */
  const record = (visit: StepReached): StepReached => {
    steps.push(visit);
    if (visit.ending.head !== undefined) onSha = visit.ending.head;
    return visit;
  };

  /**
   * What a route does to the walk, in one place — because a route is chosen at
   * two of them: `proposed`'s own visit on the way through, and the visit the
   * loop takes a step that did not pass to. `reported` is what a person should
   * be shown, and is null where nothing refused.
   *
   * `offer` is the one the visit was handed — the same object that went to the
   * body — because naming the ceiling is a subtraction over its two sets
   * (`ceilingFor`) and not something derivable from the route alone. It is
   * passed rather than recomputed for the reason `reported` is passed: it is
   * built differently on the two visits, and the way-through one is judged on a
   * `review` that passed.
   */
  const take = (
    route: StepRouted,
    reported: { step: Step; ending: StepReport } | null,
    offer: Offer,
  ): boolean => {
    const chose = route.chose ?? route.to;
    routes.push({
      from: reported?.step ?? "proposed",
      chose,
      to: route.to,
      why: route.why,
      // Read here and not on the ending, because this is the only scope that
      // holds both the choice and the offer it was made against. A route that
      // got what it wanted took an affordable destination, so this is null
      // without a `chose === to` case of its own.
      ceiling: ceilingFor(chose, offer),
    });
    if (route.to === "waiting" || route.to === "claim") {
      rested = route.to === "claim" ? "requeued" : "waiting";
      // What a person reads is the step that did not pass, never the router that
      // sent it to them; where it was sent is `routes`.
      stoppedAt = reported;
      return false;
    }
    // Back into the spine, and a round is what that costs.
    //
    // **The round the pass is about to buy is bought on something**, and 0038 §2
    // is what the next agent is owed: *the findings a previous version of this
    // diff was refused for, that an agent has since been asked to make stop
    // happening* — each one's `failureScenario` written before anybody knew what
    // the fix would be, which is what makes it a criterion the fixer could not
    // author. So the lap's findings become the next lap's `recheck`, and the
    // reviewer at `review` is handed them by name.
    //
    // The lap's, rather than the arriving step's alone: a route is chosen on
    // both of `proposed`'s visits, and the way-through one is judged on a
    // `review` that **passed** carrying findings (0058 §3b). Reading only what
    // refused would hand the fixer nothing in exactly the case 0061 §3 calls the
    // one judgement worth an agent.
    recheck = findingsIn(steps.slice(lapStart));
    lapStart = steps.length;
    roundsSpent += 1;
    at = route.to;
    return true;
  };

  while (at !== null && at !== "end") {
    const spec = SPEC[at];
    // **`proposed` routes on the way through as well as on the way back** (0058
    // §3b) — and that visit is where a `review`'s findings are judged, which is
    // 231 of the log's refusals and 0061 §3's one judgement worth an agent.
    // `review` judges nothing and passes, so nothing refused and there is
    // nothing arriving; what the judge reads is the findings on `reached`, and
    // what it may answer is this offer. Held in a local because `take` is
    // handed the same object the body was, rather than a second computation of
    // it (`ceilingFor`).
    const offer = spec.routes ? onOffer(at, PASSED_THROUGH, ceilings, roundsSpent) : NO_OFFER;
    const reached = record(
      await runStep(spec, options, bodies, [...steps], {
        context: contextFor(),
        // The spine visit: the step's own plugins, then its own body. Nothing has
        // arrived, and at nine of the ten there is nothing to route.
        arriving: null,
        offering: offer,
        // Nothing but `end` is told the outcome, because nothing but `end` runs
        // after it is known.
        outcome: null,
      }),
    );
    const ending = reached.ending;

    if (ending.ending === "routed") {
      // `proposed`, on the way through, having decided the change is not going
      // to `merge` as it stands. Nothing reported anything, so nothing is named
      // as having stopped the pass: `routes` says what was decided and
      // `review`'s own entry says what it was decided on.
      if (take(ending, null, offer)) continue;
      break;
    }

    if (ending.ending === "passed") {
      at = after(at);
      continue;
    }

    // A step that did not pass, and is not one of the seven the drawing takes to
    // the router — either by which step it is, or by which of the five endings
    // it reported.
    if (!(ARRIVE_AT_THE_ROUTER as readonly Step[]).includes(at) || !goesToTheRouter(ending)) {
      stoppedAt = { step: at, ending };
      break;
    }

    // **Every one of the seven arrives at `proposed`, carrying its reason** —
    // 0058 §3b, and §3c's *what happened has to arrive intact*. This is a second
    // visit to `proposed` in the pass rather than a branch inside the spine
    // walk, and it runs the router without the inspection: see
    // `StepWork.arriving`.
    const arrival = onOffer(at, ending, ceilings, roundsSpent);
    const router = record(
      await runStep(SPEC.proposed, options, bodies, [...steps], {
        context: contextFor(),
        arriving: reached,
        offering: arrival,
        outcome: null,
      }),
    );

    if (router.ending.ending !== "routed") {
      // The router did not answer — its body threw, or `theWorkflowsToSay`
      // refused what it answered. What stopped the pass is then `proposed`, and
      // the step that arrived is in `steps` one entry above it.
      stoppedAt = { step: "proposed", ending: router.ending };
      break;
    }

    if (!take(router.ending, { step: at, ending }, arrival)) break;
  }

  // **`end` runs on every ending and cannot refuse** (0058 §3) — nothing can be
  // stopped once a merge has landed, and nothing can be left unfinished because
  // the pass stopped early either. A point that fires on *any* terminal outcome
  // cannot live on one of the paths that reaches one (`end-step.ts`), so it is
  // here, once, after the walk, whichever of the four ways the walk ended.
  const outcome = outcomeOf({ stoppedAt, rested });
  record(
    await runStep(SPEC.end, options, bodies, [...steps], {
      context: contextFor(),
      arriving: null,
      offering: NO_OFFER,
      outcome,
    }),
  );

  return { steps, stoppedAt, routes, rested };
}

/**
 * The four things a visit is handed that depend on *how* it was reached rather
 * than on which step it is.
 *
 * Kept together and computed by `runPass` alone, because each is the workflow's
 * own answer and none is derivable inside `runStep`: `outcome` needs where the
 * pass rested, `arriving`/`offering` need what the last step said and what has
 * been spent, and `context` needs the head the walk has reached, the round it is
 * in and what that round was bought on.
 */
interface Reaching {
  /**
   * This visit's context — `contextFor()`, and never `options.context`.
   *
   * A visit is judged against a head, in a round, about findings, and all three
   * move: the one a caller handed in is the base the walk started from.
   */
  readonly context: ActionContext;
  readonly arriving: StepReached | null;
  readonly offering: Offer;
  readonly outcome: TerminalOutcome | null;
}

/**
 * Every finding a lap's plugins raised, in visit order.
 *
 * What one round was bought on, which is what the next round's agents are asked
 * about (0038 §2). It is read off the visits rather than off the log, for the
 * reason `StepReached.results` exists at all: the pass is holding the sentence
 * in memory, and reading it back would be a second source of truth for it.
 */
function findingsIn(lap: readonly StepReached[]): readonly ActionFinding[] {
  return lap.flatMap((visit) => visit.results.flatMap((result) => result.findings));
}

/**
 * **What `design` drafted, for the step that works from it** — and `NO_DESIGN`
 * where it drafted nothing.
 *
 * Read off the `design` step's own visit rather than off a variable somebody
 * carried, for `findingsIn`'s reason: the pass is holding it in memory and a
 * second place to keep it is a second place for it to be wrong. It was
 * `bodiesFor`'s until `#266`, and moved here when `implement`'s body emptied —
 * the only reader is a plugin now, and a plugin is handed the context.
 *
 * **The last `design` visit and not the first**: a pass routed back through it
 * would have a second document, and the one to work from is the one the round
 * was bought for — with the locator that came with *that* document, because the
 * two were made by one action and a pass holding the second draft beside the
 * first draft's location would be pointing `implement` at the wrong copy
 * (`#297`).
 *
 * `NO_DESIGN` rather than a bare `""` since `#297`, and it is the same brief:
 * this step is where *drafted nothing* and *never ran* stop being distinguished,
 * because `implement` works from the issue either way (0058 §3). The
 * distinction survives on the ending, where the card is rendered from.
 */
function designOn(reached: readonly StepReached[]): TheDesign {
  const drafted = reached.filter((visit) => visit.step === "design").at(-1);
  return drafted?.ending.ending === "passed" ? (drafted.ending.design ?? NO_DESIGN) : NO_DESIGN;
}

/**
 * **Why the pass is at this step a second time, read off the visits** — or
 * `null`, which is every visit on the way through.
 *
 * The route is the last visit when a step is re-entered: `runPass` records
 * `proposed`'s decision and then walks straight into the step it chose. The
 * question is the visit before that one, and only where *this* step asked it — a
 * route back to `implement` from a `build` that refused carries findings rather
 * than a question, and `ActionContext.recheck` is where those are.
 *
 * `bodiesFor`'s until `#266`, and here for `designOn`'s reason.
 */
function sentBackTo(step: Step, reached: readonly StepReached[]): SentBack | null {
  const judged = reached.at(-1);
  if (judged === undefined || judged.step !== "proposed") return null;
  const route = judged.ending;
  if (route.ending !== "routed" || route.to !== step) return null;
  const arrived = reached.at(-2);
  const asked =
    arrived !== undefined && arrived.step === step && arrived.ending.ending === "asked"
      ? arrived.ending.detail
      : null;
  // And what it printed, where that is not the question `asked` already holds.
  // The evidence the judge weighed is on the arriving visit's ending, and this
  // is the only thing that carries it as far as the agent buying the round:
  // `context.recheck` is empty on a mechanical route, because a command's
  // refusal raises no findings.
  const printed =
    asked === null && arrived !== undefined && "detail" in arrived.ending && arrived.ending.detail !== ""
      ? { step: arrived.step, detail: arrived.ending.detail }
      : null;
  return { why: route.why, asked, printed };
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
  /**
   * **Where the step's plugins left the worktree, kept across the body** (`#268`).
   *
   * A body owns the outcome rules and says which ending an answer is; *the tree
   * moved to here* is not one of those, and `admit`'s body is empty. So the fact
   * survives the body rather than being replaced by it, and a body that reports a
   * head of its own wins — `implement`'s does, and its commit is later than
   * anything its plugins could have said.
   */
  let leftTheTreeAt: LeftTheTreeAt = {};
  /**
   * **What the step's plugins drafted, kept across the body** (`#265`).
   *
   * `leftTheTreeAt`'s sibling and kept for its reason: `design`'s body is empty
   * since this ticket, so a document that did not survive the body would not
   * survive at all. No body reports one of its own, so unlike `head` there is
   * nothing for a body to win against — the spread below puts it on the ending a
   * passing body returned.
   */
  let wroteTheDesign: WroteTheDesign = {};

  try {
    // A routing arrival runs the router and not the inspection — `StepWork
    // .arriving` is the whole argument, and it is why this is `=== null` rather
    // than an unconditional call.
    if (spec.plugins === "verdicts" && reaching.arriving === null) {
      const result = await runActionPipeline({
        step: spec.step,
        actions: options.actionsAt(spec.step, actions),
        /**
         * **The two facts a plugin cannot read off `onSha`** (`#266`).
         *
         * `design` is what the step before this one drafted and `again` is why
         * this step is being run a second time, and both are folds over the visit
         * list — which the pipeline has no way to see. They are added here rather
         * than in `contextFor` because one of them is per-step: *sent back to
         * `implement`* and *sent back to `build`* are different answers on the
         * same lap.
         *
         * Every kind is handed them and one kind reads them, exactly as `recheck`
         * is: a `run:` at `build` re-runs unchanged, because a build does not need
         * to be told what the judge said.
         */
        context: {
          ...reaching.context,
          design: designOn(reached),
          again: sentBackTo(spec.step, reached),
        },
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
      leftTheTreeAt = headFrom(result);
      wroteTheDesign = designFrom(result);
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
      // `StepWork<Step>`'s three conditional fields distribute over the whole
      // union, so each widens to both of its branches — `StepReached | null`,
      // `Offer | NoOffer`, `TerminalOutcome | null` — and `Reaching` carries a
      // field assignable to each, so none of them needs a cast.
      arriving: reaching.arriving,
      offering: reaching.offering,
      outcome: reaching.outcome,
      context: reaching.context,
      emit: options.emit,
    });
    return {
      step: spec.step,
      ending: theWorkflowsToSay(spec, { ...leftTheTreeAt, ...wroteTheDesign, ...ending }, reaching),
      results,
    };
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
 * **`did-not-finish` at every one of the ten, and never `refused` or `asked`**: a
 * crash is not a judgement about the change, so it buys no fix round and stands
 * only the pass down (0057 §1–3). That it does not reach the router is now the
 * ending's own doing rather than the value of `because` — `goesToTheRouter` reads
 * no string since `#296`, so a crash cannot acquire a destination by writing one.
 * `because: "threw"` is what tells *the step threw* from *an agent started and
 * left no receipt*, a field rather than a sentence (0031 §1), and the message the
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
 * The six endings `runActionPipeline` can produce, read once.
 *
 * Each of the five absences is asked for before `ok`, so a result that somehow
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
  // **Asked before did-not-finish, and neither reads a string** (`#296`). The
  // pipeline compares `NEEDS_INPUT` once, in the file that defines it, and what
  // arrives here is two fields that are never both set: *the agent asked
  // something* has a destination, and *the agent left no receipt* has none.
  if (result.askedAt !== null) {
    return { ending: "asked", at: result.askedAt.action, detail: result.askedAt.detail };
  }
  if (result.didNotFinishAt !== null) {
    return {
      ending: "did-not-finish",
      // The pipeline's own name for it, and no finer word: it knows that an
      // agent started and left no receipt and nothing else. **Unless the action
      // had a word of its own** (`#266`), which is `becauseFrom`'s rule one
      // branch down — and none of the words left here is one the workflow reads,
      // which is what the branch above bought.
      because: result.didNotFinishAt.because ?? "did-not-finish",
      at: result.didNotFinishAt.action,
      detail: result.didNotFinishAt.detail,
    };
  }
  if (result.heldAt !== null) {
    return { ending: "held", at: result.heldAt, question: evidenceFrom(result, "needs-approval") };
  }
  if (result.failedAt !== null) {
    const said = {
      // **The action's own word where it has one, and the pipeline's where it
      // does not** (`#270`).
      //
      // *Something the recipe declared refused* is all the pipeline knows, and
      // `action-refused` is that said in the vocabulary that replaced `gate`: a
      // step is a step and an action is an action. Inventing `verify-failed`
      // here would put a word back on a list that may only shrink — `#232`'s
      // allowlist is down to nothing and `#233` renamed the value.
      //
      // **`becauseFrom` is not that.** The merge lane's `conflict` and
      // `verify-failed` are `RefusalReason`s the lane itself produced and the log
      // already carries, and `directionOf` routes on them — so since the lane is
      // a `merge:` action they arrive here on the result rather than being
      // re-derived from a sentence (`ActionResult.because`). Every other kind
      // says nothing and gets the pipeline's word.
      because: becauseFrom(result) ?? "action-refused",
      at: result.failedAt,
      detail: evidenceFrom(result, "failed"),
    } as const;
    // **A reviewer's `failed` is its findings, and not a verdict about the
    // step** (0058 §3: *a reviewer returns findings with a severity and no
    // verdict*). So `review` passes, carrying them on `results`, and the
    // judgement is made one step later — which is the whole of *`review`
    // returns findings and judges nothing*: 10% of its refusals in fourteen
    // days carried no findings at all, 24 of them
    // ([012](../../../doc/experiments/012-where-the-turns-go.md) §4), and a
    // step that refuses without saying what is wrong is a step whose judgement
    // is worth nothing to the round it buys.
    //
    // Nothing is dropped and nothing is quiet about it: the action's own
    // verdict is on `results` and `StepFailed` is already on the log, which is
    // what a `proposed` reads to decide there is a `findings` direction to
    // judge at all. What it costs is `runActionPipeline`'s own rule — the
    // pipeline stops at the first action that did not pass, so a second
    // reviewer declared after this one is not asked about a diff the first
    // already has findings on.
    if (spec.step === "review") return { ending: "passed" };
    // **Which step ran it decides what a `failed` verdict means** (0058 §2).
    // At one of the four it is a refusal, with everything a refusal buys. At
    // the other five an action saying no is an ordinary plugin verdict and not
    // a programming error. Reported as a `did-not-finish` whose `because` is
    // the action's refusal: no fix round is spent at a step the workflow does
    // not let refuse, nothing the action said is dropped, and it does not reach
    // the router, because *a step that may not refuse has not refused* and
    // there is no judgement to route.
    return spec.refuses ? { ending: "refused", ...said } : { ending: "did-not-finish", ...said };
  }
  if (result.ok) return { ending: "passed" };
  throw new Error(
    "runActionPipeline returned `ok: false` with no failed, held, never-ran, did-not-finish or " +
      "asked action. That is a pipeline that stopped for a reason it did not name, and a pass " +
      "cannot report it — see `PipelineResult` in packages/actions/src/action.ts.",
  );
}

/**
 * **Where the step's own plugins left the worktree**, or nothing where none of
 * them moved it (`#268`).
 *
 * One kind produces it — `worktree:`, at `admit` — so the last one that said
 * anything is the answer, and there can only be one of those: `StepMap` refuses
 * a second `worktree:` at a step when the recipe resolves. Read only on the
 * passing branch, because the tree a refused pipeline was cut into is the one
 * the arrival already carries: a cut that did not happen is
 * `did-not-finish`, and its head is the base the pass came in on.
 *
 * Spread rather than assigned, so that *the tree did not move* stays an absent
 * key — `record` in `runPass` advances `onSha` on `!== undefined`, and an
 * explicit `undefined` would read the same to it and differently to a reader.
 *
 * Read by `runStep` and not by `endingOf`, because it must survive the body: a
 * step whose plugins passed goes on to its body, and the body's ending is what
 * the visit reports.
 */
function headFrom(result: PipelineResult): { head?: string } {
  const moved = result.results.filter((each) => each.head !== undefined).at(-1);
  return moved?.head === undefined ? {} : { head: moved.head };
}

/**
 * **What the step's own plugins drafted**, or nothing where none of them did
 * (`#265`).
 *
 * `headFrom`'s sibling, read the same way and for the same reason: one kind
 * produces it — an `agent:` at `design`, which is `createDraftAction` — so the
 * last one that said anything is the answer, and a step declaring two drafts
 * hands `implement` the second, which is the same rule the pipeline already has
 * for a verdict.
 *
 * Spread rather than assigned, so *nothing here drafted* stays an absent key:
 * `designOn` reads it with `??`, and an empty document is a real answer that
 * must not read as an absence — the whole of 0058 §3's *or nothing, which is an
 * answer* lives in that distinction.
 *
 * **And the locator comes off the same result as the document** (`#297`). One
 * action makes both (0066 §3), so reading them off two results would be this
 * function deciding which document a location belongs to — which is the
 * pipeline understanding locators, one step before §4 says it must not. An
 * action that returned a locator and no document is therefore silent here, and
 * that is the whole of the rule.
 */
function designFrom(result: PipelineResult): { design?: TheDesign } {
  const drafted = result.results.filter((each) => each.document !== undefined).at(-1);
  if (drafted?.document === undefined) return {};
  return {
    design: {
      document: drafted.document,
      // Spread for `headFrom`'s reason: *it was kept nowhere* is an absent key,
      // and `TheDesign.locator` is optional so that a reader cannot tell an
      // explicit `undefined` from a destination that said nothing.
      ...(drafted.locator === undefined ? {} : { locator: drafted.locator }),
    },
  };
}

/**
 * **The failing action's own machine-readable reason**, or null where it had none
 * (`#270`).
 *
 * `evidenceFrom`'s sibling and asked the same way — by verdict rather than by
 * name, for the reason written there — and read on the `failed` branch alone: a
 * `needs-approval` carries a question rather than a refusal, and the three
 * absences carry their own fields.
 *
 * One kind produces it, the `merge:` action at `merge`, which is the same shape
 * `head` has at `admit`: the one action whose answer the caller cannot work out
 * for itself reports it, and the caller carries it rather than parsing it back
 * out of prose (`ActionResult.because`).
 */
function becauseFrom(result: PipelineResult): string | null {
  return result.results.filter((r) => r.verdict === "failed").at(-1)?.because ?? null;
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
 * ended it is the only result with that verdict and is also the last. The old
 * engine's merge lane read its refusal the same way and said why — *by verdict
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
        `${reaching.offering.affordable.join(", ")} (0058 §3b, 0061 §3).`,
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
    if (!reaching.offering.affordable.includes(ending.to)) {
      // **And the refusal says which half it failed** (0064 §7): a ceiling is a
      // number somebody can raise, and a destination the arrival never reached
      // is not — so the two cannot read as one absence.
      const ceiling = ceilingFor(ending.to, reaching.offering);
      throw new Error(
        `\`proposed\` routed the pass to \`${ending.to}\`, which was not on offer — ` +
          `${reaching.offering.affordable.join(", ") || "nothing was"}` +
          `${ceiling === null ? "" : `, and \`${ceiling}\` is spent`} (0061 §3). A judge answers ` +
          "*which of these*, never *what is legal*: the workflow counts the rounds and restarts " +
          "spent and hands it the set, so a destination outside the set is refused by name (0061 §8).",
      );
    }
  }
  return ending;
}
