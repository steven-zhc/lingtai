/**
 * What the board gives weight to, and what it leads with.
 *
 * Driven off the screenshot in #81: two projects, three queued, one running,
 * one waiting, six landed — six full cards of finished `enhancement`s filling
 * the screen while the one card asking for a person took about a twelfth of the
 * ink, and a bar leading with `11 items`, the sum of four columns that mean
 * different things. The two numbers an operator acts on — how many need me, and
 * what has this cost — were absent, the second of them from a page carrying
 * eleven costs and no total.
 *
 * The ordering and the arithmetic are checked here rather than in the page,
 * because both are functions of the cards and nothing else.
 */
import { describe, expect, it } from "vitest";
import type { TaskCard } from "@lingtai/projector/task-view";
import { LANDED_OPEN, issueUrl, spend, toCard, toColumns } from "../src/lib/board.ts";

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: `wi-esctest-${over.issue ?? "1"}`,
    project: "esctest",
    issue: "1",
    title: "a task",
    kind: "enhancement",
    state: "landed",
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
    repairPending: false,
    repairCostUsd: null,
    ...over,
  };
}

describe("the Landed lane's order", () => {
  /**
   * "Collapsed by default past the most recent few" is only a sentence the
   * order can make true. `readTasks` hands the lane back by ticket number,
   * which is neither recency nor anything a person reading history wants.
   */
  it("puts what landed most recently first", () => {
    const landed = toColumns(
      [
        toCard(task({ issue: "150", updatedAt: new Date("2026-09-06T00:00:00Z") })),
        toCard(task({ issue: "151", updatedAt: new Date("2026-09-08T00:00:00Z") })),
        toCard(task({ issue: "149", updatedAt: new Date("2026-09-07T00:00:00Z") })),
      ],
      [],
    ).find((c) => c.id === "landed");

    expect(landed?.cards.map((c) => c.ref)).toEqual(["151", "149", "150"]);
  });

  /**
   * The other lanes are ordered deliberately by `readTasks` — waiting by how
   * long it has waited, which is the question that lane exists to ask — and
   * this is not the place that gets to undo it.
   */
  it("leaves every other lane in the order it was given", () => {
    const columns = toColumns([
      toCard(task({ state: "waiting", issue: "9", updatedAt: new Date("2026-09-01T00:00:00Z") })),
      toCard(task({ state: "waiting", issue: "8", updatedAt: new Date("2026-09-08T00:00:00Z") })),
    ]);

    expect(columns.find((c) => c.id === "waiting")?.cards.map((c) => c.ref)).toEqual(["9", "8"]);
  });

  it("keeps enough of the lane open to answer whether the last thing worked", () => {
    expect(LANDED_OPEN).toBeGreaterThan(0);
  });
});

describe("what the board says it has cost", () => {
  /**
   * Roughly $16 was on the #81 screenshot, one card at a time, and stated
   * nowhere.
   */
  it("totals the cards in front of you, across every lane", () => {
    const columns = toColumns([
      toCard(task({ state: "landed", issue: "1", costUsd: 0.97 })),
      toCard(task({ state: "landed", issue: "2", costUsd: 1.78 })),
      toCard(task({ state: "waiting", issue: "3", costUsd: 3.4 })),
      toCard(task({ state: "running", issue: "4", costUsd: null })),
    ]);

    const total = spend(columns);
    expect(total.work).toBeCloseTo(6.15, 5);
    expect(total.cards).toBe(4);
  });

  /**
   * Apart from the work, for the reason the card keeps it apart: a repair is
   * default-on and spends an agent without being asked again, so folding it in
   * would make it an invisible bill (#84).
   */
  it("keeps repair out of the work's figure and still shows it", () => {
    const columns = toColumns([toCard(task({ costUsd: 1.0, repairCostUsd: 0.5 }))]);
    const total = spend(columns);

    expect(total.work).toBeCloseTo(1.0, 5);
    expect(total.repair).toBeCloseTo(0.5, 5);
  });

  it("says nothing spent rather than nothing at all on an empty board", () => {
    expect(spend(toColumns([]))).toEqual({ work: 0, repair: 0, cards: 0 });
  });
});

describe("where a card's reference points", () => {
  it("goes to the issue on GitHub", () => {
    expect(issueUrl("lingtai-dev", "lingtai", "112")).toBe(
      "https://github.com/lingtai-dev/lingtai/issues/112",
    );
  });

  /**
   * A project registered before `ProjectConfigured` carried an owner has no
   * link to build, and a dead one is worse than none.
   */
  it("declines to invent one for a project with no owner recorded", () => {
    expect(issueUrl(null, "lingtai", "112")).toBeNull();
  });
});
