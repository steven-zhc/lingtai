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
import { COLUMNS, toCard, toColumns } from "../src/lib/board.ts";

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

  it("shows a task in gates as running, beside the state that shares the lane", () => {
    const columns = toColumns([toCard(task("gates")), toCard(task("running"))]);
    const running = columns.find((c) => c.id === "running");
    expect(running?.cards.map((c) => c.taskId)).toEqual([
      "wi-esctest-gates",
      "wi-esctest-running",
    ]);
  });
});
