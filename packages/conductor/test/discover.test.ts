/**
 * Discovery, and the queue it feeds.
 *
 * `considerIssue` is pure, so most of the rules are testable without a database
 * or a network. `runnableNow` gets the real store anyway, because "it appends
 * nothing" is a claim about the log rather than about a return value.
 */
import type { Recipe } from "@lingtai/recipe";
import type { GitHubClient, Issue } from "@lingtai/github";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { directDatabaseUrl } from "@lingtai/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workItemStream } from "@lingtai/domain";
import { considerIssue, kindOf, runnableNow } from "../src/index.ts";

const recipe = {
  version: 1,
  repo: { base: "develop", submodules: false },
  source: { kinds: ["bug", "feature"], exclude: ["blocked", "needs-design", "agent:wip", "agent:review"] },
  env: { required: [], plantAt: ".env.local" },
  gates: { admit: [], prepared: [], proposed: [{ name: "build", run: "pnpm verify", timeout: "15m" }], merge: [], end: [] },
  runtime: { agent: "claude-code", limits: { turns: 300, wall: "2h" } },
} as unknown as Recipe;

const issue = (over: Partial<Issue> & { number: number }): Issue => ({
  title: `issue ${over.number}`,
  body: "",
  labels: [],
  state: "open",
  url: `https://example.invalid/${over.number}`,
  ...over,
});

describe("kindOf", () => {
  it("reads the kind from a label, however it is cased or spaced", () => {
    expect(kindOf(issue({ number: 1, labels: ["Bug"] }))).toBe("bug");
    expect(kindOf(issue({ number: 2, labels: ["tech debt"] }))).toBe("tech-debt");
    expect(kindOf(issue({ number: 3, labels: ["enhancement"] }))).toBe("enhancement");
  });

  it("is null when nothing says, rather than guessing", () => {
    // Guessing `bug` would put every unclassified issue at the front of a queue
    // whose priority order is by kind.
    expect(kindOf(issue({ number: 4, labels: ["documentation", "good first issue"] }))).toBeNull();
  });
});

describe("considerIssue", () => {
  it("accepts an open issue of a wanted kind", () => {
    expect(considerIssue(issue({ number: 1, labels: ["bug"] }), recipe).skip).toBeNull();
  });

  /**
   * Another system's labels are refused *because the recipe says so*, not
   * because this file knows what `agent:` means. There used to be a hardcoded
   * rule here skipping the whole namespace, and it took `agent:followup` —
   * ready work an agent had filed — down with `agent:wip`.
   */
  it("refuses another system's labels when the recipe names them", () => {
    expect(considerIssue(issue({ number: 2, labels: ["bug", "agent:wip"] }), recipe).skip).toBe(
      "excluded-label",
    );
    expect(considerIssue(issue({ number: 3, labels: ["bug", "agent:review"] }), recipe).skip).toBe(
      "excluded-label",
    );
  });

  it("takes a label in that namespace the recipe did not name", () => {
    // `agent:followup` is not in the exclude list, so it is ordinary work. The
    // old rule would have skipped it for its prefix alone.
    expect(considerIssue(issue({ number: 5, labels: ["bug", "agent:followup"] }), recipe).skip).toBeNull();
  });

  it("honours the recipe's own exclude list", () => {
    expect(considerIssue(issue({ number: 4, labels: ["bug", "blocked"] }), recipe).skip).toBe(
      "excluded-label",
    );
    expect(considerIssue(issue({ number: 5, labels: ["bug", "Needs-Design"] }), recipe).skip).toBe(
      "excluded-label",
    );
  });

  it("skips a kind this project does not want, and says which reason", () => {
    expect(considerIssue(issue({ number: 6, labels: ["tech-debt"] }), recipe).skip).toBe(
      "kind-not-wanted",
    );
    expect(considerIssue(issue({ number: 7, labels: [] }), recipe).skip).toBe("no-kind");
    expect(considerIssue(issue({ number: 8, labels: ["bug"], state: "closed" }), recipe).skip).toBe(
      "closed",
    );
  });
});

// ---------------------------------------------------------------- live ----

/**
 * A fresh project per test. They share one `events` table and one `queue`, so a
 * test that asserted on "the queue" would be asserting on its neighbours' rows
 * too — which is exactly how it failed the first time.
 */
const projects = new Set<string>();
function newProject(): string {
  const p = `esctest${crypto.randomUUID().slice(0, 6)}`;
  projects.add(p);
  return p;
}

const created = new Set<string>();

/** A client that answers from a fixed set of issues. */
function fakeClient(issues: Issue[], project = "esctest"): GitHubClient {
  return {
    owner: "steven-zhc",
    repo: project,
    installation: { id: 1, permissions: {}, account: "steven-zhc", repositorySelection: "selected" },
    request: async () => {
      throw new Error("not used");
    },
    // Throws rather than returning a dummy: these tests clone from a local path
    // and must never authenticate. If something starts asking for a token, the
    // test should say so loudly rather than quietly succeed with a fake one.
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    fileAt: async () => null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => issues,
  comment: async () => { throw new Error("no writes in this test"); },
  setLabels: async () => { throw new Error("no writes in this test"); },
    closeIssue: async () => {},
    getIssue: async (n) => issues.find((i) => i.number === n) ?? issue({ number: n }),
  };
}

let client: Db;
let store: EventStore;

beforeAll(() => {
  client = createDb();
  store = createEventStore(client);
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.query("delete from queue where project = any($1::text[])", [[...projects]]);
    await c.query("delete from checkpoints where name = 'queue'");
    await c.end();
  }
});

function track(streams: string[]): void {
  for (const s of streams) created.add(s);
}

describe("runnableNow", () => {
  /**
   * Nothing is appended and nothing is stored. What is runnable is what GitHub
   * lists that the recipe will take, returned to the caller — so the assertion
   * is about the answer, and the next one is about the log staying empty.
   */
  it("reports what is runnable and explains every issue it passed over", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 101, labels: ["bug"], title: "a race in the importer" }),
      issue({ number: 102, labels: ["feature"] }),
      issue({ number: 103, labels: ["bug", "agent:wip"] }),
      issue({ number: 104, labels: [] }),
    ];

    const result = await runnableNow({ client: fakeClient(issues, PROJECT), recipe });

    expect(result.runnable.map((r) => r.ref)).toEqual(["101", "102"]);
    expect(result.runnable[0]).toEqual({ ref: "101", title: "a race in the importer", kind: "bug" });
    expect(result.skipped).toEqual([
      { ref: 103, reason: "excluded-label" },
      { ref: 104, reason: "no-kind" },
    ]);
  });

  it("appends nothing at all", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 201, labels: ["bug"] })];

    await runnableNow({ client: fakeClient(issues, PROJECT), recipe });

    // The whole point of 0012: which issues exist is GitHub's state, and one
    // event per issue per pass was reproducing a fact GitHub answers on demand.
    expect(await store.read(workItemStream(PROJECT, 201))).toEqual([]);
  });

  /**
   * `only` means "look at these", not "these are all there is". It used to
   * matter because a partial answer written into the queue cache would delete
   * every task the caller did not name; now it only narrows the question.
   */
  it("asks about only the issues it was given", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 301, labels: ["bug"] }),
      issue({ number: 302, labels: ["bug"] }),
    ];

    const result = await runnableNow({
      client: fakeClient(issues, PROJECT),
      recipe,
      only: [302],
    });

    expect(result.runnable.map((r) => r.ref)).toEqual(["302"]);
  });
});
