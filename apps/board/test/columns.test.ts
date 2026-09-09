/**
 * Every state a task can be in is on exactly one column.
 *
 * Driven off `LABEL_STATES`, which is what `TaskState` is read from, so this is
 * a claim about the union and not about the states somebody remembered. Add a
 * sixth state and this fails until `COLUMN_OF` says where it goes — which is
 * the check #59 did not have: a task in `gates` matched no column and its card
 * was absent from the board for the whole three minutes its gates ran, while
 * `lingtai status` said `[gates]` throughout.
 */
import { describe, expect, it } from "vitest";
import { LABEL_STATES } from "@lingtai/domain";
import type { TaskCard } from "@lingtai/projector/task-view";
import { COLUMNS, emptyNote, toCard, toColumns } from "../src/lib/board.ts";

function task(state: TaskCard["state"]): TaskCard {
  return {
    taskId: `wi-esctest-${state}`,
    project: "esctest",
    issue: "1",
    title: "a task",
    kind: "bug",
    state,
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
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    blocked: false,
    repairPending: false,
    repairCostUsd: null,
  };
}

describe("the board's columns", () => {
  it("puts a task in every state on exactly one column", () => {
    for (const state of LABEL_STATES) {
      const columns = toColumns([toCard(task(state))]);
      const on = columns.filter((c) => c.cards.length === 1);
      expect(on.map((c) => c.id), `a task in ${state} is on`).toHaveLength(1);
      expect(columns.reduce((n, c) => n + c.cards.length, 0)).toBe(1);
    }
  });

  it("loses none of them when they are on the board together", () => {
    const columns = toColumns(LABEL_STATES.map((state) => toCard(task(state))));
    expect(columns.reduce((n, c) => n + c.cards.length, 0)).toBe(LABEL_STATES.length);
    expect(columns.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
  });

  /**
   * *Nothing is runnable* and *the queue could not be listed* used to render
   * identically — as an empty Queued column (#76). A recipe that would not
   * parse, one that was missing and a misconfigured App all reached the same
   * empty catch, whose comment named only "GitHub unreachable".
   */
  it("carries a queue that could not be listed as a reason, not as an absence", () => {
    const columns = toColumns([], [{ project: "lingtai", reason: "source.kinds.3: Invalid option" }]);
    const queued = columns.find((c) => c.id === "queued");

    expect(queued?.cards).toEqual([]);
    expect(queued?.problems).toEqual([
      { project: "lingtai", reason: "source.kinds.3: Invalid option" },
    ]);
    // Only Queued. Every other column is a fold of the log, which cannot fail
    // to be asked.
    expect(columns.filter((c) => c.problems !== undefined).map((c) => c.id)).toEqual(["queued"]);
  });

  it("leaves an empty queue empty, so the two stay distinguishable", () => {
    const queued = toColumns([]).find((c) => c.id === "queued");
    expect(queued?.cards).toEqual([]);
    expect(queued?.problems).toBeUndefined();
  });

  it("shows a task in gates as running, beside the state that shares the lane", () => {
    const columns = toColumns([toCard(task("gates")), toCard(task("running"))]);
    const running = columns.find((c) => c.id === "running");
    expect(running?.cards.map((c) => c.taskId)).toEqual([
      "wi-esctest-gates",
      "wi-esctest-running",
    ]);
  });
});

/**
 * The copy under an empty lane is a claim, and it can be false.
 *
 * "Nothing here yet" under Running was what the board said for four days while
 * three cards sat in Queued and the conductor was paused (#77) — true about
 * the column, wrong about the world. Checked here rather than in the page,
 * because the sentence is a function of two facts and nothing else.
 */
describe("what an empty column says", () => {
  it("says Running is stopped, not bare, while the conductor is paused", () => {
    expect(emptyNote("running", true)).toBe("Paused — nothing will start.");
  });

  it("keeps the ordinary copy when nothing is paused", () => {
    expect(emptyNote("running", false)).toBe("Nothing here yet.");
    expect(emptyNote("queued", false)).toBe("Nothing here yet.");
  });

  it("never tells a person a lane is waiting on them when it is not", () => {
    for (const paused of [true, false]) {
      expect(emptyNote("waiting", paused)).toBe("Nothing is waiting on you.");
    }
  });

  it("says something for every column there is", () => {
    for (const column of COLUMNS) {
      expect(emptyNote(column.id, true).length, `${column.id} says`).toBeGreaterThan(0);
    }
  });
});
