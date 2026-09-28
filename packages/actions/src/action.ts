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
 * arithmetic — `stepsOn()` in `@lingtai/domain` simply stops returning it. In
 * the old system approval was a label, and a label survives any amount of
 * rewriting.
 *
 * Six kinds of action produce a verdict — `run`, `agent`, `watch`, `human`,
 * `worktree`, `merge` — and all six are implemented. `run` and `human` need
 * nothing from the caller; `agent` needs a reviewer, `watch` needs the diff's
 * file list, `worktree` needs the cut and `merge` needs the lane, and
 * `conduct.ts` supplies all four. A kind whose dependency is missing is refused
 * by name rather than skipped — see `from-recipe.ts`. The pipeline, the events
 * and `onSha` are the same for all six.
 *
 * **`worktree` is the one that makes rather than judges**, and it is why
 * `ActionResult` carries a `head`: `admit` is where the tree is cut, so it is
 * where `onSha` gets a value at all
 * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §2, `#268`).
 *
 * **`merge` is the one whose *no* is not the pipeline's**, and it is why
 * `ActionResult` carries a `because`: the lane's `conflict` and `verify-failed`
 * are directions a judge routes on, and every other refusal is *something the
 * recipe declared said no* (0065 §2, `#270`).
 *
 * `close` and `labels` are the other two kinds. They are effects rather than
 * verdicts, they only run at `end`, and they never reach this interface.
 */
import { taggedTrace, type RunTrace } from "@lingtai/agent/run-log";
import type { Step, PayloadOf, RefusedAbout, Severity } from "@lingtai/domain";

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
 * What it means for the run is `conduct.ts`'s: the conductor stands down and
 * the item goes back to the queue, exactly as 0031 §3 decided for a run.
 *
 * **`did-not-finish` is a fifth, and it is the neighbour `never-ran` does not
 * cover** ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md)).
 *
 * An `agent` action that *started* and ended with no receipt — a crash, a
 * timeout, a turn budget spent without an answer — judged nothing either, and
 * for months it said so only inside the `evidence` string while returning
 * `failed`. So the conductor bought a fix round for it and an agent was paid to
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
  /**
   * **Where this action left the worktree**, and absent on every kind that only
   * judged one (0065 §2, `#268`).
   *
   * One action produces it — the `worktree` kind, at `admit` — and it is on the
   * result rather than inferred by the caller because the caller runs no git:
   * `LeftTheTreeAt` in `packages/conductor/src/pass.ts` is the same field one
   * layer up, and the step that moved the tree is the only thing that knows.
   *
   * It is not the head a verdict is *about* — that is `ActionContext.onSha`, and
   * for this action it is the base the pass arrived carrying.
   */
  head?: string;
  /**
   * **Why this action said no, in its own machine-readable word** — and absent on
   * every kind whose *no* means nothing more than *no* (0065 §2, `#270`).
   *
   * One action produces it — the `merge` kind, at `merge` — and it is on the
   * result rather than derived by the caller because the caller runs no git:
   * `conflict` and `verify-failed` are the lane's own words, they are already on
   * the log as `RefusalReason`, and `directionOf` in
   * `packages/conductor/src/pass.ts` routes on them. The pipeline knows only that
   * *something the recipe declared refused* and `endingOf` spells that
   * `action-refused`, which is right for the other five kinds and would lose the
   * direction for this one.
   *
   * Never a substitute for `evidence`. That is the words a person reads (0043);
   * this is the token a judge reads, and 0058 §3c asks for both.
   */
  because?: string;
  /**
   * **This action's answer could not be read at all** — absent on every kind that
   * has no answer to read, and on an `agent` whose answer parsed (`#279`).
   *
   * One kind produces it, the `agent` kind, and it is `parseFindings`'s own
   * `parsed` flag arriving where the decision is made. *Could not read it* and
   * *read it, it was empty* both left this interface as `findings: []`, so
   * `carriesACriterion` one layer up said *nothing an agent could be held to*
   * about an answer that had four findings in it and was one closing brace short
   * of valid JSON (`#269` attempt 3, $8.97). The sentence was true of what it was
   * handed and false about what happened, which is why it read as ordinary.
   *
   * Like `because`, it is a token rather than the prose: `evidence` has said *the
   * reviewer's answer was not readable as findings* since the branch was written,
   * and a sentence is not something a router reads.
   *
   * **It buys nothing.** An unreadable answer is not a criterion (0038 §2), so
   * what this changes is which sentence a person is shown and what the log says —
   * never whether a round is spent.
   */
  unreadable?: true;
  /**
   * **Which of the two kinds of refusal this is, in the action's own word** —
   * `lines` or `approach` (`REFUSED_ABOUT`), and absent on every result that did
   * not classify one (`#293`, and `#223` is what it is for).
   *
   * One kind produces it, the `agent` kind, on a refusal: the reviewer answers
   * `about` beside its findings, `parseFindings` takes it only when it is one of
   * the two words, and this is where it arrives. It is a sibling of `unreadable`
   * in every way that matters — the adapter's own classification of its refusal,
   * a token rather than the prose, never re-derived by a caller from `evidence`
   * or from the findings' text (0031 §1).
   *
   * **It buys nothing and routes nothing, on purpose.** `#223` wants `lines` to
   * buy a fix round and `approach` to buy a restart, and the number that decides
   * whether that branch is worth having does not exist: five review refusals on
   * 2026-09-27/28 all looked like `lines` by eye. So the classification is
   * recorded and no pass reads it, and the branch is designed against a rate
   * rather than against a guess.
   *
   * **Absent is a third state and must stay one.** A reviewer that has not been
   * updated says nothing, and a seam that read that as `lines` would make the
   * count this field exists for a count of its own default.
   */
  about?: RefusedAbout;
  /**
   * **The document a `design:` agent wrote** — absent on every kind that judged
   * something rather than producing one (0065 §2, `#265`).
   *
   * One action produces it — the `agent` kind at `design` — and it is on the
   * result rather than parsed back out of `evidence` because `evidence` is what
   * the board shows (0043), and a caller reading a document out of a display
   * string is the second reader of a sentence 0031 §1 exists to prevent. It is
   * the same shape `head` has at `admit`: the one action that *makes* the thing
   * the next step needs is the only thing that knows it, so it says so, and
   * `designFrom` in `packages/conductor/src/pass.ts` carries it onto the step's
   * ending for `implement`'s brief to read.
   *
   * **`""` is a document and not an absence.** *The agent answered that this
   * change needs no design* and *nothing here drafts* are the same brief to
   * `implement` — it works from the issue either way (0058 §3) — so the empty
   * string is set rather than the key omitted, and the distinction that is worth
   * keeping is on `evidence`, where a person reads it.
   */
  document?: string;
}

/**
 * **The step asked a question, and a judge is what answers it** (0058 §3c).
 *
 * `ActionResult.because` spelled this on a `did-not-finish`, which is the one
 * ending that may reach the router: *an agent started and left no receipt* and
 * *an agent stopped to ask* are the same verdict and cost different money, and a
 * caller reading a field rather than a sentence is 0031 §1 again.
 *
 * It lives here rather than in `pass.ts` because the action produces it and the
 * pass reads it, and a second definition of one token is the drift
 * `worktree-action.ts` names. `pass.ts` re-exports this name.
 */
export const NEEDS_INPUT = "needs-input";

/**
 * **Why a step is being run a second time** — or `null`, which is every visit on
 * the way through.
 *
 * The whole of what makes a re-run different from the first run when the round
 * was bought on a question or on what a step printed. An action that writes code
 * hands it to its agent beside the ticket — *you asked this, and the judge said
 * that*, or *`build` printed this* — and one that ignores it dispatches the brief
 * that produced the failure.
 *
 * It is computed from the visit list rather than remembered, in `pass.ts`, and
 * arrives here because the agent buying the round is a plugin since `#266`.
 */
export interface SentBack {
  /** The judge's own words for why it sent the pass back here. */
  readonly why: string;
  /** What this step asked the first time, where it asked anything. */
  readonly asked: string | null;
  /** What the refusing step printed, where the round was not bought on a question. */
  readonly printed: { readonly step: Step; readonly detail: string } | null;
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
  /**
   * **What `design` drafted**, and `""` where it drafted nothing (`#266`).
   *
   * On the context rather than on a spec for `recheck`'s reason: it is a fact
   * about *this run of the pipeline* and not about the action the recipe wrote.
   * `designFrom` in `packages/conductor/src/pass.ts` is what puts it here, off
   * the `design` step's own visit — so the one action that writes code reads what
   * the one action that writes a document produced, without either knowing the
   * other exists.
   *
   * **`""` is a document and not an absence** (`ActionResult.document`): an agent
   * that answered *this change needs no design* and a step that drafts nothing
   * are one brief, because the ticket is what it works from either way.
   */
  design?: string;
  /**
   * **Why this step is being run a second time**, or `null` on the way through.
   *
   * `recheck`'s neighbour and not its duplicate: `recheck` is the findings a
   * round was bought on, and this is what the judge said and what the step asked
   * — the two shapes a round can be bought in that no finding carries.
   */
  again?: SentBack | null;
  log?: RunTrace;
  signal?: AbortSignal;
}

export interface Action {
  readonly name: string;
  /**
   * Which action shape produced it: `run`, `agent`, `watch`, `human`, `worktree`,
   * `queue` or `merge`.
   */
  readonly kind: "run" | "agent" | "watch" | "human" | "worktree" | "queue" | "merge";
  run(context: ActionContext): Promise<ActionResult>;
}

/** Emitted for every action, in order. The pipeline's whole output is events. */
export type ActionEvent =
  | { type: "StepRequested"; data: PayloadOf<"StepRequested"> }
  | { type: "StepStarted"; data: PayloadOf<"StepStarted"> }
  | { type: "StepPassed"; data: PayloadOf<"StepPassed"> }
  | { type: "StepFailed"; data: PayloadOf<"StepFailed"> }
  /** The step was reached and produced no verdict, because its agent never
   *  started. Appended so that an action which did not judge is readable as that
   *  rather than as one still running. */
  | { type: "StepNeverRan"; data: PayloadOf<"StepNeverRan"> }
  /** The step was reached, its agent started and ended with no receipt, so
   *  nothing judged the diff. Appended once, because the action is run once
   *  (0057 §1, and §4's retry deleted by `#234`). */
  | { type: "StepDidNotFinish"; data: PayloadOf<"StepDidNotFinish"> }
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
  didNotFinishAt: { action: string; detail: string; because?: string } | null;
  /**
   * Every verdict, with the findings behind it.
   *
   * `findings` is carried here rather than left on the `StepFailed` event
   * because the caller acts on it: a refusal with findings buys a fixing agent
   * (0038 §1), and reading the log back to discover what the action it just ran
   * said would be a second source of truth for the same sentence.
   */
  results: {
    action: string;
    verdict: ActionVerdict;
    evidence: string;
    findings: ActionFinding[];
    /** Where the action left the worktree, where it moved it. `ActionResult.head`. */
    head?: string;
    /** Its own word for why it said no, where it has one. `ActionResult.because`. */
    because?: string;
    /** That its answer could not be read, where it had one. `ActionResult.unreadable`. */
    unreadable?: true;
    /** Which kind of refusal it said this was, where it said. `ActionResult.about`. */
    about?: RefusedAbout;
    /** The document it wrote, where it wrote one. `ActionResult.document`. */
    document?: string;
  }[];
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
    // `step:` is the **event payload's** field and stays that spelling until the
    // log's own vocabulary is renamed — it carries the step, and `action` beside
    // it carries this action's name.
    const base = { step: step, action: action.name, runId: context.runId, onSha: context.onSha };

    await emit({ type: "StepRequested", data: base });

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
    await emit({ type: "StepStarted", data: base });
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
      // Spread rather than assigned, so *the tree did not move* reaches the
      // caller as an absent key and not as an explicit `undefined`: `endingOf`
      // reads it with `!== undefined` and `LeftTheTreeAt` is optional for the
      // same reason.
      ...(result.head === undefined ? {} : { head: result.head }),
      // Spread for `head`'s reason, read by `becauseFrom` in `pass.ts` with the
      // same `?? "action-refused"` fallback: an explicit `undefined` would be a
      // kind claiming to have a word for its refusal and then not having one.
      ...(result.because === undefined ? {} : { because: result.because }),
      // Spread for `head`'s reason again, and the event below carries it the same
      // way: *absent* is what says an action had no answer to read, and an
      // explicit `undefined` would read the same to a program and differently to
      // a person (`#279`).
      ...(result.unreadable === undefined ? {} : { unreadable: result.unreadable }),
      // Spread for `head`'s reason a third time, and here *absent* is the whole
      // value: a reviewer that did not classify its refusal and one that said
      // `lines` must never fold into the same row, because the only thing this
      // field is for is being counted (`#293`).
      ...(result.about === undefined ? {} : { about: result.about }),
      // Spread for `head`'s reason once more, and here the absence is the one
      // that matters: *nothing at this step drafted* and *the draft was empty*
      // are different facts, and `designFrom` in `pass.ts` distinguishes them by
      // the key rather than by the string (`#265`).
      ...(result.document === undefined ? {} : { document: result.document }),
    });

    if (result.verdict === "passed") {
      // Findings go on a pass as well as a refusal: a minor does not stop the
      // run, and a finding left only in `evidence` is one nothing can read (#135).
      await emit({
        type: "StepPassed",
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
      await emit({ type: "StepNeverRan", data: { ...base, detail: result.evidence } });
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
      await emit({ type: "StepDidNotFinish", data: { ...base, detail: result.evidence } });
      return {
        ok: false,
        failedAt: null,
        heldAt: null,
        neverRanAt: null,
        // **The action's own word where it has one**, exactly as `failedAt` takes
        // one from the `merge` kind: *the agent stopped to ask* is a
        // `did-not-finish` that may reach the router, and *it left no receipt* is
        // one that may not (`NEEDS_INPUT`, `endingOf` in `pass.ts`).
        didNotFinishAt: {
          action: action.name,
          detail: result.evidence,
          ...(result.because === undefined ? {} : { because: result.because }),
        },
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
      type: "StepFailed",
      data: {
        ...base,
        evidence: result.evidence,
        findings: result.findings,
        // The one refusal that is not about the diff's contents but about whether
        // the answer could be read at all (`#279`). Absent where it could.
        ...(result.unreadable === undefined ? {} : { unreadable: result.unreadable }),
        // And, where the action said so, which kind of refusal it is (`#293`).
        // On the event rather than only on `results` because the question it
        // answers is asked of a fortnight of passes, and `results` is memory:
        // a run log would do for one pass and is deleted when the item lands
        // (0034), so the rate has to be a fold over `events` or it is a guess.
        ...(result.about === undefined ? {} : { about: result.about }),
      },
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
