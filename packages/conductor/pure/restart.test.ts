/**
 * Whether a pass whose rounds are spent starts the work over, or asks a person.
 *
 * Here for the reason `fix.test.ts` and `repair.test.ts` are here: all three are
 * about rules that decide whether money is spent, and this one decides the
 * largest amount — a whole further pass, worth `(rounds + 1)` agent runs
 * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
 *
 * So the properties that matter most are the *refusals*. The mechanism is
 * fifteen lines and the evidence for it is one ticket
 * ([experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)),
 * which means every one of these tests is pinning a way this could quietly
 * become a money pump: on by accident, on for a red build, on over somebody's
 * objection, or on for ever.
 *
 * Pure, under `vitest.pure.config.ts`: nothing here reads a database.
 */
import { describe, expect, it } from "vitest";
import { emptyWorkItem, type RestartRecord, type WorkItemState } from "@lingtai/domain";
import { armBranch, decideRestart, restartReason } from "../src/restart.ts";

const arm = (over: Partial<RestartRecord> = {}): RestartRecord => ({
  after: "run-1",
  restart: 1,
  of: 2,
  action: "review",
  rounds: 3,
  branch: "agent/144",
  headSha: "8634c5d0000000000000000000000000000000000",
  findings: [],
  ...over,
});

const item = (restarts: readonly RestartRecord[] = []): WorkItemState => ({
  ...emptyWorkItem,
  restarts,
});

/** A review that refused, with the rounds spent against it. The ordinary case. */
const refused = { action: "review", on: "findings" as const, exhausted: true };

describe("whether a spent pass buys another approach", () => {
  it("buys one when the recipe asks for one and the ceiling is not spent", () => {
    expect(
      decideRestart({ refusal: refused, restarts: 2, item: item(), alsoAsked: null }),
    ).toEqual({ restart: true, n: 1, of: 2 });

    // And the ordinal counts off the arms on the log rather than a counter —
    // which is what makes it survive a rebuild (0025 §3, one ceiling along).
    expect(
      decideRestart({ refusal: refused, restarts: 2, item: item([arm()]), alsoAsked: null }),
    ).toEqual({ restart: true, n: 2, of: 2 });
  });

  /**
   * **The default, and the whole of 0040 §4.** The evidence is one ticket and
   * the interesting failure — two fresh starts both exhausting their rounds —
   * has never been observed, so nothing changes for a project until its recipe
   * writes a number down. A test rather than a comment because a default that
   * drifts to `1` is a new way to spend an agent on every project at once.
   */
  it("buys nothing when the recipe says nothing, and names the key", () => {
    const none = decideRestart({ refusal: refused, restarts: 0, item: item(), alsoAsked: null });

    expect(none.restart).toBe(false);
    expect(none.restart === false && none.why).toMatch(/runtime\.limits\.restarts: 0/);
    expect(none.restart === false && none.why).toMatch(/to a person/);
  });

  /**
   * **0039 §2 kept, not contradicted.** For a red build and a conflict *the work
   * is still there* is a fact: the branch is finished and the remedy is
   * mechanical. Throwing it away to re-implement it is the expensive wrong
   * answer that decision exists to stop — and this rule is in code rather than
   * in the recipe, so no number a project writes down can make a typecheck
   * error buy a fresh worktree.
   */
  it("buys nothing for a check that stayed red, or a base that moved", () => {
    for (const on of ["output", "conflict"] as const) {
      const no = decideRestart({
        refusal: { action: "build", on, exhausted: true },
        restarts: 2,
        item: item(),
        alsoAsked: null,
      });

      expect(no.restart).toBe(false);
      expect(no.restart === false && no.why).toMatch(/the work is still there/);
    }
  });

  /**
   * **A decline is an objection, and this is the test that stops it being
   * buried.** 0039 §5 gave the fixing agent exactly one way to say *this
   * refusal is wrong or is not this change's*: commit nothing. Paying for a
   * fresh approach on that discards the one verdict the whole loop was built to
   * carry, and it would look like progress while doing it.
   */
  it("buys nothing when an agent declined rather than the ceiling being spent", () => {
    const no = decideRestart({
      refusal: { action: "review", on: "findings", exhausted: false },
      restarts: 2,
      item: item(),
      alsoAsked: null,
    });

    expect(no.restart).toBe(false);
    expect(no.restart === false && no.why).toMatch(/rounds were not spent/);
  });

  it("defers to anything already asking for a person, and says who", () => {
    const no = decideRestart({
      refusal: refused,
      restarts: 2,
      item: item(),
      alsoAsked: "the a-person-sees-a-new-noun action",
    });

    expect(no.restart).toBe(false);
    expect(no.restart === false && no.why).toContain("a-person-sees-a-new-noun");
    expect(no.restart === false && no.why).toMatch(/throw that question away/);
  });

  /**
   * **The bound, which is the reason the second ceiling exists at all.** A loop
   * that restarts without one is a money pump on a ticket that is simply wrong.
   */
  it("stops at the ceiling, and says which ceiling", () => {
    const spent = decideRestart({
      refusal: refused,
      restarts: 2,
      item: item([arm({ restart: 1 }), arm({ restart: 2, after: "run-2" })]),
      alsoAsked: null,
    });

    expect(spent.restart).toBe(false);
    expect(spent.restart === false && spent.why).toContain("ceiling of 2 restart(s)");
  });

  /**
   * The order the refusals are checked in is the order an operator reads them,
   * and the first refusal wins — so the sentence on a card is the most
   * fundamental reason and not the last one checked. Same property `decideFix`
   * is written for, and `decideRepair` was before `#143` deleted it.
   */
  it("names the recipe before the ceiling when both would refuse", () => {
    const no = decideRestart({
      refusal: refused,
      restarts: 0,
      item: item([arm()]),
      alsoAsked: "a repair",
    });

    expect(no.restart === false && no.why).toMatch(/runtime\.limits\.restarts: 0/);
  });
});

/**
 * The sentence has two readers, which is why it is a function: the card's line,
 * and the `how it ended` cell in the next attempt's own prompt (`attempts.ts`).
 * That is the whole of what a restart adds to a prompt — nothing new, one
 * honest row — so it has to say *abandoned* rather than merely *failed*.
 */
describe("what the release says", () => {
  it("says the approach was abandoned, and which arm this is", () => {
    const reason = restartReason({ action: "review", rounds: 3, n: 1, of: 2 });

    expect(reason).toContain("review reviewer still refused after 3 round(s)");
    expect(reason).toContain("approach is abandoned");
    expect(reason).toContain("restart 1 of 2");
  });
});

/**
 * **Where an abandoned arm is published**, which is the other half of the push:
 * the working branch is one ref and there are as many arms as the ceiling
 * allows, so `agent/7` can only ever hold the newest.
 *
 * The property under test is that two arms of one ticket do not share a name.
 * Without it the card shown when the last restart is spent — every arm, each
 * headed by the branch and sha it was refused at (0040 §3) — names commits
 * origin dropped when the next arm force-pushed over them, and it does so at
 * exactly the moment a person is being asked to compare the arms.
 */
describe("where an abandoned approach is published", () => {
  it("gives each arm a ref of its own, beside the working branch", () => {
    expect(armBranch("agent/7", 1)).toBe("agent/7-restart-1");
    expect(armBranch("agent/7", 2)).toBe("agent/7-restart-2");
    expect(armBranch("agent/7", 1)).not.toBe(armBranch("agent/7", 2));
  });

  /**
   * A sibling and not a child: git cannot hold `refs/heads/agent/7` and
   * `refs/heads/agent/7/restart-1` at once, because a ref cannot also be a
   * directory — and `agent/7` has to keep existing, since it is the name
   * `attempts.ts` spells out in the next attempt's prompt.
   */
  it("does not nest under the branch it is abandoning", () => {
    expect(armBranch("agent/7", 1).startsWith("agent/7/")).toBe(false);
  });
});
