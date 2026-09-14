/**
 * The `end` point's resolution, without a database.
 *
 * The interesting behaviour is a pure function on purpose: *what the point
 * resolved to* is decided from the recipe and the item's own stream, and
 * nothing about it needs a merge lane, a worktree or GitHub. The path that
 * lands an item through an approval is exercised for real in `run-once.test.ts`.
 */
import type { GateAction } from "@lingtai/recipe";
import type { Envelope } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import { resolveEndActions } from "../src/end-point.ts";

const CLOSE: GateAction = { name: "close the ticket", close: true, when: "landed" };
const LABEL: GateAction = { name: "label it", labels: ["lingtai:done"], when: "any" };
const BUILD: GateAction = { name: "build", run: "true", timeout: "2m", env: [] };

/** One event on a work item stream. Only `type` and `data` are read here. */
const event = (type: string, data: unknown): Envelope => ({
  seq: 1n,
  streamId: "wi-p-1",
  version: 1,
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

  it("ignores an action at `end` that has no verdict to give", () => {
    // A `run:` at `end` is a misconfiguration: the point cannot refuse, so
    // there is nothing for a command's exit code to mean. The point still ran.
    const [ev] = resolveEndActions([], [BUILD], "landed");
    expect(ev?.data).toEqual({ outcome: "landed", actions: [] });
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
  const CLOSE_ON_CLOSED: GateAction = { name: "close the issue", close: true, when: "closed" };

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
