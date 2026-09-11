/**
 * `lingtai requeue`, against the real log.
 *
 * The claim worth testing is not that the command works — it is that it is the
 * *same decision* the board takes. `#130` exists because `requeue()` had one
 * caller, a button, and the day five items blocked against a harness bug the
 * only way to answer them from a terminal was a throwaway script. A second
 * vocabulary for one idea is what this file is here to make impossible: the
 * event the command appends is compared, field by field, with the event the
 * board's own call appends for the same input.
 *
 * Real events, throwaway project, as every database-touching test here does.
 */
import { projectStream, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { requeue } from "@lingtai/conductor";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { userInfo } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requeueCommand } from "../src/requeue.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;

/** Blocked, answered from the terminal. */
const FROM_CLI = 123;
/** Blocked, answered from the board — the same decision, for comparison. */
const FROM_BOARD = 124;
/** Claimed, so there is nothing to hand back. */
const RUNNING = 125;

const wi = (n: number) => workItemStream(PROJECT, n);
const run = (n: number) => `run-${PROJECT}-${n}`;

/** What the board's `requeueCard` records, which is the local account (0007). */
const ACTOR = `human:${userInfo().username}`;
const NOTE = "the agent gate refused every review; the block is the harness, not the diff";

let client: Db;
let store: EventStore;

const discovered = (n: number) => ({
  type: "WorkItemDiscovered",
  actor: "github",
  data: {
    project: PROJECT,
    source: "github-issue" as const,
    externalRef: String(n),
    title: `a review that never ran (${n})`,
    kind: "bug",
    labels: [],
  },
});

const claimed = (n: number) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId: run(n), worker: "w", title: null, kind: null },
});

const blocked = (n: number) => ({
  type: "WorkItemBlocked",
  actor: "conductor",
  data: {
    question: "the agent gate returned a refusal instead of findings",
    needsFrom: "human" as const,
    runId: run(n),
    needs: "acknowledgement" as const,
    diagnosis: null,
  },
});

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);

  // Registered, because the command refuses a project it has never heard of
  // before it goes looking for a work item.
  await store.append(projectStream(PROJECT), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: { project: PROJECT, owner: "steven-zhc", base: "develop", configHash: "h", fromSha: "s" },
    },
  ]);

  await store.append(wi(FROM_CLI), 0, [discovered(FROM_CLI), claimed(FROM_CLI), blocked(FROM_CLI)]);
  await store.append(wi(FROM_BOARD), 0, [
    discovered(FROM_BOARD),
    claimed(FROM_BOARD),
    blocked(FROM_BOARD),
  ]);
  await store.append(wi(RUNNING), 0, [discovered(RUNNING), claimed(RUNNING)]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [
      [
        projectStream(PROJECT),
        wi(FROM_CLI),
        wi(FROM_BOARD),
        wi(RUNNING),
        run(FROM_CLI),
        run(FROM_BOARD),
        run(RUNNING),
      ],
    ]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("lingtai requeue", () => {
  it("puts a blocked item back in the queue, carrying the note", async () => {
    const said: string[] = [];
    const code = await requeueCommand({ project: PROJECT, issue: FROM_CLI, note: NOTE }, (l) =>
      said.push(l),
    );

    expect(code).toBe(0);
    expect(said.join("\n")).toContain("back in the queue");

    const events = await store.read(wi(FROM_CLI));
    const last = events[events.length - 1]!;
    expect(last.type).toBe("WorkItemUnblocked");
    expect(last.data).toEqual({ by: ACTOR, note: NOTE });
    expect(reduceWorkItem(events).lifecycle.status).toBe("backlog");
  });

  /**
   * `#130`'s last requirement, and the reason the command is a wrapper rather
   * than a second implementation. Whatever is appended here has to be the same
   * event the board appends — `requeueCard` calls `requeue()` with the local
   * account and the operator's note, which is exactly what is compared.
   *
   * Everything but the envelope's own bookkeeping: `seq`, `streamId` and `at`
   * differ between any two events and say nothing about who decided.
   */
  it("appends what the board appends, and nothing that says which side asked", async () => {
    const board = await requeue({
      project: PROJECT,
      issue: FROM_BOARD,
      by: ACTOR,
      note: NOTE,
      store,
    });
    expect(board.ok).toBe(true);

    const decided = async (n: number) => {
      const events = await store.read(wi(n));
      const { seq, streamId, at, ...rest } = events[events.length - 1]!;
      return rest;
    };

    expect(await decided(FROM_CLI)).toEqual(await decided(FROM_BOARD));
  });

  it("refuses by naming the state the item is actually in", async () => {
    const said: string[] = [];
    const code = await requeueCommand({ project: PROJECT, issue: RUNNING, note: NOTE }, (l) =>
      said.push(l),
    );

    expect(code).toBe(1);
    // "not blocked" on its own sends nobody anywhere; the state it *is* in does.
    expect(said.join("\n")).toContain("claimed");
    expect(said.join("\n")).toContain(wi(RUNNING));
    expect((await store.read(wi(RUNNING))).some((e) => e.type === "WorkItemUnblocked")).toBe(false);
  });

  /**
   * `--note` left off and `--note` with nothing after it arrive here the same
   * way, and both are refused before anything is read. A person overruling a
   * block is not anonymous and is not silent.
   */
  it("refuses an empty note rather than defaulting one", async () => {
    const said: string[] = [];
    const code = await requeueCommand({ project: PROJECT, issue: FROM_CLI, note: "  " }, (l) =>
      said.push(l),
    );

    expect(code).toBe(2);
    expect(said.join("\n")).toContain("--note");
  });

  it("says so when the project was never added", async () => {
    const said: string[] = [];
    const code = await requeueCommand(
      { project: `${PROJECT}-typo`, issue: FROM_CLI, note: NOTE },
      (l) => said.push(l),
    );

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("no project named");
  });
});
