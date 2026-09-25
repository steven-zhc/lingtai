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
  NOT_BUILT_YET,
  PASS,
  REFUSING_STEPS,
  outcomeOf,
  runPass,
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

/**
 * The ten bodies, each recording the work it was handed and then passing —
 * plus whichever of them a test wants to answer differently.
 *
 * `seen` is what makes *a configured step is never skipped* checkable: it is
 * appended to once per step reached, in order. It records the whole of what a
 * body is handed to branch on — the declared list, the outcome and the steps
 * already reached — because those three are the contract this file fixes.
 */
function watching(overrides: Partial<Record<Step, StepBody<Step>>> = {}) {
  const seen: {
    step: Step;
    actions: readonly string[];
    outcome: TerminalOutcome | null;
    reached: readonly StepReached[];
  }[] = [];
  const bodies = Object.fromEntries(
    STEPS.map((step) => [
      step,
      async (work: StepWork<Step>): Promise<StepEnding> => {
        seen.push({
          step: work.step,
          actions: work.actions.map((a) => a.name),
          outcome: work.outcome,
          reached: work.reached,
        });
        return (await overrides[step]?.(work)) ?? { ending: "passed" };
      },
    ]),
  ) as unknown as StepBodies;
  return { bodies, seen };
}

/** Every action the loop handed the pipeline, by step. */
function watchingActions(at: Record<string, readonly Action[]> = {}) {
  const ran: { step: Step; actions: readonly string[] }[] = [];
  const actionsAt: PassOptions["actionsAt"] = (step, actions) => {
    const built = at[step] ?? actions.map((a) => canned(a.name, PASSED));
    ran.push({ step, actions: built.map((a) => a.name) });
    return built;
  };
  return { actionsAt, ran };
}

const events: () => { emit: PassOptions["emit"]; seen: ActionEvent[] } = () => {
  const seen: ActionEvent[] = [];
  return { emit: (event) => void seen.push(event), seen };
};

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

  /** `end`'s three kinds run for effect and never reach the `Action` interface. */
  it("says end alone runs effects rather than verdicts", () => {
    expect(PASS.filter((s) => s.plugins === "effects").map((s) => s.step)).toEqual(["end"]);
    expect(PASS.find((s) => s.step === "end")?.refuses).toBe(false);
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
   * `continue`. There is no `continue` in `pass.ts`, and this is what fails if
   * one arrives.
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
        { name: "install", kind: "run", run: async () => (entered += 1, PASSED) },
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
      claim: async () => ({ ending: "refused", because: "action-refused", at: null, detail: "nope" }) as never,
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
    expect(outcomeOf(result.stoppedAt)).toBe("blocked");
  });

  /**
   * 0058 §2 from the plugin's side, and the case that makes the check above a
   * body's alone. `actionsAt` is the caller's seam and the pass does no kind
   * check of its own — which is why this test hands one in at `review` though
   * `KINDS_AT.review` is still `[]`. The day that row opens (`recipe.ts:781`:
   * review is *built by the pass ticket*), a cold reviewer finding a blocker
   * returns `failed` exactly as it does at `proposed` today.
   *
   * That is an ordinary verdict and not a programming error. Reported as
   * `did-not-finish`, which is what this file's own refusal message
   * prescribes: it buys no fix round (0057), and it does not crash the pass
   * before anything can route on it.
   */
  it("reads a plugin's failed verdict at one of the six as did-not-finish", async () => {
    const { bodies } = watching();
    const { actionsAt } = watchingActions({
      review: [canned("cold reviewer", { verdict: "failed", evidence: "a blocker in pass.ts", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.stoppedAt).toEqual({
      step: "review",
      ending: {
        ending: "did-not-finish",
        because: "action-refused",
        at: "cold reviewer",
        detail: "a blocker in pass.ts",
      },
    });
    // Everything the action said is kept: the router's whole job is reading it.
    expect(result.steps.find((s) => s.step === "review")?.results).toHaveLength(1);
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
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions({
      prepared: [
        canned("install", { verdict: "failed", evidence: "pnpm install exited 1", findings: [] }),
      ],
    });
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
    // The step's own body never ran: its plugins ended the step.
    expect(seen.map((s) => s.step)).toEqual(["claim", "admit", "proposed", "end"]);
    // And the refusal went to the router, not to `end` — 0058 §3c. The four
    // steps between it and `proposed` are not on the way.
    expect(result.steps.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "proposed",
      "end",
    ]);
  });
});

describe("a refusal reports what the action that refused said", () => {
  /**
   * The reason a step is what stopped and an action is what refused: nothing
   * makes an action's *name* unique within a step. `actionsAt` validates the
   * plugin and the kind (`recipe.ts:1093`) and no refinement in `recipe.ts` or
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
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.steps.find((s) => s.step === "prepared")?.results).toEqual([
      { action: "install", verdict: "failed", evidence: "exited 1", findings: [] },
    ]);
    // `end` sees the step that stopped the pass and the router it went to,
    // rather than the steps before it only.
    expect(seen.at(-1)?.reached.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "proposed",
    ]);
    expect(seen.at(-1)?.reached.find((s) => s.step === "prepared")?.results).toEqual([
      { action: "install", verdict: "failed", evidence: "exited 1", findings: [] },
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
      proposed: [canned("review", { verdict: "did-not-finish", evidence: "the turn budget ran out", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "did-not-finish",
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
      proposed: [canned("review", { verdict: "never-ran", evidence: "usage limit reached · resets 9pm", findings: [] })],
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

// --------------------------------------------------------- the router ----

describe("every step that does not pass arrives at proposed", () => {
  /**
   * 0058 §3, §3c and the second drawing of §3b: `proposed` is **the only step
   * that routes**, and every step that did not pass arrives there carrying its
   * reason. That is what bounds the loops — each one passes through the
   * workflow check, which is where the ceilings live — and a pass that went
   * from the refusal straight to `end` would put the item on *Waiting on you*
   * with nobody having judged whether a person was worth interrupting.
   */
  it("sends a refusal to the router rather than to end", async () => {
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    const { bodies, seen } = watching();
    const { actionsAt, ran } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    // The router was reached — its plugins ran, and then its body.
    expect(ran.map((r) => r.step)).toEqual(["claim", "admit", "prepared", "proposed"]);
    expect(seen.map((s) => s.step)).toEqual(["claim", "admit", "proposed", "end"]);
    // And what stopped the spine is `prepared`, not the place it was carried
    // to: `outcomeOf` reads this, and it wants the cause.
    expect(result.stoppedAt?.step).toBe("prepared");
  });

  /** `did-not-finish` too, which is 0058's *not the same thing* and buys nothing. */
  it("sends a step that did not finish there as well", async () => {
    const { bodies, seen } = watching({
      implement: async () => ({
        ending: "did-not-finish",
        because: "needs-input",
        at: null,
        detail: "which of the two schemas is authoritative?",
      }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(seen.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "design",
      "implement",
      "proposed",
      "end",
    ]);
    expect(result.stoppedAt).toEqual({
      step: "implement",
      ending: {
        ending: "did-not-finish",
        because: "needs-input",
        at: null,
        detail: "which of the two schemas is authoritative?",
      },
    });
  });

  /**
   * The router routes on `build`'s verdict and `review`'s findings, and on a
   * refusal it needs the refusing step's own — so the arrival carries the whole
   * of what happened rather than the fact that something did (0058 §3c: *what
   * happened has to arrive intact*).
   */
  it("hands the router the step that did not pass, with its verdicts", async () => {
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    let atProposed: readonly StepReached[] = [];
    const { bodies } = watching({
      proposed: async (work) => {
        atProposed = work.reached;
        return { ending: "passed" };
      },
    });
    const { actionsAt } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
    });
    const { emit } = events();

    await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(atProposed.map((s) => s.step)).toEqual(["claim", "admit", "prepared"]);
    expect(atProposed.at(-1)).toEqual({
      step: "prepared",
      ending: {
        ending: "refused",
        because: "action-refused",
        at: "install",
        detail: "exited 1",
      },
      results: [{ action: "install", verdict: "failed", evidence: "exited 1", findings: [] }],
    });
  });

  /**
   * **The router routes nowhere yet, and the pass must not fall through to
   * `merge`** — the merge lane is for a change `proposed` passed, not one it was
   * never able to judge. `NOT_BUILT_YET`'s `proposed` passes, which is what
   * makes this the case worth pinning: T4b's four answers land here, and until
   * they do, a routed pass ends after the router.
   */
  it("stops after the router rather than falling through to merge", async () => {
    const recipe = recipeWith({
      prepared: [{ name: "install", run: "pnpm install" }],
      merge: [{ name: "verify", run: "pnpm test" }],
    });
    const { bodies } = watching();
    const { actionsAt, ran } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(ran.map((r) => r.step)).not.toContain("merge");
    expect(result.steps.map((s) => s.step)).toEqual([
      "claim",
      "admit",
      "prepared",
      "proposed",
      "end",
    ]);
  });

  /** And the router is asked once: its own refusal does not send it to itself. */
  it("does not re-enter the router when the router is what refused", async () => {
    const recipe = recipeWith({ proposed: [{ name: "judge", run: "true" }] });
    const { bodies } = watching();
    const { actionsAt, ran } = watchingActions({
      proposed: [canned("judge", { verdict: "failed", evidence: "every ceiling spent", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(ran.filter((r) => r.step === "proposed")).toHaveLength(1);
    expect(result.steps.filter((s) => s.step === "proposed")).toHaveLength(1);
    expect(result.stoppedAt?.step).toBe("proposed");
  });

  /**
   * **`claim` is the one step that does not arrive there**, and it is 0058
   * §3b's second drawing that says so: it names `admit`, `prepared`, `design`,
   * `implement`, `build`, `review` and `merge`, and leaves `claim` out. A claim
   * that did not pass picked no ticket, so there is nothing for a router to
   * route and no item for it to hold — and `proposed` may send a pass back to
   * `claim`, which is the edge that would have nothing to release.
   */
  it("does not send a claim that did not pass to the router", async () => {
    // Through the body rather than a plugin, because `KINDS_AT` runs nothing at
    // `claim` yet and `StepMap` refuses an action there by name — which is the
    // same `#61` rule one layer out, and is why `claim`'s list is empty here.
    const { bodies, seen } = watching({
      claim: async () => ({ ending: "never-ran", at: "queue", detail: "usage limit reached" }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "end"]);
    expect(seen.map((s) => s.step)).toEqual(["claim", "end"]);
    // The wall is about the account rather than the diff: the claim is
    // released and the item goes back to the queue (0031 §3).
    expect(outcomeOf(result.stoppedAt)).toBe("failed");
  });

  /**
   * **`merge`'s arrival is the one back-edge, and it is T4b's.** 0058 §3c gives
   * it to `proposed` — *anything else → proposed, and only proposed may send it
   * to a person* — but the router has already run by then, so that edge is a
   * loop and a loop wants the ceiling that sits on the router. Until T4b builds
   * them, a merge that refused ends the pass, which is where the item sits
   * today. This is the assertion to change when that ticket lands.
   */
  it("ends the pass at a merge that refused, which is the edge T4b adds", async () => {
    const recipe = recipeWith({ merge: [{ name: "verify", run: "pnpm test" }] });
    const { bodies } = watching();
    const { actionsAt, ran } = watchingActions({
      merge: [canned("verify", { verdict: "failed", evidence: "the base moved", findings: [] })],
    });
    const { emit } = events();

    const result = await runPass({ recipe, context, emit, bodies, actionsAt });

    // Once on the way through, and not a second time on the way back.
    expect(ran.filter((r) => r.step === "proposed")).toHaveLength(1);
    expect(result.steps.at(-1)?.step).toBe("end");
    expect(result.stoppedAt?.step).toBe("merge");
  });
});

// ----------------------------------------------------------------- `end` ----

describe("end runs on every ending and cannot refuse", () => {
  it("runs after a step that refused", async () => {
    const recipe = recipeWith({ prepared: [{ name: "install", run: "true" }] });
    const { bodies, seen } = watching();
    const { actionsAt } = watchingActions({
      prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
    });
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
      "proposed",
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
      end: async () => ({ ending: "did-not-finish", because: "needs-input", at: null, detail: "who owns this?" }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(seen.filter((s) => s.step === "end")).toHaveLength(1);
    expect(result.steps.filter((s) => s.step === "end")).toHaveLength(1);
  });

  /**
   * **And it is not what stopped the pass.** `end` is reached inline only when
   * the nine before it passed — so the merge landed, and its body was handed
   * `landed` and has already resolved its `when: landed` effects, closing the
   * issue and labelling the item. Naming `end` on `stoppedAt` would leave one
   * pass with two readings that disagree: `outcomeOf(result.stoppedAt)` would
   * say `blocked`, and a T5 caller appending from it — the mapping this file
   * exports for exactly that — would write `WorkItemBlocked` for an item whose
   * `main` moved, and sit it on *Waiting on you*.
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
    expect(outcomeOf(result.stoppedAt)).toBe("landed");
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

  /** The one ending that asks nobody: the claim is released and the item requeues. */
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
    expect(outcomeOf(null)).toBe("landed");
    expect(outcomeOf({ step: "merge", ending: { ending: "held", at: "sign off", question: "?" } })).toBe(
      "blocked",
    );
    expect(
      outcomeOf({ step: "prepared", ending: { ending: "never-ran", at: "install", detail: "…" } }),
    ).toBe("failed");
  });
});

describe("the ten bodies are empty, and the empty one that is not silent", () => {
  it("passes every step a recipe left empty", async () => {
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, actionsAt });

    expect(result.stoppedAt).toBeNull();
    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
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

// ------------------------------------------------------- wired to nothing ----

describe("nothing in the conductor imports it", () => {
  /**
   * The ticket's first *Done when*, and the thing that makes the blast radius
   * zero: `pass.ts` lands beside `run-once.ts` and is reachable only from this
   * file. The day T5 wires it, this test is deleted in the same commit as the
   * line that wires it — which is the point of having it say so out loud.
   *
   * The pattern is `one-store.test.ts`'s: a rule nobody keeps by reading a
   * comment is a failing test.
   */
  it("is imported by no source file in the package", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));

    const offenders = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && f !== "pass.ts")
      .filter((f) => /["']\.\/pass\.ts["']/.test(readFileSync(join(src, f), "utf8")))
      .sort();

    expect(offenders).toEqual([]);
  });
});
