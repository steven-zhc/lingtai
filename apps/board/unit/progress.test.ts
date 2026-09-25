/**
 * What a running card says about *now*.
 *
 * Driven off the timeline #79 recorded against `wi-lingtai-59`'s own log, which
 * is the whole of the complaint: at 17:23 the card read `1 passed · attempt 2`
 * while the truth was "the agent finished three minutes ago; the build gate is
 * 2m34s into a 20m budget". Every fact in that sentence is in the events below,
 * and none of it reached the card.
 */
import { describe, expect, it } from "vitest";
import { STEPS, type Envelope, type Step } from "@lingtai/domain";
import type { StepPlan } from "@lingtai/conductor/filter";
import { AGENT, elapsed, foldProgress, type StepState } from "../src/lib/progress.ts";

let seq = 0n;

function at(time: string, type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId: "run-59",
    version: Number(seq),
    type,
    schemaVer: 2,
    data,
    actor: "conductor",
    causation: null,
    at: new Date(time),
  };
}

const step = (step: Step, action: string) => ({
  gate: step,
  action,
  runId: "run-59",
  onSha: "b1b8694",
});

/**
 * This repository's own recipe, as `gatePlan` reduces it — every point present
 * and every duration already a number. That reduction has its own test in
 * `packages/conductor/unit/filter.test.ts`; this one is about what the fold
 * does with the answer.
 */
const PLAN: StepPlan = new Map([
  ["admit", []],
  ["prepared", [{ name: "install", budgetMs: 10 * 60_000 }]],
  ["proposed", [{ name: "build", budgetMs: 20 * 60_000 }]],
  ["merge", []],
  ["end", [{ name: "close the ticket", budgetMs: null }]],
]);

/** The run as the log recorded it, up to any point in that timeline. */
function timeline(): Envelope[] {
  seq = 0n;
  return [
    at("2026-09-04T17:12:20Z", "GateRequested", step("prepared", "install")),
    at("2026-09-04T17:12:20Z", "GateStarted", step("prepared", "install")),
    at("2026-09-04T17:12:26Z", "GatePassed", { ...step("prepared", "install"), evidence: "ok", findings: [] }),
    at("2026-09-04T17:12:30Z", "RunStarted", {
      workItemId: "wi-lingtai-59",
      invocation: { command: "claude", args: [], tier: "guarded", limits: { turns: 150, wallMs: 3_600_000 } },
    }),
    at("2026-09-04T17:12:30Z", "GatesResolved", {
      runId: "run-59",
      configHash: "abc",
      points: STEPS.map((step) => ({
        gate: step,
        actions: (PLAN.get(step) ?? []).map((a) => a.name),
      })),
    }),
    at("2026-09-04T17:20:42Z", "RunProposedCompletion", { headSha: "b1b8694" }),
    at("2026-09-04T17:20:42Z", "RunFinished", {
      exitCode: 0,
      turns: 34,
      durationMs: 492_000,
      costUsd: 2.19,
    }),
    at("2026-09-04T17:20:43Z", "GateRequested", step("proposed", "build")),
    at("2026-09-04T17:20:43Z", "GateStarted", step("proposed", "build")),
  ];
}

const stateOf = (steps: readonly { step: string; state: StepState }[], step: string) =>
  steps.find((p) => p.step === step)?.state;

describe("where a run has got to", () => {
  it("names the point it is at and how far into that point's budget", () => {
    const progress = foldProgress(timeline(), PLAN);

    expect(progress?.now?.label).toBe("proposed:build");
    expect(progress?.now?.since).toBe("2026-09-04T17:20:43.000Z");
    // The recipe's own `timeout: 20m`, parsed once by `gatePlan`. Without the
    // denominator "slow" and "about to be killed" read the same.
    expect(progress?.now?.budgetMs).toBe(20 * 60_000);
  });

  it("measures elapsed from the run's first event, not from the agent's", () => {
    // The prepare gates run before `RunStarted`; a run that has spent six
    // minutes installing has spent six minutes.
    expect(foldProgress(timeline(), PLAN)?.since).toBe("2026-09-04T17:12:20.000Z");
  });

  it("is at the agent, against the wall clock as applied, while the agent runs", () => {
    const upToAgent = timeline().slice(0, 5);
    const progress = foldProgress(upToAgent, PLAN);

    expect(progress?.now?.label).toBe(AGENT);
    expect(progress?.now?.since).toBe("2026-09-04T17:12:30.000Z");
    // `RunStarted.invocation.limits`, which is the number the run will actually
    // be killed at — not a second reading of the recipe.
    expect(progress?.now?.budgetMs).toBe(3_600_000);
  });

  /**
   * The gap #79 measured: `RunFinished` at 17:20:42, `GateStarted` at 17:20:43.
   * Nothing is executing in between, and saying so beats saying the agent is.
   */
  it("says so when the agent has finished and no point has started", () => {
    const between = timeline().slice(0, 7);
    expect(foldProgress(between, PLAN)?.now).toBeNull();
  });

  /**
   * ADR 0016 §4: a point nobody configured is `skipped` and the skip is shown,
   * so that a point which *was* configured and did not run — Lingtai's bug — is
   * the only other way a point can be silent.
   */
  it("shows all ten steps, and which are done", () => {
    const steps = foldProgress(timeline(), PLAN)?.steps ?? [];

    expect(steps.map((p) => p.step)).toEqual([...STEPS]);
    expect(stateOf(steps, "admit")).toBe("skipped");
    expect(stateOf(steps, "prepared")).toBe("passed");
    expect(stateOf(steps, "proposed")).toBe("running");
    expect(stateOf(steps, "merge")).toBe("skipped");
    // Configured, not reached. Not the same fact as nothing being there.
    expect(stateOf(steps, "end")).toBe("pending");
  });

  /**
   * `GatesResolved` is appended after `RunStarted`, which is after the prepare
   * gates — so for the first seconds of a run the log has no plan, and the
   * recipe is the only thing that can say a point exists.
   */
  it("names a configured point before GatesResolved has landed", () => {
    const first = timeline().slice(0, 3);
    const steps = foldProgress(first, PLAN)?.steps ?? [];

    expect(stateOf(steps, "proposed")).toBe("pending");
    expect(steps.find((p) => p.step === "proposed")?.planned).toEqual(["build"]);
    expect(stateOf(steps, "merge")).toBe("skipped");
  });

  it("reads a failure at a point as failed, whatever else that point did", () => {
    const failed = [
      ...timeline(),
      at("2026-09-04T17:34:00Z", "GateFailed", {
        ...step("proposed", "build"),
        evidence: "2 tests failed",
        findings: [],
      }),
    ];
    const progress = foldProgress(failed, PLAN);

    expect(stateOf(progress?.steps ?? [], "proposed")).toBe("failed");
    // The verdict ended the phase; nothing is executing.
    expect(progress?.now).toBeNull();
  });

  /** A person is not a timeout, and pretending otherwise answers both wrongly. */
  it("puts no denominator on a point that is waiting for a person", () => {
    const held = [
      ...timeline().slice(0, 7),
      at("2026-09-04T17:21:00Z", "ApprovalRequested", {
        ...step("merge", "read it"),
        question: "land this?",
        artifacts: [],
      }),
    ];
    const progress = foldProgress(held, PLAN);

    expect(progress?.now?.label).toBe("merge:read it");
    expect(progress?.now?.budgetMs).toBeNull();
  });

  it("has nothing to say about a run with no events", () => {
    expect(foldProgress([], PLAN)).toBeNull();
  });

  /**
   * A recipe that would not resolve costs the denominators and not the card —
   * the same rule the Queued column follows when GitHub will not answer (#76).
   */
  it("still says where a run is when no recipe could be read", () => {
    const progress = foldProgress(timeline());

    expect(progress?.now?.label).toBe("proposed:build");
    expect(progress?.now?.budgetMs).toBeNull();
    // The plan the log recorded is still the plan.
    expect(stateOf(progress?.steps ?? [], "prepared")).toBe("passed");
  });
});

/**
 * The unit a live phase is read in. `inWords` answers *when* a countdown ends
 * and says "under a minute" for the first sixty seconds of a twenty-minute
 * gate, which is the one stretch where the seconds are all that is moving.
 */
describe("the stopwatch", () => {
  it("counts seconds, then minutes and seconds, then hours and minutes", () => {
    expect(elapsed(41_000)).toBe("41s");
    expect(elapsed(154_000)).toBe("2m34s");
    expect(elapsed(3_600_000 + 7 * 60_000)).toBe("1h07m");
  });

  it("never counts backwards past zero", () => {
    expect(elapsed(-5_000)).toBe("0s");
  });
});
