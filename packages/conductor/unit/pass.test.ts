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
 * is in `unit/` and why the `build` gate runs it (0060 §1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS, type Step } from "@lingtai/domain";
import type { Action, ActionContext, ActionEvent, ActionResult } from "@lingtai/actions";
import { StepMap, type StepAction } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import {
  NOT_BUILT_YET,
  PASS,
  REFUSING_STEPS,
  runPass,
  type PassOptions,
  type StepBodies,
  type StepBody,
  type StepEnding,
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
 * appended to once per step reached, in order.
 */
function watching(overrides: Partial<Record<Step, StepBody<Step>>> = {}) {
  const seen: { step: Step; actions: readonly string[] }[] = [];
  const bodies = Object.fromEntries(
    STEPS.map((step) => [
      step,
      async (work: StepWork<Step>): Promise<StepEnding> => {
        seen.push({ step: work.step, actions: work.actions.map((a) => a.name) });
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
    expect(seen.at(-1)).toEqual({ step: "end", actions: ["close it"] });
  });

  it("runs the declared action for real, so its events name the step", async () => {
    const recipe = recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] });
    const { bodies } = watching();
    const { actionsAt } = watchingActions();
    const { emit, seen } = events();

    await runPass({ recipe, context, emit, bodies, actionsAt });

    expect(seen.map((e) => [e.type, (e.data as { gate: string; action: string }).gate, (e.data as { action: string }).action])).toEqual([
      ["GateRequested", "prepared", "install"],
      ["GateStarted", "prepared", "install"],
      ["GatePassed", "prepared", "install"],
    ]);
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
      because: "gate-failed",
      at: null,
      detail: "nope",
    });
    // And one of the four compiles with no cast at all.
    const mayRefuse: StepBody<"prepared"> = async () => ({
      ending: "refused",
      because: "gate-failed",
      at: "install",
      detail: "pnpm install exited 1",
    });

    expect(cannotRefuse).toBeTypeOf("function");
    expect(mayRefuse).toBeTypeOf("function");
  });

  /**
   * The runtime half, because a body read out of `StepBodies[Step]` has been
   * widened to the union and the compiler has stopped looking. Throwing rather
   * than downgrading it: a refusal buys a fix round, holds the item and may
   * reach a person, and none of that may be spent on one nothing meant.
   */
  it("throws when a step that may not refuse refuses anyway", async () => {
    const { bodies } = watching({
      claim: async () => ({ ending: "refused", because: "gate-failed", at: null, detail: "nope" }) as never,
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    await expect(runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt })).rejects.toThrow(
      /the `claim` step refused, and only prepared, build, proposed, merge may refuse/,
    );
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
        because: "gate-failed",
        at: "install",
        detail: "pnpm install exited 1",
      },
    });
    // The step's own body never ran: its plugins ended the step.
    expect(seen.map((s) => s.step)).toEqual(["claim", "admit", "end"]);
    // And nothing after `prepared` was reached, `end` excepted.
    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "end"]);
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
   * The one case the loop already reached it. Running it twice would carry out
   * a recipe's effects twice, which is what `resolveEndActions`'s per-outcome
   * dedupe exists to stop one layer down — and it should not need to.
   */
  it("runs once when end is where the pass stopped", async () => {
    const { bodies, seen } = watching({
      end: async () => ({ ending: "did-not-finish", because: "needs-input", at: null, detail: "who owns this?" }),
    });
    const { actionsAt } = watchingActions();
    const { emit } = events();

    const result = await runPass({ recipe: recipeWith({}), context, emit, bodies, actionsAt });

    expect(seen.filter((s) => s.step === "end")).toHaveLength(1);
    expect(result.steps.filter((s) => s.step === "end")).toHaveLength(1);
    expect(result.stoppedAt?.step).toBe("end");
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

    await expect(runPass({ recipe, context, emit, actionsAt })).rejects.toThrow(
      /the `end` step has 1 effect\(s\) declared — "close it" — and this pass has no body/,
    );
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
