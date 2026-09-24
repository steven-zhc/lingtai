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
 *                   └── refuses → another round, or `restart.ts`
 *
 * **What happens when the rounds are over is no longer only a person**
 * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
 * `decideRestart` gets the refusal first and may hand the ticket back to the
 * queue for a fresh pass instead; the two diagnoses below are what a person is
 * shown once *that* ceiling is spent too, or immediately, which is every
 * project whose recipe leaves `restarts` at its default of zero.
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
import type { ActionFinding } from "@lingtai/actions";
import { SEVERITIES, type Severity } from "@lingtai/domain";
import type { BlockDiagnosis, RunFailureKind } from "@lingtai/domain";

/**
 * What a refusal handed the fixer, and which of the two shapes it is.
 *
 * **`findings` is a judgement, the other two are a machine's** — and the
 * difference is not the severity, it is who authored the criterion. A finding's
 * acceptance test is a sentence another agent wrote and a third agent will
 * judge; a red build's is *run it again, green is green*, and a conflict's is
 * *the merge succeeds and the build stays green* — neither of which the thing
 * being checked can write for itself.
 *
 * `conflict` is the merge lane's, and it is the one that has to be told rather
 * than inferred: it arrives looking exactly like a red build — no findings,
 * some output — and only the caller knows which it is.
 */
export type FixOn = "findings" | "output" | "conflict";

/**
 * Which rule refused, as something other than prose.
 *
 * `why` is a sentence and has to stay one — it is read on a card. This is for a
 * caller that has to **decide** on the refusal, and `#146` is the caller that
 * does: `runtime.limits.restarts` buys a second approach when the *ceiling* is
 * what stopped this one, and must not when the refusal carried no criterion,
 * because that is a gate with nothing to hold anybody to and starting over
 * answers none of it.
 *
 * Matching on the sentence would have worked and would have made every edit to
 * the wording a change to what money is spent — which is the shape this
 * repository keeps finding, one level up: a claim that was true where it was
 * written and is load-bearing somewhere it cannot be seen.
 */
export type FixRule = "no-criterion" | "no-rounds" | "spent";

/**
 * What ended the fix loop, as something other than prose.
 *
 * `FixRule` is only half of it: it says why no *further* round was bought, and
 * two of the endings never reach `decideFix` at all. A round that ran and whose
 * agent died, and a round that ran and whose agent objected, both arrive at
 * `run-once.ts`'s `if (!committed)` — where 0039 §5 already tells them apart for
 * the sentence underneath and, until `#197`, for nothing else.
 *
 * **The headline is the thing that needed this** (`#197`). A person shown a
 * blocked item reads one sentence and acts on it, and the endings ask for
 * different actions: adjudicate, send it again, narrow the ticket, read the
 * objection, look at the reviewer, raise the ceiling. `#187` ended on a rate
 * limit two minutes before it reset and opened with *This is a judgement, not a
 * broken build*, which is the one thing it was not — the round answering those
 * findings never finished, so nothing had been decided for anybody to
 * adjudicate.
 *
 * **The ending is not the failure kind, it is the move it implies.** The
 * runtime's five kinds collapse to two here and the line between them is
 * `attribution.ts`'s `RUN_OWNER`: `crash`, `timeout` and `aborted` are Lingtai's
 * and the ticket is coming back, so the remedy is to send it again;
 * `out-of-turns` is the *repository's* and the remedy is the opposite one, which
 * is why it is its own ending rather than a sixth way of saying *crashed*.
 * (`never-started` never arrives — `run-once.ts` stands the conductor down on it
 * before the loop can block.)
 *
 * Carried rather than matched out of `why` for `FixRule`'s own reason: a
 * sentence written for a card must not be load-bearing somewhere it cannot be
 * seen.
 */
export type FixStop =
  /** `decideFix` bought no further round, and this is the rule that refused. */
  | { ended: FixRule }
  /**
   * A round ran and something that is not the ticket stopped its agent —
   * `crash`, `timeout`, `aborted`. `failure` is the outcome's `kind: detail`, so
   * the headline can name what stopped it rather than only that something did,
   * and so that *crashed* is never asserted of a run the wall clock ended.
   */
  | { ended: "crashed"; failure: string }
  /**
   * A round ran and its agent reached the recipe's turn limit.
   *
   * Its own ending because it is the one run failure this repository calls the
   * **repository's** (`attribution.ts`'s `RUN_OWNER`), and because the sentence
   * it has already decided on is the negation of the crash's: *the ticket was
   * scoped wrong — which no retry of the same ticket answers* (`run-once.ts`'s
   * `out-of-turns` block, `#89`). Told to send it again, a person buys another
   * run to the same limit.
   */
  | { ended: "out-of-turns"; failure: string }
  /** A round ran and its agent objected by committing nothing (0039 §5). */
  | { ended: "declined" };

/**
 * Which ending each of the runtime's failure kinds is.
 *
 * **A total record rather than "everything that is not `never-started`"**, for
 * `RUN_OWNER`'s reason and with `#197` as the receipt for what a default costs:
 * `out-of-turns` was flattened into the crash's ending, and the card told a
 * person to send again a ticket this repository had already decided sending
 * again does not answer. A seventh `RunFailureKind` will not compile until
 * somebody says which sentence it gets.
 *
 * Read the rows against `attribution.ts`'s `RUN_OWNER`: the four Lingtai owns
 * are the ones the queue answers by running it again, and the one the
 * repository owns is the one it does not.
 *
 * `never-started` has a row because the record is total; it never arrives,
 * because `run-once.ts` stands the conductor down on it before the fix loop can
 * block anything.
 */
const STOP_OF: Record<RunFailureKind, "crashed" | "out-of-turns"> = {
  crash: "crashed",
  timeout: "crashed",
  aborted: "crashed",
  "no-commits": "crashed",
  "never-started": "crashed",
  "out-of-turns": "out-of-turns",
};

/**
 * What a fixing round's failure ended the loop as.
 *
 * `failure` stays `kind: detail` — the kind is carried in the words a person
 * reads rather than beside them, so no headline has to name a kind itself and
 * none of them can name the wrong one.
 */
export function fixStopOf(failure: { kind: RunFailureKind; detail: string }): FixStop {
  return { ended: STOP_OF[failure.kind], failure: `${failure.kind}: ${failure.detail}` };
}

/**
 * What the block this ending produces asks of a person —
 * `WorkItemBlocked.needs`.
 *
 * **Beside the headlines, because it is the line printed directly above one**
 * (`#197`). `describeHold` emits the `needs` line first and the diagnosis's
 * `what` second, and both the board card and `lingtai status` render them in
 * that order (#83, #100). A crashed fixer's block written `judgement`
 * unconditionally therefore reads *your judgement is needed* one line above *this
 * is infrastructure and not your call* — the two readings #83 is about,
 * contradicting each other inside one card, and the one a person reads first
 * winning.
 *
 * The split is the same one every sentence above makes: an agent that was
 * stopped and an agent that spent the recipe's turns decided nothing, so what is
 * owed is `acknowledgement` — *something failed and nobody has decided what to
 * do* is exactly what happened. The other four end with something to weigh: a
 * live refusal, an objection, or an opinion to merge over, and all of those are
 * a person's `judgement`.
 */
export function stopNeeds(stop: FixStop): "judgement" | "acknowledgement" {
  switch (stop.ended) {
    case "crashed":
    case "out-of-turns":
      return "acknowledgement";
    case "declined":
    case "no-criterion":
    case "no-rounds":
    case "spent":
      return "judgement";
  }
}

/**
 * What to call a findings-shaped block on the log — `ApprovalRequested.action`.
 *
 * **The name outlives every sentence** (`#197`). The headline is a card's, the
 * question is a notification's, and both are read once; this is the key the
 * projection folds a gate row under (`proposed:<action>`) and the word
 * `lingtai status` and the board's history print beside the point for ever. It
 * was `disagreement` whatever ended the pass, so `#187`'s rate limit is a row
 * on the board literally named *disagreement*, one line above a question saying
 * nothing was decided — the same contradiction this ticket is about, on the
 * very payload the sentences were fixed on.
 *
 * **Only the findings shape needs a table.** `unfixed` is a state — the check
 * is red and nothing fixed it — and that is true however the pass ended, so the
 * output shape keeps its one name. `disagreement` is a *claim*, that two agents
 * looked at one diff and could not settle it, and it is only true of the
 * ceiling: every other ending stopped before a second judgement existed.
 *
 * The words are the headlines' in one each, so a person who reads
 * `proposed · unfinished` on the board and *A fixing agent did not finish* on
 * the card is reading one fact twice rather than two facts.
 */
export function stopAction(stop: FixStop): string {
  switch (stop.ended) {
    // Something that was not the ticket stopped the agent answering the
    // findings — `crash`, `timeout`, `aborted`. Not *crashed*, for the reason
    // the headline is not: one word for three kinds names the wrong one twice.
    case "crashed":
      return "unfinished";
    case "out-of-turns":
      return "out-of-turns";
    case "declined":
      return "declined";
    case "no-criterion":
      return "no-criterion";
    // One agent refused and none was bought to answer it, so there is nobody
    // for it to have disagreed with.
    case "no-rounds":
      return "unanswered";
    // The ceiling, and the only ending where the old name was ever true.
    case "spent":
      return "disagreement";
  }
}

export type FixDecision =
  | { fix: true; round: number; on: FixOn }
  /** `why` is a sentence for the card, naming the rule that refused. */
  | { fix: false; rule: FixRule; why: string };

export interface FixInput {
  /**
   * What the refused gate said.
   *
   * `findings` is the reviewer's, verbatim. `evidence` is what a `run:` action
   * printed — clipped by `command.ts` long before it reaches here — and is the
   * whole of what a red build has to offer.
   */
  refusal: {
    action: string;
    findings: readonly ActionFinding[];
    evidence: string;
    /**
     * The shape, when the caller knows it and the evidence does not say.
     *
     * Only the merge lane passes one. Everything else is a gate, and a gate's
     * shape is readable from what it produced.
     */
    on?: FixOn;
  };
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
 * **Every rule that can refuse is here, in order, and each names itself** — the
 * first refusal wins, so the sentence on the card is the most fundamental reason
 * and not the last one checked. `decideRepair` was written to the same shape and
 * is gone (`#143`); this is now the only place a refusal buys an agent.
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
  const no = (rule: FixRule, why: string): FixDecision => ({ fix: false, rule, why });

  // Which shape of refusal this is, decided by what the gate produced rather
  // than by the action's name: a `run:` action is a command whatever it is
  // called, and an `agent:` reviewer that returned nothing is not a reviewer.
  const actionable = refusal.findings.filter((f) => f.failureScenario.trim() !== "");
  const output = refusal.evidence.trim();
  const on: FixOn = refusal.on ?? (refusal.findings.length > 0 ? "findings" : "output");

  if (on === "findings" && actionable.length === 0) {
    return no(
      "no-criterion",
      `the ${refusal.action} action refused with findings but no failure scenario, ` +
        "and an opinion is not something an agent can be asked to make stop happening",
    );
  }

  if (on !== "findings" && output === "") {
    return no(
      "no-criterion",
      `the ${refusal.action} action refused and printed nothing, so there is no ` +
        "output to make go green and nothing to hold a fixer to",
    );
  }

  // `no-rounds` rather than `spent`, and they are kept apart because they are
  // different sentences — *this recipe never patches* is not *this pass has
  // patched as often as it may*. To `#146` they are one thing: the depth
  // ceiling is spent and the point still refuses, which is exactly when a
  // second approach is worth considering. `rounds: 0` beside a non-zero
  // `restarts` is therefore a legible configuration — never patch, start over
  // twice — and it is the closest thing to experiment 011's winning arm.
  if (rounds === 0) {
    // **It says what it refuses, not where the refusal goes.** It used to say
    // "sends every refusal straight to a person", which was true while this was
    // the only ceiling and is not true beside a non-zero `restarts`: a person
    // is then the *third* destination, not the second. A sentence that names
    // another module's behaviour is a sentence that goes stale when that module
    // changes, which is this repository's signature defect.
    return no(
      "no-rounds",
      "this project's recipe buys no round of fix-and-recheck, so nothing " +
        "patches this diff in place (runtime.limits.rounds: 0)",
    );
  }

  if (roundsSpent >= rounds) {
    return no(
      "spent",
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
    | { on: "findings"; findings: readonly ActionFinding[] }
    | { on: "output"; output: string }
    | { on: "conflict"; base: string; paths: string };
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
      : input.refusal.on === "conflict"
        ? conflictHalf(input.refusal.base, input.refusal.paths)
        : outputHalf(input.refusal.output, input.action);

  return `# The ${input.action} action refused this change, and you are the fix

You are in the worktree the change was made in. This is fix round
${input.round} of ${input.of}.

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
  findings: readonly ActionFinding[],
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
/**
 * The merge lane's refusal: the base moved, and the merge does not apply.
 *
 * **The only one of the three where the agent does not arrive at a clean
 * tree.** The conductor has already merged the base in and left the conflict
 * standing, because a description of a conflict is not something anyone can
 * resolve — the markers are. So this half says where the agent is as much as
 * what refused, which the other two never have to.
 *
 * Its acceptance test is the strictest of the three and the only one that is
 * two things: the merge has to complete *and* the point has to stay green.
 * Resolving a conflict by taking one side wholesale passes the first and is
 * exactly what the second is there to catch.
 */
function conflictHalf(base: string, paths: string): { evidence: string; criterion: string } {
  const files = paths.trim();
  return {
    evidence: `\`${base}\` moved while this change was being worked on, and merging it in
does not apply cleanly. **You are in the middle of that merge right now** — the
conflicts are in your working tree, with markers, exactly as \`git merge\` left
them.

## What conflicts

\`\`\`
${files === "" ? "(git named no files; use `git status` and `git diff --diff-filter=U`)" : files}
\`\`\``,
    criterion: `## What counts as done

Resolve the conflict and commit the merge. Then the whole \`proposed\` point runs
again on what you committed, and the merge is attempted again — **both have to
pass.** The second is why this is not a matter of picking a side.

So:

- Keep both intentions. The other change landed for a reason and yours was
  asked for; a resolution that quietly drops either is a wrong answer that
  merges cleanly.
- **\`--ours\` and \`--theirs\` wholesale are not a resolution.** Neither is
  deleting the conflicting hunk. Read what each side was doing.
- \`git add\` the resolved files and \`git commit\` the merge. Do not
  \`git merge --abort\`: that throws away the thing you were asked to do.
- Change nothing the conflict did not force you to. The diff is about to be read
  again by a reviewer who last saw it without this merge in it.

The base can move again while you work. If it does, this comes back around —
that is ordinary, and it is bounded by the rounds above.`,
  };
}

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

/** How much of an unfinished agent's failure a headline can carry. */
const FAILURE_CHARS = 200;

/**
 * The failure, short enough to sit in a first sentence.
 *
 * Shorter than a decline's clip because this one is inside the headline rather
 * than under it, and a headline a reader has to scroll is not one. The
 * untruncated failure is still in `done`, which `run-once.ts` composes and
 * `#197` was careful not to touch.
 *
 * It arrives as `kind: detail`, so the kind is in the headline by construction
 * and no sentence around it has to name one.
 */
function clipFailure(failure: string, chars: number = FAILURE_CHARS): string {
  const said = failure.trim();
  if (said === "") return "it said nothing about why";
  return said.length > chars ? `${said.slice(0, chars)}…` : said;
}

/**
 * What a person is shown when the rounds are over, no restart was bought, and
 * the review still refuses.
 *
 * *No restart was bought* is the clause 0040 adds and it is true of every
 * project today: `restarts` defaults to zero, so this is still reached on the
 * first spent pass. Where it is not zero, this is the third destination rather
 * than the second, and `earlier` below is what makes the card say so.
 *
 * **It says two agents disagreed, not that a gate refused**, and that is 0038's
 * consequence rather than a nicety: the thing arriving at a queue is no longer a
 * finding, it is *two agents looked at this and did not agree*, which is a
 * judgement in a way a swallowed `readFile` is not. A card that said "the review
 * gate refused" would be describing the first half of something that has since
 * happened twice.
 *
 * **And it says so only when that is what happened** (`#197`). For a year the
 * sentence above was the headline of every ending this function is reached by,
 * including the two where no agent disagreed with anything: a fixer that was
 * killed and a fixer that objected. `#187` ended on a rate limit two minutes
 * before it reset, and a person who read its headline and acted on it
 * adjudicated two findings whose answer had been half-written when the process
 * died. So `stop` decides the first sentence, and the five endings say five
 * different things because they ask for five different actions — adjudicate,
 * send it again, narrow the ticket, read the objection, look at the reviewer.
 * **Two of those are opposites and the fifth is why they are told apart**: a
 * fixer the wall clock or a quota stopped is sent again, a fixer that spent the
 * recipe's turns is not, and the headline that says *send it again* to the
 * second buys another run to the same limit (`#89`). The rest of the card is
 * untouched by which one it is: `done` and `raw` carry the same evidence they
 * did, because a reading that hides what it was made from is worse than the
 * output (#83) and the headline is a reading.
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
  findings: readonly ActionFinding[];
  /** Rounds of fix-and-re-review that were spent. Zero when none was bought. */
  rounds: number;
  /**
   * How many diffs **this reviewer** refused in this pass (`#197`).
   *
   * Its own number because `rounds` is not one: that is the pass's single
   * ceiling counter and every point spends it, so it answers *how much was
   * bought* and never *how often did this action say no*. The sentences that
   * count refusals read this; the ones that name the budget still read
   * `rounds`.
   */
  refusals: number;
  /** Why no further fixer was bought, in `decideFix`'s own words. */
  why: string;
  /**
   * What ended the loop, which is what the headline is about (`#197`).
   *
   * Given rather than read back out of `why`, which is a sentence for a card:
   * the whole defect this closes was a headline that could not see a
   * classification three layers of this system had already made.
   */
  stop: FixStop;
  /**
   * The approaches already abandoned on this item, **newest first**
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §3).
   *
   * Empty for every project that leaves `restarts` at zero, which is all of
   * them today, and then every sentence below is the one it was before.
   *
   * **Each arm's findings, and not a count of them**, because the claim being
   * tested is that the arms disagree about *different* things: arm A's third
   * refusal in experiment 011 was a deadlock round 2 had created, and a person
   * shown only the last arm cannot see that. They live on run streams no later
   * pass reads, which is why `PassRestarted` carries them.
   */
  earlier?: readonly RestartArm[];
}): BlockDiagnosis {
  const worst = severest(input.findings);
  const earlier = input.earlier ?? [];
  const at = `${input.branch} at ${input.headSha.slice(0, 7)}`;
  // The one clause every ending shares: who refused, how much, how bad. What
  // changes between them is the sentence around it, because that is the
  // sentence a person acts on.
  const refused =
    `The \`${input.action}\` reviewer refused it with ${count(input.findings)} ` +
    `(worst: ${worst})`;
  /**
   * What the reviewer has already decided, which is what *nothing here was
   * decided* is a claim about (`#197`).
   *
   * **`refusals` and never `rounds`.** A fixer killed in round 2 may sit behind
   * a diff this reviewer already read and refused, and then *nothing was
   * decided* is false in the direction that costs — it invites a person to
   * treat a refusal two agents have been round twice as one nothing has argued
   * with. But `rounds` cannot say which: it is **one counter for the whole
   * pass**, spent by whichever point refused (`run-once.ts`'s *one ceiling, so
   * one counter*), so `rounds: 2` is as easily *`build` refused, a round fixed
   * it, then `review` refused the result* — where this reviewer has read
   * exactly one diff. Counting that as two credits this reviewer with a refusal
   * of a diff it never saw, which is the same overstatement one field over.
   *
   * So the count is the one the loop keeps per action, and it is the number of
   * diffs **this reviewer** refused.
   *
   * What is true of every one of them is that the findings below are the ones
   * nothing answered, which is the sentence both arms keep.
   */
  const undecided =
    input.refusals <= 1
      ? "so nothing here was decided"
      : `so nothing new was decided: the reviewer refused ${input.refusals} diffs here ` +
        "and the round answering the last produced nothing";
  /**
   * The first sentence, which is the ending's to write.
   *
   * **A `switch` and not a chain of ternaries** (`#197`). The defect this
   * function was refused for was an ending with no arm of its own falling
   * through to the ceiling's sentence — `out-of-turns` was told *send it
   * again*, which this repository had already decided answers nothing. Written
   * this way a seventh `FixStop` does not compile until somebody has written
   * the sentence for it, which is `RUN_OWNER`'s own argument one level up.
   */
  const headline = ((): string => {
    switch (input.stop.ended) {
      case "crashed":
        // **Not a judgement, and the word must not appear.** Nothing new was
        // decided: the round answering the findings was stopped before it could
        // commit, so what is in front of a person is the same refusal that was
        // already being answered. Sending it again is the whole remedy, and it
        // is not one a person has to think about.
        //
        // *Did not finish* rather than *crashed*, because `timeout` and
        // `aborted` arrive here too and a headline reading "crashed …
        // — timeout: the 2h wall" contradicts itself inside one sentence. The
        // kind is in `failure`, which says it exactly once and correctly.
        return (
          `A fixing agent did not finish on ${at}, ${undecided}. ${refused}, ` +
          `and the agent sent to answer them was stopped — ${clipFailure(input.stop.failure)}. ` +
          `This is infrastructure and not your call: the round that was answering ` +
          `those findings never got to commit, so the fix is to send it again.`
        );
      case "out-of-turns":
        // **The one ending where sending it again is the wrong move**, and the
        // repository decided that before this function existed: `RUN_OWNER`
        // calls the turn limit the repository's failure, and `run-once.ts`
        // blocks a whole run that ends this way with *narrow or split the ticket
        // first; requeued as written, it buys another run to the same limit*.
        // Nothing was adjudicated, and nothing crashed either.
        return (
          `A fixing agent ran out of turns on ${at}, ${undecided}. ${refused}, ` +
          `and the agent sent to answer them spent the recipe's whole turn budget without ` +
          `committing — ${clipFailure(input.stop.failure)}. The limit is a scope alarm: ` +
          `requeued as written this buys another round to the same limit, so what answers ` +
          `it is narrowing or splitting the ticket.`
        );
      case "declined":
        // An argument, and the one ending where the thing to read first is not
        // the findings. The objection is in `done` verbatim, via `declineWhy` —
        // this only has to stop a person adjudicating before they have read it.
        return (
          `The fixing agent declined ${at}, and its objection is what to read first. ` +
          `${refused}, and the agent sent to answer them changed nothing and said why ` +
          `instead. That is an argument and not a broken build — weigh what it said ` +
          `against the findings before deciding anything.`
        );
      case "no-criterion":
        // The reviewer is the subject here, not the diff. Describing the change
        // at all would point a person at code that was never examined against a
        // criterion, because there was not one.
        //
        // **But *no agent was bought* is only true of a first refusal**
        // (`#197`). `decideFix` checks this rule **before** either ceiling, so
        // the ending is reached at any `rounds`: a reviewer refuses A with
        // scenarios, round 1's fixer commits B, and the reviewer refuses B with
        // none. The diff on screen is then the fixer's output and not the
        // implementer's — which `done`, two fields below, says outright — so a
        // person told no money was spent and nothing was changed inspects a
        // reviewer over code that has already been rewritten once.
        return (
          `The \`${input.action}\` reviewer refused ${at} with ${count(input.findings)} ` +
          `(worst: ${worst}), and ${
            input.rounds === 0
              ? "no agent was bought to answer them"
              : `no further agent was bought after ${input.rounds} fix round(s)`
          }: not one finding ` +
          `carries a failure scenario, so there is nothing a fixer could be asked to ` +
          `make stop happening. The reviewer is what to look at here, not the diff — ` +
          `an opinion is not something this loop can act on, and ${
            input.rounds === 0
              ? "nothing was changed in answer to it"
              : "what is on the branch answers the earlier refusals rather than this one"
          }.`
        );
      case "no-rounds":
        // **Nothing disagreed with the reviewer, because nothing was bought to.**
        // `rounds: 0` is a recipe that never patches (`decideFix`), so one agent
        // looked at this diff and the sentence for two would be counting a
        // second that was never sent. Money and not correctness: the findings
        // may be right, and nothing has argued either way.
        return (
          `One agent refused ${at} and none answered it. ${refused}, and this ` +
          `project's recipe buys no round of fix-and-recheck, so no agent was sent ` +
          `to make them stop happening. Nothing here disagreed with anything: the ` +
          `findings stand unanswered, and what changes that is raising ` +
          `\`runtime.limits.rounds\` — or reading them yourself.`
        );
      case "spent":
        // The ceiling, which is the only ending where two agents **can** have
        // looked at this and disagreed — and *can* is not *did* (`#197`). One
        // ceiling means one counter and every point spends it, so `build`
        // refuses A, three rounds answer it, and `review` refuses the last diff:
        // the ceiling is spent, this reviewer has refused once, and no round was
        // ever bought to answer it. *Still refused* there invites a person to
        // adjudicate a standoff that never happened.
        //
        // Byte for byte the sentence it has always been wherever the reviewer
        // did refuse more than one diff, which is the ordinary shape and the one
        // `run-once.test.ts`'s end-to-end pass produces: the common case must
        // not get worse to fix the others.
        return input.refusals <= 1
          ? `One agent refused ${at} and no round answered it. ${refused}, and the ` +
            `pass's ${input.rounds} fix round(s) had already been spent on an earlier ` +
            `refusal, so no agent was sent to make them stop happening. The findings ` +
            `stand unanswered: what changes that is raising ` +
            `\`runtime.limits.rounds\` — or reading them yourself.`
          : `Two agents disagreed about ${at}. ${refused}, and it is still refused. ` +
            `This is a judgement, not a broken build.`;
    }
  })();
  return {
    what:
      headline +
      (earlier.length === 0
        ? ""
        : // **Not "refused for the same reason"**, which is the thing nothing
          // here checks and the thing worth knowing: whether the arms agree is
          // the judgement being handed over, so the sentence says how many
          // approaches there were and puts every arm's findings below rather
          // than asserting what they have in common (0040 §Open).
          ` This is approach ${earlier.length + 1}: ${earlier.length} earlier ` +
          `one(s) were also refused by a reviewer and started over, so what is in ` +
          `doubt may be the ticket and not only this diff. Their findings are below.`),
    done:
      (input.rounds === 0
        ? "No fixing agent ran. "
        : `${input.rounds} round(s) of fix-and-re-review ran, and the review refused what they produced. `) +
      (earlier.length === 0
        ? ""
        : `${earlier.length} earlier approach(es) were abandoned and the ticket started ` +
          `over; every arm's findings are below. `) +
      `No further agent was bought: ${input.why}`,
    // The findings verbatim, including every failure scenario. This is the
    // evidence the sentence above is a reading of, and a reading that hides what
    // it was made from is worse than the output (#83) — which is why an earlier
    // arm's findings are quoted whole here rather than summarised into the
    // sentence above.
    raw: withArms(
      input.findings.length === 0 ? null : quoteFindings(input.findings),
      `this approach · ${input.branch}@${input.headSha.slice(0, 7)}`,
      earlier,
    ),
    recommendation: null,
  };
}

/**
 * One abandoned approach, as `WorkItemState.restarts` holds it.
 *
 * Declared here rather than imported from `@lingtai/domain` for the reason
 * `PromptBudget` is declared in `attempts.ts`: this module is pure decisions
 * and prose, and what it needs of a restart record is the fields that go on a
 * card, not the fold that produced them. `RestartRecord` satisfies it
 * structurally, so the conductor passes the fold's own values straight through.
 */
export interface RestartArm {
  restart: number;
  of: number;
  action: string;
  branch: string;
  headSha: string;
  rounds: number;
  findings: readonly ActionFinding[];
}

/**
 * This arm's evidence, and the abandoned arms' under a heading each.
 *
 * **Untouched when there is nothing to add**, which is the criterion behind
 * 0040 §4 read all the way down to the bytes on a card: a project that has
 * bought no restart gets the exact string this function's callers produced
 * before it existed — no headings, no framing, nothing to notice. Headings
 * appear only when there is more than one arm to tell apart, which is when they
 * are the difference between a person seeing one refusal and seeing why the
 * ticket is in doubt.
 *
 * Newest first, because that is the order a person triages in: what refused the
 * thing in front of them, then what refused the approaches before it. An arm
 * that recorded no findings still gets its heading — *this arm was refused and
 * recorded nothing* is a fact, and a silently missing section reads as an arm
 * that never happened.
 */
function withArms(
  mine: string | null,
  at: string,
  earlier: readonly RestartArm[],
): string | null {
  if (earlier.length === 0) return mine;
  const arms = [
    { at, body: mine },
    ...earlier.map((a) => ({
      at:
        `restart ${a.restart} of ${a.of} · ${a.action} refused ${a.branch}@${a.headSha.slice(0, 7)} ` +
        `after ${a.rounds} round(s)`,
      body: a.findings.length === 0 ? null : quoteFindings(a.findings),
    })),
  ];
  return arms
    .map((arm) => [`## ${arm.at}`, "", arm.body ?? "(no findings recorded)"].join("\n"))
    .join("\n\n");
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
 * **Except when it did not check again** (`#197`). *It ran again and said the
 * same thing* is the claim this sentence is worth reading for, and it is false
 * of the three endings where the round produced no commit: a fixer that was
 * stopped, a fixer that spent the recipe's turns and a fixer that objected all
 * leave the point having run once. So `stop` decides this headline too, for the
 * same reason it decides the sibling's — `#176` and `#177` ended on a full disk
 * and arrived under a sentence asserting a check had been re-run. And the turn
 * limit is kept off *send it again* here for the reason it is kept off it there:
 * that is the one ending the repository owns (`RUN_OWNER`).
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
  /**
   * How many diffs **this action** refused in this pass (`#197`).
   *
   * Never `rounds`, for `diagnoseDisagreement`'s reason: the pass has one
   * ceiling counter and every point spends it, so *two rounds* is as easily
   * *this action refused once and another point refused the other time*.
   */
  refusals: number;
  /** Why no further fixer was bought, in `decideFix`'s own words. */
  why: string;
  /** What ended the loop, which is what the headline is about (`#197`). */
  stop: FixStop;
  /**
   * The approaches already abandoned on this item, newest first.
   *
   * A restart is never bought *for* a red build — for one of those the work is
   * still there (0039 §2) — but a pass that is itself a restart can go red, and
   * then the arms behind it are on streams nobody reads. Carried for that case
   * and empty in every other, which is every block today.
   */
  earlier?: readonly RestartArm[];
}): BlockDiagnosis {
  const earlier = input.earlier ?? [];
  const at = `${input.branch} at ${input.headSha.slice(0, 7)}`;
  /**
   * How many times the point actually ran, which is what *nothing was run
   * again* is a claim about (`#197`).
   *
   * **`refusals` and never `rounds`**, for the reason `undecided` above is.
   * A fixer that dies in round 2 may stand behind one diff this action has
   * already refused — two red results on two different diffs, which `done` two
   * fields below says outright — and telling a person none of them were tested
   * is worse than saying nothing: one red result and two are worth different
   * amounts to somebody deciding whether to merge over it. But `rounds` is the
   * pass's single ceiling counter and every point spends it, so *round 2* is as
   * easily *`review` refused, a round answered it, and this action went red on
   * the result* — one red result, and a card claiming two would overstate the
   * evidence in the direction that makes a person readier to treat it as
   * settled.
   */
  const ran = Math.max(1, input.refusals);
  const notAgain =
    ran === 1
      ? "nothing was run again"
      : `this last result was not re-checked — \`${input.action}\` ran ${ran} times in ` +
        `all, on ${ran} different diffs, and refused every one`;
  /**
   * The first sentence, which is the ending's to write — a `switch` for
   * `diagnoseDisagreement`'s reason (`#197`), so that an ending with no arm of
   * its own cannot inherit a claim that is false of it.
   */
  const headline = ((): string => {
    switch (input.stop.ended) {
      case "crashed":
        // The last result was not re-run and nothing new was decided. The remedy
        // is the same one a stopped reviewer's is, and it is not a person's
        // judgement. The kind is `failure`'s to name — `timeout` and `aborted`
        // land here too. How much was re-run is `notAgain`'s: this arm is
        // reached in round 2 as readily as in round 1.
        return (
          `\`${input.action}\` refuses ${at}, and this pass stopped on an agent that did ` +
          `not finish rather than on the check. The agent sent to make it green was ` +
          `stopped — ${clipFailure(input.stop.failure)}, so nothing new was decided and ` +
          `${notAgain}. This is infrastructure and not your call: send it again.`
        );
      case "out-of-turns":
        // Not re-run either, and the opposite remedy: the turn limit is the
        // repository's failure, so *send it again* costs another full budget and
        // answers nothing (`RUN_OWNER`, `run-once.ts`'s own block).
        return (
          `\`${input.action}\` refuses ${at}, and this pass stopped on the recipe's turn ` +
          `limit rather than on the check. The agent sent to make it green spent its whole ` +
          `budget without committing — ${clipFailure(input.stop.failure)}, so ${notAgain}. ` +
          `The limit is a scope alarm: requeued as written this buys another ` +
          `round to the same limit, so what answers it is narrowing or splitting the ticket.`
        );
      case "declined":
        return (
          `\`${input.action}\` refuses ${at}, and the fixing agent declined it — it ` +
          `changed nothing and said why instead. That is an argument and not a check ` +
          `that stayed red: ${
            ran === 1
              ? "the point has run once"
              : `the point has run ${ran} times and its last result was not re-checked`
          }, and what it printed is below next to the objection.`
        );
      case "no-rounds":
        // It failed once and was never run again, for the same reason as the
        // sibling's: this recipe buys no round. *It ran again and said the same
        // thing* is the claim this headline is read for, and here nothing ran
        // twice — the check is as good as its one result, and a reader deciding
        // whether to trust it needs to know it was not repeated.
        return (
          `\`${input.action}\` refused ${at} once, and was never run again: this ` +
          `project's recipe buys no round of fix-and-recheck, so no agent was sent ` +
          `to make it green. What it printed is below, and it is one result rather ` +
          `than a repeated one.`
        );
      case "no-criterion":
        // **Written rather than inherited, though nothing reaches it.** A
        // command that refused and printed nothing is `unbought` in `buyRound`
        // before it can become an `unresolved`, so no block is made from this
        // today. Falling through to the ceiling's arm would park a false claim
        // here against the day that guard moves, which is `#197`'s whole shape
        // one level down — so it reads the counts for the same reason the arms
        // above do: `decideFix` checks this rule before either ceiling, so a
        // round may already have been bought and committed.
        return (
          `\`${input.action}\` refused ${at} and printed nothing to hold a fixer to, ` +
          `so no ${input.rounds === 0 ? "" : "further "}agent was bought and ${notAgain}.`
        );
      case "spent":
        // **And the ceiling reads the count too** (`#197`). *It ran again and
        // said the same thing* is the claim this sentence is worth reading for,
        // and it is only true where this point is what spent the rounds: one
        // counter serves the whole pass, so `build` passes A, `review` refuses
        // it, three rounds answer the review, and `build` goes red on the last
        // diff. There the ceiling is spent, `build` has refused exactly once and
        // was never re-run — and a card claiming a repeated result overstates the
        // evidence in the direction that makes a person readier to merge over it
        // or close the ticket rather than requeue.
        //
        // Byte for byte the sentence it has always been wherever the point did
        // refuse more than one diff, which is the ordinary shape.
        return ran === 1
          ? `\`${input.action}\` refuses ${at}, and no round was bought to answer it: ` +
            `the pass's ${input.rounds} fix round(s) had already been spent on an ` +
            `earlier refusal, so \`${input.action}\` refused once and was never run ` +
            `again. What it printed is below, and it is one result rather than a ` +
            `repeated one.`
          : `\`${input.action}\` still refuses ${at}. ` +
            "This is a check that failed and stayed failed, not a judgement: whatever it " +
            "runs, it ran again and said the same thing.";
    }
  })();
  return {
    what:
      headline +
      (earlier.length === 0
        ? ""
        : ` It is approach ${earlier.length + 1}: ${earlier.length} earlier one(s) were ` +
          `refused on judgement and started over, and their findings are below.`),
    done:
      (input.rounds === 0
        ? "No fixing agent ran. "
        : `${input.rounds} round(s) of fix-and-recheck ran, and the action refused what they produced. `) +
      `No further agent was bought: ${input.why}`,
    // The output verbatim. It is already clipped to the recipe's budget by the
    // action that produced it, and clipping a clipping is how evidence becomes
    // a summary of itself.
    raw: withArms(
      input.evidence.trim() === "" ? null : input.evidence,
      `this approach · ${input.branch}@${input.headSha.slice(0, 7)} · what \`${input.action}\` printed`,
      earlier,
    ),
    recommendation: null,
  };
}

/**
 * How much of the failure the one line can carry.
 *
 * Far shorter than a headline's, because this is the whole of what a GitHub
 * notification, `lingtai status` and the board's note show: a line that wraps is
 * a line nobody finishes.
 */
const QUESTION_CHARS = 80;

/**
 * **The one line says what stopped the pass too** (`#197`).
 *
 * The headline is the second thing a person reads. This is the first — it is the
 * GitHub comment they are notified with, the board's note and the line
 * `lingtai status` prints — and for the whole of `#197`'s first draft it went on
 * saying *two agents disagreed* over a card whose own headline said a fixing
 * agent had been killed. A reading that contradicts the reading above it is
 * worse than either.
 *
 * So both functions below take the same `stop`, and each ending gets the line
 * its headline has. Exhaustively, and by `switch` rather than by falling
 * through: the ending this repository got wrong once was the one that had no
 * row of its own.
 */
export function unfixedQuestion(input: {
  action: string;
  branch: string;
  base: string;
  rounds: number;
  /**
   * How many diffs **this action** refused, as `diagnoseUnfixed` reads it
   * (`#197`).
   *
   * Here because the line is read before the card: *still refuses* is a claim
   * about a result that was reached twice, and the pass's one counter is spent
   * by whichever point refused.
   */
  refusals: number;
  /** What ended the loop, which is what the line is about (`#197`). */
  stop: FixStop;
  /** Approaches already abandoned. Absent or zero on every card today. */
  restarts?: number;
}): string {
  const where = `${input.branch} into ${input.base}`;
  const spent = `${input.rounds} fix round(s)${armSuffix(input.restarts)}`;
  // *Never re-run* is a claim about a count, and the count is in `rounds`
  // (`#197`): on these endings it is the round that produced nothing, so the
  // rounds before it each committed and the action ran on each of their diffs.
  // What is true however many there were is that the **last** result is the one
  // nothing re-checked, which is the whole of what this line has room for.
  const notAgain =
    input.rounds <= 1 ? "so it was never re-run" : "so its last result was not re-checked";
  switch (input.stop.ended) {
    case "crashed":
      return (
        `${input.action} refuses ${where} and the fixing agent did not finish after ` +
        `${spent}, ${notAgain}: ${clipFailure(input.stop.failure, QUESTION_CHARS)}`
      );
    case "out-of-turns":
      return (
        `${input.action} refuses ${where} and the fixing agent ran out of turns after ` +
        `${spent}, ${notAgain}: the ticket needs narrowing, not a retry`
      );
    case "declined":
      return (
        `${input.action} refuses ${where} and the fixing agent declined after ${spent}: ` +
        "it changed nothing and said why instead"
      );
    case "no-rounds":
      return (
        `${input.action} refuses ${where} and this recipe buys no fix round` +
        afterArms(input.restarts)
      );
    case "no-criterion":
      // The rounds when there were any, for the reason the findings-shaped line
      // names them (`#197`): the criterion rule is checked before either
      // ceiling, so this ending is not a first refusal's alone.
      return input.rounds === 0
        ? `${input.action} refuses ${where} and printed nothing to fix${afterArms(input.restarts)}`
        : `${input.action} refuses ${where} and printed nothing to fix, after ${spent}`;
    case "spent":
      // The one line it has always been, byte for byte, for the ending where
      // the point really did run again and say the same thing — and **that is
      // the count and not the ending** (`#197`). A ceiling spent answering
      // another point's refusal leaves this one red once and never re-run, and
      // *still refuses … after 3 fix round(s)* says those rounds failed to fix
      // it when they were never about it.
      return input.refusals <= 1
        ? `${input.action} refuses ${where} and no round answered it: the ceiling of ` +
          `${spent} was already spent`
        : `${input.action} still refuses ${where} after ${spent}`;
  }
}

/** The card's one line. Says what it is rather than which gate said it. */
export function disagreementQuestion(input: {
  action: string;
  branch: string;
  base: string;
  findings: readonly ActionFinding[];
  rounds: number;
  /**
   * How many diffs **this reviewer** refused, as `diagnoseDisagreement` reads
   * it (`#197`).
   *
   * Here for the reason the headline reads it: the line is what a person is
   * notified with, so of two readings that contradict each other it is the one
   * acted on. A card saying one agent refused and nothing answered it, under a
   * comment saying two agents disagreed, is the failure #83 names with the
   * notification on the wrong side of it.
   */
  refusals: number;
  /** What ended the loop, which is what the line is about (`#197`). */
  stop: FixStop;
  /** Approaches already abandoned. Absent or zero on every card today. */
  restarts?: number;
}): string {
  const where = `${input.branch} into ${input.base}`;
  const spent = `${input.rounds} fix round(s)${armSuffix(input.restarts)}`;
  const scored = `${count(input.findings)} (worst: ${severest(input.findings)})`;
  switch (input.stop.ended) {
    case "crashed":
      return (
        `a fixing agent did not finish on ${where} after ${spent}, so the ` +
        `${input.action} reviewer's ${scored} are unanswered: ` +
        clipFailure(input.stop.failure, QUESTION_CHARS)
      );
    case "out-of-turns":
      return (
        `a fixing agent ran out of turns on ${where} after ${spent}, so the ` +
        `${input.action} reviewer's ${scored} are unanswered: the ticket needs ` +
        "narrowing, not a retry"
      );
    case "declined":
      return (
        `a fixing agent declined ${where} after ${spent}: the ${input.action} ` +
        `reviewer's ${scored} stand, and it said why rather than answering them`
      );
    case "no-criterion":
      // **And the rounds are named when there were any** (`#197`).
      // `decideFix` checks the criterion rule before either ceiling, so this
      // ending is reached after rounds have been bought and committed; a line
      // reading *no fixing agent was bought* there is the card's own falsehood
      // one step earlier, where a person reads it first.
      return input.rounds === 0
        ? `the ${input.action} reviewer refuses ${where} with ${scored} and no failure ` +
          `scenario, so no fixing agent was bought${afterArms(input.restarts)}`
        : `the ${input.action} reviewer refuses ${where} with ${scored} and no failure ` +
          `scenario, so no further fixing agent was bought after ${spent}`;
    case "no-rounds":
      return (
        `the ${input.action} reviewer refuses ${where} with ${scored}, and this ` +
        `recipe buys no fix round, so nothing answered it${afterArms(input.restarts)}`
      );
    case "spent":
      // Byte for byte the line it has always been where two agents did look at
      // this and did not agree — and **that is a count, not the ending**
      // (`#197`): the pass's one counter is spent by whichever point refused, so
      // a ceiling can go entirely on answering something else and leave this
      // reviewer's single refusal unanswered.
      return input.refusals <= 1
        ? `the ${input.action} reviewer refuses ${where} with ${scored} and no round ` +
          `answered it: the ceiling of ${spent} was already spent`
        : `two agents disagreed about ${where}: the ` +
          `${input.action} reviewer still refuses it after ${spent}, ` +
          `with ${scored}`;
  }
}

/**
 * The clause after *Merge `branch` into `base` anyway?* — what a person would
 * be merging over.
 *
 * **The third sentence, and the only one of the three that is kept for ever**
 * (`#197`). `ApprovalRequested.question` is written to the log and read back by
 * every later pass, by `lingtai status` and by the approval prompt itself, and
 * it opened with *Two agents disagreed* whatever ended the pass — so `#187`'s
 * rate limit is on that stream, under that sentence, permanently. The headline
 * and the block's one line are both `stop`'s now; a record that still said
 * something else would be the disagreement #83 is about, with the log on the
 * wrong side of it.
 *
 * One function for both shapes rather than two, because the endings are the
 * same endings and only the subject changes: a reviewer refuses, a command goes
 * red. Two copies would be two places to fix the next time an ending is added.
 */
export function mergeAnywayBecause(input: {
  action: string;
  on: FixOn;
  rounds: number;
  /**
   * How many diffs **this point** refused, as the cards read it (`#197`).
   *
   * On the record for the reason everything else here is: this is the sentence
   * nothing ever rewrites, so a claim about what was decided has to be as true
   * in a year as the card was on the day.
   */
  refusals: number;
  stop: FixStop;
}): string {
  const after = `${input.rounds} fix round(s)`;
  const refuses =
    input.on === "findings"
      ? `the ${input.action} reviewer still refuses it`
      : `\`${input.action}\` is still red`;
  switch (input.stop.ended) {
    case "crashed":
      return `A fixing agent did not finish after ${after} and ${refuses}; nothing was decided.`;
    case "out-of-turns":
      return (
        `A fixing agent ran out of turns after ${after} and ${refuses}; the ticket ` +
        "needs narrowing, not a retry."
      );
    case "declined":
      return `The fixing agent declined after ${after} and ${refuses}; read its objection first.`;
    case "no-criterion":
      // **The round count is not zero here** unless the recipe's own is
      // (`#197`): the criterion rule is checked before either ceiling, so a
      // record that leaves it out says a merge was approved over a first
      // refusal when it was approved over the third.
      return input.rounds === 0
        ? `${refuses}, with nothing a fixing agent could be held to.`
        : `${refuses} after ${after}, with nothing a fixing agent could be held to.`;
    case "no-rounds":
      return `${refuses}, and this recipe buys no fix round.`;
    case "spent":
      // Byte for byte both sentences where the point refused more than one diff,
      // which is what they were always true of: the ceiling is spent and the
      // point has answered twice. **Where it refused once they are not**
      // (`#197`) — the pass has one counter and any point can spend it, so a
      // ceiling spent answering another refusal leaves this one unanswered, and
      // both *disagreed* and *still* would be recorded for ever of something
      // that happened once.
      if (input.refusals <= 1) {
        const refused =
          input.on === "findings"
            ? `The ${input.action} reviewer refuses it`
            : `\`${input.action}\` refuses it`;
        return `${refused} and no round answered it; the pass's ${after} went on an earlier refusal.`;
      }
      return input.on === "findings"
        ? `Two agents disagreed: the ${input.action} reviewer still refuses it after ${after}.`
        : `\`${input.action}\` is still red after ${after}.`;
  }
}

/**
 * *and 2 restart(s)*, or nothing at all.
 *
 * The one line is what a listing shows, so what it has to carry is the fact a
 * reader would act differently on: three rounds spent on one approach is a
 * stubborn diff, three rounds spent on each of three approaches is a ticket
 * nobody has managed to do. Nothing when there have been none, so a card on a
 * project that buys no restart reads exactly as it did.
 */
function armSuffix(restarts: number | undefined): string {
  return restarts === undefined || restarts === 0 ? "" : ` and ${restarts} restart(s)`;
}

/**
 * *, after 2 restart(s)* — the same fact, for the lines that name no round
 * count to hang `armSuffix` off.
 *
 * **Reached where `rounds` is zero, and only there** (`#197`). `no-rounds` is
 * that by definition and `no-criterion` is that when the refusal carrying no
 * criterion was the first — those lines have no *N fix round(s)* to append to.
 * (A `no-criterion` refusal **after** a round is not one of them: `decideFix`
 * checks the criterion rule before either ceiling, so the count exists and the
 * lines above name it rather than coming here.) And `rounds: 0` beside
 * a non-zero `restarts` is the configuration `decideFix`'s own comment calls
 * legible, *never patch, start over twice*, where `no-rounds` is the **only**
 * ending reachable. A line that drops the count there drops it in the one place
 * it was ever going to be printed, which is 0040 §3 lost at the last step: the
 * fact a reader would act differently on is not how red this diff is, it is
 * that two approaches were started over and thrown away, so what is in doubt
 * may be the ticket.
 */
function afterArms(restarts: number | undefined): string {
  return restarts === undefined || restarts === 0 ? "" : `, after ${restarts} restart(s)`;
}

/** The findings, whole — severity, place, claim and scenario, nothing dropped. */
export function quoteFindings(findings: readonly ActionFinding[]): string {
  return findings
    .map((f) => {
      const at = f.line === null ? f.file : `${f.file}:${f.line}`;
      return [`[${f.severity}] ${at} — ${f.claim}`, "", f.failureScenario.trim()].join("\n");
    })
    .join("\n\n---\n\n");
}

function count(findings: readonly ActionFinding[]): string {
  return findings.length === 1 ? "one finding" : `${findings.length} findings`;
}

/**
 * The highest severity present, by the rubric's own order.
 *
 * `SEVERITIES` is that order and is worst first, so this walks it rather than
 * restating it: a severity added to the enum is found here without this line
 * being touched, where a hand-written copy would have answered `none` for it
 * and printed `worst: none` beside a finding that exists.
 */
function severest(findings: readonly ActionFinding[]): Severity | "none" {
  for (const severity of SEVERITIES) {
    if (findings.some((f) => f.severity === severity)) return severity;
  }
  return "none";
}
