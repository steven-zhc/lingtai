/**
 * Whose failure it is, and what a person is told about it.
 *
 * This began as the two rules `#84` asked to be checkable — *"the
 * classification is a named function with tests rather than a condition
 * inline"* — because both of them decided whether money was spent, and a rule
 * about spending money inside an `if` in a 1,000-line file is a rule nobody can
 * audit.
 *
 * **One of the two is gone.** `#143` carries out
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
 * §Consequences: a lane refusal buys nothing, so there is no purchase to bound
 * and `decideRepair` and its fingerprint, its recursion guard and its ceiling
 * are deleted with it. What is left is *whose* failure it is — a question about
 * blame — and the sentence that answers it on a card. The unbounded-spend
 * failure mode this file was written around now lives in `fix.ts`, which is the
 * only thing that buys an agent.
 *
 * Pure, under `vitest.pure.config.ts`: nothing here reads a database, and a
 * decision that needed one would be the wrong shape.
 */
import { describe, expect, it } from "vitest";
import { RUN_FAILURE_KINDS, type RefusalReason } from "@lingtai/domain";
import { diagnoseRefusal, whoseFailure } from "../src/attribution.ts";

const conflict = {
  source: "integration" as const,
  reason: "conflict",
  detail: "agent/112 does not merge into develop:\napps/web/src/components/users/user-lookup-panel.tsx",
};

describe("whose failure it is", () => {
  /**
   * The row of 0025 §1 that used to buy an agent. It buys nothing now — what it
   * still means is that the defect is in the managed repository, so the pass it
   * happened in was the thing that could act on it, and the card says so rather
   * than blaming Lingtai for a red build.
   */
  it("calls a merge conflict, a red gate and an empty branch the repository's", () => {
    for (const reason of ["conflict", "gate-failed", "no-commits"] as const) {
      expect(whoseFailure({ ...conflict, reason }), reason).toBe("repository");
    }
  });

  /**
   * The row that is nothing to do with the diff. Nothing in the repository is
   * broken, so nothing a pass could have done would have helped — and a card
   * that pointed a person at the branch would point them at the wrong thing.
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
   * `#117`, working exactly as designed. Calling it the repository's would blame
   * a deliberate safeguard; calling it Lingtai's would say Lingtai is broken
   * when it is not.
   */
  it("calls a migration hold neither, because it is a decision somebody meant", () => {
    expect(whoseFailure({ ...conflict, reason: "pending-migration" })).toBe("person");
  });

  /**
   * A reason this build does not know is one it cannot claim to have read, so
   * the honest sentence is *something here is wrong and it is not the diff*.
   */
  it("refuses to guess about a reason it does not know", () => {
    expect(whoseFailure({ ...conflict, reason: "something-new" })).toBe("lingtai");
  });

  /**
   * The map is total over `RefusalReason`, which is what stops an eighth reason
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

  /**
   * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §2, and the
   * clause that had been missing.
   *
   * A quota burned six tickets in ninety-two seconds and bought no agent — by
   * luck, because nothing here said a run failure was not the repository's. The
   * spending half of that argument is moot now; the attribution is not. An
   * account-wide wall is Lingtai's, and a card that called it the repository's
   * would send somebody to read a diff that is not the problem.
   */
  it("calls a run that never started Lingtai's rather than the repository's", () => {
    expect(
      whoseFailure({
        source: "run",
        reason: "never-started",
        detail: "You've hit your session limit · resets 11pm (America/Chicago)",
      }),
    ).toBe("lingtai");
  });

  /**
   * Total over `RunFailed.kind` for the reason the integration map is total
   * over `RefusalReason`: a sixth kind must not default into blaming the
   * repository because nobody remembered this file existed.
   */
  it("has an answer for every way a run can end badly, and none of them is the repository's", () => {
    for (const reason of RUN_FAILURE_KINDS) {
      expect(whoseFailure({ source: "run", reason, detail: "" }), reason).not.toBe("repository");
    }
  });
});

/**
 * The sentence a refusal reaches a person as (#83), which since `#143` is the
 * whole outcome of one.
 *
 * `#112` sat in *Waiting on you* for four days holding
 * `conflict: agent/112 does not merge into develop: user-lookup-panel.tsx` — a
 * git message with a colon in it — and no action at all. Everything needed to
 * say more was already in this file: whose failure each reason is, whether the
 * mechanical remedy is spent, and whether anything could act on it.
 *
 * Pure, and tested here rather than through a run, because it is what the card
 * and `lingtai status` both end up printing.
 */
describe("a refusal, read for a person", () => {
  const REASONS: RefusalReason[] = [
    "conflict",
    "dirty-base",
    "unpushed-base",
    "pending-migration",
    "gate-failed",
    "no-commits",
    "lane-busy",
  ];

  const read = (reason: string) =>
    diagnoseRefusal({
      reason,
      detail: "CONFLICT (content): Merge conflict in apps/web/src/page.tsx",
      branch: "agent/112",
      base: "develop",
    });

  it("says something in words for every reason, and never drops the output", () => {
    for (const reason of REASONS) {
      const d = read(reason);
      // A sentence, not a reason code — the code is what the card had, and it
      // is what an operator was left to interpret.
      expect(d.what, reason).not.toContain(reason);
      expect(d.what, reason).toMatch(/\.$/);
      // The raw failure survives every one of them. A summary that hides the
      // git output is worse than the git output.
      expect(d.raw, reason).toContain("CONFLICT (content)");
      // And why no agent is coming, which is what a card could never say —
      // composed here from `whoseFailure` rather than handed in by whichever
      // call site had just asked about money.
      expect(d.done, reason).toContain("No agent was bought");
    }
  });

  /**
   * **The three sentences are three, and each one answers a different question
   * a person would actually ask.** A single "no agent was bought" would leave
   * the reader of a red build wondering whether Lingtai was broken, and the
   * reader of a migration hold wondering what had gone wrong — which is `#84`'s
   * *never left with no path forward* failing for the opposite reason.
   */
  it("says why no agent is coming in the owner's own terms", () => {
    expect(read("gate-failed").done).toContain("inside the pass it happened in");
    expect(read("dirty-base").done).toContain("Lingtai's own failure");
    expect(read("pending-migration").done).toContain("yours to answer");
  });

  it("recommends the queue for a conflict, and says the remedy is spent", () => {
    const d = read("conflict");
    expect(d.what).toBe("agent/112 does not merge into develop.");
    expect(d.done).toContain("develop was merged in first");
    expect(d.recommendation).toEqual({
      action: "requeue",
      why:
        "the mechanical remedy is already spent, so the next attempt is the fix: " +
        "it is cut from a base that has since moved",
    });
  });

  /**
   * The refusals with no move, and they are not an oversight. A red diff is the
   * judgement this system exists to ask a person for, and Lingtai's own dirty
   * checkout is not something requeueing walks past.
   */
  it("recommends nothing where nothing can honestly be recommended", () => {
    for (const reason of ["gate-failed", "pending-migration", "dirty-base", "unpushed-base"]) {
      expect(read(reason).recommendation, reason).toBeNull();
    }
  });

  /** An unknown reason still gets a diagnosis, and gets no move — as `whoseFailure` does. */
  it("says an unrecognised refusal plainly rather than guessing at it", () => {
    const d = read("something-a-newer-build-wrote");
    expect(d.what).toContain("something-a-newer-build-wrote");
    expect(d.recommendation).toBeNull();
    expect(d.raw).toContain("CONFLICT (content)");
    // Lingtai's, by the same default `whoseFailure` takes.
    expect(d.done).toContain("Lingtai's own failure");
  });
});
