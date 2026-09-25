/**
 * The `end` point's resolution, without a database.
 *
 * The interesting behaviour is a pure function on purpose: *what the point
 * resolved to* is decided from the recipe and the item's own stream, and
 * nothing about it needs a merge lane, a worktree or GitHub. The path that
 * lands an item through an approval is exercised for real in `run-once.test.ts`.
 */
import type { StepAction } from "@lingtai/recipe";
import type { Envelope } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import { resolveEndActions } from "../src/end-point.ts";

const CLOSE: StepAction = { name: "close the ticket", close: true, when: "landed" };
const LABEL: StepAction = { name: "label it", labels: ["lingtai:done"], when: "any" };
const BUILD: StepAction = { name: "build", run: "true", timeout: "2m", env: [] };

/** One event on a work item stream. Only `type` and `data` are read here. */
const event = (type: string, data: unknown): Envelope => ({
  seq: 1n,
  streamId: "wi-p-1",
  version: 2,
  type,
  schemaVer: 1,
  data,
  actor: "conductor",
  causation: null,
  at: new Date(),
});

const resolved = (outcome: string, actions: unknown[] = []) =>
  event("EndActionsResolved", { outcome, actions });

describe("the end point", () => {
  it("says nothing when the recipe declares nothing", () => {
    // The skip is the operator's decision, and `GatesResolved` already records
    // that the point was empty.
    expect(resolveEndActions([], [], "landed")).toEqual([]);
  });

  it("takes the actions whose `when` matches, and the ones that match anything", () => {
    const [ev] = resolveEndActions([], [CLOSE, LABEL], "landed");
    expect(ev?.type).toBe("EndActionsResolved");
    expect(ev?.data).toEqual({
      outcome: "landed",
      actions: [{ name: "close the ticket", close: true }, { name: "label it", labels: ["lingtai:done"] }],
    });
  });

  /**
   * The distinction the whole model rests on (0016 §4): a point that was
   * configured and resolved to nothing is not the same fact as a point that
   * never ran, and from the log they must not look alike.
   */
  it("still records the point when nothing matches the outcome", () => {
    const [ev] = resolveEndActions([], [CLOSE], "failed");
    expect(ev?.data).toEqual({ outcome: "failed", actions: [] });
  });

  /**
   * It used to *ignore* one, and that was four of `end`'s six cells: a `run:`,
   * an `agent:`, a `watch:` or a `human:` here resolved to an empty list and
   * the recipe never heard about it (`#61`). A recipe cannot say it any more —
   * the schema refuses the kind at the point — so what is left to assert is
   * that the resolver does not quietly absorb one either.
   */
  it("refuses an action at `end` that has no effect to run, rather than dropping it", () => {
    expect(() => resolveEndActions([], [BUILD], "landed")).toThrow(
      /the "build" action is a "run" at the "end" point/,
    );
  });

  it("resolves once per outcome, from the item's own stream", () => {
    const stream = [event("WorkItemLanded", {}), resolved("landed", [{ name: "close the ticket", close: true }])];
    expect(resolveEndActions(stream, [CLOSE], "landed")).toEqual([]);
  });

  it("still resolves a different outcome the item reaches later", () => {
    // Blocked, then unblocked, then landed: two things happened to the issue
    // and both are the point doing its job.
    const stream = [resolved("blocked")];
    const [ev] = resolveEndActions(stream, [CLOSE], "landed");
    expect(ev?.data).toMatchObject({ outcome: "landed" });
  });
});

/**
 * A close is a terminal outcome, so the point that fires on every terminal
 * outcome fires on it (0044, `#151`).
 *
 * It did not, and the shape of that gap is the one 0016 §4 names: `end` is
 * *defined* as the point that runs on every ending, a fourth ending was added,
 * and the sentence quietly stopped being true. A recipe saying `when: any`
 * would have gone on saying it while doing nothing.
 */
describe("the end point on a close", () => {
  const CLOSE_ON_CLOSED: StepAction = { name: "close the issue", close: true, when: "closed" };

  it("fires the actions that said any", () => {
    const [ev] = resolveEndActions([], [LABEL], "closed");

    expect(ev?.data).toEqual({ outcome: "closed", actions: [{ name: "label it", labels: ["lingtai:done"] }] });
  });

  it("fires an action that named it, and leaves the landing one alone", () => {
    // `CLOSE` is `when: "landed"`. The two words are close enough to be worth
    // an assertion: *close the issue because the work landed* and *close the
    // issue because the ticket was abandoned* are different decisions, and a
    // recipe has to be able to ask for one without the other.
    const [ev] = resolveEndActions([], [CLOSE, CLOSE_ON_CLOSED], "closed");

    expect(ev?.data).toEqual({ outcome: "closed", actions: [{ name: "close the issue", close: true }] });
  });

  it("still writes a row when nothing matched", () => {
    // The distinction the whole model rests on: *nothing was configured* and
    // *something was configured and did not match* must not look the same from
    // the log.
    const [ev] = resolveEndActions([], [CLOSE], "closed");

    expect(ev?.data).toEqual({ outcome: "closed", actions: [] });
  });

  it("resolves once, and independently of the endings before it", () => {
    // An item that was blocked, came back, and was then closed resolves twice
    // for two different outcomes — which is correct, they are two different
    // things to have done to an issue. This is also the case the *audit* used
    // to miss: it asked whether any `EndActionsResolved` existed at all.
    expect(resolveEndActions([resolved("closed")], [LABEL], "closed")).toEqual([]);
    expect(resolveEndActions([resolved("blocked")], [LABEL], "closed")).toHaveLength(1);
  });
});

/**
 * **`end`'s third effect, and the only one that destroys something** (`#240`).
 *
 * A landed ticket's `agent/<n>-attempt-<k>` refs name approaches that were
 * abandoned or superseded, and their commits are unreachable from `main`;
 * nothing has ever deleted one, so a remote's `agent/*` count is monotone in
 * how many issues the repository has had.
 *
 * **The safety is `when: landed` and it is asserted here rather than assumed.**
 * For an item that did *not* land, those refs are the only surviving account of
 * what was tried — `#239` exists to create them so a later attempt can fetch
 * them — so the case below, *any other ending resolves nothing*, is the one
 * this plugin has to pass. The schema refuses a recipe that writes any other
 * `when:` (`packages/recipe/unit/plugin.test.ts`); this holds the resolver
 * against an action built in code, which is the door the schema is not on.
 */
describe("the end point on the refs", () => {
  const SWEEP: StepAction = { name: "delete the arms", refs: true, branch: false, when: "landed" };
  const SWEEP_ALL: StepAction = { name: "delete them all", refs: true, branch: true, when: "landed" };

  it("resolves the sweep on a landing, and carries `branch` as written", () => {
    expect(resolveEndActions([], [SWEEP], "landed")[0]?.data).toEqual({
      outcome: "landed",
      actions: [{ name: "delete the arms", refs: true, branch: false }],
    });
    expect(resolveEndActions([], [SWEEP_ALL], "landed")[0]?.data).toEqual({
      outcome: "landed",
      actions: [{ name: "delete them all", refs: true, branch: true }],
    });
  });

  /**
   * **The case that earns the ticket.** A row is still written, because
   * *nothing was configured* and *something was configured and did not match*
   * must not look the same from the log — but it names no action, so nothing
   * downstream has a ref to delete.
   */
  it("resolves nothing on any other ending", () => {
    for (const outcome of ["blocked", "failed", "closed"] as const) {
      expect(resolveEndActions([], [SWEEP, SWEEP_ALL], outcome)[0]?.data).toEqual({
        outcome,
        actions: [],
      });
    }
  });

  /**
   * And it does not take the other effects' `any` with it: a recipe that
   * labels on every ending and sweeps on a landing gets both on the landing and
   * only the label on the block.
   */
  it("sits beside an effect that fires on every outcome without widening", () => {
    expect(resolveEndActions([], [LABEL, SWEEP], "landed")[0]?.data).toMatchObject({
      actions: [{ name: "label it" }, { name: "delete the arms" }],
    });
    expect(resolveEndActions([], [LABEL, SWEEP], "blocked")[0]?.data).toEqual({
      outcome: "blocked",
      actions: [{ name: "label it", labels: ["lingtai:done"] }],
    });
  });
});
