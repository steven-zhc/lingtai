/**
 * The wizard's last screen and `lingtai status`, on the same repository.
 *
 * `#165` makes an operator a promise: the list shown before the button is what
 * the next pass will take. Nothing about a shared helper *proves* that — the
 * only thing that does is running both and comparing, which is what this file
 * is. The same GitHub is handed to `firstPass` and to `status`, and the order,
 * the count and the passed-over sentence have to come out the same.
 *
 * The project is registered here and not by the wizard, deliberately: the
 * wizard's screen is computed for a repository with no `task_view` rows, and
 * this asserts that the command reaches the same answer once there is a project
 * for it to ask about.
 */
import { firstPass } from "@lingtai/conductor/wizard";
import { projectStream } from "@lingtai/domain";
import { directPostgresUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import type { GitHubClient, Issue, Label } from "@lingtai/github";
import { type ResolvedRecipe, resolveRecipe } from "@lingtai/recipe";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { status } from "../src/status.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const OWNER = "steven-zhc";

const YAML = `
version: 2
repo:
  base: develop
source:
  kinds: [bug, feature]
  exclude: [agent:hold, epic]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`;

const issue = (
  over: Omit<Partial<Issue>, "labels"> & { number: number; labels?: (string | Label)[] },
): Issue => ({
  title: `issue ${over.number}`,
  body: "",
  state: "open",
  url: `https://example.invalid/${over.number}`,
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  assignees: [],
  ...over,
  labels: (over.labels ?? []).map((l) => (typeof l === "string" ? { name: l, color: null } : l)),
});

const ISSUES: Issue[] = [
  issue({ number: 412, labels: ["bug"], title: "Search box drops the last keystroke" }),
  issue({ number: 398, labels: ["bug"], title: "Importer times out over 2MB" }),
  issue({ number: 4100, labels: ["bug"], title: "after 412, numerically" }),
  issue({ number: 7, labels: ["feature"], title: "a feature, so behind every bug" }),
  issue({ number: 88, labels: ["bug", "agent:hold"], title: "held by a label the recipe excludes" }),
  issue({ number: 99, labels: ["epic"], title: "a table of contents" }),
  issue({ number: 101, labels: ["documentation"], title: "no kind this recipe knows" }),
];

const github: GitHubClient = {
  owner: OWNER,
  repo: PROJECT,
  installation: { id: 1, permissions: {}, account: OWNER, repositorySelection: "selected", htmlUrl: null },
  request: async () => {
    throw new Error("not used");
  },
  token: async () => {
    throw new Error("not used");
  },
  defaultBranch: async () => "develop",
  fileAt: async () => YAML,
  refSha: async () => "0".repeat(40),
  matchingRefs: async () => [],
  deleteRef: async () => {
    throw new Error("no writes in this test");
  },
  listOpenIssues: async () => ISSUES,
  listIssuesSince: async () => ISSUES,
  getIssue: async (n) => ISSUES.find((i) => i.number === n) ?? issue({ number: n }),
  comment: async () => {
    throw new Error("no writes in this test");
  },
  setLabels: async () => {
    throw new Error("no writes in this test");
  },
  updateBody: async () => {
    throw new Error("no writes in this test");
  },
  createIssue: async () => {
    throw new Error("no writes in this test");
  },
  closeIssue: async () => {
    throw new Error("no writes in this test");
  },
};

let client: Db;
let store: EventStore;
let resolved: ResolvedRecipe;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  resolved = await resolveRecipe(async () => YAML, "develop");
  await store.append(projectStream(PROJECT), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: {
        project: PROJECT,
        owner: OWNER,
        base: "develop",
        configHash: resolved.configHash,
        fromSha: "0".repeat(40),
      },
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directPostgresUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = $1", [projectStream(PROJECT)]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

it("shows the queue lingtai status will print, in the same order and the same words", async () => {
  const preview = await firstPass({ client: github, recipe: resolved.recipe });

  const said: string[] = [];
  const code = await status({ project: PROJECT }, (line: string) => said.push(line), {
    clientFor: async () => github,
    recipeFor: async () => resolved,
  });
  expect(code).toBe(0);

  // The order: the rows `lingtai status` lists are the rows the preview lists,
  // and #4100 after #412 is the tiebreak that says it is one sort and not two.
  const listed = said
    .filter((l) => /^ {4}#\d/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]!.slice(1));
  expect(listed).toEqual(preview.taking.map((r) => r.issue));
  expect(listed).toEqual(["398", "412", "4100", "7"]);

  // The count. `queue: N runnable` is the line an operator reads an hour later,
  // and the preview's `line` starts with the same number and the same word.
  const queue = said.find((l) => l.includes("queue:"))!;
  expect(queue).toContain(`${preview.taking.length} runnable`);
  expect(preview.line.startsWith(`${preview.taking.length} runnable`)).toBe(true);

  // The words. `passedOver`'s sentence is one string in one place, so the clause
  // the command prints is the clause the screen prints, character for character.
  const fromGitHub = said.find((l) => l.includes("from GitHub:"))!;
  expect(preview.passedOver).not.toBeNull();
  expect(fromGitHub).toContain(preview.passedOver!);
  expect(preview.line).toContain(preview.passedOver!);
});
