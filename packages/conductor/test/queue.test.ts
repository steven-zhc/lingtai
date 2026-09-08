/**
 * The subtraction: what GitHub offers, minus what the log says is claimed.
 *
 * Lives beside `selectRunnable` rather than beside the projection it reads.
 * The fold is `projector`'s and is tested there; the *decision* about what to
 * take next is the conductor's, and this is that decision — the seam 0022 drew
 * between a projection and a caller that reads one.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { createProjectionRunner } from "@lingtai/projector";
import { taskViewProjection } from "@lingtai/projector";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectRunnable } from "../src/index.ts";

const created = new Set<string>();
let client: Db;
let store: EventStore;

/** The projection has to exist before the queue can subtract from it. */
async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store });
  try {
    await runner.start();
  } finally {
    await runner.close();
  }
}

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
    await c.query("delete from events where stream_id = any($1)", [[...created]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("selectRunnable", () => {
  const other = `esctest${crypto.randomUUID().slice(0, 6)}`;

  /**
   * The subtraction. GitHub's offer is an argument now rather than a table, so
   * what is being tested is the rule and not a cache's freshness.
   */
  it("offers what GitHub lists, minus what the log says is claimed", async () => {
    const offered = [
      { ref: "10", title: "one", kind: "bug" },
      { ref: "11", title: "two", kind: "feature" },
    ];
    const kinds = ["bug", "feature"];

    // No rows at all: the log has no opinion about either, so both are runnable.
    const before = await selectRunnable({ project: other, offered, kinds });
    expect(before.map((r) => r.issue)).toEqual(["10", "11"]);
    expect(before[0]).toEqual({ taskId: `wi-${other}-10`, issue: "10", title: "one", kind: "bug" });

    const claimedId = `wi-${other}-10`;
    created.add(claimedId);
    await store.append(claimedId, 0, [
      { type: "WorkItemClaimed", actor: "conductor", data: { runId: `run-${other}-10`, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null } },
    ]);
    created.add(`run-${other}-10`);
    await build();

    // GitHub still lists 10. The log is the authority on what happened after
    // the claim, and it says the claim happened.
    expect((await selectRunnable({ project: other, offered, kinds })).map((r) => r.issue)).toEqual([
      "11",
    ]);

    // GitHub stops listing 11 — closed by a person. Nothing has to be
    // invalidated, because nothing was stored: it is simply not in the offer.
    const narrowed = await selectRunnable({ project: other, offered: [offered[0]!], kinds });
    expect(narrowed).toEqual([]);
  });

  /** Priority is the recipe's `kinds` order, and ties break numerically. */
  it("puts the recipe's first kind first, and orders by issue number inside it", async () => {
    const fresh = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const runnable = await selectRunnable({
      project: fresh,
      offered: [
        { ref: "9", title: "b", kind: "bug" },
        { ref: "100", title: "f", kind: "feature" },
        { ref: "20", title: "b2", kind: "bug" },
      ],
      kinds: ["feature", "bug"],
    });
    // #100 beats both bugs on kind; #9 beats #20 numerically, not lexically.
    expect(runnable.map((r) => r.issue)).toEqual(["100", "9", "20"]);
  });

  /** A kind the recipe does not want is not offered, whatever GitHub says. */
  it("drops a kind the recipe does not take", async () => {
    const fresh = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const runnable = await selectRunnable({
      project: fresh,
      offered: [{ ref: "1", title: "c", kind: "chore" }],
      kinds: ["bug"],
    });
    expect(runnable).toEqual([]);
  });

  afterAll(async () => {
    const c = new pg.Client({ connectionString: directDatabaseUrl() });
    await c.connect();
    try {
      await c.query("delete from task_view where project = $1", [other]);
    } finally {
      await c.end();
    }
  });
});
