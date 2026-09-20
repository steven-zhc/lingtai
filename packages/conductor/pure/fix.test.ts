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
  type FixStop,
  decideFix,
  declineWhy,
  diagnoseDisagreement,
  diagnoseUnfixed,
  disagreementQuestion,
  fixBrief,
  fixStopOf,
  mergeAnywayBecause,
  quoteFindings,
  stopNeeds,
  unfixedQuestion,
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

const refusal = (findings: GateFinding[] = [finding()], evidence = "") => ({
  action: "review",
  findings,
  evidence,
});

/** A command's refusal: no findings, and its output is the whole of what it has. */
const redBuild = (evidence = "src/a.ts(7,3): error TS2339: Property 'x' does not exist") => ({
  action: "build",
  findings: [] as GateFinding[],
  evidence,
});

describe("whether a refusal buys an agent", () => {
  it("buys one for a finding with a failure scenario", () => {
    const decision = decideFix({ refusal: refusal(), rounds: 1, roundsSpent: 0 });

    expect(decision).toEqual({ fix: true, round: 1, on: "findings" });
  });

  /**
   * **The rule 0039 §2 rewrote, and the part of it that did not move.**
   *
   * 0038 §2 refused a red build outright: no `findings` field, no acceptance
   * criterion, no fixer. That mistook the field for the criterion. *Run it
   * again; green is green* is a criterion, and a harder one than a finding's —
   * machine-checked, and impossible for the code under test to author.
   */
  it("buys one for a command that refused with output, which is what a red build is", () => {
    const decision = decideFix({ refusal: redBuild(), rounds: 1, roundsSpent: 0 });

    expect(decision).toEqual({ fix: true, round: 1, on: "output" });
  });

  it("buys nothing for a command that refused and printed nothing", () => {
    // The other shape of the same bar: a refusal that carries no criterion
    // cannot be handed to an agent, whether the missing thing is a scenario or
    // an output.
    const decision = decideFix({ refusal: redBuild("   "), rounds: 1, roundsSpent: 0 });

    expect(decision.fix).toBe(false);
    expect(decision.fix === false && decision.why).toMatch(/printed nothing/);
  });

  it("buys nothing for an 'observation' with an empty scenario", () => {
    // `parseFindings` drops these, and this is the second place the same rule is
    // enforced rather than assumed — a finding that reached here without one is
    // an opinion, and an agent sent to address an opinion rewrites whatever it
    // likes. **A gate that produced findings is held to them**, and cannot fall
    // through to the output branch because it also printed something.
    const decision = decideFix({
      refusal: refusal([finding({ failureScenario: "   " })], "the reviewer said a lot"),
      rounds: 1,
      roundsSpent: 0,
    });

    expect(decision.fix).toBe(false);
    expect(decision.fix === false && decision.why).toMatch(/no failure scenario/);
  });

  /**
   * What `repair.on: false` used to say, in the block where the other limits
   * are. A boolean beside a count whose zero already means the same thing is a
   * redundant pair (0039 §4).
   */
  it("buys nothing when the recipe asks for no rounds", () => {
    for (const r of [refusal(), redBuild()]) {
      const decision = decideFix({ refusal: r, rounds: 0, roundsSpent: 0 });

      expect(decision.fix).toBe(false);
      expect(decision.fix === false && decision.why).toMatch(/runtime\.limits\.rounds: 0/);
      // **And it says what it refuses, not where the refusal goes.** It used to
      // say "sends every refusal straight to a person", which was true while
      // this was the only ceiling and is false beside a non-zero `restarts`
      // (0040): a person is then the third destination, not the second.
      expect(decision.fix === false && decision.why).not.toMatch(/straight to a person/);
    }
  });

  /**
   * **The rule, as something other than prose** (0040 §Consequences).
   *
   * `decideRestart` asks one question of this decision — *was the ceiling what
   * stopped it* — and it has to be able to ask it without reading a sentence
   * written for a card. `no-criterion` is the one that must not read as a spent
   * budget: a gate that refused with nothing to hold a fixer to is answered no
   * better by a fresh pass than it was by a round.
   */
  it("names the rule that refused, so a caller can decide on it", () => {
    const rules = (decision: ReturnType<typeof decideFix>) =>
      decision.fix === false ? decision.rule : "bought";

    expect(rules(decideFix({ refusal: refusal(), rounds: 0, roundsSpent: 0 }))).toBe("no-rounds");
    expect(rules(decideFix({ refusal: refusal(), rounds: 1, roundsSpent: 1 }))).toBe("spent");
    expect(
      rules(
        decideFix({
          refusal: refusal([finding({ failureScenario: "   " })], "said a lot"),
          rounds: 1,
          roundsSpent: 0,
        }),
      ),
    ).toBe("no-criterion");
    expect(rules(decideFix({ refusal: redBuild("   "), rounds: 1, roundsSpent: 0 }))).toBe(
      "no-criterion",
    );
  });

  it("stops at the ceiling, and says which ceiling", () => {
    expect(decideFix({ refusal: refusal(), rounds: 1, roundsSpent: 1 })).toEqual({
      fix: false,
      rule: "spent",
      why: expect.stringContaining("ceiling of 1 round(s) for this pass"),
    });
    // And a recipe that raised it gets the rounds it asked for.
    expect(decideFix({ refusal: refusal(), rounds: 2, roundsSpent: 1 })).toEqual({
      fix: true,
      round: 2,
      on: "findings",
    });
  });

  /**
   * **The property two purses had, deliberately given up** (0039 §3).
   *
   * 0038 §4 split the ceiling because a shared one is a race: whichever failure
   * happens first decides whether the other gets an attempt at all. That was
   * true while the two failures went to different places. They go to the same
   * place now, so the race is gone and one number is honest — but the number has
   * to be big enough, which is why the schema's default is two and not one. A
   * pass that fixes a red build and then meets a finding needs both rounds.
   *
   * This is the test that would have failed silently under a default of one: it
   * pins that the second kind of failure still gets an attempt after the first
   * has spent a round.
   */
  it("lets a second kind of failure buy a round after the first spent one", () => {
    const after = decideFix({ refusal: refusal(), rounds: 2, roundsSpent: 1 });

    expect(after).toEqual({ fix: true, round: 2, on: "findings" });
  });
});

describe("what the fixer is told", () => {
  const DIFF = "diff --git a/packages/daemon/src/subscribers.ts b/x\n+  } catch {\n+    return ok;";
  const brief = fixBrief({
    refusal: { on: "findings", findings: [finding()] },
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
    expect(brief).toMatch(/fix round\s+1 of 2/);
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
    expect(brief).toMatch(/not given that agent's reasoning\s+either/i);
    expect(brief).toMatch(/No plan, no transcript, no\s+session/i);
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
    expect(brief).toMatch(/Never make\s+the code worse to make the refusal go away/i);
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
    expect(brief).toMatch(/stops this loop and puts\s+the evidence in front of somebody/i);
    // And when to use it, in the terms the fixer can actually check.
    expect(brief).toMatch(/the sequence a finding\s+describes cannot happen/i);
    expect(brief).toMatch(/the failure was not\s+caused by this diff/i);
  });

  it("carries the diff the reviewer was shown, under the same ceiling", () => {
    expect(brief).toContain(DIFF);

    // Clipped rather than unbounded, for 0029's reason: a megabyte handed to an
    // agent produces a worse answer, not a better one.
    const huge = fixBrief({
      refusal: { on: "findings", findings: [finding()] },
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
      refusal: {
        on: "findings",
        findings: [finding(), finding({ file: "apps/board/src/page.tsx", line: 676, severity: "major" })],
      },
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
    stop: { ended: "spent" },
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
      stop: { ended: "no-rounds" },
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
      stop: { ended: "spent" },
    });

    expect(question).toContain("two agents disagreed about agent/123 into main");
    expect(question).toContain("2 findings");
    expect(question).toContain("worst: blocker");
    // And says nothing about restarts, because there have been none. A card on
    // a project that leaves `restarts` at zero reads exactly as it did.
    expect(question).not.toContain("restart");
  });
});

/**
 * **The headline says what stopped the pass** (`#197`).
 *
 * Five endings reach these two functions and they ask a person for five
 * different things — adjudicate, send it again, narrow the ticket, read the
 * objection, look at the reviewer — and for a year all five opened with *This is
 * a judgement, not a broken build*. `#187` ended on a rate limit two minutes
 * before it reset: the fixer had made four edits and was writing tests when it
 * died, and the page opened by asking a person to adjudicate two findings whose
 * answer was half-written.
 *
 * So these assert the *claim* each headline makes and not that the strings
 * differ. Two are load-bearing. The crash must never say judgement, because a
 * person who reads that word acts on it — and **`out-of-turns` must never say
 * *send it again*, because a person who reads that acts on it too**, and this
 * repository has already decided what it costs: `RUN_OWNER` calls the turn
 * limit the repository's own failure and `run-once.ts` blocks a whole run on it
 * with *narrow or split the ticket first; requeued as written, it buys another
 * run to the same limit* (`#89`). The two remedies are opposites, so one
 * sentence for both is worse than no sentence.
 */
describe("the headline says what stopped the pass", () => {
  const card = (stop: FixStop) =>
    diagnoseDisagreement({
      action: "review",
      branch: "agent/187",
      base: "main",
      headSha: "a7663f9000000000",
      findings: [finding(), finding({ severity: "major" })],
      rounds: 2,
      why: "the fixing agent did not finish (crash: it broke), so there is nothing new to read",
      stop,
    });

  /**
   * `#187` itself. The word is the whole of the defect: it is what a person
   * reads, and acting on it means adjudicating a disagreement that never
   * happened.
   */
  it("never calls a crash a judgement, and names what killed the agent", () => {
    const crashed = card({
      ended: "crashed",
      failure: "crash: You've hit your session limit · resets 4:20am (America/Chicago)",
    });

    expect(crashed.what).not.toMatch(/judgement/i);
    expect(crashed.what).not.toMatch(/two agents disagreed/i);
    expect(crashed.what).toContain("did not finish");
    expect(crashed.what).toContain("crash: You've hit your session limit");
    // And says what to do, because there is exactly one thing and it is not a
    // decision: the round answering the findings never committed.
    expect(crashed.what).toMatch(/send it again/i);
    expect(crashed.what).toMatch(/infrastructure and not your call/i);
  });

  /**
   * **The kind is said once, by the only thing that knows it.** `timeout` and
   * `aborted` reach the same ending as `crash` because they imply the same
   * move, and the first draft of this spent that on a sentence reading
   * *crashed … — timeout: the 2h wall reached*, which contradicts itself
   * between one dash and the next. A reader deciding whether to look at the
   * machine or the clock is being told both.
   */
  it("does not call a timeout a crash, because the same ending carries three kinds", () => {
    const walled = card({ ended: "crashed", failure: "timeout: the 2h wall reached" });

    expect(walled.what).not.toMatch(/crash/i);
    expect(walled.what).toContain("timeout: the 2h wall reached");
    expect(walled.what).toMatch(/send it again/i);
  });

  /**
   * **The ending this round of `#197` exists for.** `out-of-turns` was landing
   * in the crash's arm, so the card opened by calling the agent crashed and
   * closed by telling a person to send it again. Both halves are refuted by
   * code that was already there: `attribution.ts`'s `RUN_OWNER` marks the turn
   * limit the *repository's* failure, and `run-once.ts` blocks a whole run that
   * ends this way with *narrow or split the ticket first; requeued as written,
   * it buys another run to the same limit*. A person who followed the headline
   * bought a second 300-turn budget that ended the same way.
   */
  it("never tells a person to re-send a ticket that spent the turn limit", () => {
    const overspent = card({
      ended: "out-of-turns",
      failure: "out-of-turns: 300 turns, and the recipe allows 300 · $4.10",
    });

    // The two sentences the crash's arm would have produced, and neither is true.
    expect(overspent.what).not.toMatch(/send it again/i);
    expect(overspent.what).not.toMatch(/crash/i);
    // Nor is the one the ceiling's arm would have produced.
    expect(overspent.what).not.toMatch(/judgement/i);
    expect(overspent.what).not.toMatch(/two agents disagreed/i);
    // What is true, in the words `run-once.ts` already blocks a run with.
    expect(overspent.what).toMatch(/ran out of turns/i);
    expect(overspent.what).toMatch(/scope alarm/i);
    expect(overspent.what).toMatch(/narrowing or splitting the ticket/i);
    expect(overspent.what).toContain("out-of-turns: 300 turns, and the recipe allows 300");
  });

  /**
   * The record that decides it, read row by row — because the defect above was
   * not a sentence, it was *everything that is not `never-started` is a crash*.
   * A seventh `RunFailureKind` fails to compile here rather than silently
   * inheriting the wrong remedy.
   */
  it("reads the ending off the failure kind, and the turn limit is its own", () => {
    expect(fixStopOf({ kind: "out-of-turns", detail: "300 turns" })).toEqual({
      ended: "out-of-turns",
      failure: "out-of-turns: 300 turns",
    });
    for (const kind of ["crash", "timeout", "aborted", "no-commits"] as const) {
      expect(fixStopOf({ kind, detail: "why" }).ended).toBe("crashed");
    }
    // And the kind survives into the sentence rather than being replaced by it.
    expect(fixStopOf({ kind: "timeout", detail: "the 2h wall reached" }).ended).toBe("crashed");
    expect(card(fixStopOf({ kind: "timeout", detail: "the 2h wall reached" })).what).toContain(
      "timeout: the 2h wall reached",
    );
  });

  /** Clipped, because this one sits inside the first sentence a person reads. */
  it("clips a long failure rather than making the headline scroll", () => {
    const crashed = card({ ended: "crashed", failure: `crash: ${"z".repeat(5_000)}` });

    expect(crashed.what).toContain("…");
    expect(crashed.what.length).toBeLessThan(700);
  });

  /**
   * An argument, and the one ending where the findings are not what to read
   * first. 0039 §5's point, carried all the way to the headline.
   */
  it("opens a decline with the decline, and points at the objection", () => {
    const declined = card({ ended: "declined" });

    expect(declined.what).toMatch(/declined/i);
    expect(declined.what).toMatch(/objection is what to read first/i);
    expect(declined.what).not.toMatch(/two agents disagreed/i);
    expect(declined.what).not.toMatch(/broken build\.$/);
  });

  /** The reviewer is the subject. Describing the diff would point at the wrong thing. */
  it("says the reviewer produced nothing actionable, rather than describing the diff", () => {
    const opinion = card({ ended: "no-criterion" });

    expect(opinion.what).toMatch(/no failure scenario|carries a failure scenario/i);
    expect(opinion.what).toMatch(/reviewer is what to look at here, not the diff/i);
    expect(opinion.what).not.toMatch(/judgement/i);
  });

  /**
   * **The common case, byte for byte.** Fixing the other four must not cost the
   * one that was right: a real disagreement is the only ending where two agents
   * looked at this and did not agree.
   */
  it("leaves a real disagreement exactly as it was", () => {
    const spent = card({ ended: "spent" });

    expect(spent.what).toBe(
      "Two agents disagreed about agent/187 at a7663f9. The `review` reviewer refused it " +
        "with 2 findings (worst: blocker), and it is still refused. This is a judgement, " +
        "not a broken build.",
    );
  });

  /**
   * **A recipe that buys no round is not two agents disagreeing**, and this is
   * the rule that used to share the ceiling's sentence — the last place `#197`'s
   * defect survived after the crash, the turn limit, the decline and the
   * criterion each got an arm. `rounds: 0` is `decideFix`'s `no-rounds`: the
   * reviewer refused and nothing was ever bought to answer it, so exactly one
   * agent looked at the diff. The findings may be right; nothing has argued
   * either way, and the sentence must not imply something did.
   */
  it("does not say two agents disagreed where a recipe bought no round", () => {
    const none = card({ ended: "no-rounds" });

    expect(none.what).not.toMatch(/two agents disagreed/i);
    expect(none.what).not.toMatch(/still refused/i);
    expect(none.what).toMatch(/one agent refused/i);
    expect(none.what).toMatch(/buys no round of fix-and-recheck/i);
    // And what changes it: money, not correctness.
    expect(none.what).toContain("runtime.limits.rounds");
    expect(none.what).not.toBe(card({ ended: "spent" }).what);
  });

  /**
   * The ticket's own condition, read as one assertion rather than five: **no
   * two rules share a headline.** Each of `FixStop`'s endings asks a person for
   * a different move, so two that read alike are two a reader cannot tell
   * apart — which is the whole of what `#187` cost.
   */
  it("gives every ending a headline of its own", () => {
    const whats = (
      [
        { ended: "crashed", failure: "crash: it broke" },
        { ended: "out-of-turns", failure: "out-of-turns: 300 turns" },
        { ended: "declined" },
        { ended: "no-criterion" },
        { ended: "no-rounds" },
        { ended: "spent" },
      ] satisfies FixStop[]
    ).map((stop) => card(stop).what);

    expect(new Set(whats).size).toBe(whats.length);
  });

  /**
   * **The line printed directly above the headline** (`describeHold`, #83).
   * `needs` was `judgement` whatever stopped the pass, so a crashed fixer's card
   * read *your judgement is needed* and then *this is infrastructure and not
   * your call* — the contradiction `#197` is about, one line earlier than the
   * page it was found on.
   */
  it("asks for an acknowledgement where the headline says it is not your call", () => {
    expect(stopNeeds({ ended: "crashed", failure: "crash: it broke" })).toBe("acknowledgement");
    expect(stopNeeds({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" })).toBe(
      "acknowledgement",
    );
    // The four that leave something to weigh: a live refusal, an objection, an
    // opinion to merge over.
    expect(stopNeeds({ ended: "declined" })).toBe("judgement");
    expect(stopNeeds({ ended: "no-criterion" })).toBe("judgement");
    expect(stopNeeds({ ended: "no-rounds" })).toBe("judgement");
    expect(stopNeeds({ ended: "spent" })).toBe("judgement");
  });

  /**
   * The evidence under the headline is untouched by which ending it is (#83).
   * The headline is a reading; `done` and `raw` are what it was made from, and
   * `run-once.ts` was already composing the true sentence in `why`.
   */
  it("changes only the headline — done and raw are the same whatever stopped it", () => {
    const crashed = card({ ended: "crashed", failure: "crash: it broke" });
    const spent = card({ ended: "spent" });

    expect(crashed.done).toBe(spent.done);
    expect(crashed.raw).toBe(spent.raw);
    expect(crashed.done).toContain("the fixing agent did not finish (crash: it broke)");
    expect(crashed.raw).toContain(SCENARIO.split("\n")[0]!);
  });

  /**
   * The sibling has the same defect in its own words: *it ran again and said
   * the same thing* is false of a round that produced no commit. `#176` and
   * `#177` ended on a full disk and arrived under exactly that sentence.
   */
  describe("and a red check says the same, in its own words", () => {
    const red = (stop: FixStop) =>
      diagnoseUnfixed({
        action: "build",
        branch: "agent/176",
        headSha: "deadbee0000000",
        evidence: "ENOSPC: no space left on device",
        rounds: 1,
        why: "the fixing agent did not finish (crash: ENOSPC), so nothing new was produced",
        stop,
      });

    it("does not claim the check ran again when the fixer crashed", () => {
      const crashed = red({ ended: "crashed", failure: "crash: ENOSPC: no space left on device" });

      expect(crashed.what).not.toMatch(/ran again and said the same thing/i);
      expect(crashed.what).toContain("did not finish");
      expect(crashed.what).toContain("ENOSPC");
      expect(crashed.what).toMatch(/send it again/i);
    });

    /** The same opposite, in the red check's words. */
    it("does not tell a person to re-send a check whose fixer spent the turn limit", () => {
      const overspent = red({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" });

      expect(overspent.what).not.toMatch(/ran again and said the same thing/i);
      expect(overspent.what).not.toMatch(/send it again/i);
      expect(overspent.what).not.toMatch(/crash/i);
      expect(overspent.what).toMatch(/turn limit/i);
      expect(overspent.what).toMatch(/narrowing or splitting the ticket/i);
      expect(overspent.what).toContain("out-of-turns: 300 turns");
    });

    it("does not claim it ran again when the fixer declined either", () => {
      const declined = red({ ended: "declined" });

      expect(declined.what).toMatch(/declined/i);
      expect(declined.what).not.toMatch(/ran again and said the same thing/i);
      expect(declined.what).toMatch(/argument and not a check\s+that stayed red/i);
    });

    /**
     * The same rule the sibling's last arm was about, and the same falsehood:
     * a recipe that buys no round never ran the check twice, so *it ran again
     * and said the same thing* is a claim about something that did not happen.
     * The difference matters to a reader deciding how much one red result is
     * worth.
     */
    it("does not claim it ran again where a recipe bought no round", () => {
      const none = red({ ended: "no-rounds" });

      expect(none.what).not.toMatch(/ran again and said the same thing/i);
      expect(none.what).toMatch(/never run again/i);
      expect(none.what).toMatch(/buys no round of fix-and-recheck/i);
    });

    it("leaves a check that really did stay red exactly as it was", () => {
      expect(red({ ended: "spent" }).what).toBe(
        "`build` still refuses agent/176 at deadbee. This is a check that failed and " +
          "stayed failed, not a judgement: whatever it runs, it ran again and said the " +
          "same thing.",
      );
    });
  });

  /**
   * **And the line above the headline says it too.**
   *
   * `question` is what a person is actually notified with — the GitHub comment,
   * the board's note, the line `lingtai status` prints — so it is read *before*
   * the card, and for the whole of `#197`'s first draft it went on saying *two
   * agents disagreed* over a headline saying a fixing agent had been killed. Of
   * two readings that contradict each other, the one a person acts on is the one
   * they reach first.
   *
   * `run-once.ts` passes `stop` by spreading `unresolved`, so these are what
   * pins the line: nothing at that call site would fail if these functions
   * stopped reading it.
   */
  describe("and so does the one line a person is notified with", () => {
    const line = (stop: FixStop) =>
      disagreementQuestion({
        action: "review",
        branch: "agent/187",
        base: "main",
        findings: [finding(), finding({ severity: "major" })],
        rounds: 2,
        stop,
      });

    it("does not say two agents disagreed when one of them never answered", () => {
      const crashed = line({ ended: "crashed", failure: "crash: session limit" });
      const overspent = line({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" });
      const declined = line({ ended: "declined" });
      const opinion = line({ ended: "no-criterion" });

      for (const said of [crashed, overspent, declined, opinion]) {
        expect(said).not.toMatch(/two agents disagreed/i);
      }
      expect(crashed).toMatch(/did not finish/i);
      expect(crashed).toContain("crash: session limit");
      expect(declined).toMatch(/declined/i);
      expect(opinion).toMatch(/no failure scenario/i);
    });

    /** The same opposite remedies, at the same length. */
    it("keeps the turn limit off a retry on the one line too", () => {
      const overspent = line({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" });

      expect(overspent).toMatch(/ran out of turns/i);
      expect(overspent).toMatch(/needs narrowing, not a retry/i);
      expect(overspent).not.toMatch(/crash/i);
    });

    /**
     * Clipped harder than the headline: this is a whole GitHub comment body and
     * a `lingtai status` row, so a five-thousand-character quota message would
     * be the whole of both.
     */
    it("clips the failure to a line rather than a paragraph", () => {
      const crashed = line({ ended: "crashed", failure: `crash: ${"z".repeat(5_000)}` });

      expect(crashed).toContain("…");
      expect(crashed.length).toBeLessThan(260);
    });

    /** Byte for byte, both halves, for the ending that really was a disagreement. */
    it("leaves the ceiling's line exactly as it was", () => {
      expect(line({ ended: "spent" })).toBe(
        "two agents disagreed about agent/187 into main: the review reviewer still " +
          "refuses it after 2 fix round(s), with 2 findings (worst: blocker)",
      );
      // And the rule that never bought one says so, rather than borrowing it.
      expect(line({ ended: "no-rounds" })).not.toMatch(/two agents disagreed/i);
      expect(line({ ended: "no-rounds" })).toMatch(/buys no fix round/i);
      expect(
        unfixedQuestion({
          action: "build",
          branch: "agent/176",
          base: "main",
          rounds: 1,
          stop: { ended: "spent" },
        }),
      ).toBe("build still refuses agent/176 into main after 1 fix round(s)");
    });

    /** The red check's line has the same three endings to tell apart. */
    it("says what stopped a red check's pass, on its one line", () => {
      const red = (stop: FixStop) =>
        unfixedQuestion({
          action: "build",
          branch: "agent/176",
          base: "main",
          rounds: 1,
          stop,
        });

      expect(red({ ended: "crashed", failure: "crash: ENOSPC" })).toMatch(
        /did not finish.*never re-run.*crash: ENOSPC/,
      );
      expect(red({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" })).toMatch(
        /ran out of turns.*needs narrowing, not a retry/,
      );
      expect(red({ ended: "declined" })).toMatch(/declined.*said why instead/);
    });
  });

  /**
   * **And the third sentence, which is the one nothing ever rewrites.**
   *
   * `ApprovalRequested.question` goes on the run's stream and stays there: it is
   * what a later pass reads back, what `lingtai status` prints and what the
   * approval prompt asks. `#187`'s rate limit is recorded under *Two agents
   * disagreed* for good, and a card fixed above a record that says otherwise is
   * the two-readings failure #83 names, with the log on the wrong side of it.
   */
  describe("and the record a merge is approved against", () => {
    const clause = (stop: FixStop, on: "findings" | "output" = "findings") =>
      mergeAnywayBecause({ action: on === "findings" ? "review" : "build", on, rounds: 2, stop });

    it("does not record a disagreement where an agent was stopped", () => {
      const crashed = clause({ ended: "crashed", failure: "crash: session limit" });
      const overspent = clause({ ended: "out-of-turns", failure: "out-of-turns: 300 turns" });

      expect(crashed).not.toMatch(/two agents disagreed/i);
      expect(crashed).toMatch(/did not finish.*nothing was decided/i);
      expect(overspent).not.toMatch(/two agents disagreed/i);
      expect(overspent).toMatch(/needs narrowing, not a retry/i);
    });

    it("says which of the other three it is", () => {
      expect(clause({ ended: "declined" })).toMatch(/declined.*read its objection first/i);
      expect(clause({ ended: "no-criterion" })).toMatch(/nothing a fixing agent could be held to/i);
      expect(clause({ ended: "no-rounds" })).toMatch(/buys no fix round/i);
    });

    /** Byte for byte, both shapes, for the ending they were always true of. */
    it("leaves the ceiling's record exactly as it was", () => {
      expect(clause({ ended: "spent" })).toBe(
        "Two agents disagreed: the review reviewer still refuses it after 2 fix round(s).",
      );
      expect(clause({ ended: "spent" }, "output")).toBe(
        "`build` is still red after 2 fix round(s).",
      );
    });
  });
});

/**
 * **Every arm's findings on the card** (0040 §3), which is the criterion the
 * second ceiling stands or falls on.
 *
 * Each arm's refusal lives on a run stream no later pass reads, so if
 * `PassRestarted` did not carry the findings and this did not quote them, a
 * person handed the item after the last restart would see one refusal and have
 * to guess whether the earlier approaches were refused for the same reason.
 * That guess is the judgement they are being asked to make: arm A's third
 * refusal in experiment 011 was a defect round 2 had created, and two arms
 * refused for the *same* reason would say the ticket is wrong rather than the
 * approach.
 */
describe("what a person is shown when the restarts are over too", () => {
  const earlier = {
    restart: 1,
    of: 2,
    action: "review",
    // The arm's own ref, which is what `PassRestarted` records: `agent/123`
    // itself is the newest arm and this one is two force-pushes ago.
    branch: "agent/123-restart-1",
    headSha: "8634c5d0000000",
    rounds: 3,
    findings: [
      finding({
        file: "packages/daemon/src/daemon.ts",
        line: 124,
        severity: "major",
        claim: "startBeacon sits between the lock and the try/catch that releases it",
        failureScenario: "the first beat throws; startDaemon exits holding the conductor lock",
      }),
    ],
  };
  const diagnosis = diagnoseDisagreement({
    action: "review",
    branch: "agent/123",
    base: "main",
    headSha: "c0ffee1234567890",
    findings: [finding()],
    rounds: 3,
    why: "the ceiling of 2 restart(s) for this item is spent, and the review reviewer still refuses",
    stop: { ended: "spent" },
    earlier: [earlier],
  });

  it("says how many approaches, so the ticket is what reads as in doubt", () => {
    expect(diagnosis.what).toContain("This is approach 2");
    expect(diagnosis.what).toContain("the ticket and not only this diff");
  });

  it("keeps every arm's findings, each said whose it is", () => {
    expect(diagnosis.raw).toContain("this approach · agent/123@c0ffee1");
    expect(diagnosis.raw).toContain(
      "restart 1 of 2 · review refused agent/123-restart-1@8634c5d after 3 round(s)",
    );
    // The abandoned arm's scenario verbatim, which is the thing that would
    // otherwise be gone: its run's stream is not read by any later pass.
    expect(diagnosis.raw).toContain("startDaemon exits holding the conductor lock");
    // And this arm's, still.
    expect(diagnosis.raw).toContain(SCENARIO.split("\n")[0]!);
  });

  it("leaves a card with no restarts exactly as it was", () => {
    const one = diagnoseDisagreement({
      action: "review",
      branch: "agent/123",
      base: "main",
      headSha: "c0ffee1234567890",
      findings: [finding()],
      rounds: 3,
      why: "the ceiling of 3 round(s) for this pass is spent, and the review action still refuses",
      stop: { ended: "spent" },
    });

    // 0040 §4 read all the way down to the bytes: no headings, no framing,
    // nothing for a reader on a project that buys no restart to notice.
    expect(one.raw).toBe(quoteFindings([finding()]));
    expect(one.what).not.toContain("approach");
  });

  it("puts the arm count on the one line too", () => {
    expect(
      disagreementQuestion({
        action: "review",
        branch: "agent/123",
        base: "main",
        findings: [finding()],
        rounds: 3,
        restarts: 2,
        stop: { ended: "spent" },
      }),
    ).toContain("after 3 fix round(s) and 2 restart(s)");
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
/**
 * The third shape, and the only one where the agent does not arrive at a clean
 * tree (0039 §2).
 *
 * A conflict is the refusal that used to cost the most: the lane aborted, the
 * item went back to the queue, and a whole new run re-implemented a branch that
 * was finished and green and needed a merge resolved. git had already named the
 * files. What it needed was somewhere to send it back to, which is what
 * `#140` built.
 */
describe("what a conflict tells the fixer", () => {
  const brief = fixBrief({
    refusal: { on: "conflict", base: "main", paths: "src/queue.ts\npackages/domain/src/events.ts" },
    round: 1,
    of: 2,
    action: "merge",
    diff: "diff --git a/src/queue.ts b/src/queue.ts",
    diffBytes: 400_000,
  });

  it("says the agent is mid-merge, because a description is not resolvable", () => {
    expect(brief).toMatch(/in the middle of that merge right now/i);
    expect(brief).toMatch(/conflicts are in your working tree, with markers/i);
    expect(brief).toContain("`main` moved");
  });

  it("names the files git named", () => {
    expect(brief).toContain("src/queue.ts");
    expect(brief).toContain("packages/domain/src/events.ts");
  });

  /**
   * The strictest acceptance test of the three, and the only one that is two
   * things. Taking one side wholesale merges cleanly and is exactly the wrong
   * answer, so the second half — the point runs again — is what catches it.
   */
  it("asks for both the merge and the point, and refuses picking a side", () => {
    expect(brief).toMatch(/the whole `proposed` point runs\s+again/i);
    expect(brief).toMatch(/both have to\s+pass/i);
    expect(brief).toMatch(/--ours` and `--theirs` wholesale are not a resolution/i);
    expect(brief).toMatch(/Do not\s+`git merge --abort`/i);
  });

  it("says the base may move again, so a second round reads as ordinary", () => {
    expect(brief).toMatch(/base can move again while you work/i);
  });

  it("keeps the decline, which is the same escape the other two have", () => {
    expect(brief).toMatch(/change nothing and commit nothing/i);
  });
});

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
