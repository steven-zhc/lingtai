/**
 * **Which step is next when something refuses** — the decision, and the
 * counting that bounds it.
 *
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3 is where
 * this comes from, and it is one sentence:
 *
 * > **`judge:` decides which step is next. The workflow decides which steps it
 * > may choose from.**
 *
 * Those two halves are in this file and they do not touch. `stepsOnOffer` is
 * the workflow's: it reads the ceilings, counts what is spent, looks at how far
 * the pass got, and answers **the set**. A judge is handed that set and answers
 * *which of these*. `askJudge` is the seam between them, and it refuses an
 * answer outside the set by name rather than obeying it.
 *
 *     the pass refuses            reason: red · gate-failed · conflict ·
 *                                 needs-input · findings
 *       └── the workflow counts   stepsOnOffer → implement? claim? human
 *             └── the judge picks one of those, and nothing else
 *
 * **Why the split is not tidiness.** Every plugin is replaceable, `judge:`
 * included, and a replaced judge is a stranger's code deciding where the money
 * goes:
 *
 *     a misconfiguration that fails    is cheap — it errors, you fix it
 *     a misconfiguration that loops    is not — it never errors, it only spends
 *
 * A judge that could carry its own `rounds` could answer *back to `implement`*
 * for ever, at ~31 turns and ~$3.40 a round
 * ([012 §3](../../../doc/experiments/012-where-the-turns-go.md)), and nothing
 * anywhere would report a fault. So the numbers are never handed to a judge:
 * `JudgeBrief` below carries the findings, the evidence and the set, and no
 * ceiling and no count. A judge cannot widen what it cannot see.
 *
 * **Which puts the whole bound in one function, and that is a claim about
 * `stepsOnOffer` rather than about a judge.** Every rule the workflow has to
 * say *no agent for this one* has to be in it — a rule left in the module that
 * used to hold it is a rule a judge answers past, because the judge is asked
 * after it. `decideFix`'s criterion rule is the one that matters here: a
 * refusal with nothing to hold an agent to buys nothing at either extent, and
 * so offers nothing but a person.
 *
 * **Beside `fix.ts` and `restart.ts`, and it is those two read as one
 * question.** `decideFix` answers *another round in this worktree*, bounded by
 * `rounds`; `decideRestart` answers *a fresh approach*, bounded by `restarts`;
 * everything else is a person. Those are three destinations and two ceilings,
 * decided in two modules that do not know about each other, and a recipe can
 * name none of it. This file is the shape they take when a recipe can — the
 * same rules, in one function, with the *choice* lifted out where a plugin can
 * be put in its place.
 *
 * **Nothing calls it yet, and that is the same fact `whyNoKindAt` states about
 * the plugin.** `run-once.ts` still decides in `buyRound`, from `decideFix` and
 * `decideRestart`; `judge:` is refused at all ten steps until the ticket that
 * makes the recipe file `steps:`. What is here is the half that had to exist
 * before that ticket could be written safely — because the offered set is the
 * bound, and a bound invented at the same time as the thing it bounds is a
 * bound nobody checked. **Naming a thing is not wiring it**, and neither is
 * building the guard first.
 *
 * Everything here is a decision and nothing here does I/O, for `fix.ts`'s
 * reason: a rule about spending money that lives inside an `if` in a
 * 3,000-line file is a rule nobody can check.
 */
import type { GateFinding } from "@lingtai/actions";
import { STEPS, type Step } from "@lingtai/domain";
import type { BuiltInJudge, JudgeWhen } from "@lingtai/recipe";

/**
 * Where a pass may go from a refusal, and **`human` is not a step**.
 *
 * The first two are: `implement` is another round in the worktree that is
 * already cut, and `claim` is a requeue — the item is released, the approach is
 * abandoned, and a higher-priority ticket opened in the meantime goes first
 * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
 *
 * `human` is the pass stopping at `proposed` with the question on the log, and
 * it is in this list because **it is always on offer**. That is what makes the
 * set never empty, so no judge can be cornered, and it is what a refused
 * answer falls back to: the one destination that spends nothing and loops
 * never.
 */
export const DESTINATIONS = ["implement", "claim", "human"] as const;
export type Destination = (typeof DESTINATIONS)[number];

/**
 * What the workflow knows and the judge does not.
 *
 * The two counts are held by the loop that spends them rather than read back
 * off the log, which is sound for `roundsSpent` for `FixInput`'s reason — a
 * pass is one `runOnce` and a counter cannot outlive what it bounds — and for
 * `restartsSpent` because that one *is* folded from the log
 * (`WorkItemState.restarts`), and is passed in here as a number so that this
 * module stays a decision with no reader in it.
 */
export interface OfferInput {
  /** The reason the last step gave, which is the direction being decided. */
  when: JudgeWhen;
  /**
   * **How far the pass actually got** — the step whose action refused.
   *
   * The rule 0061 §3 states twice and the one a judge must never be asked to
   * know: `prepared` refuses before any agent has run, so there is no diff and
   * no error in one to fix, and `implement` is not on offer there *whatever*
   * `rounds` is left. A judge that knows nothing about `prepared` still cannot
   * choose wrongly, because the wrong answer was never in the set.
   */
  reached: Step;
  /**
   * **What the refused step produced**, which is both the judge's evidence and
   * the workflow's test of whether there is anything to buy an agent for.
   *
   * `FixInput.refusal`'s two fields under their own names, because it is the
   * same pair doing the same two jobs: `decideFix` reads them to decide whether
   * a criterion exists, and `fixPrompt` hands them to the agent. Held together
   * in one object rather than passed to `briefFor` a second time, so that what
   * `stepsOnOffer` judged the criterion by and what the judge is shown cannot
   * come apart.
   */
  refusal: {
    /** The reviewer's, verbatim. Empty for every direction but `findings`. */
    findings: readonly GateFinding[];
    /** What a command printed, clipped by `command.ts` long before it reaches here. */
    evidence: string;
  };
  /** `runtime.limits.rounds` today; `implement`'s universal `rounds:` under 0061 §2. */
  rounds: number;
  roundsSpent: number;
  /** `runtime.limits.restarts` today; `claim`'s universal `restarts:` under 0061 §2. */
  restarts: number;
  restartsSpent: number;
  /**
   * What else on this pass is asking for a person, named, or null.
   *
   * `decideRestart`'s own input, and it keeps its meaning: a `human:` action, a
   * `watch:` that saw a migration, or a repair. Releasing the item would throw
   * their question away, so `claim` comes off the set — this is a fact about
   * what the pass may do, not a judgement about what it should, which is why it
   * is here and not in front of a judge.
   */
  alsoAsked: string | null;
}

/**
 * **The set, and the whole of what a judge is allowed to choose from.**
 *
 * **Every rule the workflow has is here, and that is the whole of the bound a
 * replaced judge is held to** — so a rule kept anywhere else is a rule a judge
 * can answer past. Each is a fact rather than an opinion, which is the test of
 * whether it belongs on this side of the line. Read in order:
 *
 * - **Nothing at all without a criterion.** `decideFix`'s first rule, and the
 *   one that makes the loop safe to have (0038 §2, 0039 §2): the bar is not
 *   *has findings*, it is *carries something the fixer could not have authored*
 *   — a `failureScenario` a reviewer wrote before anybody knew what the fix
 *   would be, or a command's own output and *run it again; green is green*. A
 *   refusal with neither buys nothing at either extent, because asking an agent
 *   to address an opinion is the unbounded rewriting 0038 §2 is about, and a
 *   fresh pass answers it no better than a round would have (`decideRestart`:
 *   *the refusal carried nothing to hold one to*). So both come off the set and
 *   only a person is left.
 * - **`implement` needs an agent to have run and a round left to buy.** Two
 *   conditions and they are independent, which is the point 0061 §3 makes
 *   twice: *the offered set depends on how far the pass got, not only on what
 *   is left to spend.*
 * - **`claim` needs a judgement.** 0039 §2's rule, kept in code and never in
 *   the recipe: a red build and a conflict leave the work still there and their
 *   remedy is mechanical, so starting over throws away a branch for nothing. No
 *   number a project writes down should make a typecheck error buy a fresh
 *   worktree, and no judge should be able to either.
 * - **`human` always.** See `DESTINATIONS`.
 *
 * **One rule of `decideRestart`'s is deliberately not here, and it is the
 * ticket.** That module offers a second approach only once the rounds are
 * *spent* (`exhausted`), which makes *patch, patch, patch, then start over* the
 * only order there is. [#232](https://github.com/steven-zhc/lingtai/issues/232)
 * spent four rounds on one scanner before a fifth found the fault was in the
 * design, at $46.92; a judge that can tell *the lines are wrong* from *the
 * approach is wrong* restarts after the second. That is a choice and not a
 * fact, so it moves to the judge — and it is safe to move because `restarts`
 * still bounds it, and a restart is breadth rather than depth (0040).
 *
 * The order is the order they are offered in, cheapest first, and it is not a
 * preference: a judge that treated position as priority would still be choosing
 * from the set, which is the only property this function is responsible for.
 */
export function stepsOnOffer(input: OfferInput): readonly Destination[] {
  if (!carriesACriterion(input)) return ["human"];
  const offer: Destination[] = [];
  if (anAgentHasRun(input.reached) && input.roundsSpent < input.rounds) offer.push("implement");
  if (input.when === "findings" && input.alsoAsked === null && input.restartsSpent < input.restarts)
    offer.push("claim");
  offer.push("human");
  return offer;
}

/**
 * Whether the refusal carries something an agent could be held to.
 *
 * `decideFix`'s own two tests, and the shape is decided by `when` rather than
 * inferred from what arrived: `findings` is the one direction a reviewer's
 * findings are the whole of, and the other four are held to what the step
 * printed. That is the same split `FixOn` makes, read off the key a recipe
 * writes instead of guessed from a findings array's length — so a `findings`
 * refusal that came back with none of them is an absent criterion here rather
 * than a command with no output, which is the more useful of the two truths.
 */
function carriesACriterion(input: OfferInput): boolean {
  return input.when === "findings"
    ? input.refusal.findings.some((finding) => finding.failureScenario.trim() !== "")
    : input.refusal.evidence.trim() !== "";
}

/**
 * Whether the pass got far enough for there to be something to send back.
 *
 * Read off `STEPS`, which is the ten in the order the loop reaches them, rather
 * than written as a list of the steps that qualify: a step added to the
 * vocabulary lands on the correct side of `implement` by where it is written in
 * that enum, and a list here would be a second opinion about the order.
 */
function anAgentHasRun(reached: Step): boolean {
  return STEPS.indexOf(reached) >= STEPS.indexOf("implement");
}

/**
 * What a judge is told, and it is **everything except the numbers**.
 *
 * The findings and the evidence are what refused; `offer` is the answer to the
 * only question about money a judge is allowed to have. There is no `rounds`
 * here, no `roundsSpent`, no `restarts` and no ceiling of any kind, and that
 * absence is the safety property — see the head of this file.
 *
 * **An absence is not a guard, so the four numbers are declared here as
 * `never`.** Leaving them out says what a brief is *for* and stops nothing: a
 * caller writing the construction that will actually be written —
 * `{ ...input, ...input.refusal, offer: stepsOnOffer(input) }`, `input` being
 * the `OfferInput` the workflow already has in its hand — type-checks clean,
 * because excess-property checking is not applied to a spread, and serializes
 * every ceiling to an agent judge. Naming them as fields that can only be
 * `undefined` makes that same line an assignability error at `rounds`, which
 * is the one moment the mistake is cheap. `briefFor` below is what to write
 * instead.
 */
export interface JudgeBrief {
  /**
   * The direction, which is the `when:` the judge was written under — 0061 §3's
   * *the refusal's `reason`*, and the two fields below are the words under it.
   */
  when: JudgeWhen;
  /**
   * What the step printed when it refused, and empty where the findings are the
   * whole of it. `FixInput`'s word for the same string, and the same string.
   */
  evidence: string;
  /** The reviewer's findings, verbatim, and empty for every direction but `findings`. */
  findings: readonly GateFinding[];
  /** The steps on offer. Never empty: `human` is always in it. */
  offer: readonly Destination[];
  /** Never. The ceiling is `implement`'s and a judge cannot widen what it cannot see. */
  rounds?: never;
  /** Never. What is spent is the workflow's arithmetic, and it is already in `offer`. */
  roundsSpent?: never;
  /** Never. The ceiling is `claim`'s, for the same reason. */
  restarts?: never;
  /** Never, and for the same reason as `roundsSpent`. */
  restartsSpent?: never;
}

/**
 * **The brief, built by the workflow that holds the numbers** — and the only
 * construction of one anybody should write.
 *
 * It takes the whole `OfferInput` and nothing else, so *what a judge sees* is
 * decided here once rather than at each call site under time pressure — and so
 * that the evidence `stepsOnOffer` tested for a criterion is the evidence the
 * judge is shown. A caller that could pass a second set of findings could
 * hand one a brief the set was never computed from. The counts stay on this
 * side of the call: `stepsOnOffer` reads them, `offer` is what is left of them,
 * and nothing else crosses.
 *
 * Field by field rather than a spread with the ceilings deleted afterwards —
 * a subtraction is a list to keep correct, and the day `OfferInput` grows a
 * field the subtraction is silently a field out of date, while this is a
 * compile error at `JudgeBrief` or nothing at all.
 */
export function briefFor(input: OfferInput): JudgeBrief {
  return {
    when: input.when,
    evidence: input.refusal.evidence,
    findings: input.refusal.findings,
    offer: stepsOnOffer(input),
  };
}

/**
 * A judge, as the workflow calls one.
 *
 * `Promise` is allowed because an agent judge is a dispatch, and that is the
 * whole of the difference between the two kinds — which is why `BuiltIn` below
 * is the synchronous half rather than a flag beside it.
 */
export type Judge = (brief: JudgeBrief) => Destination | Promise<Destination>;

/**
 * A built-in judge, and **synchronous is the declaration that it spends
 * nothing**.
 *
 * Not a comment, not a field: nothing that dispatches an agent can answer
 * without awaiting, so a built-in that started spending money would stop
 * type-checking. That is the property `BUILT_IN_JUDGES` in the recipe's schema
 * promises a person writing `judge: same-worktree`, held by the type system
 * rather than by review.
 */
export type BuiltIn = (brief: JudgeBrief) => Destination;

/**
 * The built-ins, one per name the schema accepts.
 *
 * A total record over `BuiltInJudge`, so a name added to `BUILT_IN_JUDGES` with
 * no function here does not compile — the `STOP_OF` argument in `fix.ts`, and
 * the reason a recipe can never name a judge that does not exist.
 */
export const BUILT_IN: Record<BuiltInJudge, BuiltIn> = {
  /**
   * **The mechanical answer**: back to `implement`, in the worktree that is
   * already cut, with the error.
   *
   * It is the whole of what `red` and `gate-failed` need — sixty of the
   * refusals 0061 §3 measured, and not one of them a judgement. A build that
   * went red says *this line is wrong* by construction; a merge whose checks
   * went red on the new base says *the base moved and the result is wrong*; in
   * both the work is still there (0039 §2) and the remedy is to fix it where it
   * stands.
   *
   * **And it falls to a person rather than reaching for `claim`.** When
   * `implement` is not on offer the rounds are spent or no agent has run, and
   * neither is answered by starting over — for a mechanical refusal `claim` is
   * not in the set at all, so this is the set's own shape rather than a
   * preference of the built-in's.
   */
  "same-worktree": (brief) => (brief.offer.includes("implement") ? "implement" : "human"),
};

/**
 * Which directions a built-in answers, and which cost money.
 *
 * A **total** record over the five, so a sixth direction does not compile until
 * somebody has said which kind it is — `RUN_OWNER`'s argument in
 * `attribution.ts`, and `#197`'s receipt for what a default costs.
 *
 * `null` does not mean *no judge*. It means **no judge that spends nothing**:
 * the three are the directions where deciding is a judgement, and 0061 §3's
 * measurement is the whole argument for the split —
 *
 *     red           34   back to implement with the error       mechanical
 *     gate-failed   26   back to implement with the new base    mechanical
 *     conflict       6   text: resolve · intent: a person
 *     needs-input    —   interrupt, or go round stating the assumption
 *     findings     231   the lines or the approach              ← the judgement
 *
 * — one judge for all five pays an agent sixty times to reach a mechanical
 * conclusion, and makes anyone replacing it reimplement the mechanical branches
 * correctly or the loop breaks.
 */
export const BUILT_IN_FOR: Record<JudgeWhen, BuiltInJudge | null> = {
  red: "same-worktree",
  "gate-failed": "same-worktree",
  conflict: null,
  "needs-input": null,
  findings: null,
};

/** Where the pass goes, and whether the judge had to be overruled to send it there. */
export interface Judgement {
  /** The destination. **Always one the brief offered**, whatever the judge said. */
  next: Destination;
  /** Null when the judge answered from the set; the refusal, naming it, when it did not. */
  refused: string | null;
}

/**
 * Ask a judge, and hold it to the set.
 *
 * **A judge that returns a step it was not offered is refused by name**, which
 * is 0061 §8's rule used once more: *a step refuses a plugin it cannot run*
 * becomes *a step refuses a destination it did not offer*. The refusal is a
 * sentence and not a throw, because the thing that went wrong is a
 * configuration and the pass is mid-flight — a stack trace out of the middle of
 * one names neither the judge nor what it answered.
 *
 * **And the fallback is the one destination that cannot loop.** An overruled
 * judge is a judge nobody should trust for a second opinion, so the answer is
 * not *the next cheapest step*: it is a person, with the refusal on the card.
 * A wrong answer therefore costs one pass and stops, which is the asymmetry at
 * the head of this file paid out — a misconfiguration that fails is cheap.
 */
export async function askJudge(
  /** The name a recipe wrote, so the refusal can say which entry to fix. */
  named: string,
  judge: Judge,
  brief: JudgeBrief,
): Promise<Judgement> {
  const answer = await judge(brief);
  if (brief.offer.includes(answer)) return { next: answer, refused: null };
  return {
    next: "human",
    refused:
      `the "${named}" judge answered "${answer}" for a "${brief.when}" refusal, and that is not ` +
      `one of the steps it was offered — ${brief.offer.map((step) => `"${step}"`).join(", ")}. ` +
      "A judge chooses which of the offered steps is next; which steps are on offer is the " +
      "workflow's, and it counts the rounds and restarts spent to work them out (0061 §3). " +
      "The pass is held for a person, because a judge that answered outside the set is not one " +
      "to ask a second time",
  };
}
