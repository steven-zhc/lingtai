/**
 * What the board is told when the table it reads is one column short.
 *
 * `create table if not exists` runs once and never again, so every later change
 * to the DDL is a change to a statement nobody executes (#84, `shape.ts`). #84
 * was caught by a *write*: the daemon threw `column task_view.awaiting_approval
 * does not exist` and stopped. The rename of `gates` to `verdicts` has a reader
 * in the same position and no such luck — `select t.*` hands back the columns
 * the table has, so the missing one is simply absent from the row, and
 * `row.verdicts ?? {}` counts it as a run that recorded nothing. Every card
 * then reports zero passed, zero failed, zero waived and zero approved, with no
 * `a-fail` stripe on a ticket whose build refused.
 *
 * Nothing else covers it. The daemon still appending has the old code and the
 * old column, so lag is 0 and the health dot is green; the shape check runs in
 * `start()` and in `lingtai doctor`, and the board calls neither for
 * `task_view`.
 *
 * **Unit, and 0060 §1 is why**: `:memory:` is a database with no file, so this
 * touches no filesystem, no process and no network — `openSqliteProjections`
 * skips WAL for exactly that path. It is here rather than in `test/contract.ts`
 * because the `build` gate runs the unit half and this is a claim about a diff.
 *
 * **And the same position one table along, where there is no guard at all.**
 * `finding_backlog`'s reader does not go through `columnOf`: `toEntry` in
 * `postgres.ts` and `sqlite.ts` takes each field straight off a `select *` row,
 * so a key the table has not got is `undefined` and no refusal is raised
 * anywhere. `#250` renamed `BacklogEntry.gate` to `step` and renamed the read
 * with it, over a column still declared `gate` — every entry came back
 * `step: undefined`, and `lingtai backlog` printed `undefined:review` while
 * `backlog accept` wrote it into a GitHub issue body as the step that raised the
 * finding. Neither `pnpm typecheck` nor `pnpm test` could see it:
 * `pg.QueryResultRow` and `ProjectionRow` are index-signature types, and the
 * only assertion was `test/contract.ts`'s, in the integration half. So the
 * round trip is asserted here, where the gate runs.
 */
import { describe, expect, it } from "vitest";
import { ProjectionShapeError, columnOf } from "../src/store.ts";
import { createSqliteProjectionStore, openSqliteProjections } from "../src/sqlite.ts";
import { taskViewProjection } from "../src/task-view.ts";
import { backlogProjection, type BacklogEntry } from "../src/backlog.ts";
import type { ProjectionStore } from "../src/store.ts";

const RUN = "run-drift-1";
const RECORDED = JSON.stringify({ [`${RUN}:proposed:build`]: "failed" });

/**
 * A store whose `task_view` is the real one, optionally aged back to the shape
 * it had before the rename — which is what a live table actually is until
 * somebody runs `lingtai projection rebuild task_view`.
 */
async function storeWith(column: "verdicts" | "gates"): Promise<ProjectionStore> {
  const store = createSqliteProjectionStore(openSqliteProjections(":memory:"));
  await store.transact(async (ctx) => {
    await taskViewProjection.create(ctx);
    if (column === "gates") {
      await ctx.query("alter table task_view rename column verdicts to gates");
    }
    await ctx.query(
      `insert into task_view
         (task_id, project, issue, state, run_id, ${column}, updated_at, updated_seq)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["wi-drift-1", "drift", "1", "gates", RUN, RECORDED, new Date().toISOString(), 1],
    );
  });
  return store;
}

describe("a column the row has not got", () => {
  it("answers with the value when the column is there", () => {
    expect(columnOf({ verdicts: { a: "passed" } }, "task_view", "verdicts")).toEqual({
      a: "passed",
    });
  });

  it("answers with null rather than refusing — empty is not absent", () => {
    // The distinction the whole guard turns on. A column that exists and holds
    // nothing is a run that recorded nothing, which is a fact and not drift.
    expect(columnOf({ verdicts: null }, "task_view", "verdicts")).toBeNull();
  });

  it("refuses when the column is absent, and names the rebuild", () => {
    let err: unknown;
    try {
      columnOf({ steps: "{}" }, "task_view", "verdicts");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectionShapeError);
    expect((err as ProjectionShapeError).drift).toEqual([
      { table: "task_view", missing: ["verdicts"], unexpected: [] },
    ]);
    expect((err as Error).message).toContain("lingtai projection rebuild task_view");
  });

  it("does not say `does not exist`, which the board reads as an empty board", () => {
    // `emptyIfUnbuilt` in apps/board/src/lib/board.ts swallows any error whose
    // message matches /does not exist/i and renders no cards: before the first
    // run there is no table, and that is a state rather than a fault. A
    // refusal phrased as the driver's own `column t.verdicts does not exist`
    // would be swallowed by it and land back on a board saying nothing is
    // wrong.
    const message = new ProjectionShapeError("task_view", [
      { table: "task_view", missing: ["verdicts"], unexpected: [] },
    ]).message;
    expect(message).not.toMatch(/does not exist/i);
  });
});

describe("the board, reading a task_view built before the rename", () => {
  it("refuses the read rather than reporting four zeros", async () => {
    const store = await storeWith("gates");
    try {
      await expect(store.tasks({ retentionDays: 2 })).rejects.toThrow(ProjectionShapeError);
      await expect(store.tasks({ retentionDays: 2 })).rejects.toThrow(
        /lingtai projection rebuild task_view/,
      );
    } finally {
      await store.close();
    }
  });

  it("counts the verdict the run recorded once the column is the declared one", async () => {
    // The control: the same row, the same read, a table at the current shape.
    // Without it the assertion above passes on a store that refuses everything.
    const store = await storeWith("verdicts");
    try {
      const [card] = await store.tasks({ retentionDays: 2 });
      expect(card!.failed).toBe(1);
      expect(card!.passed).toBe(0);
    } finally {
      await store.close();
    }
  });
});

/**
 * The columns `finding_backlog` is declared with, and the value each one holds
 * in the row below. Written as the entry a reader is owed, so that the two names
 * for one column — `gate` in the table, `step` on the entry — are the only place
 * the two vocabularies are allowed to meet.
 */
const RAISED = {
  project: "drift",
  key: "f-1",
  issue: "251",
  task_id: "wi-drift-251",
  run_id: "run-drift-2",
  gate: "proposed",
  action: "review",
  on_sha: "e".repeat(40),
  file: "packages/projector/src/postgres.ts",
  line: 136,
  severity: "minor",
  claim: "the bar is written twice",
  failure_scenario: "a passing review raises a minor and the backlog cannot say what raised it",
  raised_seq: 4211,
  raised_at: "2026-09-25T09:15:00.000Z",
} as const;

async function withOneRaised(): Promise<ProjectionStore> {
  const store = createSqliteProjectionStore(openSqliteProjections(":memory:"));
  const columns = Object.keys(RAISED);
  await store.transact(async (ctx) => {
    await backlogProjection.create(ctx);
    await ctx.query(
      `insert into finding_backlog (${columns.join(", ")})
       values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(RAISED) as unknown[],
    );
  });
  return store;
}

describe("a backlog entry read back out of the table that holds it", () => {
  it("says which step raised the finding, and never `undefined`", async () => {
    const store = await withOneRaised();
    try {
      const [entry] = await store.backlog({ project: RAISED.project });

      // The defect, stated as the thing a person reads: `lingtai backlog` prints
      // `${step}:${action}` and `backlog accept` writes it into an issue body,
      // so `undefined` here is a durable record of which step raised it, wrong.
      expect(entry?.step).toBe("proposed");
      expect(entry?.step).not.toBeUndefined();
      expect(`${entry?.step}:${entry?.action}`).toBe("proposed:review");
    } finally {
      await store.close();
    }
  });

  /**
   * **And the next one of these, not only this one.** The defect was a field
   * whose key stopped naming a column, which `toEntry` reports as `undefined`
   * rather than refusing the way `columnOf` does. Asserting the whole entry is
   * what makes that a red test for any of the twenty-three columns instead of
   * for the one somebody happened to rename — the round trip, and no field left
   * to be quietly absent.
   */
  it("carries every declared column through, with nothing silently absent", async () => {
    const store = await withOneRaised();
    try {
      const [entry] = await store.backlog({ project: RAISED.project });

      expect(entry).toEqual({
        key: RAISED.key,
        project: RAISED.project,
        issue: RAISED.issue,
        taskId: RAISED.task_id,
        runId: RAISED.run_id,
        step: RAISED.gate,
        action: RAISED.action,
        onSha: RAISED.on_sha,
        file: RAISED.file,
        line: RAISED.line,
        severity: RAISED.severity,
        claim: RAISED.claim,
        failureScenario: RAISED.failure_scenario,
        raisedSeq: String(RAISED.raised_seq),
        raisedAt: new Date(RAISED.raised_at),
        // The default the DDL gives a row nobody has decided yet, and the nulls
        // beside it: absent because nothing was decided, not because a key
        // missed its column.
        status: "open",
        decidedBy: null,
        decidedAt: null,
        kind: null,
        proposedRef: null,
        proposedUrl: null,
        reason: null,
      } satisfies BacklogEntry);
    } finally {
      await store.close();
    }
  });
});
