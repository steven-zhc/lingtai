/**
 * The wizard's last screen, and the one write onboarding makes (#165).
 *
 * Against the real log, because the two claims worth testing are both about
 * writes. *Abandon before the button and nothing was written* cannot be checked
 * against a mock that was never asked; it is checked here by running the whole
 * read-only half against a GitHub that throws on every write and a project
 * stream that is then read back and found empty. And `selectRunnable` reads
 * `task_view`, which is the point — the preview is the queue's own answer and
 * not a second one.
 */
import { projectStream, reduceProject } from "@lingtai/domain";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { GitHubError, type GitHubClient, type Issue, type Label } from "@lingtai/github";
import { RECIPE_PATH, type Recipe, resolveRecipe } from "@lingtai/recipe";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passedOver } from "../src/discover.ts";
import { selectRunnable } from "../src/queue.ts";
import {
  HOLD_LABEL,
  ONBOARDING_BRANCH,
  firstPass,
  holdAll,
  holdLabel,
  nothingReadsIt,
  pullRequestBody,
  startOnboarding,
  validateProposal,
} from "../src/wizard.ts";

const OWNER = "steven-zhc";

/**
 * A throwaway project per test, swept in `afterAll`.
 *
 * One name shared would make these tests order-dependent in the way the code
 * under test is: `startOnboarding` reads the stream first and refuses a
 * repository already recorded, so the second test to use a name would be
 * testing that refusal instead of itself.
 */
const created = new Set<string>();
function fresh(): string {
  const name = `esctest${crypto.randomUUID().slice(0, 6)}`;
  created.add(projectStream(name));
  return name;
}

/** The sentences the page showed. The file's comments and the PR body are both these. */
const SAID = {
  "source.kinds": "Order is priority: a bug is taken before a feature.",
  "gates.merge": "Nobody approves a merge — the build is what stands between an agent and develop.",
} as const;

const YAML = `
version: 1
repo:
  base: develop
source:
  kinds: [bug, feature]
  exclude: [agent:hold, epic]
gates:
  proposed:
    - name: build
      run: pnpm verify
      timeout: 15m
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`;

let recipe: Recipe;
let client: Db;
let store: EventStore;

const issue = (
  over: Omit<Partial<Issue>, "labels"> & { number: number; labels?: (string | Label)[] },
): Issue => ({
  title: `issue ${over.number}`,
  body: "",
  state: "open",
  url: `https://example.invalid/${over.number}`,
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  ...over,
  labels: (over.labels ?? []).map((l) => (typeof l === "string" ? { name: l, color: null } : l)),
});

/**
 * Four the recipe will take and four it will not, passed over for two different
 * reasons — so both counts on the line, and the breakdown inside the second,
 * are distinguishable from each other.
 */
const ISSUES: Issue[] = [
  issue({ number: 412, labels: ["bug"], title: "Search box drops the last keystroke" }),
  issue({ number: 398, labels: ["bug"], title: "Importer times out over 2MB" }),
  issue({ number: 4100, labels: ["bug"], title: "numerically after 412, not lexically" }),
  issue({ number: 7, labels: ["feature"], title: "a feature, and so behind every bug" }),
  issue({ number: 88, labels: ["bug", "agent:hold"], title: "held by a label the recipe excludes" }),
  issue({ number: 99, labels: ["epic"], title: "a table of contents, not work" }),
  issue({ number: 101, labels: ["documentation"], title: "no kind this recipe knows" }),
  issue({ number: 102, labels: [], title: "no labels at all" }),
];

/** Every write throws. A test that abandons the wizard must not reach one. */
function readOnlyClient(project: string, issues: Issue[] = ISSUES): GitHubClient {
  return {
    owner: OWNER,
    repo: project,
    installation: { id: 1, permissions: {}, account: OWNER, repositorySelection: "selected" },
    request: async (method: string) => {
      if (method !== "GET") throw new Error(`the wizard wrote to GitHub: ${method}`);
      throw new GitHubError(404, "/", "Not Found");
    },
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    fileAt: async () => null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => issues,
    listIssuesSince: async () => issues,
    getIssue: async (n) => issues.find((i) => i.number === n) ?? issue({ number: n }),
    comment: async () => {
      throw new Error("the wizard wrote to GitHub: comment");
    },
    setLabels: async () => {
      throw new Error("the wizard wrote to GitHub: setLabels");
    },
    updateBody: async () => {
      throw new Error("the wizard wrote to GitHub: updateBody");
    },
    createIssue: async () => {
      throw new Error("the wizard wrote to GitHub: createIssue");
    },
    closeIssue: async () => {
      throw new Error("the wizard wrote to GitHub: closeIssue");
    },
  };
}

/** A client that records what was asked of it, and answers the three calls the PR needs. */
function recordingClient(project: string, over: { branchExists?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const labelled: { issue: number; labels: readonly string[] }[] = [];
  const base = readOnlyClient(project);
  const client: GitHubClient = {
    ...base,
    request: (async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        if (over.branchExists) return { ref: path };
        throw new GitHubError(404, path, "Not Found");
      }
      if (path.endsWith("/pulls")) return { number: 7, html_url: `https://github.com/${OWNER}/${project}/pull/7` };
      return {};
    }) as GitHubClient["request"],
    setLabels: async (n, labels) => {
      labelled.push({ issue: n, labels });
    },
  };
  return { client, calls, labelled };
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  recipe = (await resolveRecipe(async () => YAML, "develop")).recipe;
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

describe("the queue preview", () => {
  /**
   * `selectRunnable`'s answer and not a second one — the same call, the same
   * order. #4100 after #412 is the tiebreak that says so: a listing sorted any
   * other way puts it between #398 and #412.
   */
  it("is selectRunnable's answer, in selectRunnable's order", async () => {
    const project = fresh();
    const pass = await firstPass({ client: readOnlyClient(project), recipe });

    expect(pass.taking.map((r) => r.issue)).toEqual(["398", "412", "4100", "7"]);
    expect(
      await selectRunnable({
        project,
        offered: pass.taking.map((r) => ({ ref: r.issue, title: r.title, kind: r.kind })),
        kinds: recipe.source.kinds,
        backoffMs: 60 * 60_000,
      }),
    ).toEqual(pass.taking);
  });

  /** `passedOver`'s sentence, character for character, and not a second phrasing. */
  it("counts what it passed over in discover.ts's own words", async () => {
    const pass = await firstPass({ client: readOnlyClient(fresh()), recipe });

    expect(pass.passedOver).toBe(
      passedOver([
        { ref: 88, reason: "excluded-label" },
        { ref: 99, reason: "excluded-label" },
        { ref: 101, reason: "no-kind" },
        { ref: 102, reason: "no-kind" },
      ]),
    );
    expect(pass.line).toBe("4 runnable · 4 passed over — excluded-label 2, no-kind 2");
  });

  /** Nothing passed over is no clause, rather than "0 passed over". */
  it("says only the count when the recipe takes everything", async () => {
    const pass = await firstPass({
      client: readOnlyClient(fresh(), [issue({ number: 1, labels: ["bug"] })]),
      recipe,
    });
    expect(pass.passedOver).toBeNull();
    expect(pass.line).toBe("1 runnable");
  });
});

describe("abandoning the wizard", () => {
  /**
   * **The rule the whole epic inherits, and the only place it can be checked.**
   * Every read-only step runs — the preview, the validation, the file, the pull
   * request body — against a GitHub whose every write throws, and the project
   * stream is read back afterwards. No labels, no branch, no events.
   */
  it("leaves nothing behind — no labels, no branch, no events", async () => {
    const project = fresh();
    const github = readOnlyClient(project);

    const pass = await firstPass({ client: github, recipe });
    expect(pass.taking.length).toBe(4);
    const validated = await validateProposal(recipe, SAID);
    expect(validated.ok).toBe(true);
    pullRequestBody(recipe, SAID);
    holdLabel(recipe);
    nothingReadsIt(recipe);

    expect(await store.read(projectStream(project))).toEqual([]);

    // And the stream is not empty because nothing here *could* write to it: the
    // button writes, so a test that passed for that reason would pass for ever.
    const { client: writable } = recordingClient(project);
    const started = await startOnboarding({ client: writable, recipe, said: SAID, by: "human:tester", store });
    expect(started.ok).toBe(true);
    expect((await store.read(projectStream(project))).map((e) => e.type)).toEqual([
      "ProjectOnboardingStarted",
    ]);
  });
});

describe("the pull request", () => {
  /**
   * A recipe that will not parse opens nothing at all. The refusal names the
   * field, because *which* field is the whole of what a person can act on.
   */
  it("is not opened at all by a recipe Recipe.parse refuses, and the refusal names the field", async () => {
    const { client: github, calls } = recordingClient(fresh());
    const noKinds = { ...recipe, source: { ...recipe.source, kinds: [] } } as Recipe;

    const started = await startOnboarding({
      client: github,
      recipe: noKinds,
      by: "human:tester",
      store,
      branch: "lingtai/never",
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal).toContain("source.kinds");
    // Not one request, of any kind: validation is ahead of every call.
    expect(calls).toEqual([]);
  });

  /** The branch, the file and the pull request, in that order, and then the event. */
  it("puts the recipe on a branch and opens it against repo.base", async () => {
    const project = fresh();
    const { client: github, calls } = recordingClient(project);

    const started = await startOnboarding({ client: github, recipe, said: SAID, by: "human:tester", store });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.pr.number).toBe(7);
    expect(started.branch).toBe(ONBOARDING_BRANCH);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/${OWNER}/${project}/git/ref/heads/${ONBOARDING_BRANCH}`,
      `POST /repos/${OWNER}/${project}/git/refs`,
      `PUT /repos/${OWNER}/${project}/contents/${RECIPE_PATH}`,
      `POST /repos/${OWNER}/${project}/pulls`,
    ]);
    const opened = calls[3]!.body as { base: string; head: string; body: string };
    expect(opened.base).toBe("develop");
    expect(opened.head).toBe(ONBOARDING_BRANCH);

    const written = calls[2]!.body as { content: string };
    const file = Buffer.from(written.content, "base64").toString("utf8");
    // What lands is the file, and the file is what `lingtai add` will read.
    expect((await resolveRecipe(async () => file, "develop")).recipe).toEqual(recipe);

    const state = reduceProject(await store.read(projectStream(project)));
    expect(state.base).toBe("develop");
    expect(state.owner).toBe(OWNER);
  });

  /** A second press does not open a second pull request. */
  it("refuses a repository already on its way in", async () => {
    const project = fresh();
    const { client: github, calls } = recordingClient(project);
    expect((await startOnboarding({ client: github, recipe, by: "human:tester", store })).ok).toBe(true);

    const opened = calls.length;
    const again = await startOnboarding({ client: github, recipe, by: "human:tester", store });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toContain("already on its way in");
    // Nothing was asked of GitHub the second time: the stream is read first.
    expect(calls.length).toBe(opened);
  });

  /**
   * The body says what the recipe does in the sentences the wizard showed —
   * the same record the file's comments come from, so the two cannot drift.
   */
  it("says what the recipe does, in the sentences the wizard showed", () => {
    const body = pullRequestBody(recipe, SAID);
    for (const [path, sentence] of Object.entries(SAID)) {
      expect(body).toContain(path);
      expect(body).toContain(sentence);
    }
    expect(body).toContain("Recheck");
  });

  /**
   * The one place the wizard argues. With a check at `proposed` there is
   * something between an agent and the base branch, so nothing is said.
   */
  it("warns only when nothing at all reads a diff", () => {
    expect(nothingReadsIt(recipe)).toBeNull();
    const unchecked = { ...recipe, gates: { ...recipe.gates, proposed: [] } } as Recipe;
    expect(nothingReadsIt(unchecked)).toContain("straight into `develop`");
    expect(pullRequestBody(unchecked)).toContain("Nothing checks a diff");
  });
});

describe("Hold all", () => {
  /** The label has to be one the recipe excludes, or holding holds nothing. */
  it("takes its label from source.exclude", () => {
    expect(holdLabel(recipe)).toBe(HOLD_LABEL);
    expect(holdLabel({ ...recipe, source: { ...recipe.source, exclude: ["paused"] } } as Recipe)).toBe("paused");
    expect(holdLabel({ ...recipe, source: { ...recipe.source, exclude: [] } } as Recipe)).toBeNull();
  });

  /** Exactly the listed issues, and each keeps the labels it already had. */
  it("applies the hold to exactly the issues the screen listed", async () => {
    const project = fresh();
    const { client: github, labelled } = recordingClient(project);
    const pass = await firstPass({ client: github, recipe });

    const held = await holdAll({
      client: github,
      issues: pass.taking.map((r) => r.issue),
      label: holdLabel(recipe)!,
    });

    expect(held.held).toEqual([398, 412, 4100, 7]);
    expect(held.failed).toEqual([]);
    expect(labelled).toEqual([
      { issue: 398, labels: ["bug", HOLD_LABEL] },
      { issue: 412, labels: ["bug", HOLD_LABEL] },
      { issue: 4100, labels: ["bug", HOLD_LABEL] },
      { issue: 7, labels: ["feature", HOLD_LABEL] },
    ]);
  });

  /** A refusal on one is not a refusal on the rest. */
  it("reports what GitHub refused and holds the others anyway", async () => {
    const { client: github } = recordingClient(fresh());
    const refusing: GitHubClient = {
      ...github,
      setLabels: async (n) => {
        if (n === 412) throw new GitHubError(403, "/", "Resource not accessible by integration");
      },
    };

    const held = await holdAll({ client: refusing, issues: ["412", "398"], label: HOLD_LABEL });
    expect(held.held).toEqual([398]);
    expect(held.failed.map((f) => f.issue)).toEqual([412]);
  });
});
