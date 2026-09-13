/**
 * The attempt is the unit, and the page can say what each one cost.
 *
 * The folds are pure and exported for exactly this: `task.ts` reaches the
 * database and GitHub, and *what the page says about a run* is settled by
 * envelopes and nothing else — the same split `history.ts` makes one level
 * down.
 *
 * Every claim here is about the shape #102 says was missing: three claims read
 * as one flat list, gates sat in a page-level section though a gate runs once
 * per attempt, and `RunFinished` carried `costUsd`, `turns` and `durationMs` on
 * every run while the page showed none of them.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "@lingtai/domain";
import { claimsOf, foldRun, groupHistory, totalsOf, type Claim, type RunView } from "../src/lib/task.ts";

let seq = 0n;

function e(streamId: string, type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date("2026-09-08T04:12:15Z"),
  };
}

const RUN_1 = "run-11111111-0000-0000-0000-000000000000";
const RUN_2 = "run-22222222-0000-0000-0000-000000000000";
const CLAIM: Claim = { runId: RUN_1, at: "2026-09-08T04:12:15.000Z", repair: false, released: null };

describe("the claims an item made", () => {
  it("keeps every one, in order, where the page kept only the last", () => {
    const claims = claimsOf([
      e("wi-lingtai-89", "WorkItemDiscovered", { externalRef: "89" }),
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_1 }),
      e("wi-lingtai-89", "WorkItemReleased", { runId: RUN_1, reason: "timeout" }),
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_2 }),
    ]);

    expect(claims.map((c) => c.runId)).toEqual([RUN_1, RUN_2]);
    expect(claims[0]?.released).toBe("timeout");
    expect(claims[1]?.released).toBeNull();
  });

  it("names the attempt a repair bought, which no event says outright", () => {
    // The claim consumes the pending repair, exactly as `work-item.ts` folds
    // it. There is no second event: 0025 refuses a repair a vocabulary of its
    // own, and this is the whole of how a run learns it is one.
    const claims = claimsOf([
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_1 }),
      e("wi-lingtai-89", "RepairRequested", { runId: RUN_1, attempt: 1, reason: "conflict" }),
      e("wi-lingtai-89", "WorkItemReleased", { runId: RUN_1, reason: "repair" }),
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_2 }),
    ]);

    expect(claims.map((c) => c.repair)).toEqual([false, true]);
  });

  it("counts a claim naming a run it already holds as the same attempt", () => {
    const claims = claimsOf([
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_1 }),
      e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_1 }),
    ]);

    expect(claims).toHaveLength(1);
  });
});

describe("one attempt", () => {
  it("carries the money the log has always recorded and the page never showed", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, "RunStarted", { baseSha: "a".repeat(40), runtime: "claude-code" }),
      e(RUN_1, "RunPrompted", { promptVersion: "ticket@1924", bytes: 4593, prompt: "do the thing" }),
      e(RUN_1, "RunFinished", { exitCode: 0, turns: 92, durationMs: 1_405_000, costUsd: 8.4 }),
    ]);

    expect(run.turns).toBe(92);
    expect(run.durationMs).toBe(1_405_000);
    expect(run.costUsd).toBe(8.4);
    expect(run.outcome).toEqual({ state: "finished", detail: null });
    expect(run.prompt).toEqual({ version: "ticket@1924", bytes: 4593, text: "do the thing" });
  });

  it("holds its own verdicts, so two attempts' gates are never one list", () => {
    const one = foldRun(CLAIM, 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: "b".repeat(40) }),
      e(RUN_1, "GateFailed", {
        gate: "proposed",
        action: "build",
        onSha: "b".repeat(40),
        evidence: "error TS2741",
      }),
    ]);
    const two = foldRun({ ...CLAIM, runId: RUN_2 }, 2, [
      e(RUN_2, "RunProposedCompletion", { headSha: "c".repeat(40) }),
      e(RUN_2, "GatePassed", { gate: "proposed", action: "build", onSha: "c".repeat(40) }),
    ]);

    expect(one.gates.map((g) => [g.gate, g.state])).toEqual([["proposed:build", "failed"]]);
    expect(two.gates.map((g) => [g.gate, g.state])).toEqual([["proposed:build", "passed"]]);
  });

  /**
   * The gate that stopped the run has to appear on the page written for it.
   *
   * `GateNeverRan` calls its text `detail` rather than `evidence`, because it is
   * evidence about the account and never about the diff (#133). This fold read
   * `evidence` only, so the never-ran gate arrived with `evidence: null` — and
   * `Evidence` shows only gates that said something, so the one gate a person
   * opening the page is looking for was the one gate not on it.
   */
  it("shows a never-ran gate's words, which it files under a different name", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: "b".repeat(40) }),
      e(RUN_1, "GateNeverRan", {
        gate: "proposed",
        action: "review",
        onSha: "b".repeat(40),
        detail: "You've hit your session limit · resets 2pm (America/Chicago)",
      }),
    ]);

    expect(run.gates.map((g) => [g.gate, g.state])).toEqual([["proposed:review", "never-ran"]]);
    expect(run.gates[0]?.evidence).toContain("You've hit your session limit");
    // And no findings: there is no verdict, so there is nothing it found.
    expect(run.gates[0]?.findings).toEqual([]);
  });

  it("says a run was released rather than leaving it reading as still running", () => {
    const run = foldRun({ ...CLAIM, released: "shutdown" }, 1, [
      e(RUN_1, "RunStarted", { baseSha: "a".repeat(40) }),
    ]);

    expect(run.outcome).toEqual({ state: "released", detail: "shutdown" });
  });

  it("says a claim whose stream is empty is that, and not a run in flight", () => {
    expect(foldRun(CLAIM, 1, []).outcome.state).toBe("claimed");
  });

  it("names a failure by its kind, and leaves the whole of it to the history", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, "RunStarted", { baseSha: "a".repeat(40) }),
      e(RUN_1, "RunFailed", { kind: "never-started", detail: "a long message from the runtime" }),
    ]);

    expect(run.outcome).toEqual({ state: "failed", detail: "never-started" });
  });

  it("lists a file once, however many times the agent touched it", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, "RunTouchedFile", { path: "src/task.ts", op: "write" }),
      e(RUN_1, "RunTouchedFile", { path: "src/task.ts", op: "edit" }),
      e(RUN_1, "RunTouchedFile", { path: "src/page.tsx", op: "edit" }),
    ]);

    expect(run.files).toEqual([
      { path: "src/task.ts", op: "edit" },
      { path: "src/page.tsx", op: "edit" },
    ]);
  });

  it("still shows all five points, including the ones nothing was configured at", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, "GatesResolved", { points: [{ gate: "proposed", actions: ["build"] }] }),
    ]);

    expect(run.points).toHaveLength(5);
    expect(run.points.filter((p) => p.skipped)).toHaveLength(4);
  });
});

describe("the totals", () => {
  function run(over: Partial<RunView>): RunView {
    return { ...foldRun(CLAIM, 1, []), ...over };
  }

  it("adds up every attempt, which is the figure that appeared nowhere", () => {
    const totals = totalsOf([
      run({ turns: 92, durationMs: 1_000_000, costUsd: 8.4 }),
      run({ turns: 55, durationMs: 405_000, costUsd: 4.64 }),
    ]);

    expect(totals.attempts).toBe(2);
    expect(totals.turns).toBe(147);
    expect(totals.durationMs).toBe(1_405_000);
    expect(totals.costUsd).toBeCloseTo(13.04, 5);
  });

  it("keeps a repair's spend beside the work's and never inside it", () => {
    const totals = totalsOf([run({ costUsd: 8.4 }), run({ costUsd: 2.2, repair: true })]);

    expect(totals.costUsd).toBeCloseTo(8.4, 5);
    expect(totals.repairUsd).toBeCloseTo(2.2, 5);
  });

  it("does not read an unreported cost as a free run", () => {
    // `RunFinished.costUsd` is nullable, and the label says no money at all
    // rather than `$0.00` — a run whose cost was never recorded has not been
    // shown to have cost nothing.
    expect(totalsOf([run({ costUsd: null })]).costUsd).toBe(0);
  });
});

describe("the history", () => {
  const events = [
    e("wi-lingtai-89", "WorkItemDiscovered", { externalRef: "89" }),
    e("wi-lingtai-89", "WorkItemClaimed", { runId: RUN_1 }),
    e(RUN_1, "RunStarted", { baseSha: "a".repeat(40) }),
    // A ticket-level event landing mid-run. It must not cut the run in two.
    e("wi-lingtai-89", "WorkItemBlocked", { question: "which flag?" }),
    e(RUN_1, "RunFinished", { exitCode: 0, turns: 92, durationMs: 1000, costUsd: 8.4 }),
    e(RUN_2, "RunStarted", { baseSha: "a".repeat(40) }),
  ];
  const attempts = new Map([
    [RUN_1, 1],
    [RUN_2, 2],
  ]);

  it("groups by the stream, and loses nothing doing it", () => {
    const groups = groupHistory(events, attempts);

    expect(groups.map((g) => g.label)).toEqual(["the ticket", "attempt 1", "attempt 2"]);
    expect(groups.reduce((n, g) => n + g.lines.length, 0)).toBe(events.length);
    expect(groups[1]?.lines.map((l) => l.type)).toEqual(["RunStarted", "RunFinished"]);
  });

  it("carries a seq range per group, which is what a finding cites", () => {
    const run = groupHistory(events, attempts).find((g) => g.attempt === 1);

    expect(run?.from).toBe(String(events[2]?.seq));
    expect(run?.to).toBe(String(events[4]?.seq));
  });
});
