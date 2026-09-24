/**
 * The action: one primitive, four kinds.
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
import { taggedTrace, type RunTrace } from "@lingtai/agent/run-log";
import type { Step, PayloadOf, Severity } from "@lingtai/domain";

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
 * §1, one layer up). It cannot pass, because a green action for a diff nobody
 * assessed is the thing `agent-action.ts` already refuses to emit; and it must
 * not fail, because a failure is a sentence about *this diff* produced by a
 * condition that has nothing to do with any diff (`#133`).
 *
 * What it means for the run is `run-once.ts`'s: the conductor stands down and
 * the item goes back to the queue, exactly as 0031 §3 decided for a run.
 *
 * **`did-not-finish` is a fifth, and it is the neighbour `never-ran` does not
 * cover** ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md)).
 *
 * An `agent` action that *started* and ended with no receipt — a crash, a
 * timeout, a turn budget spent without an answer — judged nothing either, and
 * for months it said so only inside the `evidence` string while returning
 * `failed`. So `run-once.ts` bought a fix round for it and an agent was paid to
 * answer a question nobody asked (`#196`). It is not `never-ran`, because that
 * stands the whole conductor down on the grounds that the wall is account-wide
 * (0031 §3) and a crash is local.
 *
 * What it costs is 0057 §2, and it is the pipeline's below: no fix round, and
 * the pass stops. **§4's retry is gone** (`#234`) — it reused the crashed
 * attempt's session id, so `claude` refused every one of them in zero seconds
 * having run nothing, and the log then said the action did not finish *twice*
 * when it had been tried once. 0057 §1–3 is what is kept, and it is the half
 * that works: this is not a refusal, it buys no round, and it stands the pass
 * down rather than the conductor.
 */
export type ActionVerdict = "passed" | "failed" | "needs-approval" | "never-ran" | "did-not-finish";

export interface ActionFinding {
  file: string;
  line: number | null;
  claim: string;
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: string;
  /** The ladder is `SEVERITIES` in `@lingtai/domain` and is not restated here. */
  severity: Severity;
}

export interface ActionResult {
  verdict: ActionVerdict;
  /**
   * What the board shows. For a process action this is the log tail — enough to
   * act on without leaving the card, which is the whole point of the board.
   */
  evidence: string;
  findings: ActionFinding[];
}

export interface ActionContext {
  runId: string;
  /** The commit this verdict is about, and the only thing that makes it stale. */
  onSha: string;
  /** The worktree. Actions run where the agent worked, never anywhere else. */
  cwd: string;
  /**
   * The **agent's** environment, filtered exactly as the agent's was — and an
   * `agent` action is now the only kind that reads it.
   *
   * A `run:` action does not, since
   * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1: it is
   * the extension point, its code is not trusted, and it gets the names the
   * recipe declared beside it and nothing else. Its environment therefore
   * belongs to the action rather than to the step, and lives on
   * `ProcessActionSpec`. This stays here because a cold reviewer is the core's own
   * agent runtime, not an extension.
   */
  env: Record<string, string>;
  /**
   * Findings a **previous** version of this diff was refused for, and that an
   * agent has since been asked to make stop happening
   * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
   *
   * On the context rather than on a spec, because it is a fact about *this run
   * of the pipeline* exactly as `onSha` is: the same recipe, the same actions, a
   * head that moved and a question that has been asked once already. Absent on
   * the first pass, which is every pass before a fix.
   *
   * Only the `agent` kind reads it, and it is the acceptance contract rather
   * than context: each finding's `failureScenario` was written before anybody
   * knew what the fix would be, which is what makes it a criterion the fixer
   * could not author. A process action re-runs unchanged — a build does not need
   * to be told what the reviewer said.
   */
  recheck?: readonly ActionFinding[];
  /**
   * Which fix round this pipeline is judging — 0 before any fix was bought.
   * Only said on the run log, so a slow re-review reads as *round 2*.
   */
  round?: number;
  /**
   * The run's log ([0034](../../../doc/decisions/0034-the-run-log.md), #153).
   *
   * `runActionPipeline` writes each action's start and end here under
   * `<step>:<action>`, and hands the action this same log **already tagged**,
   * so an `agent` action passes it to its runtime and every line its agent
   * writes is filed under the action it belongs to. A `run` or `watch` action has
   * no agent and writes nothing further. Absent, nothing is written.
   */
  log?: RunTrace;
  signal?: AbortSignal;
}

export interface Action {
  readonly name: string;
  /** Which action shape produced it: `run`, `agent`, `watch` or `human`. */
  readonly kind: "run" | "agent" | "watch" | "human";
  run(context: ActionContext): Promise<ActionResult>;
}

/** Emitted for every action, in order. The pipeline's whole output is events. */
export type ActionEvent =
  | { type: "GateRequested"; data: PayloadOf<"GateRequested"> }
  | { type: "GateStarted"; data: PayloadOf<"GateStarted"> }
  | { type: "GatePassed"; data: PayloadOf<"GatePassed"> }
  | { type: "GateFailed"; data: PayloadOf<"GateFailed"> }
  /** The step was reached and produced no verdict, because its agent never
   *  started. Appended so that an action which did not judge is readable as that
   *  rather than as one still running. */
  | { type: "GateNeverRan"; data: PayloadOf<"GateNeverRan"> }
  /** The step was reached, its agent started and ended with no receipt, so
   *  nothing judged the diff. Appended once, because the action is run once
   *  (0057 §1, and §4's retry deleted by `#234`). */
  | { type: "GateDidNotFinish"; data: PayloadOf<"GateDidNotFinish"> }
  /** The same event `--no-merge` emits. One vocabulary for one idea. */
  | { type: "ApprovalRequested"; data: PayloadOf<"ApprovalRequested"> };

export interface PipelineResult {
  /** True when every action passed. Never true when one is waiting on a person. */
  ok: boolean;
  /** The action that failed, when one did. */
  failedAt: string | null;
  /** The action waiting on a person, when one is. */
  heldAt: string | null;
  /**
   * The action whose agent never started, when one did not — with the runtime's
   * own words, because they are the only evidence there is and 0031 §4 reads a
   * reset time back out of them.
   *
   * Null on every ordinary pipeline, including a failing one: this is the
   * ending that is about the account rather than about the diff, and the caller
   * has to be able to tell them apart without reading a sentence.
   */
  neverRanAt: { action: string; detail: string } | null;
  /**
   * The action whose agent started and did not finish
   * ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §1).
   *
   * Its own field for the same reason `neverRanAt` is one: this ending buys no
   * fix round (§2) and does not stand the conductor down (§3), and a caller
   * that had to read `evidence` to tell it from a refusal would be the second
   * reader of a sentence that 0031 §1 exists to prevent.
   */
  didNotFinishAt: { action: string; detail: string } | null;
  /**
   * Every verdict, with the findings behind it.
   *
   * `findings` is carried here rather than left on the `GateFailed` event
   * because the caller acts on it: a refusal with findings buys a fixing agent
   * (0038 §1), and reading the log back to discover what the action it just ran
   * said would be a second source of truth for the same sentence.
   */
  results: { action: string; verdict: ActionVerdict; evidence: string; findings: ActionFinding[] }[];
  /** Actions never reached because an earlier one failed or is waiting. */
  skipped: string[];
}

export interface PipelineOptions {
  /** Which of the ten steps this pipeline is. Stamped on every verdict. */
  step: Step;
  actions: readonly Action[];
  context: ActionContext;
  /**
   * Called for every event, in order, before the next action starts.
   *
   * The pipeline does not touch the store itself: an action that ran but whose
   * verdict was never recorded is the failure this design exists to remove, and
   * keeping the append in one place makes that impossible to forget.
   */
  emit: (event: ActionEvent) => Promise<void> | void;
}

/**
 * Runs the actions in recipe order and stops at the first failure.
 *
 * Stopping is deliberate. Running the remaining actions after one has already
 * refused costs money and produces verdicts about a diff that is not going
 * anywhere; worse, a board showing three green badges and one red invites the
 * reading that it is three-quarters fine.
 */
export async function runActionPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { actions, step, context, emit } = options;
  const results: PipelineResult["results"] = [];

  for (const [index, action] of actions.entries()) {
    // `gate:` is the **event payload's** field and stays that spelling until the
    // log's own vocabulary is renamed — it carries the step, and `action` beside
    // it carries this action's name.
    const base = { gate: step, action: action.name, runId: context.runId, onSha: context.onSha };

    await emit({ type: "GateRequested", data: base });

    /**
     * The start and the end on the run's log, for every kind (#153).
     *
     * A review is eighteen minutes and a build four and a half, and the file a
     * person was following said nothing for either. The line's own time is
     * *since when*; the round is which question this is. An `agent` action is
     * handed the log tagged as this action, so what its agent does lands between
     * these two lines; any other kind has no agent and writes nothing between.
     */
    const tag = `${step}:${action.name}`;
    const round = context.round ? ` · round ${context.round}` : "";

    /**
     * **One run of the action, and no retry** (`#234`).
     *
     * [0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §4 put
     * one here and it never once ran. The session id is a hash of
     * `<runId>:review:<action>:<sha>` (`agent-action.ts:356`, `sessionIdFor` at
     * `claude-code.ts:93`) and a second attempt moves none of the four, so the
     * retry computed the id attempt 1 had already opened a session with and
     * `claude` refused it in zero seconds: two retries on this machine's run
     * logs, both `Session ID … is already in use`, neither reaching a reviewer.
     * A retry could only help where attempt 1 died *before* opening a session,
     * and 0057's own subject is an agent that started — which opened one.
     *
     * So what a `did-not-finish` costs is 0057 §1–3 and nothing else, and
     * that is the half that works: no round (§2), no stand-down (§3), and the
     * pass reports it to a person. Whether to spend another agent on it is
     * [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
     * §3c's judge, not a constant in a loop here.
     */
    await emit({ type: "GateStarted", data: base });
    const started = Date.now();
    context.log?.note(tag, `started · ${action.kind} on ${context.onSha.slice(0, 7)}${round}`);

    let result: ActionResult;
    try {
      result = await action.run(context.log ? { ...context, log: taggedTrace(context.log, tag) } : context);
    } catch (err) {
      // An action that throws is an action that failed. The alternative is an
      // exception escaping the pipeline and a run ending with no verdict at all.
      result = {
        verdict: "failed",
        evidence: `the ${action.name} action threw: ${(err as Error).message}`,
        findings: [],
      };
    }
    context.log?.note(tag, `${result.verdict} · after ${elapsed(Date.now() - started)}${round}`);

    results.push({
      action: action.name,
      verdict: result.verdict,
      evidence: result.evidence,
      findings: result.findings,
    });

    if (result.verdict === "passed") {
      // Findings go on a pass as well as a refusal: a minor does not stop the
      // run, and a finding left only in `evidence` is one nothing can read (#135).
      await emit({
        type: "GatePassed",
        data: { ...base, evidence: result.evidence, findings: result.findings },
      });
      continue;
    }

    if (result.verdict === "never-ran") {
      // No verdict event, because there is no verdict: what is appended says
      // the step was reached and its agent never started. The pipeline stops
      // for the reason a refusal stops it and one it does not have — the actions
      // after this one would ask the same account the same question and meet
      // the same wall, which is 0031 §3 with a queue's worth of items replaced
      // by a recipe's worth of actions.
      await emit({ type: "GateNeverRan", data: { ...base, detail: result.evidence } });
      return {
        ok: false,
        failedAt: null,
        heldAt: null,
        neverRanAt: { action: action.name, detail: result.evidence },
        didNotFinishAt: null,
        results,
        skipped: actions.slice(index + 1).map((a) => a.name),
      };
    }

    if (result.verdict === "did-not-finish") {
      // The neighbouring absence, and no verdict event for the same reason: the
      // agent started, produced no receipt, and nothing judged the diff. One
      // event, because the action ran once — and it stops the pass rather than
      // the conductor, because a crash is local (0057 §3). `didNotFinishAt` is
      // a field rather than a sentence to be re-read.
      await emit({ type: "GateDidNotFinish", data: { ...base, detail: result.evidence } });
      return {
        ok: false,
        failedAt: null,
        heldAt: null,
        neverRanAt: null,
        didNotFinishAt: { action: action.name, detail: result.evidence },
        results,
        skipped: actions.slice(index + 1).map((a) => a.name),
      };
    }

    if (result.verdict === "needs-approval") {
      // Stops for the same reason a failure does — the actions after this one are
      // about a diff that is not going anywhere yet — but it is not a failure,
      // and the event says which.
      await emit({
        type: "ApprovalRequested",
        data: { ...base, question: result.evidence, artifacts: [] },
      });
      return {
        ok: false,
        failedAt: null,
        heldAt: action.name,
        neverRanAt: null,
        didNotFinishAt: null,
        results,
        skipped: actions.slice(index + 1).map((a) => a.name),
      };
    }

    await emit({
      type: "GateFailed",
      data: { ...base, evidence: result.evidence, findings: result.findings },
    });
    return {
      ok: false,
      failedAt: action.name,
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: null,
      results,
      skipped: actions.slice(index + 1).map((a) => a.name),
    };
  }

  return {
    ok: true,
    failedAt: null,
    heldAt: null,
    neverRanAt: null,
    didNotFinishAt: null,
    results,
    skipped: [],
  };
}

/** `4m27s`, `12s` — how long an action took, as the run log says it. */
function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
