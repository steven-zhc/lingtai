/**
 * Whether a refused review buys an agent, what that agent is told, and what a
 * person is shown when two of them cannot agree.
 *
 * Here for the reason `repair.test.ts` is here: both files are about rules that
 * decide whether money is spent, and
 * [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §4 adds a *second* purse — so the property that matters most is the one a
 * single ceiling could not have: **spending one does not spend the other.**
 *
 * The prompt is tested as carefully as the decision, and that is not padding.
 * The acceptance contract of the whole loop is that the fixer is handed each
 * finding's `failureScenario` verbatim and nothing from the implementer; a brief
 * that summarised a scenario, or that quietly grew a "here is what the last
 * agent was thinking" section, would leave the loop shipped and the guard gone.
 *
 * Pure, under `vitest.pure.config.ts`: nothing here reads a database.
 */
import { describe, expect, it } from "vitest";
import type { GateFinding } from "@lingtai/actions";
import {
  decideFix,
  declineWhy,
  diagnoseDisagreement,
  disagreementQuestion,
  fixBrief,
  quoteFindings,
} from "../src/fix.ts";

const SCENARIO =
  "call deliver() while the log file is unreadable; readFile throws, the catch\n" +
  "swallows it, and the delivery resolves as a success";

const finding = (over: Partial<GateFinding> = {}): GateFinding => ({
  file: "packages/daemon/src/subscribers.ts",
  line: 71,
  claim: "a failed log read is swallowed, so the delivery resolves as a success",
  failureScenario: SCENARIO,
  severity: "blocker",
  ...over,
});

const refusal = (findings: GateFinding[] = [finding()]) => ({ action: "review", findings });

const policy = { on: true, fix: 1 };

describe("whether a refusal buys an agent", () => {
  it("buys one for a finding with a failure scenario", () => {
    const decision = decideFix({ refusal: refusal(), policy, roundsSpent: 0 });

    expect(decision).toEqual({ fix: true, round: 1 });
  });

  /**
   * The rule that makes the loop safe to have at all. A finding *with* a
   * scenario determines its own fix — make that sequence stop producing that
   * outcome — and a refusal without one is not a judgement an agent can be
   * asked to answer.
   */
  it("buys nothing for a refusal with no findings, which is what a red build is", () => {
    const decision = decideFix({ refusal: { action: "build", findings: [] }, policy, roundsSpent: 0 });

    expect(decision.fix).toBe(false);
    expect(decision.fix === false && decision.why).toMatch(/without findings/);
  });

  it("buys nothing for an 'observation' with an empty scenario", () => {
    // `parseFindings` drops these, and this is the second place the same rule is
    // enforced rather than assumed — a finding that reached here without one is
    // an opinion, and an agent sent to address an opinion rewrites whatever it
    // likes.
    const decision = decideFix({
      refusal: refusal([finding({ failureScenario: "   " })]),
      policy,
      roundsSpent: 0,
    });

    expect(decision.fix).toBe(false);
  });

  it("respects a recipe that does not repair", () => {
    const decision = decideFix({ refusal: refusal(), policy: { on: false, fix: 2 }, roundsSpent: 0 });

    expect(decision.fix).toBe(false);
    expect(decision.fix === false && decision.why).toMatch(/repair\.on: false/);
  });

  /**
   * A repository that wants findings read by a person rather than answered by an
   * agent can say so **without** turning `repair` off and losing the merge
   * lane's agent with it. That is the whole point of two keys.
   */
  it("buys nothing when the recipe asks for no rounds, with repair still on", () => {
    const decision = decideFix({ refusal: refusal(), policy: { on: true, fix: 0 }, roundsSpent: 0 });

    expect(decision.fix).toBe(false);
    expect(decision.fix === false && decision.why).toMatch(/repair\.fix: 0/);
  });

  it("stops at the ceiling, and says which ceiling", () => {
    expect(decideFix({ refusal: refusal(), policy, roundsSpent: 1 })).toEqual({
      fix: false,
      why: expect.stringContaining("ceiling of 1 fix round(s)"),
    });
    // And a recipe that raised it gets the rounds it asked for.
    expect(decideFix({ refusal: refusal(), policy: { on: true, fix: 2 }, roundsSpent: 1 })).toEqual({
      fix: true,
      round: 2,
    });
  });

  /**
   * **The property a shared ceiling could not have** (0038 §4).
   *
   * `decideFix` reads `policy.fix` and the rounds spent on this run;
   * `decideRepair` reads `policy.maxAttempts` and the repairs on the item.
   * Neither number appears in the other's rules, so a build that broke and spent
   * the repair ceiling cannot leave a one-line finding with nothing to buy an
   * agent with — which is the race that was being called a budget.
   */
  it("does not read the repair ceiling, however spent it is", () => {
    const spent = { on: true, fix: 1, maxAttempts: 1 };

    expect(decideFix({ refusal: refusal(), policy: spent, roundsSpent: 0 })).toEqual({
      fix: true,
      round: 1,
    });
  });
});

describe("what the fixer is told", () => {
  const DIFF = "diff --git a/packages/daemon/src/subscribers.ts b/x\n+  } catch {\n+    return ok;";
  const brief = fixBrief({
    findings: [finding()],
    round: 1,
    of: 2,
    action: "review",
    diff: DIFF,
    diffBytes: 400_000,
  });

  it("carries the failure scenario verbatim, line for line", () => {
    // Verbatim is the contract: the scenario was written before anybody knew
    // what the fix would be, which is what makes it a criterion the fixer cannot
    // author. A paraphrase is a looser criterion than the one it will be held to.
    for (const line of SCENARIO.split("\n")) expect(brief).toContain(line);
    expect(brief).toContain("packages/daemon/src/subscribers.ts:71");
    expect(brief).toContain("blocker");
  });

  it("says which round of how many, so the agent knows what is left", () => {
    expect(brief).toContain("fix round\n1 of 2");
  });

  /**
   * 0038 §3, asserted rather than intended. The guarantee is structural — the
   * signature takes the findings, the diff, a round, a count and a name, and
   * there is no parameter through which a plan or a transcript could arrive —
   * and this is the other half: the words that would mean somebody had added
   * one, and the ticket text that would mean it had been handed the job again
   * rather than these scenarios.
   */
  it("hands over no plan, transcript or session from the implementer", () => {
    expect(brief).toMatch(/not given that agent's reasoning/i);
    expect(brief).toMatch(/No plan, no transcript, no session/i);
    // The task is bounded, and the ticket is not part of it: this agent is not
    // being asked to do the work again, it is being asked to make these
    // sequences stop happening.
    expect(brief).toMatch(/Make each sequence stop producing its outcome/i);
  });

  it("bounds the change and refuses the silencing fix", () => {
    expect(brief).toMatch(/change nothing else/i);
    expect(brief).toMatch(/Deleting the line, renaming the symbol or suppressing the warning is not\s+a\s+fix/i);
    // And the ending 0025 made a rule: what a person approves is a diff. It
    // says *what you fix* now, because the unqualified "Commit." was read
    // against the decline below — see that test.
    expect(brief).toMatch(/\*\*Commit what you fix\.\*\*/);
    expect(brief).toMatch(/Never make\s+the code worse to make the finding go away/i);
  });

  /**
   * 0039 §5, and the reason it needed deciding at all.
   *
   * `run-once.ts`'s `if (!committed)` has always ended the loop and put the
   * findings in front of a person — 0038's Open §2 said a fixer had no move
   * except to change the code anyway, and that was wrong. What was missing was
   * telling the fixer, and what the prompt said instead pointed the other way:
   * *commit*, *an attempt that ends with advice produces nothing*, and *if a
   * finding is wrong say so in your final message* — a message nothing reads as
   * a verdict. The one branch that carries an objection into the log was the
   * branch the prompt discouraged.
   *
   * So this asserts the sentence, not the intention. An escape hatch nobody is
   * told about is not one, and a later edit that trims this paragraph for length
   * should fail here rather than quietly close the hatch again.
   */
  it("tells the fixer it may decline, and that declining is how a person hears it", () => {
    expect(brief).toMatch(/change nothing and commit nothing/i);
    // Not giving up, and not a wasted round: the prompt has to say what the
    // move *achieves*, or an agent under a "produce something" reading will
    // avoid it exactly when it is most needed.
    expect(brief).toMatch(/how your objection\s+reaches a person/i);
    expect(brief).toMatch(/stops this loop and puts\s+the findings in front of somebody/i);
    // And when to use it, in the terms the fixer can actually check.
    expect(brief).toMatch(/the sequence it describes cannot happen/i);
    expect(brief).toMatch(/the failure was not caused by this diff/i);
  });

  it("carries the diff the reviewer was shown, under the same ceiling", () => {
    expect(brief).toContain(DIFF);

    // Clipped rather than unbounded, for 0029's reason: a megabyte handed to an
    // agent produces a worse answer, not a better one.
    const huge = fixBrief({
      findings: [finding()],
      round: 1,
      of: 1,
      action: "review",
      diff: "x".repeat(5_000),
      diffBytes: 1_000,
    });
    expect(huge).toContain("[diff truncated at 1000 bytes]");
  });

  it("names every finding it was given", () => {
    const two = fixBrief({
      findings: [finding(), finding({ file: "apps/board/src/page.tsx", line: 676, severity: "major" })],
      round: 1,
      of: 1,
      action: "review",
      diff: "d",
      diffBytes: 400_000,
    });

    expect(two).toContain("### 1. blocker");
    expect(two).toContain("### 2. major · apps/board/src/page.tsx:676");
  });
});

describe("what a person is shown when the rounds are over", () => {
  const diagnosis = diagnoseDisagreement({
    action: "review",
    branch: "agent/123",
    base: "main",
    headSha: "c0ffee1234567890",
    findings: [finding()],
    rounds: 1,
    why: "the ceiling of 1 fix round(s) for this item is spent, and the review still refuses",
  });

  /**
   * The criterion in as many words: **two agents disagreed**, not *a gate
   * refused*. The second sentence describes the first half of something that has
   * since happened twice.
   */
  it("says two agents disagreed, and not that a gate refused", () => {
    expect(diagnosis.what).toContain("Two agents disagreed");
    expect(diagnosis.what).not.toMatch(/gate refused/i);
    expect(diagnosis.what).toContain("agent/123");
    expect(diagnosis.what).toContain("c0ffee1");
    // The severity is on the sentence because it is what a person triages by.
    expect(diagnosis.what).toContain("blocker");
  });

  it("says what was already spent, and why nothing more was", () => {
    expect(diagnosis.done).toContain("1 round(s) of fix-and-re-review ran");
    expect(diagnosis.done).toContain("No further agent was bought");
    expect(diagnosis.done).toContain("ceiling of 1 fix round(s)");
  });

  it("keeps the findings verbatim under the sentence", () => {
    // A reading that hides the output it was made from is worse than the output
    // (#83). The failure scenario is the evidence here, so it is the thing that
    // must survive.
    expect(diagnosis.raw).toContain(SCENARIO.split("\n")[0]!);
    expect(quoteFindings([finding()])).toContain("[blocker]");
  });

  it("recommends nothing, because approving over a live finding is a person's call", () => {
    expect(diagnosis.recommendation).toBeNull();
  });

  it("says the fixer changed nothing when that is what happened", () => {
    const none = diagnoseDisagreement({
      action: "review",
      branch: "agent/123",
      base: "main",
      headSha: "c0ffee1234567890",
      findings: [finding()],
      rounds: 0,
      why: "this project's recipe buys no rounds of fix-and-re-review (repair.fix: 0)",
    });

    expect(none.done).toContain("No fixing agent ran");
  });

  it("puts the count and the worst severity on the card's one line", () => {
    const question = disagreementQuestion({
      action: "review",
      branch: "agent/123",
      base: "main",
      findings: [finding({ severity: "major" }), finding()],
      rounds: 1,
    });

    expect(question).toContain("two agents disagreed about agent/123 into main");
    expect(question).toContain("2 findings");
    expect(question).toContain("worst: blocker");
  });
});

/**
 * The other half of 0039 §5: the fixer is told it may decline, so a person has
 * to be able to see that it did.
 *
 * Both outcomes reach `run-once.ts`'s `if (!committed)` — a fixer that objected
 * and a fixer that was killed commit exactly the same nothing. For a day the
 * sentence for both was *the fixing agent committed nothing*, which describes a
 * crashed process as a judgement and a judgement as a crash.
 */
describe("a decline, told apart from a crash", () => {
  it("says declined, and carries the objection the prompt promised would travel", () => {
    const why = declineWhy(
      "Finding 1 cannot happen: deliver() is only ever called from the subscriber\n" +
        "loop, which already holds the lock.",
    );

    expect(why).toContain("declined");
    expect(why).toContain("It said: Finding 1 cannot happen");
    // The whole objection, not a gesture at one — a decline a person cannot
    // read the reason for is barely better than the refusal it replaced.
    expect(why).toContain("already holds the lock.");
  });

  it("says so when the agent declined and explained nothing", () => {
    expect(declineWhy(null)).toContain("gave no reason");
    expect(declineWhy("   ")).toContain("gave no reason");
  });

  it("clips a long message, because this sentence is read on a card", () => {
    const why = declineWhy("z".repeat(5_000));

    expect(why).toContain("…");
    expect(why.length).toBeLessThan(600);
  });
});
