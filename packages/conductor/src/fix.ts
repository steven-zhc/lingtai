/**
 * Whether a refusal at `proposed` buys an agent, what that agent is told, and
 * what a person is shown when the rounds are over.
 *
 * [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * is where this began and
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §2
 * is its present shape: **a point refuses, and the agent is sent back to the
 * same worktree with what refused it.**
 *
 *     a point refuses
 *       └── an agent fixes, given the evidence
 *             └── the whole point runs again
 *                   ├── passes → it lands
 *                   └── refuses → another round, or a person
 *
 * On 2026-09-10 there was nothing between *refused* and *your problem*, and the
 * three items that produced were the three whose fixes were least in doubt: a
 * swallowed `readFile` error rated `blocker`, with one obvious remedy, waiting on
 * the same queue as a judgement call. Severity measures how bad a defect is, not
 * how hard the judgement is.
 *
 * **Two shapes of refusal reach here and they are one flow** (0039 §2): a
 * reviewer's findings, and a command's output. They differ in what evidence they
 * carry and in the acceptance test that follows from it — nothing else. 0038 §2
 * let only the first in, on the reasoning that a refusal with no `findings`
 * field had no criterion to hold a fixer to. A red build has one, and a harder
 * one: *run it again; green is green.*
 *
 * **Beside `repair.ts` and not inside it**, because the two decisions differ in
 * every part except their shape:
 *
 *   `repair.ts`  a failure of the *merge lane*, after the worktree is gone. It
 *                buys the **next run**: record, release, and the next claim is
 *                the repair. `#142` is what removes that difference, and most of
 *                that file with it.
 *   here         a refusal at `proposed`, while the worktree is still there and
 *                the diff is still what everybody is talking about. It buys an
 *                agent **inside this pass**, and the point runs again.
 *
 * They now spend one ceiling, `runtime.limits.rounds` (0039 §3). 0038 §4 gave
 * them two because a shared one was a race — whichever failure happened first
 * decided whether the other got an attempt at all — and that was true only while
 * the two went to different places. They go to the same place now, which is why
 * the schema's default is two rather than one: a pass that fixes a red build and
 * then meets a finding has to be able to do both.
 *
 * Everything here is a decision and nothing here does I/O — the same reason
 * `repair.ts` is a module rather than a condition inline in `run-once.ts`. A rule
 * about spending money that lives inside an `if` in a 1,500-line file is a rule
 * nobody can check.
 */
import type { GateFinding } from "@lingtai/actions";
import type { BlockDiagnosis } from "@lingtai/domain";

/**
 * What a refusal handed the fixer, and which of the two shapes it is.
 *
 * **`findings` is a judgement, `output` is a machine's** — and the difference is
 * not the severity, it is who authored the criterion. A finding's acceptance
 * test is a sentence another agent wrote and a third agent will judge; a red
 * build's is *run it again, green is green*, which the thing being checked
 * cannot write for itself.
 */
export type FixOn = "findings" | "output";

export type FixDecision =
  | { fix: true; round: number; on: FixOn }
  /** `why` is a sentence for the card, naming the rule that refused. */
  | { fix: false; why: string };

export interface FixInput {
  /**
   * What the refused gate said.
   *
   * `findings` is the reviewer's, verbatim. `evidence` is what a `run:` action
   * printed — clipped by `command.ts` long before it reaches here — and is the
   * whole of what a red build has to offer.
   */
  refusal: { action: string; findings: readonly GateFinding[]; evidence: string };
  /** `runtime.limits.rounds`: how many times this pass may send the agent back. */
  rounds: number;
  /**
   * Rounds already spent on this run.
   *
   * **Held by the loop that spends them, not read back from the log**, and that
   * is sound because the two have the same extent: `rounds` is a ceiling *per
   * pass*, a pass is one `runOnce`, and one `runOnce` is one process. A counter
   * cannot outlive what it bounds.
   *
   * The property it therefore does not have: it is not recoverable. A conductor
   * that dies mid-round loses the count — and loses the run with it, because the
   * item is released and the next claim is a new run with a new id and, by the
   * same rule, a fresh purse. **Make `rounds` per item and this has to come from
   * the log.**
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
 * The first rule is the one that makes the loop safe to have at all, and
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §2
 * is why it is now written in two halves. **The bar is not "has findings", it is
 * "carries a criterion the fixer could not have authored"** — and there are two
 * ways to carry one:
 *
 *   a reviewer refused   each finding's `failureScenario`, written before
 *                        anybody knew what the fix would be, and judged again
 *                        by a third agent
 *   a command refused    its own output, and *run it again; green is green* —
 *                        machine-checked, and impossible for the code under
 *                        test to write for itself
 *
 * 0038 §2 refused the second outright, on the reasoning that a refusal with no
 * `findings` field had no acceptance criterion. **That mistook the field for the
 * criterion.** A red build has one and a harder one; what it does not have is a
 * sentence, and a sentence was never what made the guard work.
 *
 * The guard itself is unchanged where it applied. A gate that produced findings
 * is still held to them: if none of them carries a scenario, no fixer is bought,
 * because asking an agent to "address" an opinion is the unbounded rewriting
 * 0038 §2 is actually about. A gate that produced *no* findings is a command,
 * and is held to its output instead — a command that refused and printed
 * nothing buys nothing either, for the same reason in the other shape.
 */
export function decideFix(input: FixInput): FixDecision {
  const { refusal, rounds, roundsSpent } = input;
  const no = (why: string): FixDecision => ({ fix: false, why });

  // Which shape of refusal this is, decided by what the gate produced rather
  // than by the action's name: a `run:` action is a command whatever it is
  // called, and an `agent:` reviewer that returned nothing is not a reviewer.
  const actionable = refusal.findings.filter((f) => f.failureScenario.trim() !== "");
  const output = refusal.evidence.trim();
  const on: FixOn = refusal.findings.length > 0 ? "findings" : "output";

  if (on === "findings" && actionable.length === 0) {
    return no(
      `the ${refusal.action} action refused with findings but no failure scenario, ` +
        "and an opinion is not something an agent can be asked to make stop happening",
    );
  }

  if (on === "output" && output === "") {
    return no(
      `the ${refusal.action} action refused and printed nothing, so there is no ` +
        "output to make go green and nothing to hold a fixer to",
    );
  }

  if (rounds === 0) {
    return no(
      "this project's recipe sends every refusal straight to a person " +
        "(runtime.limits.rounds: 0)",
    );
  }

  if (roundsSpent >= rounds) {
    return no(
      `the ceiling of ${rounds} round(s) for this pass is spent, and the ` +
        `${refusal.action} action still refuses`,
    );
  }

  return { fix: true, round: roundsSpent + 1, on };
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
 *
 * **And it says the fixer may decline**
 * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
 * §5). The mechanism was always there — `run-once.ts`'s `if (!committed)` ends
 * the loop and hands a person the findings — and for a day this prompt pointed
 * the other way: *commit*, *an attempt that ends with advice produces nothing*,
 * and *if a finding is wrong say so in your final message*, which is not a
 * verdict anything reads. The one branch that carries an objection into the log
 * was the branch the prompt discouraged. An escape hatch nobody is told about is
 * not one, so `fix.test.ts` pins the sentence rather than trusting it to stay.
 */
export function fixBrief(input: {
  /**
   * What refused, and what it said.
   *
   * **The one argument that differs between the two prompts** (0039 §2). Not
   * two functions and not two flows: the header, the diff, the bound on the
   * change and the decline are the same words either way, and only the evidence
   * and the acceptance test turn on which shape this is.
   */
  refusal:
    | { on: "findings"; findings: readonly GateFinding[] }
    | { on: "output"; output: string };
  round: number;
  of: number;
  /** The refusing action's name, so the prompt can say who refused. */
  action: string;
  /** `base...head`, as the reviewer was shown it. */
  diff: string;
  /** `runtime.budget.diff`. The same ceiling the review runs under. */
  diffBytes: number;
}): string {
  const clipped =
    input.diff.length > input.diffBytes
      ? `${input.diff.slice(0, input.diffBytes)}\n\n[diff truncated at ${input.diffBytes} bytes]`
      : input.diff;

  const { evidence, criterion } =
    input.refusal.on === "findings"
      ? findingsHalf(input.refusal.findings, input.action)
      : outputHalf(input.refusal.output, input.action);

  return `# The ${input.action} action refused this change, and you are the fix

You are in the worktree the change was made in, at the commit that was checked.
This is fix round ${input.round} of ${input.of}.

**You are not given the implementer's reasoning.** No plan, no transcript, no
session. What you have is below, and the code in front of you.

${evidence}

## The change under review

\`\`\`diff
${clipped}
\`\`\`

${criterion}

- **Change nothing else.** Not the formatting, not the neighbouring function, not
  the thing you would have done differently. A diff wider than the refusal is a
  diff the review has to read again from scratch, and it is no longer the change
  anybody asked for.
- Add or tighten a test where a test is what would have caught it.

**Commit what you fix.** What the gates judge, and what a person may be asked to
approve, is a commit — an attempt that ends with advice about the code produces
nothing anyone can act on.

## If this is not yours to fix, change nothing and commit nothing

That is not giving up, and it is not a wasted round. **It is how your objection
reaches a person.** A round that ends with no new commit stops this loop and puts
the evidence in front of somebody, together with your final message — so say
plainly there what you are declining and why.

Decline when the refusal is wrong or is not this change's: the sequence a finding
describes cannot happen, or it does not happen here, or the failure was not
caused by this diff. **Never make the code worse to make the refusal go away.** A
fixer that rewrites working code to silence a false finding, or deletes a test to
make a build go green, is the failure this whole loop is most likely to produce,
and committing nothing is the move that exists so you never have to.`;
}

/**
 * A reviewer's refusal: the findings verbatim, and the question they will be
 * asked again.
 *
 * **Verbatim is the contract.** Each `failureScenario` was written before
 * anybody knew what the fix would be, and the re-review is asked whether those
 * sequences still produce those outcomes. Summarising one here would hand the
 * fixer a looser criterion than the one it will be held to, which is worse than
 * handing it none.
 */
function findingsHalf(
  findings: readonly GateFinding[],
  action: string,
): { evidence: string; criterion: string } {
  const items = findings.map((f, i) => {
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

  return {
    evidence: `A second agent read the diff cold — it had the ticket and the diff and
nothing else — and refused it. **You are not given that agent's reasoning
either**, only what it wrote down below.

## The findings

${items.join("\n\n")}`,
    criterion: `## What counts as done

The review runs again on what you commit, and it will be asked one question per
finding: **does that sequence still produce that outcome?** Those scenarios were
written before anybody knew what the fix would be, which is what makes them a
criterion you cannot author.

So:

- Make each sequence stop producing its outcome. Prove it to yourself the way
  the scenario is written — the inputs, the interleaving, the call order.
- **Deleting the line, renaming the symbol or suppressing the warning is not a
  fix.** The \`${action}\` reviewer is being asked about the sequence and not
  about its own sentence, so a finding whose text is gone and whose behaviour is
  not will be reported again, and removing a capability along with its defect is
  a new finding against you.`,
  };
}

/**
 * A command's refusal: its output, and the hardest acceptance test in the
 * system.
 *
 * **Nothing is summarised and nothing is diagnosed for it.** The output is what
 * the command printed, already clipped by `command.ts` to the recipe's budget,
 * and a prompt that said "the build failed because X" would be handing the fixer
 * one reading of the evidence instead of the evidence — the same mistake
 * `diagnoseRefusal` is careful not to make on a card.
 *
 * The acceptance test does not have to be written here at all, which is the
 * whole reason this shape is cheap: **the same point runs again.** `build`, then
 * `review`. Green is checked by the thing that went red, and the reviewer reads
 * whatever the fixer did to get there — which is what stops *delete the test*
 * from working, without this prompt having to be believed.
 */
function outputHalf(output: string, action: string): { evidence: string; criterion: string } {
  return {
    evidence: `## What \`${action}\` printed

\`\`\`
${output.trim()}
\`\`\``,
    criterion: `## What counts as done

The whole point runs again on what you commit — every action, in order, starting
from the first. **\`${action}\` has to go green, and everything after it has to
stay green.** That is a criterion no prose can loosen and you cannot author: it
is checked by running it.

So:

- Make \`${action}\` pass, for the reason it is failing. Read the output above
  rather than guessing from the diff.
- **Deleting the test, skipping it, or loosening the assertion is not a fix.**
  A review action runs after this one and reads your diff; a test that asserts
  less than it appears to is on its checklist, and arriving there having removed
  the thing that caught you is worse than arriving red.
- If the failure is not this change's — a flake, a broken dependency, something
  already failing on the base — **do not fix it here.** Say so and commit
  nothing; see below.`,
  };
}

/** How much of a declining fixer's last message a card can carry. */
const DECLINE_CHARS = 400;

/**
 * The sentence for a round that ended with no commit and no failure.
 *
 * **That is the decline** — the move `fixBrief` tells the fixer it has — and it
 * arrives at `run-once.ts` through the same `if (!committed)` branch a crashed
 * fixer does. What separates them there is `failure`; what separates them for a
 * person is this sentence, which says *declined* and then says what was said.
 *
 * The message is the whole objection, so dropping it would leave a person a
 * decline with no reason in it, which is barely better than the refusal it
 * replaced. It is clipped because a card is read, not scrolled: the untruncated
 * message is in the run log and in the agent's own transcript.
 */
export function declineWhy(text: string | null): string {
  const said = (text ?? "").trim();
  const body =
    "the fixing agent declined — it committed nothing, which is how it says these " +
    "findings are not this diff's to answer";
  if (said === "") return `${body}, and it gave no reason`;
  const clipped = said.length > DECLINE_CHARS ? `${said.slice(0, DECLINE_CHARS)}…` : said;
  return `${body}. It said: ${clipped}`;
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

/**
 * What a person is shown when the rounds are over and a **command** still
 * refuses.
 *
 * Sibling of `diagnoseDisagreement`, and separate from it on purpose. 0038 kept
 * a red build out of that shape by keeping it out of the loop entirely; 0039 §2
 * lets it in, and the thing that must not follow is describing a typecheck error
 * as *two agents disagreed*. **One is a judgement nobody could settle
 * mechanically; the other is a fact that stayed true.** A person reading the
 * first is being asked to decide something. A person reading this one is being
 * told the machine checked, N times, and it is still red.
 *
 * No recommendation, for `diagnoseRefusal`'s reason: merging over a red build is
 * a call only a person makes, and a default here would be making it for them.
 */
export function diagnoseUnfixed(input: {
  action: string;
  branch: string;
  headSha: string;
  /** What the command last printed, still failing. */
  evidence: string;
  /** Rounds of fix-and-recheck that were spent. Zero when none was bought. */
  rounds: number;
  /** Why no further fixer was bought, in `decideFix`'s own words. */
  why: string;
}): BlockDiagnosis {
  return {
    what:
      `\`${input.action}\` still refuses ${input.branch} at ${input.headSha.slice(0, 7)}. ` +
      "This is a check that failed and stayed failed, not a judgement: whatever it " +
      "runs, it ran again and said the same thing.",
    done:
      (input.rounds === 0
        ? "No fixing agent ran. "
        : `${input.rounds} round(s) of fix-and-recheck ran, and the action refused what they produced. `) +
      `No further agent was bought: ${input.why}`,
    // The output verbatim. It is already clipped to the recipe's budget by the
    // action that produced it, and clipping a clipping is how evidence becomes
    // a summary of itself.
    raw: input.evidence.trim() === "" ? null : input.evidence,
    recommendation: null,
  };
}

/** The card's one line, for a command that stayed red. */
export function unfixedQuestion(input: {
  action: string;
  branch: string;
  base: string;
  rounds: number;
}): string {
  return (
    `${input.action} still refuses ${input.branch} into ${input.base} after ` +
    `${input.rounds} fix round(s)`
  );
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
