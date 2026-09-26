/**
 * The pass, read against the decision rather than against a diff.
 *
 * `pass.ts` is wired to nothing (`#253`), so this file is the whole of what says
 * it works — which is the arrangement the ticket asked for: *a reviewer reads it
 * against the ADR, which is the one reading a cold reviewer is good at.* So each
 * `describe` below is a sentence from
 * [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) or
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md), and each
 * `it` is the half of it a test can check.
 *
 * Nothing here leaves the system: the two seams `runPass` takes — the ten bodies
 * and how a declared list becomes runnable actions — are both replaced, so no
 * process is spawned, no agent is paid and no person is asked. That is why this
 * is in `unit/` and why the `build` point runs it (0060 §1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS, type Step } from "@lingtai/domain";
import type { Action, ActionContext, ActionEvent, ActionFinding, ActionResult } from "@lingtai/actions";
import { StepMap, type StepAction } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import type { TerminalOutcome } from "../src/end-step.ts";
import {
  ARRIVE_AT_THE_ROUTER,
  NEEDS_INPUT,
  NOT_BUILT_YET,
  PASS,
  REFUSING_STEPS,
  onOffer,
  outcomeOf,
  runPass,
  type Ceilings,
  type Destination,
  type PassOptions,
  type StepBodies,
  type StepBody,
  type StepEnding,
  type StepReached,
  type StepWork,
} from "../src/pass.ts";

// --------------------------------------------------------------- fixtures ----

const context: ActionContext = { runId: "run-1", onSha: "abc1234def", cwd: "/nowhere", env: {} };

const PASSED: ActionResult = { verdict: "passed", evidence: "green", findings: [] };

/** An action that needs nothing and answers what it was told to answer. */
const canned = (name: string, result: ActionResult): Action => ({
  name,
  kind: "run",
  run: async () => result,
});

/** A recipe with only the ten steps on it, resolved by the real schema. */
const recipeWith = (steps: Record<string, unknown>): PassOptions["recipe"] => ({
  steps: StepMap.parse(steps),
});

/** What a body was handed, which is the contract this file fixes. */
interface Handed {
  step: Step;
  actions: readonly string[];
  outcome: TerminalOutcome | null;
  arriving: StepReached | null;
  offering: readonly Destination[];
  reached: readonly StepReached[];
  /** This visit's — the head it is judged against, the round, and the recheck. */
  context: ActionContext;
}

/**
 * A router that answers whatever a test tells it to — and only ever on a
 * routing arrival, since a spine visit has nothing to route.
 */
function routerSaying(to: (work: StepWork<"proposed">) => Destination) {
  return async (work: StepWork<Step>): Promise<StepEnding> => {
    const at = work as StepWork<"proposed">;
    if (at.arriving === null) return { ending: "passed" };
    return { ending: "routed", to: to(at), why: "because a test said so" };
  };
}

/**
 * The ten bodies, each recording the work it was handed and then passing —
 * plus whichever of them a test wants to answer differently.
 *
 * `proposed` is the one that does not simply pass, and it matches
 * `NOT_BUILT_YET`'s: a refusal is taken to a person. A body that answered
 * `passed` on a routing arrival is refused by the loop, and rightly — there is
 * no spine under a step that did not pass — so every test that reaches the
 * router needs an answer from it, and *a person* is the one that is always on
 * offer.
 *
 * `seen` is what makes *a configured step is never skipped* checkable: it is
 * appended to once per visit, in order.
 */
function watching(overrides: Partial<Record<Step, StepBody<Step>>> = {}) {
  const seen: Handed[] = [];
  const toAPerson = routerSaying(() => "waiting");
  const bodies = Object.fromEntries(
    STEPS.map((step) => [
      step,
      async (work: StepWork<Step>): Promise<StepEnding> => {
        seen.push({
          step: work.step,
          actions: work.actions.map((a) => a.name),
          outcome: work.outcome,
          arriving: work.arriving,
          offering: work.offering,
          reached: work.reached,
          context: work.context,
        });
        const override = overrides[step];
        if (override) return await override(work);
        return step === "proposed" ? await toAPerson(work) : { ending: "passed" };
      },
    ]),
  ) as unknown as StepBodies;
  return { bodies, seen };
}

/** Every action the loop handed the pipeline, by visit. */
function watchingActions(at: Record<string, readonly Action[]> = {}) {
  const ran: { step: Step; actions: readonly string[] }[] = [];
  const actionsAt: PassOptions["actionsAt"] = (step, actions) => {
    const built = at[step] ?? actions.map((a) => canned(a.name, PASSED));
    ran.push({ step, actions: built.map((a) => a.name) });
    return built;
  };
  return { actionsAt, ran };
}

/** What one action was judged against, which is the half `Handed` cannot see. */
interface Judged {
  step: Step;
  onSha: string;
  round: number | undefined;
  recheck: readonly ActionFinding[];
}

/**
 * One action at every step, recording the context it was run with.
 *
 * `runActionPipeline` hands the context to `Action.run`, so this is the only
 * place a test can read back what the loop actually judged each visit against —
 * and `answering` is told which visit it is at, so a lap can be red and the next
 * green.
 */
function judging(answering: (step: Step, lap: number) => ActionResult = () => PASSED) {
  const judged: Judged[] = [];
  const laps = new Map<Step, number>();
  const actionsAt: PassOptions["actionsAt"] = (step) => [
    {
      name: "check",
      kind: "run",
      run: async (seenWith) => {
        const lap = laps.get(step) ?? 0;
        laps.set(step, lap + 1);
        judged.push({
          step,
          onSha: seenWith.onSha,
          round: seenWith.round,
          recheck: seenWith.recheck ?? [],
        });
        return answering(step, lap);
      },
    },
  ];
  return { actionsAt, judged };
}

const events: () => { emit: PassOptions["emit"]; seen: ActionEvent[] } = () => {
  const seen: ActionEvent[] = [];
  return { emit: (event) => void seen.push(event), seen };
};

/** One refusing action, at the one refusing step that takes a `run:` today. */
const installFails = (evidence = "pnpm install exited 1") => ({
  recipe: recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] }),
  at: { prepared: [canned("install", { verdict: "failed", evidence, findings: [] })] },
});

/** An `implement` body that reports 0058 §3c's `needs-input` rather than passing. */
const asked = (detail: string): StepBody<Step> => async () => ({
  ending: "did-not-finish",
  because: NEEDS_INPUT,
  at: null,
  detail,
});

// -------------------------------------------------------------- the shape ----

describe("the ten steps are the vocabulary, and here they are data", () => {
  it("is ten, in the order the pass reaches them", () => {
    expect(PASS.map((s) => s.step)).toEqual([...STEPS]);
    expect(PASS).toHaveLength(10);
  });

  /**
   * 0058 §2: the workflow fixes which steps may refuse, and a plugin may not
   * change it. The list and the rows are derived from one another here, so the
   * failure where they disagree cannot happen.
   */
  it("lets exactly prepared, build, proposed and merge refuse", () => {
    expect(PASS.filter((s) => s.refuses).map((s) => s.step)).toEqual([
      "prepared",
      "build",
      "proposed",
      "merge",
    ]);
    expect([...REFUSING_STEPS]).toEqual(["prepared", "build", "proposed", "merge"]);
  });

  /** 0058 §3: `proposed` is the only step that routes. */
  it("lets proposed alone route", () => {
    expect(PASS.filter((s) => s.routes).map((s) => s.step)).toEqual(["proposed"]);
  });

  /** `end`'s three kinds run for effect and never reach the `Action` interface. */
  it("says end alone runs effects rather than verdicts", () => {
    expect(PASS.filter((s) => s.plugins === "effects").map((s) => s.step)).toEqual(["end"]);
    expect(PASS.find((s) => s.step === "end")?.refuses).toBe(false);
  });

  /** 0058 §3b's second drawing, node for node — and the three not on it. */
  it("takes seven steps to the router, and not claim, proposed or end", () => {
    expect([...ARRIVE_AT_THE_ROUTER]).toEqual([
      "admit",
      "prepared",
      "design",
      "implement",
      "build",
      "review",
      "merge",
    ]);
    expect(STEPS.filter((s) => !(ARRIVE_AT_THE_ROUTER as readonly Step[]).includes(s))).toEqual([
      "claim",
      "proposed",
      "end",
    ]);
  });
});

// ------------------------------------------------------- an empty step ----

describe("the file may omit a step; the resolved recipe may not", () => {
  /** 0061 §5, and `StepMap`'s defaults are the mechanism that ADR names. */
  it("resolves a recipe that says nothing to ten empty steps", () => {
    const steps = StepMap.parse({});
    expect(Object.keys(steps).sort()).toEqual([...STEPS].sort());
    expect(Object.values(steps)).toEqual(STEPS.map(() => []));
  });

  it("carries on through every one of them, and reports all ten", async () => {
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toBeNull();
    expect(result.rested).toBeNull();
    expect(result.routes).toEqual([]);
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
    expect(result.steps.every((s) => s.ending.ending === "passed")).toBe(true);
    // Nine times out of ten the loop meets `[]`, and an empty step is a pass.
    expect(seen.map((s) => s.step)).toEqual([...STEPS]);
  });
});

describe("a step that was configured is never skipped", () => {
  /**
   * `#61`'s failure, which is what the ticket's *watch out* is about: four of
   * `end`'s six cells were declarable, drawn, and silently dropped by a
   * `continue`. There is no `continue` past a step in `pass.ts`, and this is
   * what fails if one arrives.
   */
  it("hands every declared action to the step it was declared at", async () => {
    const recipe = recipeWith({
      prepared: [{ name: "install", run: "pnpm install" }],
      proposed: [{ name: "build", run: "pnpm test" }],
      merge: [{ name: "verify", run: "pnpm typecheck" }],
      end: [{ name: "close it", close: true }],
    });
    const { bodies, seen } = watching();
    const { actionsAt, ran } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toBeNull();
    // The nine steps whose plugins are verdicts, each with what it declared.
    expect(ran).toEqual([
      { step: "claim", actions: [] },
      { step: "admit", actions: [] },
      { step: "prepared", actions: ["install"] },
      { step: "design", actions: [] },
      { step: "implement", actions: [] },
      { step: "build", actions: [] },
      { step: "review", actions: [] },
      { step: "proposed", actions: ["build"] },
      { step: "merge", actions: ["verify"] },
    ]);
    // And `end`'s effects reach `end`'s body, which is the only thing that can
    // carry them out — the loop does not run them as actions.
    expect(seen.at(-1)).toMatchObject({ step: "end", actions: ["close it"] });
  });

  /**
   * And the action is *run*, not merely built. `runActionPipeline` is what runs
   * it — the loop calls it and does not reimplement it — so the proof is the
   * action's own `run` having been entered, and the three events the pipeline
   * emits for it arriving on the caller's `emit` untouched.
   */
  it("runs the declared action rather than only building it", async () => {
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    const { bodies } = watching();
    let entered = 0;
    const { actionsAt } = watchingActions({
      prepared: [
        {
          name: "install",
          kind: "run",
          run: async () => {
            entered += 1;
            return PASSED;
          },
        },
      ],
    });
    const { emit, seen } = events();

    await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(entered).toBe(1);
    // Requested, started, passed — the pipeline's three, and nothing from the
    // nine steps whose lists were empty.
    expect(seen).toHaveLength(3);
  });
});

// ------------------------------------------------------------- a refusal ----

describe("four steps may refuse, and the other six may not", () => {
  it("is the type rather than a comment", () => {
    // @ts-expect-error `claim` is not one of the four (0058 §2), so `refused` is
    // subtracted from what its body may hand back. If this stops being an error,
    // `EndingAt` has stopped saying the thing the type exists to say.
    const cannotRefuse: StepBody<"claim"> = async () => ({
      ending: "refused",
      because: "action-refused",
      at: null,
      detail: "nope",
    });
    // And one of the four compiles with no cast at all.
    const mayRefuse: StepBody<"prepared"> = async () => ({
      ending: "refused",
      because: "action-refused",
      at: "install",
      detail: "pnpm install exited 1",
    });

    expect(cannotRefuse).toBeTypeOf("function");
    expect(mayRefuse).toBeTypeOf("function");
  });

  /** 0058 §3: and the same type says only `proposed` may route. */
  it("says only proposed may route, in the type too", () => {
    // @ts-expect-error `routed` is `proposed`'s alone, because `waiting` has
    // exactly one way in and it is the router's to choose.
    const cannotRoute: StepBody<"merge"> = async () => ({
      ending: "routed",
      to: "implement",
      why: "the base moved",
    });
    const mayRoute: StepBody<"proposed"> = async () => ({
      ending: "routed",
      to: "implement",
      why: "the base moved",
    });

    expect(cannotRoute).toBeTypeOf("function");
    expect(mayRoute).toBeTypeOf("function");
  });

  /**
   * The runtime half, because a body read out of `StepBodies[Step]` has been
   * widened to the union and the compiler has stopped looking. It is not
   * downgraded to a refusal anybody acts on: a refusal buys a fix round, holds
   * the item and may reach a person, and none of that may be spent on one
   * nothing meant.
   *
   * The assertion throws, and the loop reports the throw as the step's ending
   * rather than letting it out — because an exception escaping `runPass` takes
   * `end` with it, and an item whose pass vanished carries no terminal outcome
   * at all. The words are on `detail`, where a person reads them.
   */
  it("reports a body's refusal at a step that may not refuse, and still reaches end", async () => {
    const { bodies, seen } = watching({
      claim: async () =>
        ({ ending: "refused", because: "action-refused", at: null, detail: "nope" }) as never,
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toMatchObject({
      step: "claim",
      ending: {
        ending: "did-not-finish",
        because: "threw",
        detail: expect.stringContaining(
          "the `claim` step refused, and only prepared, build, proposed, merge may refuse",
        ),
      },
    });
    // No fix round bought — and `end` reached, with an outcome for the item.
    expect(seen.at(-1)?.step).toBe("end");
    expect(outcomeOf(result)).toBe("blocked");
  });

  /** And the same for a body that tries to route from somewhere else. */
  it("reports a body's route at a step that may not route", async () => {
    const { bodies } = watching({
      merge: async () => ({ ending: "routed", to: "implement", why: "the base moved" }) as never,
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toMatchObject({
      step: "merge",
      ending: {
        ending: "did-not-finish",
        because: "threw",
        detail: expect.stringContaining(
          "the `merge` step routed the pass to `implement`, and `proposed` is the only step that routes",
        ),
      },
    });
  });

  /**
   * 0058 §2 from the plugin's side, and the case that makes the check above a
   * body's alone. `actionsAt` is the caller's seam and the pass does no kind
   * check of its own — which is why this test hands one in at `implement` though
   * `KINDS_AT.implement` is still `[]`.
   *
   * A plugin saying no at a step the workflow does not let refuse is an ordinary
   * verdict and not a programming error. Reported as `did-not-finish`, which buys
   * no fix round (0057) and is not routed, because a step that may not refuse has
   * not refused.
   */
  it("reads a plugin's failed verdict at one of the five as did-not-finish", async () => {
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      implement: [canned("a check of its own", { verdict: "failed", evidence: "no diff", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toEqual({
      step: "implement",
      ending: {
        ending: "did-not-finish",
        because: "action-refused",
        at: "a check of its own",
        detail: "no diff",
      },
    });
    // Everything the action said is kept: the router's whole job is reading it.
    expect(result.steps.find((s) => s.step === "implement")?.results).toHaveLength(1);
    // And no round was bought for it, which is what `did-not-finish` costs.
    expect(result.routes).toEqual([]);
  });

  /**
   * **And `review` is the sixth, which does not report it at all** — 0058 §3, *a
   * reviewer returns findings with a severity and no verdict*, and `#254`'s *review
   * returns findings and judges nothing*. A cold reviewer finding a blocker returns
   * `failed` exactly as it does at `proposed` today; the **step** passes carrying
   * the findings, and the judgement is made one step later, where there is a round
   * to buy with it.
   *
   * Nothing is dropped and nothing is quiet: the action's own verdict is still on
   * `results`, and it is what a `proposed` reads to know there is a `findings`
   * direction to judge at all.
   */
  it("reads the same verdict at `review` as findings and not a verdict", async () => {
    const finding: ActionFinding = {
      file: "packages/conductor/src/pass.ts",
      line: 1,
      claim: "a blocker",
      failureScenario: "it does the wrong thing",
      severity: "blocker",
    };
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      review: [canned("cold reviewer", { verdict: "failed", evidence: "a blocker in pass.ts", findings: [finding] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    const reviewed = result.steps.find((s) => s.step === "review");
    expect(reviewed?.ending).toEqual({ ending: "passed" });
    expect(reviewed?.results).toEqual([
      { action: "cold reviewer", verdict: "failed", evidence: "a blocker in pass.ts", findings: [finding] },
    ]);
    // Nothing refused, so nothing stopped the pass and no round was bought here:
    // the visit that decides is `proposed`, on its own way through.
    expect(result.stoppedAt).toBeNull();
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
  });

  /** And at one of the four the same verdict is a refusal, with all it buys. */
  it("reads the same verdict at one of the four as a refusal", async () => {
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      build: [canned("cold reviewer", { verdict: "failed", evidence: "a blocker in pass.ts", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "refused",
      because: "action-refused",
      at: "cold reviewer",
      detail: "a blocker in pass.ts",
    });
  });

  /** 0058 §3c: which step, what refused, and a machine-readable reason. */
  it("reports the step, what refused and a reason", async () => {
    const { recipe, at } = installFails();
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toEqual({
      step: "prepared",
      ending: {
        ending: "refused",
        because: "action-refused",
        at: "install",
        detail: "pnpm install exited 1",
      },
    });
    // The step's own body never ran: its plugins ended the step. The router did,
    // and then `end`.
    expect(seen.map((s) => s.step)).toEqual(["claim", "admit", "proposed", "end"]);
  });
});

describe("a refusal reports what the action that refused said", () => {
  /**
   * The reason a step is what stopped and an action is what refused: nothing
   * makes an action's *name* unique within a step. `actionsAt` (`recipe.ts:1093`)
   * validates the plugin and the kind, and no refinement in `recipe.ts` or
   * `resolve.ts` asks for distinct names, so a lookup by name returns whichever
   * was declared first — and *refused at `check` — tests green* is a refusal
   * reporting the passing check's evidence.
   */
  it("reads the evidence by verdict rather than by the first action of that name", async () => {
    const recipe = recipeWith({
      proposed: [
        { name: "check", run: "pnpm test" },
        { name: "check", run: "pnpm typecheck" },
      ],
    });
    // The schema takes both, which is the premise the rest of this rests on.
    expect(recipe.steps.proposed).toHaveLength(2);

    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      proposed: [
        canned("check", { verdict: "passed", evidence: "tests green", findings: [] }),
        canned("check", { verdict: "failed", evidence: "typecheck: 3 errors", findings: [] }),
      ],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "refused",
      because: "action-refused",
      at: "check",
      detail: "typecheck: 3 errors",
    });
  });

  /**
   * The same lookup and the same trap, and this one is worse: a person is being
   * asked, and the question is the whole of what they are answering.
   */
  it("asks the question the held action asked, under a duplicated name", async () => {
    const recipe = recipeWith({
      merge: [
        { name: "sign off", run: "pnpm test" },
        { name: "sign off", human: "ship it?" },
      ],
    });
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      merge: [
        canned("sign off", { verdict: "passed", evidence: "tests green", findings: [] }),
        canned("sign off", { verdict: "needs-approval", evidence: "ship it?", findings: [] }),
      ],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({ ending: "held", at: "sign off", question: "ship it?" });
  });
});

// ---------------------------------------------------------- to the router ----

describe("every step that does not pass arrives at proposed", () => {
  /**
   * 0058 §3b's second drawing, and the property it exists for: **`proposed` is
   * the only step that routes, so every loop passes through the workflow check
   * and no loop is unbounded.** A pass that breaks straight to `end` on a
   * refusal cannot buy a fix round at all, and leaves a `proposed` body written
   * later as a router nothing can call.
   */
  it("takes a refusal to the router, carrying its reason", async () => {
    const { recipe, at } = installFails();
    let handed: Handed | undefined;
    const { bodies } = watching({
      proposed: async (work) => {
        handed = {
          step: work.step,
          actions: work.actions.map((a) => a.name),
          outcome: work.outcome,
          arriving: work.arriving,
          offering: work.offering,
          reached: work.reached,
          context: work.context,
        };
        return { ending: "routed", to: "waiting", why: "a base that will not install is yours" };
      },
    });
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    // What happened arrived intact (0058 §3c) — the step, what refused, and why.
    expect(handed?.arriving).toMatchObject({
      step: "prepared",
      ending: { ending: "refused", because: "action-refused", at: "install", detail: "pnpm install exited 1" },
    });
    expect(handed?.arriving?.results).toEqual([
      { action: "install", verdict: "failed", evidence: "pnpm install exited 1", findings: [] },
    ]);
    // `proposed` is visited for the routing, and the visit is in `steps`.
    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "proposed", "end"]);
    expect(result.routes).toEqual([
      { from: "prepared", to: "waiting", why: "a base that will not install is yours" },
    ]);
  });

  /** And `needs-input` arrives too, which is the half that is not a refusal. */
  it("takes a needs-input to the router without buying a round", async () => {
    let offering: readonly Destination[] = [];
    const { bodies } = watching({
      implement: asked("which of the two `base` values did you mean?"),
      proposed: async (work) => {
        offering = work.offering;
        return { ending: "routed", to: "waiting", why: "only you can answer that" };
      },
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    // 0058 §3c: *that step again with "state your assumption"*, or a person.
    expect(offering).toEqual(["waiting", "implement"]);
    expect(result.stoppedAt).toMatchObject({
      step: "implement",
      ending: { ending: "did-not-finish", because: NEEDS_INPUT },
    });
    expect(result.rested).toBe("waiting");
  });

  /**
   * Its plugins are not re-run on the way back. They are verdicts about a diff
   * and the step that arrived did not pass, so there is no new diff to inspect —
   * and a declared `human:` approval must not reach a person once per round.
   */
  it("runs the router without re-running proposed's own inspection", async () => {
    const recipe = recipeWith({
      prepared: [{ name: "install", run: "pnpm install" }],
      proposed: [{ name: "sign off", human: "ship it?" }],
    });
    const { bodies } = watching({
      proposed: routerSaying(() => "waiting"),
    });
    const { actionsAt, ran } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
      proposed: [canned("sign off", { verdict: "needs-approval", evidence: "ship it?", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    // `prepared` refused before the spine ever reached `proposed`, so the
    // declared `human:` action was never built and nobody was asked twice.
    expect(ran.map((r) => r.step)).toEqual(["claim", "admit", "prepared"]);
    expect(result.steps.find((s) => s.step === "proposed")?.results).toEqual([]);
    expect(result.rested).toBe("waiting");
  });

  /**
   * And the three that are not on the drawing go nowhere. `proposed` is the
   * router, so a visit that did not pass there has nothing above it to appeal
   * to; `waiting` is where it rests and `stoppedAt` names it.
   */
  it("does not route proposed's own refusal", async () => {
    const recipe = recipeWith({ proposed: [{ name: "tamper", run: "true" }] });
    const { bodies, seen } = watching({ proposed: routerSaying(() => "implement") });
    const { actionsAt } = watchingActions({
      proposed: [canned("tamper", { verdict: "failed", evidence: "a watched path moved", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt, ceilings: { rounds: 3, restartsLeft: 3 } });

    expect(result.stoppedAt).toMatchObject({ step: "proposed", ending: { ending: "refused" } });
    expect(result.routes).toEqual([]);
    // One visit to `proposed`, not two: nothing sent its own refusal to itself.
    expect(result.steps.filter((s) => s.step === "proposed")).toHaveLength(1);
    expect(seen.at(-1)?.step).toBe("end");
  });

  /**
   * `never-ran` and `held` do not arrive either, and the endings say why. A
   * quota is about the account rather than the diff, and the only judge worth an
   * agent is itself an agent (0061 §3) — so paying to ask *what shall we do
   * about the quota* is the one route that cannot work. A declared `human:` is
   * the recipe having already decided a person is next.
   */
  it("does not route a never-ran or a question already put to a person", async () => {
    for (const [verdict, ending] of [
      ["never-ran", "never-ran"],
      ["needs-approval", "held"],
    ] as const) {
      const recipe = recipeWith({ merge: [{ name: "check", run: "true" }] });
      const { bodies } = watching({ proposed: routerSaying(() => "implement") });
      const { actionsAt } = watchingActions({
        merge: [canned("check", { verdict, evidence: "…", findings: [] })],
      });
      const { emit } = events();

      const result = await runPass({
        recipe,
        context,
        emit,
        bodies,
        actionsAt,
        ceilings: { rounds: 3, restartsLeft: 3 },
      });

      expect(result.stoppedAt).toMatchObject({ step: "merge", ending: { ending } });
      expect(result.routes).toEqual([]);
    }
  });

  /** A crash is not a question, so 0057 §2's *the pass stops* is the rule. */
  it("does not route a step that threw", async () => {
    const { bodies } = watching({
      implement: async () => {
        throw new Error("the agent runtime raised: ECONNRESET");
      },
      proposed: routerSaying(() => "implement"),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 3, restartsLeft: 3 },
    });

    expect(result.stoppedAt).toMatchObject({
      step: "implement",
      ending: { ending: "did-not-finish", because: "threw" },
    });
    expect(result.routes).toEqual([]);
  });
});

describe("the workflow decides which steps the judge may choose from", () => {
  const spent: Ceilings = { rounds: 0, restartsLeft: 0 };
  const spare: Ceilings = { rounds: 2, restartsLeft: 1 };
  const refused: StepEnding = { ending: "refused", because: "action-refused", at: "check", detail: "…" };
  const asking: StepEnding = { ending: "did-not-finish", because: NEEDS_INPUT, at: null, detail: "?" };
  /** `proposed`'s own visit, which is the `findings` direction and no other. */
  const wayThrough: StepEnding = { ending: "passed" };

  /**
   * 0061 §3: *when `rounds` is spent, `implement` is not in that set* — and
   * `waiting` is always there, because a person can always be the answer.
   */
  it("offers a person, and nothing else, once every ceiling is spent", () => {
    expect(onOffer("proposed", wayThrough, spent, 0)).toEqual(["waiting"]);
    expect(onOffer("proposed", wayThrough, spare, spare.rounds)).toEqual(["waiting", "claim"]);
  });

  /**
   * *The set depends on how far the pass got, not only on what is left to
   * spend.* A failed install refuses before any agent has run, so there is no
   * diff and no error in one to fix.
   */
  it("does not offer implement for a refusal at prepared", () => {
    expect(onOffer("prepared", refused, spare, 0)).toEqual(["waiting"]);
    expect(onOffer("build", refused, spare, 0)).toEqual(["waiting", "implement"]);
    expect(onOffer("review", refused, spare, 0)).toEqual(["waiting", "implement"]);
  });

  /**
   * A conflict an agent resolved is code written *after* `review` passed, so it
   * goes back through both — the edge that buys *every path into `end` has been
   * through `build` and `review`*.
   */
  it("offers build for a refusal at merge", () => {
    expect(onOffer("merge", refused, spare, 0)).toEqual(["waiting", "implement", "build"]);
  });

  /** 0058 §3c: a `needs-input` offers the step that asked, and nothing else. */
  it("offers the step that asked, for a needs-input", () => {
    expect(onOffer("design", asking, spare, 0)).toEqual(["waiting", "design"]);
    expect(onOffer("admit", asking, spare, 0)).toEqual(["waiting", "admit"]);
  });

  /**
   * **And the way-through visit is offered something too**, which is what makes
   * *`review` returns findings and judges nothing* buildable: the review passed,
   * so nothing refused, and the judge that reads its findings is at `proposed` on
   * the spine.
   */
  it("offers the way-through visit a round as well as a person", () => {
    expect(onOffer("proposed", wayThrough, spare, 0)).toEqual(["waiting", "claim", "implement"]);
  });

  /**
   * **A restart is offered for one direction and it is `findings`** — 0039 §2,
   * `stepsOnOffer`'s own rule, and the reason it is in code rather than in the
   * recipe: *no number a project writes down should make a typecheck error buy a
   * fresh worktree, and no judge should be able to either.* The way-through visit
   * is the `findings` direction; every other arrival at the router is one of the
   * four mechanical ones, and their remedy is to fix the work where it stands.
   *
   * It is the one move `claim` makes that cannot be taken back: the item is
   * released and the worktree thrown away.
   */
  it("offers a restart for the findings direction and for no other", () => {
    expect(onOffer("proposed", wayThrough, spare, 0)).toContain("claim");
    for (const at of ["prepared", "implement", "build", "review", "merge"] as const) {
      expect(onOffer(at, refused, spare, 0)).not.toContain("claim");
    }
    expect(onOffer("implement", asking, spare, 0)).not.toContain("claim");
  });

  /** And a destination outside the set is refused by name (0061 §3, §8). */
  it("refuses a route it did not offer", async () => {
    const { recipe, at } = installFails();
    const { bodies, seen } = watching({
      // `prepared` refused, so `implement` is on no offer — and this is the
      // judge that answers it anyway.
      proposed: async () => ({ ending: "routed", to: "implement", why: "have another go" }),
    });
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 3, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toMatchObject({
      step: "proposed",
      ending: {
        ending: "did-not-finish",
        because: "threw",
        detail: expect.stringContaining(
          "`proposed` routed the pass to `implement`, which was not on offer — waiting",
        ),
      },
    });
    // Refused rather than obeyed, and `end` still ran.
    expect(result.routes).toEqual([]);
    expect(seen.at(-1)?.step).toBe("end");
  });

  /** And the way-through visit is held to the same set. */
  it("refuses a route the way-through visit was not offered", async () => {
    const { bodies } = watching({
      // `build` is only ever offered for a conflict at `merge`.
      proposed: async () => ({ ending: "routed", to: "build", why: "round we go" }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 3, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toMatchObject({
      step: "proposed",
      ending: {
        ending: "did-not-finish",
        detail: expect.stringContaining(
          "`proposed` routed the pass to `build`, which was not on offer — waiting, implement",
        ),
      },
    });
  });
});

describe("proposed routes on the way through as well as on the way back", () => {
  /**
   * **This is what lets `review` judge nothing** (0058 §3, and the change with
   * the most evidence behind it: *10% of `review` refusals in 14 days carried no
   * findings at all*). A review that found a blocker and one that found nothing
   * both pass; the findings ride on `review`'s `results`, and the step that reads
   * them is `proposed` on its way through. If that visit could only pass or
   * report, a `findings` judge would have nowhere to say *the lines* or *the
   * approach* — the 231-refusal case, and 0061 §3's one judgement worth an agent.
   */
  it("sends a change back to implement on the findings of a review that passed", async () => {
    const finding: ActionFinding = {
      file: "packages/conductor/src/pass.ts",
      line: 1,
      claim: "a blocker",
      failureScenario: "it does the wrong thing",
      severity: "major",
    };
    let findingsSeen: readonly ActionFinding[] = [];
    let laps = 0;
    const { bodies } = watching({
      proposed: async (work) => {
        const at = work as StepWork<"proposed">;
        if (at.arriving !== null) return { ending: "routed", to: "waiting", why: "unreachable here" };
        findingsSeen = at.reached.find((s) => s.step === "review")?.results.flatMap((r) => r.findings) ?? [];
        // One round on the findings, then let it past — which is what a fix that
        // landed looks like.
        return laps++ === 0 && findingsSeen.length > 0
          ? { ending: "routed", to: "implement", why: "the lines, not the approach" }
          : { ending: "passed" };
      },
    });
    let reviews = 0;
    const actionsAt: PassOptions["actionsAt"] = (step) =>
      step === "review"
        ? [
            canned("cold reviewer", {
              verdict: "passed",
              evidence: "read the diff",
              findings: reviews++ === 0 ? [finding] : [],
            }),
          ]
        : [];
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    // The review passed both times, so nothing ever refused — and the pass still
    // bought a round and then landed.
    expect(result.steps.filter((s) => s.step === "review").map((s) => s.ending.ending)).toEqual([
      "passed",
      "passed",
    ]);
    expect(result.routes).toEqual([
      { from: "proposed", to: "implement", why: "the lines, not the approach" },
    ]);
    expect(result.stoppedAt).toBeNull();
    expect(result.rested).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
    expect(result.steps.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "design",
      "implement",
      "build",
      "review",
      "proposed",
      // the round it bought on the findings
      "implement",
      "build",
      "review",
      "proposed",
      "merge",
      "end",
    ]);
  });

  /**
   * And when the judge decides the findings are a person's, nothing is named as
   * having stopped the pass — because nothing refused. `rested` is what says a
   * person holds it, and `outcomeOf` reads that before `stoppedAt` for exactly
   * this case.
   */
  it("reports no stopping step when the way-through visit sends it to a person", async () => {
    const { bodies } = watching({
      proposed: async (work) =>
        (work as StepWork<"proposed">).arriving === null
          ? { ending: "routed", to: "waiting", why: "this changes a decision — your call" }
          : { ending: "routed", to: "waiting", why: "unreachable here" },
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toBeNull();
    expect(result.rested).toBe("waiting");
    expect(result.routes).toEqual([
      { from: "proposed", to: "waiting", why: "this changes a decision — your call" },
    ]);
    expect(outcomeOf(result)).toBe("blocked");
    // `merge` was never reached, and `end` was told the pass did not land.
    expect(result.steps.map((s) => s.step)).not.toContain("merge");
    expect(result.steps.at(-1)?.step).toBe("end");
  });

  /** The default body lets it past, which is today's behaviour with no judge. */
  it("lets a change past on the way through when no judge is built", async () => {
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, actionsAt });

    expect(result.routes).toEqual([]);
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
  });
});

describe("a route back into the spine resumes there, and the loop is bounded", () => {
  /** 0058 §3b: back to `implement`, in the same worktree, and on through. */
  it("walks the spine again from where the judge sent it", async () => {
    let refusals = 0;
    // Declared nowhere, because `KINDS_AT.build` is still `[]` and the schema
    // refuses an action at a step no code reaches (`#61`). The action arrives
    // through `actionsAt`, which is the caller's seam and not the recipe's.
    const recipe = recipeWith({});
    const { bodies } = watching({ proposed: routerSaying(() => "implement") });
    const actionsAt: PassOptions["actionsAt"] = (step) =>
      step === "build"
        ? [
            canned(
              "tests",
              // Red the first time, green the second: one round buys the fix.
              refusals++ === 0
                ? { verdict: "failed", evidence: "3 failing", findings: [] }
                : PASSED,
            ),
          ]
        : [];
    const { emit } = events();

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toBeNull();
    expect(result.rested).toBeNull();
    expect(result.routes).toEqual([{ from: "build", to: "implement", why: "because a test said so" }]);
    expect(result.steps.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "design",
      "implement",
      "build",
      // the refusal's route
      "proposed",
      // the round
      "implement",
      "build",
      "review",
      "proposed",
      "merge",
      "end",
    ]);
  });

  /**
   * **The bound is structural rather than a guard.** A judge that always says
   * `implement` spends every round and is then offered nothing but a person, so
   * the walk is at most `rounds + 1` laps long — which is the whole reason 0061
   * §3 puts the counting in the workflow and the choosing in the plugin: *a
   * misconfiguration that fails is cheap; one that loops never errors, it only
   * spends.*
   */
  it("stops buying rounds once the ceiling is spent", async () => {
    // Declared nowhere, because `KINDS_AT.build` is still `[]` and the schema
    // refuses an action at a step no code reaches (`#61`). The action arrives
    // through `actionsAt`, which is the caller's seam and not the recipe's.
    const recipe = recipeWith({});
    const { bodies } = watching({
      // The replaced judge that would loop for ever if it could.
      proposed: routerSaying((work) => (work.offering.includes("implement") ? "implement" : "waiting")),
    });
    const { actionsAt } = watchingActions({
      build: [canned("tests", { verdict: "failed", evidence: "3 failing", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({
      recipe,
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.routes.map((r) => r.to)).toEqual(["implement", "implement", "waiting"]);
    expect(result.steps.filter((s) => s.step === "build")).toHaveLength(3);
    expect(result.rested).toBe("waiting");
    // The refusal a person is handed is the build's, not the router's.
    expect(result.stoppedAt).toMatchObject({ step: "build", ending: { ending: "refused" } });
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * **A restart is a requeue and it ends the pass** (0058 §3b): the item is
   * released, and the queue's next pass orders by kind and then by number as it
   * always does — so the next ticket taken may not be this one. Which is why the
   * loop does not walk back to `claim` itself.
   */
  it("ends the pass when the judge chooses a restart", async () => {
    // On the way through, because that is the one visit `claim` is offered at:
    // a restart answers *the approach is wrong*, which only the `findings`
    // direction can say (0039 §2).
    const { bodies } = watching({
      proposed: async (work): Promise<StepEnding> => {
        const at = work as StepWork<"proposed">;
        return at.arriving === null
          ? { ending: "routed", to: "claim", why: "because a test said so" }
          : { ending: "routed", to: "waiting", why: "not this one" };
      },
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 1 },
    });

    expect(result.rested).toBe("requeued");
    expect(result.routes).toEqual([{ from: "proposed", to: "claim", why: "because a test said so" }]);
    expect(result.steps.filter((s) => s.step === "claim")).toHaveLength(1);
    // Released rather than held: `failed` is *put the item back in the queue*.
    expect(outcomeOf(result)).toBe("failed");
    expect(result.steps.at(-1)?.step).toBe("end");
  });

  /** And a restart is on no offer when the item has none left. */
  it("does not offer a restart the item cannot afford", async () => {
    const { recipe, at } = installFails();
    let offering: readonly Destination[] = [];
    const { bodies } = watching({
      proposed: async (work) => {
        offering = work.offering;
        return { ending: "routed", to: "waiting", why: "nothing left to spend" };
      },
    });
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    await runPass({ recipe, context, emit, bodies, actionsAt, ceilings: { rounds: 2, restartsLeft: 0 } });

    expect(offering).toEqual(["waiting"]);
  });
});

// ------------------------------------------- the head, the round, the findings ----

describe("a visit is judged against the head the walk has reached", () => {
  /**
   * **`onSha` is *the commit this verdict is about, and the only thing that
   * makes it stale*** (`ActionContext`), and `stepsOn()`
   * (`packages/domain/src/run.ts`) shows a step only where its `onSha` is the
   * item's head. So a pass that judged the base while the agent's commit was the
   * head would pay for `build`, `review` and `proposed` and show none of them —
   * a card with no build and no review, beside a `PassResult` saying all ten
   * steps passed.
   *
   * The loop runs no git and the caller cannot know the value either, because
   * the commit is made in the middle of the walk. So the step that moved the
   * tree says so on its ending, and every visit after it is judged against it.
   */
  it("judges the steps after a commit against the commit, and the ones before against the base", async () => {
    const { bodies, seen } = watching({
      // T4b's `implement`: the agent ran, and this is the head it committed.
      implement: async () => ({ ending: "passed", head: "b2b2b2b" }),
    });
    const { actionsAt, judged } = judging();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toBeNull();
    expect(judged.map((j) => [j.step, j.onSha])).toEqual([
      // Before the agent, including `implement`'s own plugins: the base is what
      // they are about, because nothing has been written yet.
      ["claim", "abc1234def"],
      ["admit", "abc1234def"],
      ["prepared", "abc1234def"],
      ["design", "abc1234def"],
      ["implement", "abc1234def"],
      // And after it, the head the agent left — which is what the board reads.
      ["build", "b2b2b2b"],
      ["review", "b2b2b2b"],
      ["proposed", "b2b2b2b"],
      ["merge", "b2b2b2b"],
    ]);
    // The bodies are handed the same context their plugins were run with.
    expect(seen.find((s) => s.step === "build")?.context.onSha).toBe("b2b2b2b");
    expect(seen.find((s) => s.step === "design")?.context.onSha).toBe("abc1234def");
  });

  /** A step that moved nothing says nothing, which is eight of the ten. */
  it("leaves the head alone when no step says it moved the tree", async () => {
    const { bodies } = watching();
    const { actionsAt, judged } = judging();
    const { emit } = events();

    await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(judged.every((j) => j.onSha === "abc1234def")).toBe(true);
  });

  /**
   * And a fix round is the case the whole thing is for: the second agent commits
   * too, so the second `build` and the second `review` are about that commit and
   * not about the one the first round was refused for.
   */
  it("advances the head again on a fix round", async () => {
    const heads = ["b2b2b2b", "c3c3c3c"];
    let commits = 0;
    const { bodies } = watching({
      implement: async () => ({ ending: "passed", head: heads[commits++] ?? "" }),
      proposed: routerSaying(() => "implement"),
    });
    const { actionsAt, judged } = judging((step, lap) =>
      step === "build" && lap === 0
        ? { verdict: "failed", evidence: "3 failing", findings: [] }
        : PASSED,
    );
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toBeNull();
    expect(judged.filter((j) => j.step === "build").map((j) => j.onSha)).toEqual([
      "b2b2b2b",
      "c3c3c3c",
    ]);
    expect(judged.filter((j) => j.step === "review").map((j) => j.onSha)).toEqual(["c3c3c3c"]);
  });
});

describe("a visit is judged in the round the pass is in", () => {
  /**
   * `round` is *which fix round this pipeline is judging — 0 before any fix was
   * bought* (`ActionContext`), and it is the workflow's own count rather than
   * anything a plugin or a caller supplies: the pass is the thing that buys the
   * rounds. A frozen 0 files the second round's actions under the first, so a
   * slow re-review reads as the one that already finished.
   */
  it("counts the rounds it bought, and every lap is judged in its own", async () => {
    const { bodies } = watching({ proposed: routerSaying(() => "implement") });
    const { actionsAt, judged } = judging((step, lap) =>
      step === "build" && lap === 0
        ? { verdict: "failed", evidence: "3 failing", findings: [] }
        : PASSED,
    );
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.routes).toEqual([{ from: "build", to: "implement", why: "because a test said so" }]);
    expect(judged.map((j) => [j.step, j.round])).toEqual([
      ["claim", 0],
      ["admit", 0],
      ["prepared", 0],
      ["design", 0],
      ["implement", 0],
      ["build", 0],
      // the round the refusal bought
      ["implement", 1],
      ["build", 1],
      ["review", 1],
      ["proposed", 1],
      ["merge", 1],
    ]);
  });
});

describe("the round a pass buys is bought on something", () => {
  const finding: ActionFinding = {
    file: "packages/conductor/src/pass.ts",
    line: 1,
    claim: "the reviewer is never told what it refused last time",
    failureScenario: "the fix round re-reviews from scratch and the criterion is lost",
    severity: "major",
  };

  /**
   * 0038 §2, and the acceptance contract this pass exists to keep: **the
   * findings a previous version of this diff was refused for, and that an agent
   * has since been asked to make stop happening.** Each `failureScenario` was
   * written before anybody knew what the fix would be, which is what makes it a
   * criterion the fixer could not author — and a reviewer that is never handed
   * them silently stops applying it.
   *
   * The lap's findings rather than a refusal's, because a route is chosen on
   * both of `proposed`'s visits: here the review **passed** carrying a finding
   * and the way-through judge bought the round on it (0058 §3b), which is the
   * case 0061 §3 calls the one judgement worth an agent.
   */
  it("hands the next round's plugins the findings this one was bought on", async () => {
    let laps = 0;
    const { bodies } = watching({
      proposed: async (work) => {
        const at = work as StepWork<"proposed">;
        if (at.arriving !== null) return { ending: "routed", to: "waiting", why: "unreachable here" };
        return laps++ === 0
          ? { ending: "routed", to: "implement", why: "the lines, not the approach" }
          : { ending: "passed" };
      },
    });
    const { actionsAt, judged } = judging((step, lap) =>
      step === "review" && lap === 0
        ? { verdict: "passed", evidence: "read the diff", findings: [finding] }
        : PASSED,
    );
    const { emit } = events();

    const result = await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(result.stoppedAt).toBeNull();
    // The first review was asked about nothing; the second is asked about the
    // scenario the first wrote, by name.
    expect(judged.filter((j) => j.step === "review").map((j) => j.recheck)).toEqual([[], [finding]]);
    // Nothing in the first lap was, because nothing had been refused yet.
    expect(judged.filter((j) => j.round === 0).every((j) => j.recheck.length === 0)).toBe(true);
    // And the agent being asked to fix it is judged with it too.
    expect(judged.find((j) => j.step === "implement" && j.round === 1)?.recheck).toEqual([finding]);
  });

  /**
   * And a refusal's findings are the same story from the other side — a `build`
   * that refused carrying what it found, and the round it bought asked about it.
   */
  it("carries a refusing action's findings into the round it bought", async () => {
    const { bodies } = watching({ proposed: routerSaying(() => "implement") });
    const { actionsAt, judged } = judging((step, lap) =>
      step === "build" && lap === 0
        ? { verdict: "failed", evidence: "3 failing", findings: [finding] }
        : PASSED,
    );
    const { emit } = events();

    await runPass({
      recipe: recipeWith({}),
      context,
      emit,
      bodies,
      actionsAt,
      ceilings: { rounds: 2, restartsLeft: 0 },
    });

    expect(judged.filter((j) => j.step === "build").map((j) => j.recheck)).toEqual([[], [finding]]);
  });
});

describe("a body can read what the steps before it said", () => {
  /**
   * 0058 §3c gives `proposed` the one job of routing, and what it routes on is
   * `build`'s verdict and `review`'s findings — neither of which is a
   * `StepEnding`, since a review that found a blocker and one that found
   * nothing both end `passed`. `emit` is write-only, so `reached` is the only
   * way the router sees them without reading the log back.
   *
   * `build` and `review` have no kinds in `KINDS_AT` yet, so the producer here
   * is `prepared`, the one refusing step that takes a `run:` today. What is
   * being checked is the contract, and it does not change when those two rows
   * open.
   */
  it("hands a later step the verdicts and findings of the earlier ones", async () => {
    const finding: ActionFinding = {
      file: "packages/conductor/src/pass.ts",
      line: 257,
      claim: "the router has nothing to route on",
      failureScenario: "`proposed` is asked to decide and is handed no verdict",
      severity: "major",
    };
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    let atProposed: readonly StepReached[] = [];
    const { bodies } = watching({
      proposed: async (work) => {
        atProposed = work.reached;
        return { ending: "passed" };
      },
    });
    const { actionsAt } = watchingActions({
      // A finding on a pass, because a minor does not stop the run (#135) — and
      // it is exactly the case a router must be able to see.
      prepared: [canned("install", { verdict: "passed", evidence: "1200 packages", findings: [finding] })],
    });
    const { emit } = events();

    await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(atProposed.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "design",
      "implement",
      "build",
      "review",
    ]);
    expect(atProposed.find((s) => s.step === "prepared")?.results).toEqual([
      { action: "install", verdict: "passed", evidence: "1200 packages", findings: [finding] },
    ]);
    // And a step whose list was empty said nothing, rather than being absent.
    expect(atProposed.find((s) => s.step === "design")?.results).toEqual([]);
  });

  /** The refusing case, which is the one the router most needs to see. */
  it("carries the refusing step's verdicts through to end", async () => {
    const { recipe, at } = installFails("exited 1");
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.steps.find((s) => s.step === "prepared")?.results).toEqual([
      { action: "install", verdict: "failed", evidence: "exited 1", findings: [] },
    ]);
    // `end` sees the step that stopped the pass and the route that was chosen
    // for it, not the two before them only.
    expect(seen.at(-1)?.reached.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "proposed",
    ]);
  });
});

describe("a step that did not finish is not a step that refused", () => {
  /**
   * 0057: a refusal buys a fix round, holds the item and reaches a person, and
   * this buys none of it — so the two may not arrive in one field for a caller
   * to tell apart by reading a sentence (0031 §1).
   */
  it("keeps did-not-finish apart from a refusal", async () => {
    const recipe = recipeWith({ proposed: [{ name: "review", run: "true" }] });
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      proposed: [
        canned("review", { verdict: "did-not-finish", evidence: "the turn budget ran out", findings: [] }),
      ],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "did-not-finish",
      // Deliberately not `needs-input`: nobody was asked anything, so there is
      // nothing for the router to route.
      because: "did-not-finish",
      at: "review",
      detail: "the turn budget ran out",
    });
  });

  /** And `never-ran` apart from both: that one stands the conductor down. */
  it("keeps never-ran apart from did-not-finish", async () => {
    const recipe = recipeWith({ proposed: [{ name: "review", run: "true" }] });
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      proposed: [
        canned("review", { verdict: "never-ran", evidence: "usage limit reached · resets 9pm", findings: [] }),
      ],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "never-ran",
      at: "review",
      detail: "usage limit reached · resets 9pm",
    });
  });

  /** A person being asked is a third thing again, and it is not a failure. */
  it("keeps a question for a person apart from a refusal", async () => {
    const recipe = recipeWith({ merge: [{ name: "sign off", human: "ship it?" }] });
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      merge: [canned("sign off", { verdict: "needs-approval", evidence: "ship it?", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({ ending: "held", at: "sign off", question: "ship it?" });
  });
});

// ----------------------------------------------------------------- `end` ----

describe("end runs on every ending and cannot refuse", () => {
  it("runs after a step that refused", async () => {
    const { recipe, at } = installFails("exited 1");
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(seen.at(-1)?.step).toBe("end");
    expect(result.steps.at(-1)?.step).toBe("end");
  });

  it("runs after a step that did not finish, and after one held for a person", async () => {
    for (const verdict of ["did-not-finish", "needs-approval"] as const) {
      const recipe = recipeWith({ proposed: [{ name: "review", run: "true" }] });
      const { bodies, seen } = watching();
      const { actionsAt } = watchingActions({
        proposed: [canned("review", { verdict, evidence: "…", findings: [] })],
      });
      const { emit } = events();

      const result = await runPass({ recipe, context, emit, bodies, actionsAt });

      expect(seen.at(-1)?.step).toBe("end");
      expect(result.steps.map((s) => s.step).filter((s) => s === "end")).toEqual(["end"]);
    }
  });

  /**
   * A body that throws rather than returning: T4b's `implement` when the agent
   * runtime raises, `merge`'s when `git push` throws. Nothing else in the pass
   * catches it, so without the loop's own guard the promise rejects with
   * `steps` and `stoppedAt` discarded and `end` never reached — no resolved
   * effects, no terminal outcome, and an item waiting on a run that vanished.
   * `action.ts` guards the same hole one layer down and says why.
   */
  it("runs after a body that threw, and the throw is the step's ending", async () => {
    const { bodies, seen } = watching({
      implement: async () => {
        throw new Error("the agent runtime raised: ECONNRESET");
      },
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toEqual({
      step: "implement",
      ending: {
        ending: "did-not-finish",
        because: "threw",
        at: null,
        detail: "the `implement` step threw: the agent runtime raised: ECONNRESET",
      },
    });
    expect(result.steps.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "design",
      "implement",
      "end",
    ]);
    expect(seen.at(-1)).toMatchObject({ step: "end", outcome: "blocked" });
  });

  /** And a list that could not even be built is the same ending, not a crash. */
  it("runs after an actionsAt that threw", async () => {
    const { bodies, seen } = watching();
    const actionsAt: PassOptions["actionsAt"] = (step) => {
      if (step === "prepared") throw new Error("no plugin named `instal`");
      return [];
    };
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toMatchObject({
      step: "prepared",
      ending: { ending: "did-not-finish", because: "threw" },
    });
    expect(seen.at(-1)?.step).toBe("end");
  });

  /**
   * The one case the loop already reached it. Running it twice would carry out
   * a recipe's effects twice, which is what `resolveEndActions`'s per-outcome
   * dedupe exists to stop one layer down — and it should not need to.
   */
  it("runs once when end itself is the step that did not pass", async () => {
    const { bodies, seen } = watching({
      end: async () => ({
        ending: "did-not-finish",
        because: NEEDS_INPUT,
        at: null,
        detail: "who owns this?",
      }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(seen.filter((s) => s.step === "end")).toHaveLength(1);
    expect(result.steps.filter((s) => s.step === "end")).toHaveLength(1);
    // And it is not taken to the router: `end` runs after the decision.
    expect(result.routes).toEqual([]);
  });

  /**
   * **And it is not what stopped the pass.** `end` is reached after a walk that
   * got through — so the merge landed, and its body was handed `landed` and has
   * already resolved its `when: landed` effects, closing the issue and labelling
   * the item. Naming `end` on `stoppedAt` would leave one pass with two readings
   * that disagree: `outcomeOf` would say `blocked`, and a T5 caller appending
   * from it — the mapping this file exports for exactly that — would write
   * `WorkItemBlocked` for an item whose `main` moved, and sit it on *Waiting on
   * you*.
   *
   * How `end` went is not lost; it is `end`'s own entry in `steps`.
   */
  it("does not report itself as where the pass stopped", async () => {
    const { bodies, seen } = watching({
      end: async () => ({ ending: "did-not-finish", because: "threw", at: null, detail: "tell.ts: 404" }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    // What the body was told and what a caller reads back are one answer.
    expect(seen.at(-1)).toMatchObject({ step: "end", outcome: "landed" });
    expect(result.stoppedAt).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
    expect(result.steps.at(-1)).toMatchObject({
      step: "end",
      ending: { ending: "did-not-finish", because: "threw", detail: "tell.ts: 404" },
    });
  });
});

describe("end is told which of the four endings it is running for", () => {
  /**
   * `end` is the one step whose declared effects are filtered by `when:`, and
   * `resolveEndActions(events, end, outcome)` takes that outcome as its third
   * argument. A body handed no value for it can only run every declared cell on
   * every ending — `agent:hold` on an item that landed — or run none of them,
   * which is `#61`'s declared-drawn-never-fired failure.
   *
   * The mapping itself is the conductor's, not this file's invention: every
   * stop that asks a person resolves `blocked` (`run-once.ts:2229`, `:3274`,
   * `:3383`), the merge resolves `landed` (`:3423`), and the wall releases the
   * claim without asking anybody (0031 §3).
   */
  const endSaw = async (steps: Record<string, unknown>, at: Record<string, readonly Action[]> = {}) => {
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions(at);
    const { emit } = events();
    await runPass({ recipe: recipeWith(steps), context, emit, bodies, actionsAt });
    return seen.filter((s) => s.step === "end").at(-1)?.outcome;
  };

  const stopping = (verdict: ActionResult["verdict"]) => ({
    proposed: [canned("check", { verdict, evidence: "…", findings: [] })],
  });
  const oneAtProposed = { proposed: [{ name: "check", run: "true" }] };

  it("says landed when every step passed", async () => {
    expect(await endSaw({})).toBe("landed");
  });

  it("says blocked when a step refused, held for a person, or did not finish", async () => {
    for (const verdict of ["failed", "needs-approval", "did-not-finish"] as const) {
      expect(await endSaw(oneAtProposed, stopping(verdict))).toBe("blocked");
    }
  });

  /** The one verdict that asks nobody: the claim is released and the item requeues. */
  it("says failed when the agent never started", async () => {
    expect(await endSaw(oneAtProposed, stopping("never-ran"))).toBe("failed");
  });

  it("tells the other nine nothing, because the outcome is not decided yet", async () => {
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions();
    const { emit } = events();

    await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(seen.filter((s) => s.outcome !== null).map((s) => s.step)).toEqual(["end"]);
  });

  /** And the rule on its own, since it is the pass's and not a body's (0058 §2b). */
  it("is outcomeOf, and closed is nobody's pass to reach", () => {
    expect(outcomeOf({ stoppedAt: null, rested: null })).toBe("landed");
    expect(
      outcomeOf({
        stoppedAt: { step: "merge", ending: { ending: "held", at: "sign off", question: "?" } },
        rested: null,
      }),
    ).toBe("blocked");
    expect(
      outcomeOf({
        stoppedAt: { step: "prepared", ending: { ending: "never-ran", at: "install", detail: "…" } },
        rested: null,
      }),
    ).toBe("failed");
    // A requeue releases the item too, for the opposite reason (0040).
    expect(
      outcomeOf({
        stoppedAt: { step: "build", ending: { ending: "refused", because: "red", at: "tests", detail: "…" } },
        rested: "requeued",
      }),
    ).toBe("failed");
  });
});

describe("the ten bodies are empty, and the two that are not silent", () => {
  it("passes every step a recipe left empty", async () => {
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, actionsAt });

    expect(result.stoppedAt).toBeNull();
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
  });

  /**
   * **A pass with no judge built sends every refusal to a person**, which is the
   * correct answer while `rounds` can buy nothing and is what `NOT_BUILT_YET`
   * therefore says. It is not the straight break to `end` that leaves a
   * `proposed` written later as a router nothing can call: the refusal reaches
   * the router, the router answers, and `routes` records that it did.
   */
  it("sends a refusal to a person, through the router, with no judge built", async () => {
    const { recipe, at } = installFails();
    const { actionsAt } = watchingActions(at);
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, actionsAt });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "proposed", "end"]);
    expect(result.routes).toMatchObject([{ from: "prepared", to: "waiting" }]);
    expect(result.routes[0]?.why).toContain("no `judge:` is built yet");
    expect(result.rested).toBe("waiting");
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * *Configured and did not run* must not look like *empty* (0016 §4). `end`'s
   * effects are resolved by `resolveEndActions` and carried out by `tell.ts`,
   * and this pass wires neither — so a declared `close:` is a loud error rather
   * than a green step, which is the `#61` failure this file opens by naming.
   */
  it("refuses to pass an end step whose effects it cannot carry out", async () => {
    const recipe = recipeWith({ end: [{ name: "close it", close: true }] });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, actionsAt });

    // Reported as the step's ending rather than thrown out of the pass, which
    // is the same rule one turn on: a pass that vanished must not look like
    // one that never started. The words are all still there.
    expect(result.steps.at(-1)).toMatchObject({
      step: "end",
      ending: {
        ending: "did-not-finish",
        because: "threw",
        detail: expect.stringContaining(
          'the `end` step has 1 effect(s) declared — "close it" — and this pass has no body',
        ),
      },
    });
    // And it names the call the body will make, third argument filled in: the
    // outcome is what a body needs to decide whether `close it` fires at all.
    expect(result.steps.at(-1)?.ending).toMatchObject({
      detail: expect.stringContaining('resolveEndActions(events, end, "landed")'),
    });
  });

  it("is the same ten bodies the loop uses by default", () => {
    expect(Object.keys(NOT_BUILT_YET).sort()).toEqual([...STEPS].sort());
  });
});

// ---------------------------------------------------------- one caller ----

describe("the pass has one caller, and it is `conduct.ts`", () => {
  /**
   * **This test was *nothing in the conductor imports it*, and `#256` is the
   * commit that wires it** — so the rule is inverted rather than deleted.
   *
   * What it guarded was the blast radius while the pass was unreachable. What it
   * guards now is the thing that replaced that: the pass has **one** caller, and
   * a second one would be a second engine. `run-once.ts` is gone, and the way
   * that stays true is that this fails the day another source file reaches for
   * `runPass`.
   *
   * **`pass-steps.ts` is still allowed to import `pass.ts`**, because it is
   * filling in that file's own contract — and nothing but `conduct.ts` may import
   * either. The pattern is `one-store.test.ts`'s: a rule nobody keeps by reading
   * a comment is a failing test.
   */
  it.each([
    { module: "pass.ts", allowed: ["pass-steps.ts", "conduct.ts"] },
    { module: "pass-steps.ts", allowed: ["conduct.ts"] },
  ])("$module is imported only by $allowed", ({ module, allowed }) => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const imports = new RegExp(`["']\\./${module.replace(".", "\\.")}["']`);

    const offenders = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && f !== module && !allowed.includes(f))
      .filter((f) => imports.test(readFileSync(join(src, f), "utf8")))
      .sort();

    expect(offenders).toEqual([]);
  });

  /** And the caller is there, which is the other half of *one*. */
  it("is imported by `conduct.ts`", () => {
    const src = fileURLToPath(new URL("../src/conduct.ts", import.meta.url));
    const wiring = readFileSync(src, "utf8");
    expect(wiring).toContain('from "./pass.ts"');
    expect(wiring).toContain('from "./pass-steps.ts"');
    expect(wiring).toContain("runPass({");
  });
});
