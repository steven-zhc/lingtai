/**
 * The projector a command holds while it appends.
 *
 * The failure this pins down is not subtle and was caught by nothing: a whole
 * queue was worked by hand, the log was right, and `task_view` — the only table
 * the board reads — never moved, because the follower lived only in the daemon
 * and nobody had started one. `lingtai projection lag` said *no projection has
 * a checkpoint yet* through nine runs.
 *
 * The catch-up-on-exit that answered it was the wrong shape: the board stayed
 * frozen for the whole of a run and jumped to current when the command exited
 * (`#64`). One behaviour now — the process follows the log while it works — and
 * the two things worth asserting are that the work sees a current projection
 * *during* it, and that the process can still exit afterwards.
 */
import { readTasks } from "@lingtai/conductor";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, projectionLag, type Db, type EventStore } from "@lingtai/store";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withProjector } from "../src/projector.ts";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const wi = `wi-${PROJECT}-1`;
const runId = `run-${PROJECT}-1`;
let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [[wi, runId]]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("withProjector", () => {
  /**
   * The whole of `#64`, inverted. What was appended a moment ago is folded
   * *while the work is still running*, not after the command returns.
   */
  it("folds what the work appends, before the work has finished", async () => {
    const seen = await withProjector(
      () => {},
      async () => {
        await store.append(wi, 0, [
          {
            type: "WorkItemClaimed",
            actor: "conductor",
            data: { runId, worker: "w", leaseUntilMs: Date.now() + 60_000, title: "held open", kind: "bug" },
          },
        ]);

        // The subscription is asynchronous, so this waits on the fact rather
        // than on a duration — a sleep long enough to be reliable here would be
        // long enough to hide a regression.
        for (let i = 0; i < 100; i += 1) {
          const tasks = await readTasks({ project: PROJECT });
          if (tasks.length > 0) return tasks.map((t) => [t.issue, t.state]);
          await new Promise((r) => setTimeout(r, 100));
        }
        return [];
      },
    );

    expect(seen).toEqual([["1", "running"]]);
  }, 60_000);

  /** Every exit path, not just the happy one — including the early refusals. */
  it("releases the projector when the work throws, and the error is the caller's", async () => {
    await expect(
      withProjector(
        () => {},
        async () => {
          throw new Error("the recipe could not be read");
        },
      ),
    ).rejects.toThrow("the recipe could not be read");

    // Released, so the next one starts cleanly rather than on an exhausted pool.
    const lags = await withProjector(() => {}, async () => projectionLag());
    expect(lags.some((l) => l.name === "task_view")).toBe(true);
  }, 60_000);

  /**
   * The hazard the scope exists for. An open projector holds a session-mode
   * connection **and keeps the event loop alive**, so a command that forgot to
   * release one would print its result and then hang forever — which is worse
   * than a stale board, because it looks like the work is still going.
   */
  it("lets the process exit", async () => {
    const script = `
      import { withProjector } from ${JSON.stringify(resolve(here, "../src/projector.ts"))};
      await withProjector(() => {}, async () => "done");
      console.log("returned");
    `;
    const { stdout } = await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: resolve(here, "../../.."),
      env: process.env,
      timeout: 60_000,
    });
    expect(stdout).toContain("returned");
  }, 90_000);
});
