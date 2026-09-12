/**
 * The Queued column's grouping, which is where priority becomes legible.
 *
 * `source.kinds` is a priority order — earlier wins — and until #85 the column
 * rendered nine cards in a flat list, so *what gets taken next* was a fact you
 * could only get by reading the recipe. The grouping is the answer, and it has
 * to be `selectRunnable`'s order and not a second one: a column that claims
 * `feature` is next while the conductor claims a `bug` is worse than no
 * grouping at all.
 */
import { describe, expect, it } from "vitest";
import { groupQueue, queuedStanding, toCard } from "../src/lib/board.ts";
import type { TaskCard } from "@lingtai/projector/task-view";

function queued(over: Partial<TaskCard> & { issue: string; kind: string }): TaskCard {
  return {
    taskId: `wi-esctest-${over.issue}`,
    project: "esctest",
    title: `issue ${over.issue}`,
    state: "queued",
    tier: "guarded",
    runId: null,
    turns: null,
    costUsd: null,
    gatesPassed: 0,
    gatesFailed: 0,
    gatesWaived: 0,
    gatesApproved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date("2026-09-04T04:27:22Z"),
    closedAt: null,
    attempts: 0,
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    blocked: false,
    needs: null,
    diagnosis: null,
    repairCostUsd: null,
    ...over,
  };
}

const card = (issue: string, kind: string, heldUntil: Date | null = null) =>
  toCard(queued({ issue, kind }), heldUntil);

describe("the Queued column, grouped", () => {
  it("groups by kind in the recipe's order, not in the order cards arrive", () => {
    const groups = groupQueue(
      [card("62", "feature"), card("74", "bug"), card("75", "tech-debt"), card("79", "feature")],
      ["bug", "tech-debt", "feature"],
    );

    expect(groups.map((g) => g.kind)).toEqual(["bug", "tech-debt", "feature"]);
    expect(groups.map((g) => g.cards.map((c) => c.ref))).toEqual([["74"], ["75"], ["62", "79"]]);
  });

  /** `selectRunnable`'s tiebreak: #402 before #409, and both before #4100. */
  it("orders within a group by issue number, as the conductor does", () => {
    const [bugs] = groupQueue([card("4100", "bug"), card("409", "bug"), card("402", "bug")], ["bug"]);
    expect(bugs?.cards.map((c) => c.ref)).toEqual(["402", "409", "4100"]);
  });

  it("names the group the next claim comes from", () => {
    const groups = groupQueue([card("79", "feature"), card("74", "bug")], ["bug", "feature"]);
    expect(groups.filter((g) => g.next).map((g) => g.kind)).toEqual(["bug"]);
  });

  /**
   * The distinction #95 put on the cards, kept in the heading. A kind whose
   * only queued items are backing off is not the kind that gets taken next, and
   * a heading that said it was would be the lie the cards stopped telling.
   */
  it("skips a group whose every card is being held back by the backoff", () => {
    const held = new Date("2099-01-01T00:00:00Z");
    const groups = groupQueue(
      [card("74", "bug", held), card("79", "feature")],
      ["bug", "feature"],
    );

    expect(groups.map((g) => g.kind)).toEqual(["bug", "feature"]);
    expect(groups.filter((g) => g.next).map((g) => g.kind)).toEqual(["feature"]);
  });

  /**
   * A recipe that drops a kind leaves items in the log named by it, and they
   * come back to the queue under a label nothing prioritises any more. They are
   * still work and still rendered — after everything the order does name, since
   * nothing says where else they go.
   */
  it("puts a kind the order does not name after the ones it does", () => {
    const groups = groupQueue([card("9", "chore"), card("74", "bug")], ["bug"]);
    expect(groups.map((g) => g.kind)).toEqual(["bug", "chore"]);
  });

  it("has no order to show when no recipe could be read, and still shows every card", () => {
    const groups = groupQueue([card("74", "bug"), card("62", "feature")], []);
    expect(groups.flatMap((g) => g.cards.map((c) => c.ref)).sort()).toEqual(["62", "74"]);
  });
});

/**
 * The three states that read identically, rendered
 * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)'s closing
 * table, `#100`).
 *
 * `run failed: crash` was on the card whether the run would be back at 23:45 or
 * whether the conductor had been stopped and nothing here would move at all,
 * and a card nobody had tried said nothing — which is right, and was
 * indistinguishable from the other two because they said nothing about *when*
 * either.
 */
describe("what a Queued card says about whether it will come back", () => {
  const held = new Date("2026-09-09T04:32:00Z");
  const now = Date.parse("2026-09-09T04:00:00Z");

  it("says nothing at all about a card that is simply next", () => {
    expect(queuedStanding(card("74", "bug"), false, now)).toBeNull();
  });

  it("says when a backing-off card returns, in `lingtai status`'s own words", () => {
    const said = queuedStanding(card("74", "bug", held), false, now);
    expect(said?.state).toBe("backing-off");
    // The exact line `lingtai status` prints inside its brackets, so the two
    // cannot come to word the same row differently again.
    expect(said?.text).toBe("backing off — runnable in 32m");
    expect(said?.title).toBe(`backing off until ${held.toISOString()}`);
  });

  it("says nothing will start while the conductor is paused", () => {
    const said = queuedStanding(card("74", "bug"), true, now);
    expect(said?.state).toBe("paused");
    expect(said?.text).toBe("paused — nothing will start");
  });

  /** The whole complaint, as one assertion: three states, three readings. */
  it("gives the three of them three different readings", () => {
    const readings = [
      queuedStanding(card("74", "bug"), false, now),
      queuedStanding(card("74", "bug", held), false, now),
      queuedStanding(card("74", "bug"), true, now),
    ].map((s) => s?.text ?? null);

    expect(new Set(readings).size).toBe(3);
  });

  /**
   * A pause outranks a backoff, because only one of them decides anything: an
   * item whose backoff lifts in a minute still does not move while the
   * conductor is taking nothing, and `runnable in 32m` would be the more
   * precise of two answers and the wrong one.
   */
  it("says the pause, not the backoff, when both hold", () => {
    expect(queuedStanding(card("74", "bug", held), true, now)?.state).toBe("paused");
  });

  /**
   * Neither fact is about any other lane. A running card is not backing off and
   * a paused conductor does not stop the run already in flight (0013).
   */
  it("says nothing about a card that is not queued", () => {
    const running = toCard(queued({ issue: "74", kind: "bug", state: "running" }));
    expect(queuedStanding(running, true, now)).toBeNull();
  });
});
