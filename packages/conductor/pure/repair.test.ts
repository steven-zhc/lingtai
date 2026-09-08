/**
 * Whose failure it is, and whether it buys an agent.
 *
 * These are the two rules `#84` asked to be checkable — *"the classification is
 * a named function with tests rather than a condition inline"* — and the reason
 * is that both of them decide whether money is spent. A rule about spending
 * money that lives inside an `if` in a 1,000-line file is a rule nobody can
 * audit, and the bound in
 * [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) §3 is the one
 * place in this design where the failure mode is unbounded spend rather than a
 * wrong answer.
 *
 * Pure, under `vitest.pure.config.ts`: nothing here reads a database, and a
 * decision that needed one would be the wrong shape.
 */
import { describe, expect, it } from "vitest";
import { type RefusalReason, type WorkItemState, emptyWorkItem } from "@lingtai/domain";
import { decideRepair, repairBrief, repairFingerprint, whoseFailure } from "../src/repair.ts";

const conflict = {
  source: "integration" as const,
  reason: "conflict",
  detail: "agent/112 does not merge into develop:\napps/web/src/components/users/user-lookup-panel.tsx",
};

const repairs = (n: number, fingerprint = "aaaaaaaaaaaa"): WorkItemState["repairs"] =>
  Array.from({ length: n }, (_, i) => ({
    after: `run-${i}`,
    reason: "conflict",
    detail: "something",
    fingerprint,
    attempt: i + 1,
  }));

const item = (over: Partial<WorkItemState> = {}): WorkItemState => ({ ...emptyWorkItem, ...over });

const policy = { on: true, maxAttempts: 1 };

describe("whose failure it is", () => {
  /**
   * The row of 0025 §1 that buys an agent: the agent holds the worktree and can
   * act.
   */
  it("calls a merge conflict, a red gate and an empty branch the repository's", () => {
    for (const reason of ["conflict", "gate-failed", "no-commits"] as const) {
      expect(whoseFailure({ ...conflict, reason }), reason).toBe("repository");
    }
  });

  /**
   * The row that never does. An agent pointed at one of these has no access to
   * the thing that is broken and nothing it could change — it would spend money
   * to report that it cannot see anything.
   */
  it("calls the integrator's own worktree, mirror and lane Lingtai's", () => {
    for (const reason of ["dirty-base", "unpushed-base", "lane-busy"] as const) {
      expect(whoseFailure({ ...conflict, reason }), reason).toBe("lingtai");
    }
  });

  it("calls every project-level refusal Lingtai's, whatever it says", () => {
    for (const reason of [
      "no GitHub App configured",
      "source.kinds.3: Invalid option",
      "LINGTAI_TEST_DATABASE_URL is declared and has no value",
      "no lingtai-hook binary at /x/lingtai-hook",
    ]) {
      expect(whoseFailure({ source: "project", reason, detail: reason }), reason).toBe("lingtai");
    }
  });

  /**
   * A pending migration is not a failure at all — it is the hold that caught
   * `#117`, working exactly as designed. Calling it the repository's would buy
   * an agent to undo a deliberate safeguard; calling it Lingtai's would say
   * Lingtai is broken when it is not.
   */
  it("calls a migration hold neither, because it is a decision somebody meant", () => {
    expect(whoseFailure({ ...conflict, reason: "pending-migration" })).toBe("person");
  });

  /**
   * The default for a rule that spends money is the one that spends none. A
   * reason this build does not know is a reason it cannot claim an agent could
   * act on.
   */
  it("refuses to guess about a reason it does not know", () => {
    expect(whoseFailure({ ...conflict, reason: "something-new" })).toBe("lingtai");
  });

  /**
   * The map is total over `RefusalReason`, which is what stops a seventh reason
   * silently defaulting into either answer. Asserted here as well as by the
   * compiler, because the compiler's version disappears if anyone reaches for
   * an index signature.
   */
  it("has an answer for every refusal the integrator can make", () => {
    const every: RefusalReason[] = [
      "conflict",
      "dirty-base",
      "unpushed-base",
      "pending-migration",
      "gate-failed",
      "no-commits",
      "lane-busy",
    ];
    for (const reason of every) {
      expect(["repository", "lingtai", "person"], reason).toContain(
        whoseFailure({ ...conflict, reason }),
      );
    }
  });
});

describe("the same failure, twice", () => {
  it("fingerprints to the same string", () => {
    expect(repairFingerprint(conflict)).toBe(repairFingerprint({ ...conflict }));
  });

  /**
   * The granularity that makes the bound *one per distinct failure* rather than
   * one per item: a conflict on another file is another failure, and may buy
   * its own attempt against the ceiling.
   */
  it("separates a conflict on one file from a conflict on another", () => {
    expect(repairFingerprint(conflict)).not.toBe(
      repairFingerprint({ ...conflict, detail: "apps/board/src/app/page.tsx" }),
    );
  });
});

describe("whether a failure buys an agent", () => {
  it("buys one for the repository's failure, and says which attempt it is", () => {
    const decision = decideRepair({ failure: conflict, policy, item: item(), runId: "run-1" });
    expect(decision).toEqual({
      repair: true,
      fingerprint: repairFingerprint(conflict),
      attempt: 1,
    });
  });

  it("never buys one for Lingtai's own, whatever the recipe says", () => {
    const decision = decideRepair({
      failure: { source: "project", reason: "no GitHub App configured", detail: "" },
      policy: { on: true, maxAttempts: 99 },
      item: item(),
      runId: "run-1",
    });
    expect(decision.repair).toBe(false);
    expect(decision.repair === false && decision.why).toMatch(/Lingtai's own failure/);
  });

  it("never buys one for a hold a person meant", () => {
    const decision = decideRepair({
      failure: { ...conflict, reason: "pending-migration" },
      policy: { on: true, maxAttempts: 99 },
      item: item(),
      runId: "run-1",
    });
    expect(decision.repair).toBe(false);
    expect(decision.repair === false && decision.why).toMatch(/yours to answer/);
  });

  it("does not buy one for a project whose recipe declines", () => {
    const decision = decideRepair({
      failure: conflict,
      policy: { on: false, maxAttempts: 1 },
      item: item(),
      runId: "run-1",
    });
    expect(decision.repair).toBe(false);
    expect(decision.repair === false && decision.why).toMatch(/repair\.on: false/);
  });

  /**
   * The bound that would compound. Without it a repair that fails buys a repair
   * of the repair, which buys another, at agent prices, for ever.
   */
  it("does not analyse the analysis when the repair's own run fails", () => {
    const of = repairs(1)[0]!;
    const decision = decideRepair({
      failure: conflict,
      policy: { on: true, maxAttempts: 9 },
      item: item({ repairs: [of], repairRun: { runId: "run-2", of } }),
      runId: "run-2",
    });
    expect(decision.repair).toBe(false);
    expect(decision.repair === false && decision.why).toMatch(/analysis of the analysis/);
  });

  /**
   * One agent per **distinct** failure, not one per pass. The queue offers a
   * blocked item again every time round; the fingerprint is what stops each lap
   * costing a run.
   */
  it("does not buy a second agent for a failure that already bought one", () => {
    const decision = decideRepair({
      failure: conflict,
      policy: { on: true, maxAttempts: 9 },
      item: item({ repairs: repairs(1, repairFingerprint(conflict)) }),
      runId: "run-2",
    });
    expect(decision.repair).toBe(false);
    expect(decision.repair === false && decision.why).toMatch(/already bought an agent/);
  });

  it("buys one for a different failure, until the ceiling is reached", () => {
    const spent = repairs(1, repairFingerprint({ ...conflict, detail: "another file" }));

    const under = decideRepair({
      failure: conflict,
      policy: { on: true, maxAttempts: 2 },
      item: item({ repairs: spent }),
      runId: "run-2",
    });
    expect(under).toEqual({ repair: true, fingerprint: repairFingerprint(conflict), attempt: 2 });

    const at = decideRepair({
      failure: conflict,
      policy: { on: true, maxAttempts: 1 },
      item: item({ repairs: spent }),
      runId: "run-2",
    });
    expect(at.repair).toBe(false);
    expect(at.repair === false && at.why).toMatch(/ceiling of 1 repair attempt\(s\)/);
  });

  /**
   * Every refusal names its own rule. The card shows this sentence, and `#84`
   * asks that an item with no path forward *says so* rather than offering a
   * control that refuses — which needs a reason, not a boolean.
   */
  it("gives a reason for every refusal, and a fingerprint with it", () => {
    const refusals = [
      decideRepair({ failure: { ...conflict, reason: "lane-busy" }, policy, item: item(), runId: "r" }),
      decideRepair({ failure: conflict, policy: { on: false, maxAttempts: 1 }, item: item(), runId: "r" }),
      decideRepair({
        failure: conflict,
        policy,
        item: item({ repairs: repairs(1, repairFingerprint(conflict)) }),
        runId: "r",
      }),
    ];
    for (const decision of refusals) {
      expect(decision.repair).toBe(false);
      if (decision.repair) continue;
      expect(decision.why.length).toBeGreaterThan(20);
      expect(decision.fingerprint).toHaveLength(12);
    }
  });
});

describe("what the repair attempt is told", () => {
  /**
   * The difference between a repair and a re-run. `#82` calls it the one hard
   * dependency: an agent that is not told what the conflict was is the same
   * agent again, at the same price, arriving at the same place.
   */
  it("carries the refusal verbatim", () => {
    const brief = repairBrief({ reason: "conflict", detail: conflict.detail, attempt: 1 });
    expect(brief).toContain("user-lookup-panel.tsx");
    expect(brief).toContain("conflict");
  });

  /** The mechanical remedy is spent by the time an agent is bought (0025 §4). */
  it("says the mechanical remedy has already been tried", () => {
    expect(repairBrief({ reason: "conflict", detail: "x", attempt: 1 })).toMatch(
      /merged the base branch in/,
    );
  });

  /**
   * An approval means *merge what the held run actually produced*, so an
   * attempt that ends with advice and no commit produces nothing anyone can
   * approve. The prompt has to say so, because that is the half of 0025 the
   * whole design rests on.
   */
  it("asks for a commit rather than a recommendation", () => {
    const brief = repairBrief({ reason: "gate-failed", detail: "x", attempt: 2 });
    expect(brief).toMatch(/commit/i);
    expect(brief).toMatch(/recommendation is not enough/i);
    expect(brief).toContain("attempt 2");
  });
});
