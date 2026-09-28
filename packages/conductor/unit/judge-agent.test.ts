/**
 * **An agent, paid for a judgement** — the prompt it is given and the reading of
 * what it says (`#277`).
 *
 * The two functions are pure and the cases are about the one property each has.
 * `judgePrompt` must carry **the set and no count**, which is `JudgeBrief`'s
 * safety property kept at the place the money is actually spent: a judge that
 * could see `rounds` could argue about it, and nothing anywhere would report a
 * fault. `chosenIn` must read an answer the way `parseFindings` does — a model
 * asked for JSON usually gives JSON, and the run where it does not must not
 * become a crash with no verdict.
 *
 * **What is deliberately not asserted is that the answer is on offer.** Holding
 * one to the set is `judged`'s in `pass-steps.ts`, where the offer and the
 * ceilings are, and it is asserted there; a second copy of that rule here would
 * be the divergence the single reader exists to prevent.
 *
 * Unit, under `--project unit`: nothing here spawns anything or reads a file.
 */
import { describe, expect, it } from "vitest";
import type { ActionFinding } from "@lingtai/actions";
import { chosenIn, judgePrompt } from "../src/judge-agent.ts";
import type { Judging } from "../src/pass-steps.ts";

const BLOCKER: ActionFinding = {
  file: "packages/conductor/src/conduct.ts",
  line: 1761,
  claim: "the judge is asked before the worktree exists",
  failureScenario: "a refusal at `admit` reaches the router and `cutTree()` throws",
  severity: "blocker",
};

const ARRIVED: Judging = {
  when: "findings",
  offering: ["waiting", "claim", "implement"],
  findings: [BLOCKER],
  evidence: "1 blocker, 0 major, 2 minor",
};

describe("what a runtime judge is asked", () => {
  /**
   * **The set, and no count** — the negative half of `JudgeBrief` asserted where
   * it is serialized to a model rather than only where the object is built.
   *
   * `Judging` carries no ceiling, so there is nothing here for a prompt to leak;
   * this is the case that fails the day somebody adds one *for context*, which is
   * how it would be added. A judge cannot widen what it cannot see.
   */
  it("carries the offered steps and not one ceiling", () => {
    const prompt = judgePrompt(ARRIVED);

    for (const to of ARRIVED.offering) expect(prompt, to).toContain(`\`${to}\``);
    // The words that name a ceiling, none of which a judge may be told. *Another
    // round* is in it and is not one of them: it is what `implement` **means**,
    // where `rounds` is how many of them are left — and the second is the one a
    // judge could argue with.
    for (const ceiling of ["rounds", "restarts", "spent", "limit", "budget"]) {
      expect(prompt, ceiling).not.toContain(ceiling);
    }
    // And nothing that is not on offer is named as a thing to ask for.
    expect(prompt).not.toContain("`build`");
  });

  /** The findings verbatim, and the direction, which is what it is judging. */
  it("shows the findings and what the step printed", () => {
    const prompt = judgePrompt(ARRIVED);

    expect(prompt).toContain(BLOCKER.claim);
    expect(prompt).toContain(BLOCKER.failureScenario);
    expect(prompt).toContain(`${BLOCKER.file}:${BLOCKER.line}`);
    expect(prompt).toContain(ARRIVED.evidence);
    expect(prompt).toContain("`findings`");
    // The question, and it is `#223`'s distinction rather than *is this good*.
    expect(prompt).toContain("whether the lines are wrong or the approach is");
  });

  /**
   * **A direction with no findings is the ordinary case for four of the five**,
   * and the prompt says so rather than rendering an empty list a model then
   * reasons about.
   */
  it("says so where there are no findings and nothing was printed", () => {
    const prompt = judgePrompt({ ...ARRIVED, when: "red", findings: [], evidence: "  " });

    expect(prompt).toContain("raised no findings");
    expect(prompt).toContain("printed nothing");
    // No empty block where the output would have been, and no heading over it.
    expect(prompt).not.toContain("What the step printed");
  });
});

describe("what it answered", () => {
  /** The ordinary case: one fenced object, and the reason travels with it. */
  it("reads a fenced answer", () => {
    expect(
      chosenIn('Having read them:\n\n```json\n{"next": "claim", "why": "the seam is wrong"}\n```'),
    ).toEqual({ next: "claim", why: "the seam is wrong" });
  });

  /**
   * **Where the answer starts is not the first brace in it** (`#272`, and
   * `parseFindings`' own case). A judge that quotes the code it is judging writes
   * braces in its prose, and the more precisely it quotes the likelier that is —
   * so every brace is a candidate, tried last first, because the object is what
   * the answer *ends* in.
   */
  it("reads an answer after prose that quotes a brace", () => {
    const said =
      'The finding cites `StepPassed` = `{ending:"passed"}`, which is right.\n\n' +
      '{"next": "implement", "why": "two lines, and the shape is right"}';

    expect(chosenIn(said)).toEqual({ next: "implement", why: "two lines, and the shape is right" });
  });

  /**
   * **A destination the offer did not contain comes back, and is not dropped.**
   *
   * This is the one place being permissive is the safe thing: the refusal a
   * person reads names what the judge asked for and which ceiling refused it
   * (`judged`, `becauseSpent`), and a null here would put *the judge said
   * nothing* on the card for a judge that said `implement` with the rounds spent
   * — sending somebody to look for a broken model instead of a number they can
   * raise.
   */
  it("returns a destination that was not on offer, so the refusal can name it", () => {
    expect(chosenIn('{"next": "merge", "why": "just land it"}')).toEqual({
      next: "merge",
      why: "just land it",
    });
  });

  /**
   * **Null is *it judged nothing*, and it is not `waiting`.** A reviewer whose
   * answer will not parse has not reviewed (`agent-action.ts`); a judge whose
   * answer will not parse has not judged, and the caller says so in the words on
   * the card rather than filing it as a choice somebody made.
   */
  it("answers nothing for an answer that names no destination", () => {
    expect(chosenIn(null)).toBeNull();
    expect(chosenIn("")).toBeNull();
    expect(chosenIn("I think they should probably start over, honestly.")).toBeNull();
    // A readable object naming something that is not a step at all.
    expect(chosenIn('{"next": "start-over", "why": "the approach"}')).toBeNull();
    // And a truncated answer parses at no position, which stays a refusal.
    expect(chosenIn('{"next": "claim", "why": "the sea')).toBeNull();
  });

  /** A choice with no reason is still a choice, and the card still gets a sentence. */
  it("keeps a destination whose reason is missing", () => {
    expect(chosenIn('{"next": "waiting"}')).toEqual({ next: "waiting", why: "it gave no reason" });
    expect(chosenIn('{"next": "waiting", "why": "   "}')).toEqual({
      next: "waiting",
      why: "it gave no reason",
    });
  });
});
