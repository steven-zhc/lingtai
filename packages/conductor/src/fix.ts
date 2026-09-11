/**
 * Whether a refused review buys an agent, what that agent is told, and what a
 * person is shown when two of them cannot agree.
 *
 * [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * is the decision this file implements. Its shape, in one line: **a gate's
 * refusal is a failure 0025 did not count** —
 *
 *     review refuses
 *       └── an agent fixes, given the findings
 *             └── review runs again
 *                   ├── passes → it lands
 *                   └── refuses → a person
 *
 * On 2026-09-10 there was nothing between *refused* and *your problem*, and the
 * three items that produced were the three whose fixes were least in doubt: a
 * swallowed `readFile` error rated `blocker`, with one obvious remedy, waiting on
 * the same queue as a judgement call. Severity measures how bad a defect is, not
 * how hard the judgement is.
 *
 * **Beside `repair.ts` and not inside it**, because the two decisions differ in
 * every part except their shape:
 *
 *   `repair.ts`  a failure of the *merge lane*, after the worktree is gone. It
 *                buys the **next run**: record, release, and the next claim is
 *                the repair.
 *   here         a refusal at `proposed`, while the worktree is still there and
 *                the diff is still what everybody is talking about. It buys an
 *                agent **inside this run**, and the gates run again.
 *
 * They also spend different purses, which is 0038 §4 and the reason `fix` is its
 * own recipe key: `repair.maxAttempts` is documented as the ceiling *across every
 * distinct failure*, so a broken build that spent it left a one-line finding with
 * nothing left to buy an agent with. One ceiling for two kinds of failure is not
 * a budget, it is a race.
 *
 * Everything here is a decision and nothing here does I/O — the same reason
 * `repair.ts` is a module rather than a condition inline in `run-once.ts`. A rule
 * about spending money that lives inside an `if` in a 1,500-line file is a rule
 * nobody can check.
 */
import type { GateFinding } from "@lingtai/actions";
import type { BlockDiagnosis } from "@lingtai/domain";

/** What the recipe says about fixing a refusal. See `Recipe.repair`. */
export interface FixPolicy {
  on: boolean;
  /** Rounds of fix-and-re-review a refusal buys. `repair.fix`. */
  fix: number;
}

export type FixDecision =
  | { fix: true; round: number }
  /** `why` is a sentence for the card, naming the rule that refused. */
  | { fix: false; why: string };

export interface FixInput {
  /** What the refused gate said. `findings` is the reviewer's, verbatim. */
  refusal: { action: string; findings: readonly GateFinding[] };
  policy: FixPolicy;
  /**
   * Rounds already spent on this run.
   *
   * **Held by the loop that spends them, not read back from the log**, and that
   * is sound because the two have the same extent: `repair.fix` is a ceiling
   * *per run*, a run is one `runOnce`, and one `runOnce` is one process. A
   * counter cannot outlive what it bounds.
   *
   * The property it therefore does not have: it is not recoverable. A conductor
   * that dies mid-round loses the count — and loses the run with it, because the
   * item is released and the next claim is a new run with a new id and, by the
   * same rule, a fresh purse. That is the same shape `repair.maxAttempts` has
   * per item, and it is only correct while `fix` stays per run. **Make it per
   * item and this has to come from the log.**
   */
  roundsSpent: number;
}

/**
 * Whether this refusal buys an agent.
 *
 * **Every rule that can refuse is here, in order, and each names itself**, as in
 * `decideRepair` — the first refusal wins, so the sentence on the card is the
 * most fundamental reason and not the last one checked.
 *
 * The first rule is the one that makes the loop safe to have at all.
 * **No failure scenario, no fixer.** It is the rubric's own bar used a second
 * way: a finding with a concrete failure scenario determines its own fix — make
 * that sequence stop producing that outcome — and a refusal with no findings is
 * not a judgement an agent can be asked to answer. That is what a `run:` action
 * refusing looks like: a red build carries no findings, reaches the merge lane,
 * and is the repair purse's business. Asking a fixer to "address" a typecheck
 * failure with no scenario to hold it to would be exactly the unbounded
 * rewriting 0038 §2 is about.
 */
export function decideFix(input: FixInput): FixDecision {
  const { refusal, policy, roundsSpent } = input;
  const no = (why: string): FixDecision => ({ fix: false, why });

  const actionable = refusal.findings.filter((f) => f.failureScenario.trim() !== "");
  if (actionable.length === 0) {
    return no(
      `the ${refusal.action} action refused without findings, and a refusal with no ` +
        "failure scenario is not something an agent can be asked to make stop happening",
    );
  }

  if (!policy.on) {
    return no("this project's recipe says it does not repair (repair.on: false)");
  }

  if (policy.fix === 0) {
    return no(
      "this project's recipe buys no rounds of fix-and-re-review (repair.fix: 0) — " +
        "a review's findings are read by a person here",
    );
  }

  if (roundsSpent >= policy.fix) {
    return no(
      `the ceiling of ${policy.fix} fix round(s) for this item is spent, and the ` +
        "review still refuses",
    );
  }

  return { fix: true, round: roundsSpent + 1 };
}

/**
 * What the fixing agent is told, as its whole prompt.
 *
 * **Findings and the diff, and not the reasoning** (0038 §3). Not the
 * implementer's plan, transcript or session —
 * [experiment 001](../../../doc/experiments/001-cold-review-issue-58.md) is
 * about exactly that, and a fixer handed the reasoning that produced the defect
 * inherits the reasoning that produced the defect. It is not even given the
 * ticket: the task is not *do this work well*, it is **make these sequences stop
 * happening and change nothing else**, and bounded is what makes it cheap.
 *
 * **The diff is quoted, and not left to the filesystem.** The agent does run in
 * the worktree at the head the findings were made against, so it could derive
 * one — but only by guessing where the change starts, which is the sort of
 * guess that ends with a fixer reading `HEAD~1` on a three-commit branch. The
 * reviewer was shown the diff against the base; so is this, under the same
 * `runtime.budget.diff` ceiling (0029), because the two agents arguing about a
 * change should be looking at the same change.
 *
 * **Verbatim is the contract.** Each `failureScenario` was written before
 * anybody knew what the fix would be, and the re-review is asked whether those
 * sequences still produce those outcomes. Summarising one here would hand the
 * fixer a looser criterion than the one it will be held to, which is worse than
 * handing it none.
 */
export function fixBrief(input: {
  findings: readonly GateFinding[];
  round: number;
  of: number;
  /** The reviewer's name, so the prompt can say who refused. */
  action: string;
  /** `base...head`, as the reviewer was shown it. */
  diff: string;
  /** `runtime.budget.diff`. The same ceiling the review runs under. */
  diffBytes: number;
}): string {
  const items = input.findings.map((f, i) => {
    const at = f.line === null ? f.file : `${f.file}:${f.line}`;
    return [
      `### ${i + 1}. ${f.severity} · ${at}`,
      "",
      f.claim,
      "",
      "The failure scenario, which is the acceptance criterion, verbatim:",
      "",
      "```",
      f.failureScenario.trim(),
      "```",
    ].join("\n");
  });

  const clipped =
    input.diff.length > input.diffBytes
      ? `${input.diff.slice(0, input.diffBytes)}\n\n[diff truncated at ${input.diffBytes} bytes]`
      : input.diff;

  return `# A review refused this change, and you are the fix

You are in the worktree the change was made in, at the commit that was reviewed.
A second agent read the diff cold — it had the ticket and the diff and nothing
else — and refused it at the \`${input.action}\` action. This is fix round
${input.round} of ${input.of}.

**You are not given that agent's reasoning, and you are not given the
implementer's.** No plan, no transcript, no session. What you have is below, and
the code in front of you.

## The findings

${items.join("\n\n")}

## The change under review

\`\`\`diff
${clipped}
\`\`\`

## What counts as done

The review runs again on what you commit, and it will be asked one question per
finding: **does that sequence still produce that outcome?** Those scenarios were
written before anybody knew what the fix would be, which is what makes them a
criterion you cannot author.

So:

- Make each sequence stop producing its outcome. Prove it to yourself the way
  the scenario is written — the inputs, the interleaving, the call order.
- **Deleting the line, renaming the symbol or suppressing the warning is not a
  fix.** The reviewer is being asked about the sequence and not about its own
  sentence, so a finding whose text is gone and whose behaviour is not will be
  reported again, and removing a capability along with its defect is a new
  finding against you.
- **Change nothing else.** Not the formatting, not the neighbouring function, not
  the thing you would have done differently. A diff wider than the findings is a
  diff the review has to read again from scratch, and it is no longer the change
  anybody asked for.
- Add or tighten a test where a test is what would have caught it.

**Commit.** What the gates judge and what a person may be asked to approve is a
commit; an attempt that ends with advice produces nothing anyone can act on. If a
finding is wrong — if the sequence it describes cannot happen — say so plainly in
your final message and **do not change the code to silence it**. A fixer that
rewrites working code to make a false finding go away is the failure this whole
loop is most likely to produce.`;
}

/**
 * What a person is shown when the rounds are over and the review still refuses.
 *
 * **It says two agents disagreed, not that a gate refused**, and that is 0038's
 * consequence rather than a nicety: the thing arriving at a queue is no longer a
 * finding, it is *two agents looked at this and did not agree*, which is a
 * judgement in a way a swallowed `readFile` is not. A card that said "the review
 * gate refused" would be describing the first half of something that has since
 * happened twice.
 *
 * Shaped like `diagnoseRefusal`'s answer for the same reason it exists: *what*
 * happened, what was *done* about it — including the decline, because a card
 * must be able to say why no further agent was bought — and the evidence
 * verbatim. No recommendation: approving over a live finding is the one
 * judgement nothing but a person should make, and a default here would be
 * picking for them.
 */
export function diagnoseDisagreement(input: {
  action: string;
  branch: string;
  base: string;
  headSha: string;
  /** What the reviewer last said, still live. */
  findings: readonly GateFinding[];
  /** Rounds of fix-and-re-review that were spent. Zero when none was bought. */
  rounds: number;
  /** Why no further fixer was bought, in `decideFix`'s own words. */
  why: string;
}): BlockDiagnosis {
  const worst = severest(input.findings);
  return {
    what:
      `Two agents disagreed about ${input.branch} at ${input.headSha.slice(0, 7)}. ` +
      `The \`${input.action}\` reviewer refused it with ${count(input.findings)} ` +
      `(worst: ${worst}), and it is still refused. This is a judgement, not a broken build.`,
    done:
      (input.rounds === 0
        ? "No fixing agent ran. "
        : `${input.rounds} round(s) of fix-and-re-review ran, and the review refused what they produced. `) +
      `No further agent was bought: ${input.why}`,
    // The findings verbatim, including every failure scenario. This is the
    // evidence the sentence above is a reading of, and a reading that hides what
    // it was made from is worse than the output (#83).
    raw: input.findings.length === 0 ? null : quoteFindings(input.findings),
    recommendation: null,
  };
}

/** The card's one line. Says what it is rather than which gate said it. */
export function disagreementQuestion(input: {
  action: string;
  branch: string;
  base: string;
  findings: readonly GateFinding[];
  rounds: number;
}): string {
  return (
    `two agents disagreed about ${input.branch} into ${input.base}: the ` +
    `${input.action} reviewer still refuses it after ${input.rounds} fix round(s), ` +
    `with ${count(input.findings)} (worst: ${severest(input.findings)})`
  );
}

/** The findings, whole — severity, place, claim and scenario, nothing dropped. */
export function quoteFindings(findings: readonly GateFinding[]): string {
  return findings
    .map((f) => {
      const at = f.line === null ? f.file : `${f.file}:${f.line}`;
      return [`[${f.severity}] ${at} — ${f.claim}`, "", f.failureScenario.trim()].join("\n");
    })
    .join("\n\n---\n\n");
}

function count(findings: readonly GateFinding[]): string {
  return findings.length === 1 ? "one finding" : `${findings.length} findings`;
}

/** The highest severity present, by the rubric's own order. */
function severest(findings: readonly GateFinding[]): string {
  for (const severity of ["blocker", "major", "minor"] as const) {
    if (findings.some((f) => f.severity === severity)) return severity;
  }
  return "none";
}
