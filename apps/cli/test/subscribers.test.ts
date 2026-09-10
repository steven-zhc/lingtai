/**
 * Which project an event is about, against the real log.
 *
 * This is the file that answers the refusal that ended attempt 3 of `#123`. The
 * old subscription was `{ project: "*" }` and short-circuited before it ever
 * looked at a stream; a per-recipe one cannot, and **three of the four types
 * this repository declares are appended to no work item stream**:
 *
 *   `WorkItemBlocked`      `wi-{project}-{n}`    the stream says it
 *   `IntegrationRefused`   `int-{project}-{base}` `data.workItemId` says it
 *   `ApprovalRequested`    `run-<uuid>`          only the run's `RunStarted`
 *   `RunAwaitingInput`     `run-<uuid>`          the same
 *
 * So all four are appended here exactly as `run-once.ts`, `hook-socket.ts` and
 * `integrate.ts` append them, and the resolver is asked. A mock store would
 * have passed for the version that was refused, because the thing it got wrong
 * was what the log actually holds.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { integrationStream, workItemStream } from "@lingtai/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubjectResolver } from "../src/subscribers.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const wi = workItemStream(PROJECT, 7);
const runId = `run-${crypto.randomUUID()}`;
const startless = `run-${crypto.randomUUID()}`;
const lane = integrationStream(PROJECT, "main");
const streams = [wi, runId, startless, lane];

let client: Db;
let store: EventStore;
let subject: ReturnType<typeof createSubjectResolver>;

/** The envelope the resolver is handed, off the log rather than made up. */
const head = async (streamId: string) => {
  const events = await store.read(streamId);
  const last = events.at(-1);
  if (!last) throw new Error(`${streamId} is empty`);
  return last;
};

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  subject = createSubjectResolver(store);

  // A run stream, opened the way `run-once.ts` opens one: `RunStarted` first,
  // carrying the work item, and then the events that carry only a `runId`.
  await store.append(runId, 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: {
        workItemId: wi,
        runtime: "claude-code",
        model: "claude-opus-5",
        promptVersion: "v1",
        baseSha: "a".repeat(40),
        configHash: "b".repeat(12),
        worktree: "/tmp/wt",
        invocation: null,
      },
    },
  ]);
  await store.append(runId, 1, [
    {
      type: "ApprovalRequested",
      actor: "conductor",
      data: {
        gate: "merge",
        action: "approve",
        runId,
        onSha: "c".repeat(40),
        question: "Merge into main?",
        artifacts: [],
      },
    },
  ]);
  await store.append(runId, 2, [
    { type: "RunAwaitingInput", actor: `agent:${runId}`, data: { prompt: "which base?" } },
  ]);
  await store.append(lane, 0, [
    {
      type: "IntegrationRefused",
      actor: "conductor",
      data: { workItemId: wi, branch: "agent/7", reason: "conflict", detail: "does not merge" },
    },
  ]);
  await store.append(wi, 0, [
    {
      type: "WorkItemBlocked",
      actor: "conductor",
      data: {
        question: "which base?",
        needsFrom: "human",
        runId,
        needs: "judgement",
        diagnosis: null,
      },
    },
  ]);
  // A run refused before it started: no `RunStarted`, so nothing names a card.
  await store.append(startless, 0, [
    { type: "RunAwaitingInput", actor: `agent:${startless}`, data: { prompt: "anybody there?" } },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [streams]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("createSubjectResolver", () => {
  const card = { id: wi, project: PROJECT, issue: "7" };

  it("reads the work item off its own stream", async () => {
    expect(await subject(await head(wi))).toEqual(card);
  });

  /** `int-{project}-{base}` cannot be split back — a base may hold a `-` — so the payload answers. */
  it("reads it off `workItemId` for an integration lane", async () => {
    expect(await subject(await head(lane))).toEqual(card);
  });

  /**
   * The two the refused attempt dropped. Both are on a run stream and carry a
   * `runId` and nothing else, so the answer is `RunStarted`, which is the run
   * stream's own first word.
   */
  it("reads it off the run's RunStarted for an approval", async () => {
    const events = await store.read(runId);
    const approval = events.find((e) => e.type === "ApprovalRequested");
    expect(approval).toBeDefined();
    expect(await subject(approval!)).toEqual(card);
  });

  it("reads it off the run's RunStarted for a question", async () => {
    expect(await subject(await head(runId))).toEqual(card);
  });

  /**
   * Null is *not from here*, and it is what a notification must not be sent
   * about: a card named by guesswork is worse than none.
   */
  it("answers null for a run that never started", async () => {
    expect(await subject(await head(startless))).toBeNull();
  });

  it("answers null for a stream that belongs to the installation", async () => {
    const control = await head(wi);
    expect(await subject({ ...control, streamId: "ctl-conductor" })).toBeNull();
    expect(await subject({ ...control, streamId: "chat-abc" })).toBeNull();
  });
});
