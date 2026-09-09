/**
 * Discovery, and the queue it feeds.
 *
 * `considerIssue` is pure, so most of the rules are testable without a database
 * or a network. `runnableNow` gets the real store anyway, because "it appends
 * nothing" is a claim about the log rather than about a return value.
 */
import type { Recipe } from "@lingtai/recipe";
import type { GitHubClient, Issue, Label } from "@lingtai/github";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { directDatabaseUrl } from "@lingtai/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workItemStream } from "@lingtai/domain";
import { considerIssue, kindOf, runnableNow } from "../src/index.ts";

const recipe = {
  version: 1,
  repo: { base: "develop", submodules: false },
  // `documentation` is here on purpose: it is not a member of any enum, and
  // before #76 a recipe naming it did not parse at all — which took the two
  // `bug`s down with it rather than the one label.
  source: {
    kinds: ["bug", "feature", "documentation"],
    exclude: ["blocked", "needs-design", "agent:wip", "agent:review"],
  },
  env: { required: [], plantAt: ".env.local" },
  gates: { admit: [], prepared: [], proposed: [{ name: "build", run: "pnpm verify", timeout: "15m" }], merge: [], end: [] },
  runtime: { agent: "claude-code", limits: { turns: 300, wall: "2h" } },
} as unknown as Recipe;

/**
 * Labels are given here as names, and coloured only where a test is about the
 * colour. GitHub sends `{ name, color }` and `Issue` carries both (#85); a
 * fixture that made every case say so would put a colour in twenty-five
 * assertions that are about which *label* names a kind.
 */
const issue = (
  over: Omit<Partial<Issue>, "labels"> & { number: number; labels?: (string | Label)[] },
): Issue => ({
  title: `issue ${over.number}`,
  body: "",
  state: "open",
  url: `https://example.invalid/${over.number}`,
  ...over,
  labels: (over.labels ?? []).map((l) => (typeof l === "string" ? { name: l, color: null } : l)),
});

describe("kindOf", () => {
  const kinds = ["bug", "tech-debt", "documentation"];

  it("reads the kind from a label, however it is cased or spaced", () => {
    expect(kindOf(issue({ number: 1, labels: ["Bug"] }), kinds)).toBe("bug");
    expect(kindOf(issue({ number: 2, labels: ["tech debt"] }), kinds)).toBe("tech-debt");
  });

  /**
   * The whole of #76 in one assertion. `documentation` was not in the core's
   * `WorkKind` enum, and a recipe that named it did not fail to take
   * documentation — it failed to resolve, so the project offered nothing at all.
   */
  it("takes any label the recipe names, not a vocabulary of its own", () => {
    expect(kindOf(issue({ number: 3, labels: ["documentation"] }), kinds)).toBe("documentation");
    expect(kindOf(issue({ number: 4, labels: ["chore"] }), ["chore"])).toBe("chore");
  });

  it("is null for a label the recipe does not name, rather than guessing", () => {
    // Guessing the first kind would put every unclassified issue at the front
    // of a queue whose priority order is by kind. `enhancement` used to be in
    // the enum and is in no recipe here, which is the asymmetry #76 removed.
    expect(kindOf(issue({ number: 5, labels: ["enhancement"] }), kinds)).toBeNull();
    expect(kindOf(issue({ number: 6, labels: ["good first issue"] }), kinds)).toBeNull();
  });

  it("resolves an issue carrying two by the recipe's order, not the issue's", () => {
    expect(kindOf(issue({ number: 7, labels: ["documentation", "bug"] }), kinds)).toBe("bug");
    expect(kindOf(issue({ number: 8, labels: ["documentation", "bug"] }), ["documentation", "bug"])).toBe(
      "documentation",
    );
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

  it("takes a label of the repository's own that no enum ever had", () => {
    expect(considerIssue(issue({ number: 9, labels: ["documentation"] }), recipe).skip).toBeNull();
  });

  it("skips a kind this project does not want, and says which reason", () => {
    // One reason, not two: with the recipe's `kinds` as the whole vocabulary
    // there is no difference between "unclassified" and "classified as
    // something this project does not take". `kind-not-wanted` named that gap
    // and the gap is gone (#76).
    expect(considerIssue(issue({ number: 6, labels: ["tech-debt"] }), recipe).skip).toBe("no-kind");
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
  updateBody: async () => { throw new Error("no writes in this test"); },
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

  /**
   * The colour is the repository's and is read, never invented (#85). Kinds are
   * unbounded since #76, so a colour Lingtai generated would have to be hashed
   * from the name — and a hash lands on the palette's reserved amber sooner or
   * later, silently. It comes off the issues this call already read, so asking
   * for it costs no request.
   */
  it("reports what colour the repository gives each kind it offers", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 401, labels: [{ name: "bug", color: "#d73a4a" }] }),
      issue({ number: 402, labels: [{ name: "feature", color: "#a2eeef" }] }),
    ];

    const result = await runnableNow({ client: fakeClient(issues, PROJECT), recipe });

    expect(result.kindColors).toEqual({ bug: "#d73a4a", feature: "#a2eeef" });
  });

  /**
   * A kind's colour is a fact about the repository, not about whether this
   * particular ticket can be run — and a held ticket is often the only open
   * issue a kind has. Learning colours only from runnable issues would lose a
   * kind's colour the moment its last queued item was claimed.
   */
  it("learns a kind's colour from an issue it is passing over", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 403, labels: [{ name: "bug", color: "#d73a4a" }, "blocked"] })];

    const result = await runnableNow({ client: fakeClient(issues, PROJECT), recipe });

    expect(result.runnable).toEqual([]);
    expect(result.skipped).toEqual([{ ref: 403, reason: "excluded-label" }]);
    expect(result.kindColors).toEqual({ bug: "#d73a4a" });
  });

  /**
   * Absent, not defaulted. No colour is exactly what a renderer needs to hear
   * to render none — the kind stays grey text, which is what every kind was
   * before this existed.
   */
  it("says nothing about a label GitHub gives no colour for", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 404, labels: ["bug"] })];

    const result = await runnableNow({ client: fakeClient(issues, PROJECT), recipe });

    expect(result.kindColors).toEqual({});
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
