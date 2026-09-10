/**
 * The gate: one primitive, four kinds.
 *
 * Verification, code review and human approval look like three features. They
 * are one — **a named check that produces a verdict about a specific diff** —
 * and collapsing them is what makes "configure it for another project" a YAML
 * file rather than a patch. Adding a CI check, a second reviewer or a security
 * scan is a configuration line.
 *
 * **`onSha` is load-bearing.** A verdict is about a diff, not about a ticket.
 * Bind it to the commit and a force-push invalidates the approval by
 * arithmetic — `gatesOn()` in `@lingtai/domain` simply stops returning it. In
 * the old system approval was a label, and a label survives any amount of
 * rewriting.
 *
 * Four kinds of action produce a verdict — `run`, `agent`, `watch`, `human` —
 * and all four are implemented. `run` and `human` need nothing from the caller;
 * `agent` needs a reviewer and `watch` needs the diff's file list, and
 * `run-once` supplies both. A kind whose dependency is missing is refused by
 * name rather than skipped — see `from-recipe.ts`. The pipeline, the events and
 * `onSha` are the same for all four.
 *
 * `close` and `labels` are the other two kinds. They are effects rather than
 * verdicts, they only run at `end`, and they never reach this interface.
 */
import type { GatePoint, PayloadOf } from "@lingtai/domain";

/**
 * `needs-approval` is a third outcome, not a flavour of failure.
 *
 * A `watch` action that sees a migration in the diff, and a `human` one, both end
 * the same way: nothing is wrong, and nothing may proceed until a person says
 * so. Folding that into `failed` would put "the build is broken" on a card
 * whose build is fine, and folding it into `passed` would merge it.
 *
 * **`never-ran` is a fourth outcome, and it is not a verdict at all.**
 *
 * An `agent` action whose agent never started — a quota, a signed-out runtime —
 * has judged nothing ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)
 * §1, one layer up). It cannot pass, because a green gate for a diff nobody
 * assessed is the thing `agent-gate.ts` already refuses to emit; and it must
 * not fail, because a failure is a sentence about *this diff* produced by a
 * condition that has nothing to do with any diff (`#133`).
 *
 * What it means for the run is `run-once.ts`'s: the conductor stands down and
 * the item goes back to the queue, exactly as 0031 §3 decided for a run.
 */
export type GateVerdict = "passed" | "failed" | "needs-approval" | "never-ran";

export interface GateFinding {
  file: string;
  line: number | null;
  claim: string;
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: string;
  severity: "blocker" | "major" | "minor";
}

export interface GateResult {
  verdict: GateVerdict;
  /**
   * What the board shows. For a process gate this is the log tail — enough to
   * act on without leaving the card, which is the whole point of the board.
   */
  evidence: string;
  findings: GateFinding[];
}

export interface GateContext {
  runId: string;
  /** The commit this verdict is about, and the only thing that makes it stale. */
  onSha: string;
  /** The worktree. Gates run where the agent worked, never anywhere else. */
  cwd: string;
  /**
   * The **agent's** environment, filtered exactly as the agent's was — and an
   * `agent` action is now the only kind that reads it.
   *
   * A `run:` action does not, since
   * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1: it is
   * the extension point, its code is not trusted, and it gets the names the
   * recipe declared beside it and nothing else. Its environment therefore
   * belongs to the action rather than to the point, and lives on
   * `ProcessGateSpec`. This stays here because a cold reviewer is the core's own
   * agent runtime, not an extension.
   */
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface Gate {
  readonly name: string;
  /** Which action shape produced it: `run`, `agent`, `watch` or `human`. */
  readonly kind: "run" | "agent" | "watch" | "human";
  run(context: GateContext): Promise<GateResult>;
}

/** Emitted for every gate, in order. The pipeline's whole output is events. */
export type GateEvent =
  | { type: "GateRequested"; data: PayloadOf<"GateRequested"> }
  | { type: "GateStarted"; data: PayloadOf<"GateStarted"> }
  | { type: "GatePassed"; data: PayloadOf<"GatePassed"> }
  | { type: "GateFailed"; data: PayloadOf<"GateFailed"> }
  /** The point was reached and produced no verdict, because its agent never
   *  started. Appended so that a gate which did not judge is readable as that
   *  rather than as one still running. */
  | { type: "GateNeverRan"; data: PayloadOf<"GateNeverRan"> }
  /** The same event `--no-merge` emits. One vocabulary for one idea. */
  | { type: "ApprovalRequested"; data: PayloadOf<"ApprovalRequested"> };

export interface PipelineResult {
  /** True when every gate passed. Never true when one is waiting on a person. */
  ok: boolean;
  /** The gate that failed, when one did. */
  failedAt: string | null;
  /** The gate waiting on a person, when one is. */
  heldAt: string | null;
  /**
   * The gate whose agent never started, when one did not — with the runtime's
   * own words, because they are the only evidence there is and 0031 §4 reads a
   * reset time back out of them.
   *
   * Null on every ordinary pipeline, including a failing one: this is the
   * ending that is about the account rather than about the diff, and the caller
   * has to be able to tell them apart without reading a sentence.
   */
  neverRanAt: { gate: string; detail: string } | null;
  results: { gate: string; verdict: GateVerdict; evidence: string }[];
  /** Gates never reached because an earlier one failed or is waiting. */
  skipped: string[];
}

export interface PipelineOptions {
  /** Which of the five points this pipeline is. Stamped on every verdict. */
  point: GatePoint;
  gates: readonly Gate[];
  context: GateContext;
  /**
   * Called for every event, in order, before the next gate starts.
   *
   * The pipeline does not touch the store itself: a gate that ran but whose
   * verdict was never recorded is the failure this design exists to remove, and
   * keeping the append in one place makes that impossible to forget.
   */
  emit: (event: GateEvent) => Promise<void> | void;
}

/**
 * Runs the gates in recipe order and stops at the first failure.
 *
 * Stopping is deliberate. Running the remaining gates after one has already
 * refused costs money and produces verdicts about a diff that is not going
 * anywhere; worse, a board showing three green badges and one red invites the
 * reading that it is three-quarters fine.
 */
export async function runGatePipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { gates, point, context, emit } = options;
  const results: PipelineResult["results"] = [];

  for (const [index, gate] of gates.entries()) {
    const base = { gate: point, action: gate.name, runId: context.runId, onSha: context.onSha };

    await emit({ type: "GateRequested", data: base });
    await emit({ type: "GateStarted", data: base });

    let result: GateResult;
    try {
      result = await gate.run(context);
    } catch (err) {
      // A gate that throws is a gate that failed. The alternative is an
      // exception escaping the pipeline and a run ending with no verdict at all.
      result = {
        verdict: "failed",
        evidence: `the ${gate.name} gate threw: ${(err as Error).message}`,
        findings: [],
      };
    }

    results.push({ gate: gate.name, verdict: result.verdict, evidence: result.evidence });

    if (result.verdict === "passed") {
      await emit({ type: "GatePassed", data: { ...base, evidence: result.evidence } });
      continue;
    }

    if (result.verdict === "never-ran") {
      // No verdict event, because there is no verdict: what is appended says
      // the point was reached and its agent never started. The pipeline stops
      // for the reason a refusal stops it and one it does not have — the gates
      // after this one would ask the same account the same question and meet
      // the same wall, which is 0031 §3 with a queue's worth of items replaced
      // by a recipe's worth of gates.
      await emit({ type: "GateNeverRan", data: { ...base, detail: result.evidence } });
      return {
        ok: false,
        failedAt: null,
        heldAt: null,
        neverRanAt: { gate: gate.name, detail: result.evidence },
        results,
        skipped: gates.slice(index + 1).map((g) => g.name),
      };
    }

    if (result.verdict === "needs-approval") {
      // Stops for the same reason a failure does — the gates after this one are
      // about a diff that is not going anywhere yet — but it is not a failure,
      // and the event says which.
      await emit({
        type: "ApprovalRequested",
        data: { ...base, question: result.evidence, artifacts: [] },
      });
      return {
        ok: false,
        failedAt: null,
        heldAt: gate.name,
        neverRanAt: null,
        results,
        skipped: gates.slice(index + 1).map((g) => g.name),
      };
    }

    await emit({
      type: "GateFailed",
      data: { ...base, evidence: result.evidence, findings: result.findings },
    });
    return {
      ok: false,
      failedAt: gate.name,
      heldAt: null,
      neverRanAt: null,
      results,
      skipped: gates.slice(index + 1).map((g) => g.name),
    };
  }

  return { ok: true, failedAt: null, heldAt: null, neverRanAt: null, results, skipped: [] };
}
