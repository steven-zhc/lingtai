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

/**
 * A client that records what was asked of it, and answers the calls the PR needs.
 *
 * `setLabels` is left as `readOnlyClient` has it — throwing. Nothing here may
 * reach it: a hold that replaces an issue's label set is the defect, not the
 * feature, so the double refuses to be the thing that makes it look fine.
 *
 * `fileOnBranch` is the bytes the branch carries and not a boolean, and
 * `pullBase` the branch the open pull request targets, because those two are
 * exactly what the adopting press has to check: a repository left behind by an
 * interrupted press carries the file *that press wrote*, and a test that let the
 * double invent either one would be asserting that adoption happens rather than
 * that it happens to the right pull request.
 */
function recordingClient(
  project: string,
  over: {
    branchExists?: boolean;
    fileOnBranch?: string;
    pullOpen?: boolean;
    pullBase?: string;
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const base = readOnlyClient(project);
  const pull = {
    number: 7,
    html_url: `https://github.com/${OWNER}/${project}/pull/7`,
    base: { ref: over.pullBase ?? "develop" },
  };
  const client: GitHubClient = {
    ...base,
    fileAt: async () => over.fileOnBranch ?? null,
    request: (async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.includes("/git/ref/heads/")) {
        if (over.branchExists) return { ref: path };
        throw new GitHubError(404, path, "Not Found");
      }
      // The listing, which GitHub answers with an array however many there are.
      if (method === "GET" && path.includes("/pulls?")) return over.pullOpen ? [pull] : [];
      if (path.endsWith("/pulls")) return pull;
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
  return { client, calls, labelled, pull };
}

/**
 * The file a press left on the branch, read back off the `PUT` it made.
 *
 * The repository an interrupted press leaves behind carries those exact bytes,
 * and adoption is now a comparison against them — so the second press's double
 * is handed this rather than a constant, and a test that passes passes because
 * the two presses agree and not because the fixture was written to agree.
 */
function wroteToBranch(calls: { method: string; body?: unknown }[]): string {
  const put = calls.find((c) => c.method === "PUT")!.body as { content: string };
  return Buffer.from(put.content, "base64").toString("utf8");
}

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
   * stream is read back afterwards. No branch, no events.
   */
  it("leaves nothing behind — no branch, no events", async () => {
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

  /**
   * **`Hold all` is the exception, and it is on the same screen.** It runs
   * before the button, it writes to GitHub, and nothing records that it did —
   * so the clause above is *no branch, no events* and never *no labels*.
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
   * **The window between the pull request and the event, both halves of it.**
   * The pull request is open — the four calls all succeeded — and the append
   * throws. That used to throw out of `startOnboarding`, leaving an operator
   * told onboarding failed over an open pull request bearing their recipe, the
   * log empty so no pending card and no `Recheck`, and every further press
   * refused by the branch check with *delete it, or the pull request on it is
   * the one to merge* — advice that leads nowhere, since merging appends
   * nothing either.
   */
  it("refuses by naming the open pull request when the append fails, and finishes it on the next press", async () => {
    const project = fresh();
    const { client: github, calls, pull } = recordingClient(project);
    const blinked: EventStore = {
      ...store,
      append: async () => {
        throw new Error("the connection was reset");
      },
    };

    const failed = await startOnboarding({ client: github, recipe, by: "human:tester", store: blinked });

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.refusal).toContain(pull.html_url);
    expect(failed.refusal).toContain("Press this again");
    expect(await store.read(projectStream(project))).toEqual([]);

    // The second press, against the repository that state left behind — and the
    // branch carries what the first press *wrote*, read back off its own PUT,
    // rather than a file the double invented. Adoption is a comparison now, so
    // a double that guessed the bytes would be testing itself.
    const again = recordingClient(project, {
      branchExists: true,
      fileOnBranch: wroteToBranch(calls),
      pullOpen: true,
    });
    const finished = await startOnboarding({ client: again.client, recipe, by: "human:tester", store });

    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.pr).toEqual({ number: 7, url: pull.html_url });
    // No second branch and no second pull request: it finished the first one.
    expect(again.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const state = reduceProject(await store.read(projectStream(project)));
    expect(state.base).toBe("develop");
  });

  /**
   * **The edited retry, which is the other reason a second press happens.**
   * The first press left a branch, a file and a pull request against `develop`;
   * the operator then changes `repo.base` to `main` and presses again. Adopting
   * that pull request would append `base: main` while #7 goes on merging into
   * `develop` — the board's pending card would then look for the recipe on
   * `main`, never find it, and say so for ever, with the log recording a base no
   * pull request ever targeted and the live recipe the one they rejected.
   *
   * So the base the pull request targets is compared with the base about to be
   * recorded, and nothing is appended when they disagree.
   */
  it("refuses to adopt a pull request that targets a different base", async () => {
    const project = fresh();
    const first = recordingClient(project);
    expect(
      (await startOnboarding({ client: first.client, recipe, by: "human:tester", store: blinks() })).ok,
    ).toBe(false);

    const toMain = { ...recipe, repo: { ...recipe.repo, base: "main" } } as Recipe;
    const again = recordingClient(project, {
      branchExists: true,
      fileOnBranch: wroteToBranch(first.calls),
      pullOpen: true,
      pullBase: "develop",
    });
    const next = await startOnboarding({ client: again.client, recipe: toMain, by: "human:tester", store });

    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.refusal).toContain(first.pull.html_url);
    expect(next.refusal).toContain("targets develop and not main");
    // Nothing recorded, and no second pull request opened either.
    expect(await store.read(projectStream(project))).toEqual([]);
    expect(again.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  /**
   * The same press with the recipe itself edited — the base unchanged, the
   * kinds not. The pull request on the branch carries the recipe the operator
   * replaced, and adopting it would tell them onboarding started with the one
   * they are looking at.
   */
  it("refuses to adopt a pull request carrying a different recipe", async () => {
    const project = fresh();
    const first = recordingClient(project);
    expect(
      (await startOnboarding({ client: first.client, recipe, by: "human:tester", store: blinks() })).ok,
    ).toBe(false);

    const bugsOnly = { ...recipe, source: { ...recipe.source, kinds: ["bug"] } } as Recipe;
    const again = recordingClient(project, {
      branchExists: true,
      fileOnBranch: wroteToBranch(first.calls),
      pullOpen: true,
    });
    const next = await startOnboarding({ client: again.client, recipe: bugsOnly, by: "human:tester", store });

    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.refusal).toContain(first.pull.html_url);
    expect(next.refusal).toContain(`carries a different ${RECIPE_PATH}`);
    expect(await store.read(projectStream(project))).toEqual([]);
    expect(again.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  /**
   * The other way that append fails: `lingtai add` wrote `ProjectConfigured`
   * between the read at the top and the append at the bottom, so the expected
   * version is stale and the store refuses. The way out is not this function —
   * the project is registered — and the next press says so rather than talking
   * about a branch.
   *
   * **So this refusal must not send them to that press.** *Press this again; it
   * picks up the pull request* is true of a store that blinked and false here:
   * the next press stops at `isRegistered` and says nothing about GitHub, so an
   * operator who followed that advice would be left with a branch and an open
   * pull request nobody has mentioned — one that would put this unreviewed
   * recipe on `develop` if anyone merges it. The refusal names both and says
   * what became of the project instead.
   */
  it("sends an operator to the registration when the stream moved underneath it", async () => {
    const project = fresh();
    const { client: github, pull } = recordingClient(project);
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

    const raced = await startOnboarding({ client: github, recipe, by: "human:tester", store: stale });

    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.refusal).toContain(pull.html_url);
    // Not the sentence the blinking store gets, because it is not true here.
    expect(raced.refusal).not.toContain("Press this again");
    expect(raced.refusal).toContain("will not finish it");
    // The two things left on their repository, named, with what to do about them.
    expect(raced.refusal).toContain(ONBOARDING_BRANCH);
    expect(raced.refusal).toContain("already registered");
    expect(raced.refusal).toContain("close it and delete");
    expect((await store.read(projectStream(project))).map((e) => e.type)).toEqual([
      "ProjectConfigured",
    ]);

    const again = recordingClient(project, {
      branchExists: true,
      fileOnBranch: YAML,
      pullOpen: true,
    });
    const next = await startOnboarding({ client: again.client, recipe, by: "human:tester", store });

    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.refusal).toContain("already registered");
    expect(again.calls).toEqual([]);
  });

  /** A branch of that name that is not an interrupted onboarding is still refused. */
  it("refuses a branch of its own name that carries no onboarding", async () => {
    const project = fresh();
    // No `fileOnBranch`: `.lingtai/config.yaml` is not on the branch, so it
    // is somebody else's and there is nothing here to adopt.
    const { client: github } = recordingClient(project, { branchExists: true });

    const started = await startOnboarding({ client: github, recipe, by: "human:tester", store });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal).toContain("delete the branch");
    expect(await store.read(projectStream(project))).toEqual([]);
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
