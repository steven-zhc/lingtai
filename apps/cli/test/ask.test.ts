/**
 * `lingtai ask` and `lingtai answer`, against the real log (#147).
 *
 * What is worth testing is the round trip the ticket is about: a question
 * asked before anything is claimed lands as a block belonging to no run,
 * `lingtai status` prints the question rather than counting it, and the answer
 * is what a replay — and the projection rebuilt from it — can say afterwards.
 *
 * Real events, throwaway project, as every database-touching test here does.
 */
import { projectStream, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { directPostgresUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { createProjectionRunner, taskViewProjection } from "@lingtai/projector";
import { userInfo } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerCommand, askCommand } from "../src/ask.ts";
import { requeueCommand } from "../src/requeue.ts";
import { status } from "../src/status.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;

/** Asked, then answered. */
const ASKED = 51;
/** Claimed, so there is no asking it anything before a run. */
const RUNNING = 52;
/** Asked by mistake, then withdrawn. */
const WITHDRAWN = 53;

const wi = (n: number) => workItemStream(PROJECT, n);
const ACTOR = `human:${userInfo().username}`;
const QUESTION = "which of the three designs for the production-credential tripwire?";
const CHOICE = "the second — refuse at the hook";

let client: Db;
let store: EventStore;

/**
 * Catches the projection up to the head before `status` reads it. The command
 * holds a projector while it appends, but closing one does not wait for the
 * append it just made — a daemon is what guarantees that in production, and
 * this test has none.
 */
async function fold(): Promise<void> {
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
  await store.append(projectStream(PROJECT), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: { project: PROJECT, owner: "steven-zhc", base: "develop", configHash: "h", fromSha: "s" },
    },
  ]);
  await store.append(wi(RUNNING), 0, [
    {
      type: "WorkItemClaimed",
      actor: "conductor",
      data: { runId: `run-${PROJECT}-${RUNNING}`, worker: "w", title: null, kind: null },
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directPostgresUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [
      [projectStream(PROJECT), wi(ASKED), wi(RUNNING), wi(WITHDRAWN)],
    ]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("lingtai ask / answer", () => {
  it("asks before any run, and status prints the question rather than counting it", async () => {
    const said: string[] = [];
    expect(await askCommand({ project: PROJECT, issue: ASKED, text: QUESTION }, (l) => said.push(l))).toBe(0);

    const events = await store.read(wi(ASKED));
    expect(events.map((e) => e.type)).toEqual(["WorkItemBlocked"]);
    expect(events[0]!.data).toEqual({
      question: QUESTION,
      needsFrom: "human",
      runId: null,
      needs: "judgement",
      diagnosis: null,
    });
    expect(reduceWorkItem(events).lifecycle.status).toBe("blocked");

    await fold();
    const listed: string[] = [];
    await status({ project: PROJECT }, (l) => listed.push(l));
    const out = listed.join("\n");
    expect(out).toContain(QUESTION);
    expect(out).toContain("waiting for your answer");
    // Printed, not counted: the queue line does not fold it into "waiting on you".
    expect(out).not.toMatch(/\d+ waiting on you/);
  });

  it("refuses to ask about an item a run holds", async () => {
    const said: string[] = [];
    expect(await askCommand({ project: PROJECT, issue: RUNNING, text: QUESTION }, (l) => said.push(l))).toBe(1);
    expect(said.join("\n")).toContain("claimed");
    expect((await store.read(wi(RUNNING))).some((e) => e.type === "WorkItemBlocked")).toBe(false);
  });

  it("refuses a blank question and a blank answer rather than defaulting either", async () => {
    expect(await askCommand({ project: PROJECT, issue: ASKED, text: "  " }, () => {})).toBe(2);
    expect(await answerCommand({ project: PROJECT, issue: ASKED, text: "" }, () => {})).toBe(2);
  });

  /**
   * The fold keeps whatever note ends a block with no run as a decision, and
   * every later prompt carries it. So a requeue's why must not become one — but
   * a question asked by mistake still has to have a way out that is not an
   * answer, or *asked by mistake, ignore* is what the agent is told to build.
   */
  it("withdraws a question asked before any run on requeue, and keeps no answer", async () => {
    expect(await askCommand({ project: PROJECT, issue: WITHDRAWN, text: "which desgin?" }, () => {})).toBe(0);

    const said: string[] = [];
    const code = await requeueCommand(
      { project: PROJECT, issue: WITHDRAWN, note: "asked by mistake, ignore" },
      (l) => said.push(l),
    );
    expect(code).toBe(0);
    expect(said.join("\n")).toContain("withdrawn");

    const events = await store.read(wi(WITHDRAWN));
    expect(events[events.length - 1]!.data).toEqual({ by: ACTOR, note: "asked by mistake, ignore", withdrawn: true });
    const item = reduceWorkItem(events);
    expect(item.lifecycle.status).toBe("backlog");
    expect(item.answers).toEqual([]);

    // And it can be asked again, reworded.
    expect(await askCommand({ project: PROJECT, issue: WITHDRAWN, text: "which design?" }, () => {})).toBe(0);
  });

  it("answers on the record, and the fold keeps what the answer was", async () => {
    const said: string[] = [];
    expect(await answerCommand({ project: PROJECT, issue: ASKED, text: CHOICE }, (l) => said.push(l))).toBe(0);

    const events = await store.read(wi(ASKED));
    const last = events[events.length - 1]!;
    expect(last.type).toBe("WorkItemUnblocked");
    expect(last.data).toEqual({ by: ACTOR, note: CHOICE });

    const item = reduceWorkItem(events);
    expect(item.lifecycle.status).toBe("backlog");
    expect(item.answers).toEqual([{ question: QUESTION, runId: null, answer: CHOICE, by: ACTOR }]);
  });
});
