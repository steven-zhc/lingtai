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
import { directPostgresUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { GitHubError, type GitHubClient, type Issue, type Label } from "@lingtai/github";
import { type Recipe, machinePath, recipePath, resolveLocalRecipe, resolveRecipe } from "@lingtai/recipe";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passedOver } from "../src/discover.ts";
import { selectRunnable } from "../src/queue.ts";
import {
  HOLD_LABEL,
  firstPass,
  holdAll,
  holdLabel,
  nothingReadsIt,
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
  "steps.merge": "Nobody approves a merge — the build is what stands between an agent and develop.",
} as const;

const YAML = `
version: 2
repo:
  base: develop
source:
  kinds: [bug, feature]
  exclude: [agent:hold, epic]
steps:
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
  assignees: [],
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
    installation: { id: 1, permissions: {}, account: OWNER, repositorySelection: "selected", htmlUrl: null },
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
    // Reading the refs is a read; deleting one is a write, and the wizard has
    // no business doing either.
    matchingRefs: async () => [],
    deleteRef: async () => {
      throw new Error("the wizard wrote to GitHub: deleteRef");
    },
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

/**
 * A client that records what was asked of it.
 *
 * `setLabels` is left as `readOnlyClient` has it — throwing. Nothing here may
 * reach it: a hold that replaces an issue's label set is the defect, not the
 * feature, so the double refuses to be the thing that makes it look fine.
 */
function recordingClient(project: string) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const base = readOnlyClient(project);
  const client: GitHubClient = {
    ...base,
    request: (async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return {};
    }) as GitHubClient["request"],
  };
  /** What `holdAll` asked GitHub to add, read back off the requests it made. */
  const labelled = () =>
    calls
      .filter((c) => c.method === "POST" && /\/issues\/\d+\/labels$/.test(c.path))
      .map((c) => ({
        issue: Number(/\/issues\/(\d+)\/labels$/.exec(c.path)![1]),
        labels: (c.body as { labels: string[] }).labels,
      }));
  return { client, calls, labelled };
}

/** A machine of its own: `~/.lingtai/` for one test, so a press writes nowhere real. */
async function machine(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lingtai-onboard-"));
  homes.push(home);
  return home;
}
const homes: string[] = [];

/** A store whose append fails without the stream having moved: the database blinked. */
function blinks(): EventStore {
  return {
    ...store,
    append: async () => {
      throw new Error("the connection was reset");
    },
  };
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  recipe = (await resolveRecipe(async () => YAML, "develop")).recipe;
}, 120_000);

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  await client.close();
  const c = new pg.Client({ connectionString: directPostgresUrl() });
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
   * Every read-only step runs — the preview, the validation, the file — against
   * a GitHub whose every write throws, and the project stream and this
   * machine's `~/.lingtai/` are read back afterwards. No file, no events.
   */
  it("leaves nothing behind — no file, no events", async () => {
    const project = fresh();
    const github = readOnlyClient(project);
    const home = await machine();

    const pass = await firstPass({ client: github, recipe });
    expect(pass.taking.length).toBe(4);
    const validated = await validateProposal(recipe, SAID);
    expect(validated.ok).toBe(true);
    holdLabel(recipe);
    nothingReadsIt(recipe);

    expect(await store.read(projectStream(project))).toEqual([]);
    expect(await readdir(home)).toEqual([]);

    // And the stream is not empty because nothing here *could* write to it: the
    // button writes, so a test that passed for that reason would pass for ever.
    const { client: writable, calls } = recordingClient(project);
    const started = await startOnboarding({ client: writable, recipe, said: SAID, by: "human:tester", store, home });
    expect(started.ok).toBe(true);
    // And the button's write is this machine's, never the repository's (#180).
    expect(calls).toEqual([]);
    expect((await store.read(projectStream(project))).map((e) => e.type)).toEqual([
      "ProjectOnboardingStarted",
    ]);
  });

  /**
   * **`Hold all` is the exception, and it is on the same screen.** It runs
   * before the button, it writes to GitHub, and nothing records that it did —
   * so the clause above is *no file, no events* and never *no labels*.
   *
   * Asserted against the code that can break it rather than around it: the
   * five other functions on that screen cannot reach a write, `holdAll` is the
   * one that can, and here every write throws, so what it would have written
   * comes back in `failed` instead. The issues it was given are the issues the
   * screen listed.
   */
  it("does not hold anything the operator did not press Hold all for", async () => {
    const project = fresh();
    const github = readOnlyClient(project);
    const pass = await firstPass({ client: github, recipe });

    const attempted = await holdAll({
      client: github,
      issues: pass.taking.map((r) => r.issue),
      label: holdLabel(recipe)!,
    });

    expect(attempted.held).toEqual([]);
    expect(attempted.failed.map((f) => f.issue)).toEqual([398, 412, 4100, 7]);
    for (const f of attempted.failed) expect(f.detail).toContain("the wizard wrote to GitHub");
    expect(await store.read(projectStream(project))).toEqual([]);
  });
});

describe("the managed repository", () => {
  /**
   * **Nothing in onboarding writes to it** (0046 §3, #182). The whole wizard —
   * the preview, the validation, the button — runs against a GitHub that fails
   * any request that is not a `GET`, and it finishes: the recipe is on this
   * machine and the project is recorded as pending. The pull request that used
   * to be the last step would fail here by name, which is the point.
   */
  it("is only ever read: the wizard finishes against a client that fails any non-GET", async () => {
    const project = fresh();
    const github = readOnlyClient(project);
    const home = await machine();

    await firstPass({ client: github, recipe });
    const started = await startOnboarding({ client: github, recipe, said: SAID, by: "human:tester", store, home });

    expect(started).toEqual({ ok: true, path: recipePath(project, home) });
    const state = reduceProject(await store.read(projectStream(project)));
    expect(state.project).toBe(project);
    expect(state.configHash).toBeNull();
  });
});

describe("the recipe the button writes", () => {
  /**
   * A recipe that will not parse writes nothing at all. The refusal names the
   * field, because *which* field is the whole of what a person can act on.
   */
  it("writes nothing for a recipe Recipe.parse refuses, and the refusal names the field", async () => {
    const project = fresh();
    const { client: github, calls } = recordingClient(project);
    const home = await machine();
    const noKinds = { ...recipe, source: { ...recipe.source, kinds: [] } } as Recipe;

    const started = await startOnboarding({ client: github, recipe: noKinds, by: "human:tester", store, home });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal).toContain("source.kinds");
    expect(calls).toEqual([]);
    expect(await readdir(home)).toEqual([]);
    expect(await store.read(projectStream(project))).toEqual([]);
  });

  /**
   * **The file `Recheck` reads, and nothing in the repository** (#180). The
   * press writes `~/.lingtai/<project>/recipe.yml` and the page's agent and
   * limits into the machine file, and `resolveLocalRecipe` — what `lingtai add`
   * calls — reads back exactly the recipe the page built. So a pending card
   * has a recipe to find, and no pull request exists to wait for.
   */
  it("writes the machine's recipe, which resolves to the recipe the page built", async () => {
    const project = fresh();
    const { client: github, calls } = recordingClient(project);
    const home = await machine();

    const started = await startOnboarding({ client: github, recipe, said: SAID, by: "human:tester", store, home });

    expect(started).toEqual({ ok: true, path: recipePath(project, home) });
    expect(calls).toEqual([]);

    const written = await readFile(recipePath(project, home), "utf8");
    expect(written).not.toMatch(/^\s+agent:/m);
    expect(written).not.toMatch(/^\s+limits:/m);
    const resolved = await resolveLocalRecipe(project, {
      home,
      signedIn: async () => {
        throw new Error("the agent is named, so nothing is asked what is signed in");
      },
    });
    expect(resolved.recipe).toEqual(recipe);
    expect(resolved.provenance?.["runtime.agent"]).toContain(`projects.${project}`);

    const state = reduceProject(await store.read(projectStream(project)));
    expect(state.base).toBe("develop");
    expect(state.owner).toBe(OWNER);
  });

  /** The machine file keeps everything it already said. */
  it("adds the project's runtime to a machine file without disturbing the rest of it", async () => {
    const project = fresh();
    const home = await machine();
    const before = "# mine\nruntime:\n  agent: codex\nprojects:\n  other:\n    runtime:\n      limits: { rounds: 1 }\n";
    await writeFile(machinePath(home), before);

    const started = await startOnboarding({
      client: recordingClient(project).client,
      recipe,
      by: "human:tester",
      store,
      home,
    });

    expect(started.ok).toBe(true);
    const after = await readFile(machinePath(home), "utf8");
    expect(after).toContain("# mine");
    expect(after).toContain("agent: codex");
    expect(after).toContain("rounds: 1");
    const resolved = await resolveLocalRecipe(project, { home, signedIn: async () => [] });
    expect(resolved.recipe.runtime.agent).toBe("claude-code");
  });

  /** A person's choice already in the machine file is not overwritten by a page. */
  it("refuses, writing nothing, when the machine file already names another runtime for the project", async () => {
    const project = fresh();
    const home = await machine();
    const before = `projects:\n  ${project}:\n    runtime:\n      agent: codex\n`;
    await writeFile(machinePath(home), before);

    const started = await startOnboarding({
      client: recordingClient(project).client,
      recipe,
      by: "human:tester",
      store,
      home,
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal).toContain(`projects.${project}.runtime`);
    expect(await readFile(machinePath(home), "utf8")).toBe(before);
    expect(await readdir(home)).toEqual(["config.yml"]);
    expect(await store.read(projectStream(project))).toEqual([]);
  });

  /** A second press does not write a second time. */
  it("refuses a repository already on its way in", async () => {
    const project = fresh();
    const home = await machine();
    const github = recordingClient(project).client;
    expect((await startOnboarding({ client: github, recipe, by: "human:tester", store, home })).ok).toBe(true);
    const written = await readFile(recipePath(project, home), "utf8");

    const again = await startOnboarding({ client: github, recipe, by: "human:tester", store, home });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toContain("already on its way in");
    expect(again.refusal).toContain(recipePath(project, home));
    expect(await readFile(recipePath(project, home), "utf8")).toBe(written);
  });

  /**
   * **The window between the file and the event.** The recipe is written and
   * the append throws. The refusal names the file, and the next press picks up
   * the file it wrote rather than refusing it as somebody else's.
   */
  it("refuses by naming the file when the append fails, and finishes it on the next press", async () => {
    const project = fresh();
    const home = await machine();
    const github = recordingClient(project).client;

    const failed = await startOnboarding({ client: github, recipe, by: "human:tester", store: blinks(), home });

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.refusal).toContain(recipePath(project, home));
    expect(failed.refusal).toContain("Press this again");
    expect(await store.read(projectStream(project))).toEqual([]);
    const written = await readFile(recipePath(project, home), "utf8");

    const finished = await startOnboarding({ client: github, recipe, by: "human:tester", store, home });

    expect(finished).toEqual({ ok: true, path: recipePath(project, home) });
    expect(await readFile(recipePath(project, home), "utf8")).toBe(written);
    expect(reduceProject(await store.read(projectStream(project))).base).toBe("develop");
  });

  /**
   * **The edited retry.** A recipe already at the path that is not this one —
   * a person's own, or an earlier press with other choices — is not the
   * button's to overwrite, and nothing is recorded over it.
   */
  it("refuses a recipe already on this machine that is not this one", async () => {
    const project = fresh();
    const home = await machine();
    const github = recordingClient(project).client;
    expect(
      (await startOnboarding({ client: github, recipe, by: "human:tester", store: blinks(), home })).ok,
    ).toBe(false);
    const written = await readFile(recipePath(project, home), "utf8");

    const bugsOnly = { ...recipe, source: { ...recipe.source, kinds: ["bug"] } } as Recipe;
    const next = await startOnboarding({ client: github, recipe: bugsOnly, by: "human:tester", store, home });

    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.refusal).toContain(`already a recipe at ${recipePath(project, home)}`);
    expect(await readFile(recipePath(project, home), "utf8")).toBe(written);
    expect(await store.read(projectStream(project))).toEqual([]);
  });

  /**
   * The other way that append fails: `lingtai add` wrote `ProjectConfigured`
   * between the read at the top and the append at the bottom. The next press
   * stops at `isRegistered`, so this refusal must not send anybody to it, and
   * hands back the file instead.
   */
  it("sends an operator to the registration when the stream moved underneath it", async () => {
    const project = fresh();
    const home = await machine();
    const github = recordingClient(project).client;
    await store.append(projectStream(project), 0, [
      {
        type: "ProjectConfigured",
        actor: "conductor",
        data: {
          project,
          owner: OWNER,
          base: "develop",
          configHash: "sha256:whatever",
          fromSha: "0".repeat(40),
        },
      },
    ]);
    // What `startOnboarding` read before that landed: nothing.
    const stale: EventStore = { ...store, read: async () => [] };

    const raced = await startOnboarding({ client: github, recipe, by: "human:tester", store: stale, home });

    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.refusal).toContain(recipePath(project, home));
    expect(raced.refusal).not.toContain("Press this again");
    expect(raced.refusal).toContain("will not finish it");
    expect(raced.refusal).toContain("already registered");
    expect((await store.read(projectStream(project))).map((e) => e.type)).toEqual(["ProjectConfigured"]);

    const next = await startOnboarding({ client: github, recipe, by: "human:tester", store, home });
    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.refusal).toContain("already registered");
  });

  /**
   * The one place the wizard argues. With a check at `proposed` there is
   * something between an agent and the base branch, so nothing is said.
   */
  it("warns only when nothing at all reads a diff", () => {
    expect(nothingReadsIt(recipe)).toBeNull();
    const unchecked = { ...recipe, steps: { ...recipe.steps, proposed: [] } } as Recipe;
    expect(nothingReadsIt(unchecked)).toContain("straight into `develop`");
  });
});

describe("Hold all", () => {
  /**
   * `agent:hold`, excluded, or no button at all.
   *
   * `source.exclude` is free-form (`recipe.ts:326`), so the first entry of an
   * operator's own excludes is a label whose meaning nothing here knows:
   * `wontfix` across twelve open bug reports is a sentence about them Lingtai
   * would be writing in their repository, with no undo and nothing on the log
   * saying Lingtai wrote it. A hold is offered only where a hold is what it
   * would say.
   */
  it("offers a hold only when the recipe excludes agent:hold", () => {
    const excluding = (exclude: string[]) =>
      holdLabel({ ...recipe, source: { ...recipe.source, exclude } } as Recipe);

    expect(holdLabel(recipe)).toBe(HOLD_LABEL);
    expect(excluding(["wontfix", "epic"])).toBeNull();
    expect(excluding(["paused"])).toBeNull();
    expect(excluding([])).toBeNull();
    expect(excluding(["epic", HOLD_LABEL])).toBe(HOLD_LABEL);
  });

  /**
   * Exactly the listed issues, and one label added to each.
   *
   * **Added by GitHub, not by a set this code read first.** The loop runs for
   * tens of seconds over thirty issues, so a label somebody else puts on #398
   * while it is at #10 would be silently taken off by a read-then-replace —
   * with no error, nothing in `failed`, and #398 reported held. There is no set
   * here to go stale: the request carries the one label, and `setLabels` — the
   * call that replaces — throws on this double and is never reached.
   */
  it("adds the hold to exactly the issues the screen listed, and touches no other label", async () => {
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
    expect(labelled()).toEqual([
      { issue: 398, labels: [HOLD_LABEL] },
      { issue: 412, labels: [HOLD_LABEL] },
      { issue: 4100, labels: [HOLD_LABEL] },
      { issue: 7, labels: [HOLD_LABEL] },
    ]);
  });

  /**
   * The interleaving the read-then-replace lost, run through: #398 gains
   * `needs-info` after the pass that would have read it and before the pass
   * that writes it. The write says `agent:hold` and nothing else, so GitHub's
   * union keeps `needs-info` — the label is still there at the end.
   */
  it("keeps a label added while the loop was running", async () => {
    const project = fresh();
    const { client: github } = recordingClient(project);
    const carried = new Map<number, string[]>([
      [412, ["bug"]],
      [398, ["bug"]],
    ]);

    const racing: GitHubClient = {
      ...github,
      request: (async (method: string, path: string, body?: unknown) => {
        const at = /\/issues\/(\d+)\/labels$/.exec(path);
        if (method === "POST" && at !== null) {
          const n = Number(at[1]);
          // A colleague labels #398 while the loop is on the issue before it.
          if (n === 412) carried.set(398, [...carried.get(398)!, "needs-info"]);
          const union = new Set([...carried.get(n)!, ...(body as { labels: string[] }).labels]);
          carried.set(n, [...union]);
          return {};
        }
        return github.request(method, path, body);
      }) as GitHubClient["request"],
    };

    const held = await holdAll({ client: racing, issues: ["412", "398"], label: HOLD_LABEL });

    expect(held.held).toEqual([412, 398]);
    expect(held.failed).toEqual([]);
    expect(carried.get(398)).toEqual(["bug", "needs-info", HOLD_LABEL]);
  });

  /** A refusal on one is not a refusal on the rest. */
  it("reports what GitHub refused and holds the others anyway", async () => {
    const { client: github } = recordingClient(fresh());
    const refusing: GitHubClient = {
      ...github,
      request: (async (method: string, path: string, body?: unknown) => {
        if (path.endsWith("/issues/412/labels")) {
          throw new GitHubError(403, path, "Resource not accessible by integration");
        }
        return github.request(method, path, body);
      }) as GitHubClient["request"],
    };

    const held = await holdAll({ client: refusing, issues: ["412", "398"], label: HOLD_LABEL });
    expect(held.held).toEqual([398]);
    expect(held.failed.map((f) => f.issue)).toEqual([412]);
  });
});
