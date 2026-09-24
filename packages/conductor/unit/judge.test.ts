/**
 * **The workflow counts; the judge chooses** —
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3, and the
 * two rules that make a replaceable judge safe.
 *
 * Both are about the same asymmetry, so the cases are written against it rather
 * than against the functions:
 *
 *     a misconfiguration that fails    is cheap — it errors, you fix it
 *     a misconfiguration that loops    is not — it never errors, it only spends
 *
 * So what is asserted is not *the built-in gives a sensible answer*. It is that
 * **no judge, however written, can answer its way past a ceiling**: the numbers
 * are never in front of one, the set it is handed is the workflow's arithmetic,
 * and an answer outside the set is refused by name and lands on a person. A
 * judge that could widen either bound could answer *back to `implement`* for
 * ever at ~$3.40 a round with nothing reporting a fault, which is the failure
 * every case below is an angle on.
 *
 * The second rule gets its own cases because it is the one a reader assumes
 * away: **the offered set depends on how far the pass got, not only on what is
 * left to spend.** `prepared` refuses before any agent has run, and `implement`
 * is off the set there with every round unspent.
 *
 * Unit, under `--project unit`: nothing here reads a database, spawns anything
 * or touches the filesystem.
 */
import { describe, expect, it } from "vitest";
import type { GateFinding } from "@lingtai/actions";
import { STEPS } from "@lingtai/domain";
import { BUILT_IN_JUDGES, JudgeWhen, judgePlugin, readFields } from "@lingtai/recipe";
import {
  BUILT_IN,
  BUILT_IN_FOR,
  DESTINATIONS,
  type Destination,
  type Judge,
  type JudgeBrief,
  askJudge,
  stepsOnOffer,
} from "../src/judge.ts";

const FINDING: GateFinding = {
  file: "packages/conductor/src/run-once.ts",
  line: 1761,
  claim: "the decision that costs the most money is invisible",
  failureScenario: "a review refuses twice about the approach; every round patches the lines",
  severity: "major",
};

/** A pass that has run an agent, has rounds and restarts left, and nobody else waiting. */
const EVERYTHING = {
  reached: "proposed",
  rounds: 2,
  roundsSpent: 0,
  restarts: 1,
  restartsSpent: 0,
  alsoAsked: null,
} as const;

function brief(when: JudgeWhen, offer: readonly Destination[]): JudgeBrief {
  return { when, reason: "the review action refused", findings: [FINDING], offer };
}

describe("the set is the workflow's", () => {
  /**
   * The rule stated as arithmetic: `implement` leaves the set the round the
   * ceiling is reached, and no input a judge has any part in brings it back.
   */
  it("takes `implement` off the set when the rounds are spent", () => {
    expect(stepsOnOffer({ ...EVERYTHING, when: "red", roundsSpent: 1 })).toContain("implement");
    expect(stepsOnOffer({ ...EVERYTHING, when: "red", roundsSpent: 2 })).not.toContain("implement");
    // And a recipe that never patches is the same fact with the ceiling at zero
    // — `rounds: 0` is a legible configuration and not a disabled feature.
    expect(stepsOnOffer({ ...EVERYTHING, when: "red", rounds: 0 })).toEqual(["human"]);
  });

  /**
   * **The half a reader assumes away** (0061 §3). `prepared` refuses before any
   * agent has run — a failed install — so there is no diff and no error in one
   * to fix, and `implement` is off the set with *every* round unspent. A judge
   * that knows nothing about `prepared` still cannot choose wrongly, because
   * the wrong answer was never in the set.
   */
  it("takes `implement` off the set before an agent has run, whatever is left to spend", () => {
    const early = stepsOnOffer({ ...EVERYTHING, when: "red", reached: "prepared" });
    expect(early).toEqual(["human"]);
    // Not a fact about `prepared`'s name: it is where the step sits in the pass.
    for (const reached of STEPS.slice(0, STEPS.indexOf("implement"))) {
      expect(stepsOnOffer({ ...EVERYTHING, when: "red", reached }), reached).not.toContain(
        "implement",
      );
    }
    for (const reached of STEPS.slice(STEPS.indexOf("implement"))) {
      expect(stepsOnOffer({ ...EVERYTHING, when: "red", reached }), reached).toContain("implement");
    }
  });

  /**
   * `restarts` is the breadth ceiling and it bounds the same way, with the
   * extra rule 0039 §2 keeps in code: only a judgement buys a fresh approach.
   * No number a project writes down should make a typecheck error buy a new
   * worktree, and no judge should be able to either.
   */
  it("offers `claim` only for a judgement, and only while restarts are left", () => {
    expect(stepsOnOffer({ ...EVERYTHING, when: "findings" })).toContain("claim");
    expect(stepsOnOffer({ ...EVERYTHING, when: "findings", restartsSpent: 1 })).not.toContain(
      "claim",
    );
    for (const when of ["red", "gate-failed", "conflict", "needs-input"] as const) {
      expect(stepsOnOffer({ ...EVERYTHING, when }), when).not.toContain("claim");
    }
    // Somebody else is waiting on this pass, and releasing the item would throw
    // their question away — `decideRestart`'s own rule, kept on this side of
    // the line because it is a fact about what the pass may do.
    expect(
      stepsOnOffer({ ...EVERYTHING, when: "findings", alsoAsked: "the approve action" }),
    ).not.toContain("claim");
  });

  /** Never empty, so no judge is ever cornered and every refusal has somewhere to land. */
  it("always offers a person", () => {
    for (const when of JudgeWhen.options) {
      for (const reached of STEPS) {
        const offer = stepsOnOffer({ ...EVERYTHING, when, reached, rounds: 0, restarts: 0 });
        expect(offer, `${when} at ${reached}`).toContain("human");
        expect(offer.every((step) => DESTINATIONS.includes(step))).toBe(true);
      }
    }
  });
});

describe("the judge chooses, and cannot widen anything", () => {
  /**
   * **The numbers are not in front of it.** The safety property is negative and
   * so is the assertion: a judge cannot widen a ceiling it is never shown, so
   * the brief is checked for what it does *not* carry as carefully as for what
   * it does.
   */
  it("hands the judge the set and never the counts", async () => {
    let seen: JudgeBrief | null = null;
    const nosy: Judge = (b) => {
      seen = b;
      return "human";
    };
    const offer = stepsOnOffer({ ...EVERYTHING, when: "findings" });
    await askJudge("claude-code", nosy, brief("findings", offer));

    expect(Object.keys(seen!).sort()).toEqual(["findings", "offer", "reason", "when"]);
    expect(seen!.offer).toEqual(["implement", "claim", "human"]);
    expect(JSON.stringify(seen)).not.toContain("rounds");
    expect(JSON.stringify(seen)).not.toContain("restarts");
  });

  /**
   * **The ceiling, from the judge's side.** Rounds spent, so `implement` is not
   * offered; a judge that asks for it anyway is refused by name and the pass is
   * held for a person. This is the loop that would otherwise never terminate,
   * and it terminates in one pass.
   */
  it("refuses a step it did not offer, and holds for a person instead", async () => {
    const offer = stepsOnOffer({ ...EVERYTHING, when: "findings", roundsSpent: 2 });
    expect(offer).not.toContain("implement");

    const greedy: Judge = () => "implement";
    const answered = await askJudge("my-own-judge", greedy, brief("findings", offer));

    expect(answered.next).toBe("human");
    expect(answered.refused).toContain('"my-own-judge"');
    expect(answered.refused).toContain('"implement"');
    expect(answered.refused).toContain('"findings"');
    // It says what *was* on offer, so the entry to fix is readable off the card.
    expect(answered.refused).toContain('"claim", "human"');
  });

  /**
   * And the same refusal for `prepared`, where `implement` was never reached —
   * the second rule proved at the seam rather than only at `stepsOnOffer`. The
   * judge here is the one a project would plausibly write: it knows `red` means
   * *go back and fix it* and nothing about which step refused.
   */
  it("refuses it again where no agent ever ran, with every round unspent", async () => {
    const offer = stepsOnOffer({ ...EVERYTHING, when: "red", reached: "prepared" });
    expect(offer).toEqual(["human"]);

    const naive: Judge = () => "implement";
    const answered = await askJudge("same-worktree-but-mine", naive, brief("red", offer));

    expect(answered.next).toBe("human");
    expect(answered.refused).toContain("not one of the steps it was offered");
    expect(answered.refused).toContain('"human"');
  });

  /** An answer from the set is passed straight through, and says nothing was overruled. */
  it("takes an answer that is on offer", async () => {
    const offer = stepsOnOffer({ ...EVERYTHING, when: "findings" });
    // Annotated rather than inferred: `Judge` returns `Destination |
    // Promise<Destination>`, and an `async` body takes no contextual return
    // type from a union, so a bare `async () => "claim"` widens to
    // `Promise<string>` and stops type-checking. Writing the awaited type here
    // keeps this the async half — the shape an agent judge has.
    const thoughtful: Judge = async (): Promise<Destination> => "claim";
    expect(await askJudge("claude-code", thoughtful, brief("findings", offer))).toEqual({
      next: "claim",
      refused: null,
    });
  });

  /**
   * **No plugin can widen either bound, because neither is a field it has.**
   * The recipe-side half of the same property: `rounds` and `restarts` are
   * universal keys on the steps they bound, and a recipe writing one under a
   * judge is refused by name, listing what the plugin does declare (0061 §9).
   */
  it("declares no ceiling of its own", () => {
    expect(judgePlugin.declares).toEqual(["name", "judge", "when"]);
    for (const ceiling of ["rounds", "restarts"] as const) {
      const problems = readFields(judgePlugin, {
        name: "the lines or the approach",
        judge: "claude-code",
        when: "findings",
        [ceiling]: 9,
      }).problems!;
      expect(problems).toHaveLength(1);
      expect(problems[0]!.field).toBe(ceiling);
      expect(problems[0]!.why).toContain(`"judge" declares no "${ceiling}" field`);
    }
  });
});

describe("the mechanical directions spend nothing", () => {
  /**
   * **Synchronous is the declaration**, and it is why this is an assertion
   * rather than a comment: nothing that dispatches an agent can answer without
   * awaiting, so a built-in that started spending money would fail here and in
   * the type checker at once.
   */
  it("answers `red` and `gate-failed` with a built-in that returns without awaiting", () => {
    for (const when of ["red", "gate-failed"] as const) {
      const name = BUILT_IN_FOR[when];
      expect(name, `${when} has no built-in`).not.toBeNull();
      const answer = BUILT_IN[name!](brief(when, ["implement", "human"]));
      expect(answer).not.toBeInstanceOf(Promise);
      expect(answer).toBe("implement");
    }
  });

  /** And it holds to the set like any other judge: no round left, so a person. */
  it("falls to a person when `implement` is not on offer", async () => {
    const offer = stepsOnOffer({ ...EVERYTHING, when: "red", roundsSpent: 2 });
    const answered = await askJudge("same-worktree", BUILT_IN["same-worktree"], brief("red", offer));
    expect(answered).toEqual({ next: "human", refused: null });
  });

  /**
   * The three that cost money are `null` rather than absent, so a sixth
   * direction does not compile until somebody has said which kind it is — and
   * so that *no built-in* is a decision on the record rather than a gap.
   */
  it("says which directions have no built-in, rather than leaving them out", () => {
    expect(Object.keys(BUILT_IN_FOR).sort()).toEqual([...JudgeWhen.options].sort());
    expect(BUILT_IN_FOR.conflict).toBeNull();
    expect(BUILT_IN_FOR["needs-input"]).toBeNull();
    expect(BUILT_IN_FOR.findings).toBeNull();
  });

  /**
   * **Every name the schema accepts is a function here**, which is what stops a
   * recipe naming a judge nothing answers — `#61` through the one door a
   * replaceable plugin opens. 0061 §3's example also names `ask-or-assume`, and
   * it is deliberately in neither list: nothing implements it.
   */
  it("implements every built-in name the recipe accepts, and no others", () => {
    expect(Object.keys(BUILT_IN).sort()).toEqual([...BUILT_IN_JUDGES].sort());
    expect(BUILT_IN_JUDGES).not.toContain("ask-or-assume");
  });
});
