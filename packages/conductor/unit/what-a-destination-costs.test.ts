/**
 * **A destination fails three ways, and each way costs something different** —
 * [0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §7's table, row by row (`#299`).
 *
 * ```
 * the recipe is wrong          refused at resolve   nothing is claimed and nothing runs
 * briefly unreachable          did-not-finish       the pass stops; no round, no route
 * it needs a person            asked                reaches `proposed`, and a person
 * ```
 *
 * The first row is most of the work and the cheapest outcome, and it is the one
 * the other two are worth nothing without: a configuration error that survives
 * to run time is retried on the recipe's backoff — **every hour here** — and
 * each retry claims the ticket, cuts a worktree, dispatches and fails again
 * (0066 §6). So what is asserted about it is that the pass is never reached at
 * all, which is a different kind of claim from the two below it.
 *
 * **`design` may not refuse** — it is a rectangle in 0058 §3's list, and
 * `REFUSING_STEPS` is where that is written down — so none of the three buys a
 * fix round, and that is the feature rather than the gap: a broken destination
 * costs the design run and nothing more.
 *
 * **No plugin is a destination yet**, which is 0069's *what the first
 * destination plugin is … is `#295`'s remaining tickets*. So the destination
 * here is declared as the `agent:` that writes the design today and its answers
 * are canned — the arrangement `pass.test.ts`'s *what design's ending carries to
 * implement* uses one ticket earlier (`#297`), and for its reason: nothing in
 * the tree can be the subject yet, so what is pinned is **what the first one
 * will meet**. None of the three rows is a plugin's to implement; each is made
 * of the schema at resolve and of the endings `runActionPipeline` and `endingOf`
 * already produce.
 *
 * `what-a-red-command-costs.test.ts` is the neighbour, asking the same question
 * — *what does this cost where it is written* — of the other extension point,
 * and `doc/writing-a-plugin.md`'s *a plugin that keeps something somewhere fails
 * three ways* is the page that tells a plugin author the same table.
 */
import type { Step } from "@lingtai/domain";
import { NEEDS_INPUT, type Action, type ActionEvent, type ActionResult } from "@lingtai/actions";
import { StepMap } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import {
  onOffer,
  outcomeOf,
  runPass,
  type Ceilings,
  type PassOptions,
  type PassResult,
  type StepEnding,
} from "../src/pass.ts";

/**
 * Rounds to spare on every pass below, so that *no round was bought* is a fact
 * about the ending rather than about an empty purse.
 */
const SPARE: Ceilings = { rounds: 2, restartsLeft: 1 };

/**
 * **The line a recipe writes to keep the design somewhere**, as near as the
 * schema can say it today.
 *
 * A destination plugin's key will not be `agent:` — 0066 §5 makes `file:` and
 * `confluence:` two plugins rather than one with a field — but the step, the
 * list it sits in and everything the pass then does with its answer are the
 * same, and those are what is being measured.
 */
const DESTINATION = { name: "keep it", agent: "claude-code", prompt: "write the shape down" };

/** A destination that answers what the row under test says it answers. */
const answering = (result: ActionResult): PassOptions["actionsAt"] => {
  const kept: Action = { name: DESTINATION.name, kind: "agent", run: async () => result };
  return (step, actions) => (step === "design" ? [kept] : actions.map((a) => ({ ...kept, name: a.name })));
};

/** One pass with a destination at `design`, and the events it appended. */
async function passWith(result: ActionResult): Promise<{ result: PassResult; events: ActionEvent[] }> {
  const events: ActionEvent[] = [];
  const passed = await runPass({
    recipe: { steps: StepMap.parse({ design: [DESTINATION] }) },
    context: { runId: "run-1", onSha: "abc1234def", cwd: "/nowhere", env: {} },
    emit: (event) => void events.push(event),
    actionsAt: answering(result),
    // No `bodies`, so `NOT_BUILT_YET` answers — which is the floor 0066 §7's
    // third row names in as many words: *with no judge declared, a person*.
    ceilings: SPARE,
  });
  return { result: passed, events };
}

/** The visits, in order, which is the whole of *what did this pass pay for*. */
const visited = (result: PassResult): readonly Step[] => result.steps.map((visit) => visit.step);

/**
 * Why the schema refused this `design:` list — the issues themselves rather than
 * the `ZodError`'s message, which is those issues serialised and so quotes every
 * quotation mark in a refusal written for a person to read.
 */
function refusing(...actions: readonly unknown[]): { path: readonly PropertyKey[]; message: string }[] {
  const read = StepMap.safeParse({ design: actions });
  if (read.success) throw new Error("the schema accepted a `design:` list this test wrote to be refused");
  return read.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

describe("a destination fails three ways, and a step has one way to say so", () => {
  // ------------------------------------------- the recipe is wrong ----

  /**
   * **Refused at resolve, before a worktree, before an agent, before any
   * money** — which is the sentence the schema already carries everywhere else
   * and the reason this row is the important half of the failure story.
   *
   * It is the plugin's own field list that does it, so the first destination
   * plugin gets this row by declaring its fields and writing no code for it
   * (`readFields`, and `doc/writing-a-plugin.md`'s *write the plugin*). What
   * would lose it is a plugin that took a loose shape here and checked it when
   * it ran.
   */
  describe("the recipe is wrong", () => {
    it("is refused when the recipe resolves, naming the line", () => {
      const [refused] = refusing({ ...DESTINATION, prompt: 12 });

      expect(refused?.message).toContain('the "keep it" action is a "agent" at the "design" step');
      expect(refused?.message).toContain('its "prompt" field is not what "agent" accepts');
      expect(refused?.message).toContain(
        "Refused when the recipe resolves, before a worktree, before an agent, before any money.",
      );
    });

    /**
     * **The line, and not the file**: the step, which entry in its list, and the
     * field. A refusal that named only the step would send a person reading a
     * `design:` with three actions under it to the wrong one.
     */
    it("says which action and which field", () => {
      const refused = refusing(DESTINATION, { ...DESTINATION, name: "file a copy", prompt: 12 });

      expect(refused.map((issue) => issue.path)).toEqual([["design", 1, "prompt"]]);
      expect(refused[0]?.message).toContain('the "file a copy" action');
    });

    /**
     * **A field no plugin declares is refused too, and by name.** This is what a
     * destination's own field gets *today*, written under a plugin that does not
     * declare it — and it is the same refusal the first `file:` plugin's
     * misspelt `path:` will get, from the same place: a plugin refuses a field it
     * does not understand rather than accepting it and ignoring it (0061 §9).
     */
    it("refuses a destination field written under a plugin that declares none", () => {
      const [refused] = refusing({ ...DESTINATION, path: "doc/design/x.md" });

      expect(refused?.message).toContain('"agent" declares no "path" field');
      expect(refused?.path).toEqual(["design", 0, "path"]);
    });

    /**
     * **And what it costs is nothing**, which is this row's whole point: the
     * recipe does not resolve, so there is no pass to run, nothing to claim and
     * no worktree to cut. The contrast is the assertion — the same list, made
     * legal, resolves and is run.
     */
    it("costs nothing, because the pass is never reached", async () => {
      expect(refusing({ ...DESTINATION, prompt: 12 })).not.toEqual([]);

      const { result } = await passWith({ verdict: "passed", evidence: "kept it", findings: [], document: "x" });
      expect(visited(result)).toContain("design");
    });
  });

  // ----------------------------------- the destination was unreachable ----

  /**
   * **`did-not-finish`, and the pass stops.** Nothing was judged, so there is no
   * judgement to route: `goesToTheRouter` lets no `did-not-finish` past, and the
   * item is held for a person with nothing bought (0057 §1–3).
   *
   * 0066 §7 leaves *unreachable* and *needs a person* to measurement and says to
   * start everything here, so this is the row a destination's first failure
   * belongs in.
   */
  describe("the destination was briefly unreachable", () => {
    it("ends `did-not-finish`, stops the pass, and buys no round", async () => {
      const { result, events } = await passWith({
        verdict: "did-not-finish",
        evidence: "confluence.example: ETIMEDOUT after 30s",
        findings: [],
      });

      expect(result.stoppedAt).toEqual({
        step: "design",
        ending: {
          ending: "did-not-finish",
          because: "did-not-finish",
          at: "keep it",
          detail: "confluence.example: ETIMEDOUT after 30s",
        },
      });
      // It never reached the router, so no judge was asked and no round could
      // have been spent — the cost row two is named for.
      expect(result.routes).toEqual([]);
      expect(result.rested).toBeNull();
      // And nothing after `design` ran: `implement` is not among the visits, so
      // the expensive half of the pass was never bought.
      expect(visited(result)).toEqual(["claim", "admit", "prepared", "design", "end"]);
      expect(outcomeOf(result)).toBe("blocked");
      // `StepDidNotFinish` and not `StepAsked` — broken machinery, not a
      // question (0068).
      expect(events.filter((e) => e.type === "StepAsked")).toEqual([]);
      expect(events.some((e) => e.type === "StepDidNotFinish")).toBe(true);
    });

    /**
     * **And a plain `failed` lands in the same row**, because `design` is not one
     * of `REFUSING_STEPS`: a destination that says no at a step the workflow does
     * not let refuse is reported as a `did-not-finish` carrying the action's own
     * word, and it buys no round either. A destination reaching for `refused` to
     * get attention would be buying an agent to report a typo, which is the
     * ticket's *watch out*.
     */
    it("reads a refusal at `design` as the same ending, and still buys no round", async () => {
      const { result } = await passWith({
        verdict: "failed",
        evidence: "the wiki answered 503",
        findings: [],
      });

      expect(result.stoppedAt?.ending.ending).toBe("did-not-finish");
      expect(result.routes).toEqual([]);
      expect(outcomeOf(result)).toBe("blocked");
    });
  });

  // ------------------------------------ the destination needs a person ----

  /**
   * **`asked`, and it reaches `proposed`** — the third row, and the one that was
   * unreachable until `#294` gave a `design` something to produce it with and
   * `#296` split the ending from the crash it shared a name with.
   *
   * The action says `NEEDS_INPUT` on a `did-not-finish` and that is the last
   * place the token is compared to anything: `runActionPipeline` reads it,
   * appends `StepAsked`, and what leaves the pipeline is a field and an event
   * type rather than a string the workflow branches on.
   */
  describe("the destination needs a person", () => {
    const asking: ActionResult = {
      verdict: "did-not-finish",
      because: NEEDS_INPUT,
      evidence: "which Confluence space should the design go in?",
      findings: [],
    };

    it("ends `asked`, reaches the router, and rests at a person", async () => {
      const { result, events } = await passWith(asking);

      expect(result.steps.find((visit) => visit.step === "design")?.ending).toEqual({
        ending: "asked",
        at: "keep it",
        detail: "which Confluence space should the design go in?",
      });
      // It arrived, which is the whole difference from row two — and with no
      // judge declared, the router's floor sends it to a person.
      expect(result.routes.map((route) => ({ from: route.from, to: route.to }))).toEqual([
        { from: "design", to: "waiting" },
      ]);
      expect(result.rested).toBe("waiting");
      expect(outcomeOf(result)).toBe("blocked");
      // The question is on `StepAsked.detail`, which is where a person reads it.
      expect(events.filter((e) => e.type === "StepDidNotFinish")).toEqual([]);
      expect(events.find((e) => e.type === "StepAsked")?.data).toMatchObject({
        step: "design",
        action: "keep it",
        detail: "which Confluence space should the design go in?",
      });
    });

    /**
     * **And it buys no round getting there** (0066 §7). The pass rests at a
     * person with the rounds untouched: `design` is visited once, and the ceiling
     * had two to give.
     */
    it("buys no round, though there were rounds to spend", async () => {
      const { result } = await passWith(asking);

      expect(result.steps.filter((visit) => visit.step === "design")).toHaveLength(1);
      expect(result.routes.every((route) => route.ceiling === null)).toBe(true);
    });

    /**
     * **What separates the two costs is that this one is answerable.** A
     * `did-not-finish` reaches nobody; a question reaches `proposed` with the
     * step that asked on the offer, so a `judge:` declared at `needs-input` can
     * answer it and a person is the floor rather than the only reading — 0058
     * §3c's *that step again, stating the assumption*.
     */
    it("arrives with somewhere to go, which a crash never does", () => {
      const question: StepEnding = { ending: "asked", at: "keep it", detail: "which space?" };

      expect(onOffer("design", question, SPARE, 0).affordable).toEqual(["waiting", "design"]);
      // Nobody but the step that asked knows the question, so the offer is that
      // step and a person, and never `implement`.
      expect(onOffer("design", question, SPARE, 0).reachable).not.toContain("implement");
    });
  });
});
