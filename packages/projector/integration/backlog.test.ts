/**
 * `finding_backlog`, against the real store (`#137`).
 *
 * What it has to hold: a passing gate's minors become entries and nothing else
 * does; the same finding on a second attempt is the same entry; a decision
 * closes it; and dropping the table and replaying the log gives the same rows.
 */
import { directPostgresUrl } from "@lingtai/env";
import { backlogStream, findingKey } from "@lingtai/domain";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogProjection, createProjectionRunner, readBacklog } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const track = (id: string) => {
  created.add(id);
  return id;
};
const wi = (n: number) => track(`wi-${PROJECT}-${n}`);
const run = (n: number, attempt: number) => track(`run-${PROJECT}-${n}-${attempt}`);

const minor = (claim: string, line: number) => ({
  file: "src/a.ts",
  line,
  claim,
  failureScenario: `when ${claim}, it breaks`,
  severity: "minor" as const,
});

async function attempt(n: number, a: number, findings: unknown[], verdict = "GatePassed") {
  await store.append(run(n, a), 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: {
        workItemId: wi(n),
        runtime: "claude-code",
        model: "m",
        promptVersion: "p",
        baseSha: "base",
        configHash: "h",
        worktree: "/tmp/w",
        invocation: null,
      },
    },
    {
      type: verdict,
      actor: "conductor",
      data: { step: "proposed", action: "review", runId: run(n, a), onSha: `sha-${a}`, evidence: "ok", findings },
    },
  ]);
}

async function rebuild(): Promise<void> {
  const runner = createProjectionRunner({ projection: backlogProjection, store });
  try {
    await runner.rebuild();
  } finally {
    await runner.close();
  }
}

async function fold(): Promise<void> {
  const runner = createProjectionRunner({ projection: backlogProjection, store });
  try {
    await runner.start();
  } finally {
    await runner.close();
  }
}

const keyOf = (claim: string) =>
  findingKey({ issue: "1", step: "proposed", action: "review", file: "src/a.ts", claim });

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  // The test database is shared, and may hold this table in an older shape.
  // A rebuild is how any drift is answered, here as anywhere.
  await rebuild();

  await attempt(1, 1, [
    minor("the name shadows an import", 10),
    minor("the error message is vague", 20),
    { ...minor("a major is not backlog", 30), severity: "major" },
  ]);
  // A failing gate's findings go to a fix round, not here.
  await attempt(2, 1, [minor("on a failing gate", 5)], "GateFailed");
  await fold();

  // The second attempt says the first thing again, lines moved and spacing changed.
  await attempt(1, 2, [minor("The name  shadows an import", 14)]);
  const declined = track(backlogStream(PROJECT, keyOf("the error message is vague")));
  await store.append(declined, 0, [
    { type: "FindingDeclined", actor: "human:t", data: { project: PROJECT, key: keyOf("the error message is vague"), by: "human:t", reason: "style" } },
  ]);
  const accepted = track(backlogStream(PROJECT, keyOf("the name shadows an import")));
  await store.append(accepted, 0, [
    {
      type: "FindingAccepted",
      actor: "human:t",
      data: { project: PROJECT, key: keyOf("the name shadows an import"), by: "human:t", kind: "bug", labels: ["agent:hold"] },
    },
    {
      type: "FindingProposed",
      actor: "human:t",
      data: { project: PROJECT, key: keyOf("the name shadows an import"), by: "human:t", externalRef: "212", url: "https://x/212" },
    },
  ]);
  await fold();

  // A third attempt, after both decisions, says both things again.
  await attempt(1, 3, [minor("the error message is vague", 22), minor("the name shadows an import", 11)]);
  await fold();
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directPostgresUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
    await c.query("delete from finding_backlog where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("finding_backlog", () => {
  it("holds a passing gate's minors, one entry per finding however many attempts said it", async () => {
    const entries = await readBacklog({ project: PROJECT });
    expect(entries.map((e) => e.claim).sort()).toEqual([
      "the error message is vague",
      "the name shadows an import",
    ]);
  });

  it("keeps the run and gate that first raised it, and everything the finding said", async () => {
    const [entry] = await readBacklog({ project: PROJECT, key: keyOf("the name shadows an import") });
    expect(entry).toMatchObject({
      issue: "1",
      taskId: wi(1),
      runId: run(1, 1),
      step: "proposed",
      action: "review",
      file: "src/a.ts",
      line: 10,
      severity: "minor",
      failureScenario: "when the name shadows an import, it breaks",
    });
  });

  it("records the decision, so the same finding does not ask again", async () => {
    // The third attempt raised both after they were decided, and neither reopened.
    const open = await readBacklog({ project: PROJECT, status: "open" });
    expect(open).toEqual([]);
    const [accepted] = await readBacklog({ project: PROJECT, status: "accepted" });
    expect(accepted).toMatchObject({ proposedRef: "212", kind: "bug", decidedBy: "human:t", runId: run(1, 1) });
    const [declined] = await readBacklog({ project: PROJECT, status: "declined" });
    expect(declined).toMatchObject({ reason: "style", runId: run(1, 1) });
    expect(await readBacklog({ project: PROJECT })).toHaveLength(2);
  });

  it("is reproduced by a rebuild", async () => {
    const before = await readBacklog({ project: PROJECT });
    await rebuild();
    expect(await readBacklog({ project: PROJECT })).toEqual(before);
  }, 120_000);
});
