/**
 * Convergence: GitHub is brought into line without anything being replayed.
 *
 * The test #69 asked for, in the shape it asked for: **fail a label write, run
 * reconcile, assert GitHub matches the log.** The failure is recorded as
 * `IssueUpdateFailed` exactly as `tell.ts` records it, and nothing between that
 * and the reconcile remembers the call — the pass has to work it out from
 * `labelsFor` and the work item's own state, which is the whole argument the
 * outbox was deleted on.
 *
 * The second property is the one that makes it convergence rather than retry:
 * an issue somebody fixed by hand gets no write at all.
 */
import { directDatabaseUrl } from "@lingtai/env";
import type { GitHubClient, Issue } from "@lingtai/github";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import type { ProjectState } from "@lingtai/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convergeIssues, findIssueDrift } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const project: ProjectState = {
  project: PROJECT,
  owner: "steven-zhc",
  base: "main",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  version: 1,
  lastSeq: null,
};

/** GitHub, as a mutable set of labels plus a record of what was asked of it. */
function fakeGitHub(start: { labels: string[]; state?: "open" | "closed" }) {
  const world = { labels: [...start.labels], state: start.state ?? ("open" as "open" | "closed") };
  const writes: string[] = [];
  const github = {
    getIssue: async (n: number): Promise<Issue> => ({
      number: n,
      title: "a ticket",
      body: "",
      labels: [...world.labels],
      state: world.state,
      url: `https://example.invalid/${n}`,
    }),
    setLabels: async (_n: number, labels: readonly string[]) => {
      world.labels = [...labels];
      writes.push(`setLabels ${[...labels].sort().join(",")}`);
    },
    closeIssue: async () => {
      world.state = "closed";
      writes.push("close");
    },
    comment: async () => {
      writes.push("comment");
      return { id: 1 };
    },
  } as unknown as GitHubClient;
  return { github, world, writes };
}

async function seed(stream: string, events: { type: string; data: unknown }[]): Promise<void> {
  created.add(stream);
  await store.append(
    stream,
    0,
    events.map((e) => ({ type: e.type, actor: "conductor", data: e.data as never })),
  );
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

describe("convergeIssues", () => {
  /** #69's test, verbatim: fail a label write, reconcile, GitHub matches the log. */
  it("brings an issue whose label write failed back into line, without replaying it", async () => {
    const stream = `wi-${PROJECT}-1`;
    await seed(stream, [
      { type: "WorkItemClaimed", data: { runId: `run-${PROJECT}-1`, worker: "w", leaseUntilMs: Date.now() + 600_000, title: "t", kind: "bug" } },
      // Exactly what `tell.ts` writes when GitHub refuses. Nothing else about
      // the call survives — no body, no attempt count, no queue row.
      { type: "IssueUpdateFailed", data: { project: PROJECT, issue: "1", change: "labels", error: "503 from GitHub" } },
    ]);

    // Somebody else's label is on the issue and must survive; ours is missing.
    const { github, world, writes } = fakeGitHub({ labels: ["bug"] });

    const { converged } = await convergeIssues({
      store,
      projects: [project],
      clients: new Map([[PROJECT, github]]),
    });

    expect(world.labels.sort()).toEqual(["bug", "lingtai:working"]);
    expect(writes).toEqual(["setLabels bug,lingtai:working"]);
    expect(converged.map((d) => d.change)).toEqual(["labels"]);

    // And the log now says so, which is how doctor's check goes quiet — by the
    // log agreeing with itself, not by anything being marked resolved.
    const types = (await store.read(stream)).map((e) => e.type);
    expect(types.at(-1)).toBe("IssueUpdated");
    expect(await findIssueDrift({ store, projects: [project], clients: new Map([[PROJECT, github]]) })).toEqual([]);
  }, 60_000);

  /**
   * The difference between convergence and retry, as an assertion. The log
   * still records a failure; GitHub is already right; nothing is written.
   */
  it("writes nothing when somebody already fixed the issue by hand", async () => {
    const stream = `wi-${PROJECT}-2`;
    await seed(stream, [
      { type: "WorkItemClaimed", data: { runId: `run-${PROJECT}-2`, worker: "w", leaseUntilMs: Date.now() + 600_000, title: "t", kind: "bug" } },
      { type: "IssueUpdateFailed", data: { project: PROJECT, issue: "2", change: "labels", error: "503 from GitHub" } },
    ]);

    const { github, writes } = fakeGitHub({ labels: ["bug", "lingtai:working"] });
    const { divergences, converged } = await convergeIssues({
      store,
      projects: [project],
      clients: new Map([[PROJECT, github]]),
    });

    expect(divergences).toEqual([]);
    expect(converged).toEqual([]);
    expect(writes).toEqual([]);
  }, 60_000);

  /** A comment cannot be recomputed, so it is reported and left alone. */
  it("reports a lost comment and does not re-send it", async () => {
    const stream = `wi-${PROJECT}-3`;
    await seed(stream, [
      { type: "WorkItemClaimed", data: { runId: `run-${PROJECT}-3`, worker: "w", leaseUntilMs: Date.now() + 600_000, title: "t", kind: "bug" } },
      { type: "IssueUpdated", data: { project: PROJECT, issue: "3", change: "labels", detail: "lingtai:working" } },
      { type: "IssueUpdateFailed", data: { project: PROJECT, issue: "3", change: "comment", error: "503 from GitHub" } },
    ]);

    const { github, writes } = fakeGitHub({ labels: ["bug", "lingtai:working"] });
    const { divergences, converged } = await convergeIssues({
      store,
      projects: [project],
      clients: new Map([[PROJECT, github]]),
    });

    expect(divergences.map((d) => d.change)).toEqual(["comment"]);
    expect(converged).toEqual([]);
    // The point: no comment was posted. Re-sending would be replay wearing
    // convergence's clothes.
    expect(writes).toEqual([]);
  }, 60_000);

  /** A landed item should be carrying no Lingtai label, and a stale one is drift. */
  it("clears a label the log says should be gone", async () => {
    const stream = `wi-${PROJECT}-4`;
    await seed(stream, [
      { type: "WorkItemClaimed", data: { runId: `run-${PROJECT}-4`, worker: "w", leaseUntilMs: Date.now() + 600_000, title: "t", kind: "bug" } },
      { type: "WorkItemLanded", data: { mergeCommit: "a".repeat(40), base: "main" } },
      { type: "IssueUpdateFailed", data: { project: PROJECT, issue: "4", change: "labels", error: "503" } },
    ]);

    const { github, world } = fakeGitHub({ labels: ["bug", "lingtai:working"] });
    await convergeIssues({ store, projects: [project], clients: new Map([[PROJECT, github]]) });

    expect(world.labels).toEqual(["bug"]);
  }, 60_000);
});
