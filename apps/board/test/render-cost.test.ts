/**
 * What a render costs, as a property rather than as a stopwatch.
 *
 * #112 measured the home page at 4.68s, 4.69s and 4.82s server-side, three
 * times the detail page at a third the size, and — because `live.tsx` asks the
 * router to re-render on every append — paid again for every event the log took
 * during a run. The stage breakdown had one shape in it: `board.ts` asked each
 * project for its recipe and its queue **in series**, so two repositories cost
 * 597ms + 762ms where 762 would have done, and a third would have added a
 * third.
 *
 * A wall-clock assertion would only re-measure this machine's GitHub. What is
 * asserted here is the thing that was actually wrong and that a later edit can
 * silently undo: whether the projects overlap, and whether the recipe is read
 * again when nothing has moved. Both fail closed — a sequential loop deadlocks
 * on the barrier rather than merely running slower.
 */
import { describe, expect, it } from "vitest";
import type { ProjectState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { queuedCards, type ProjectQueue } from "../src/lib/board.ts";
import { forgetRecipes, recipeAtHead } from "../src/lib/recipe.ts";

/** Enough of a project for a fold that only ever reads its name. */
const project = (name: string): ProjectState =>
  ({ project: name, owner: "steven-zhc", base: "main" }) as ProjectState;

/**
 * A gate every caller must arrive at before any of them may leave.
 *
 * The whole test, really. Under `Promise.all` all of them arrive; under a loop
 * of `await`s the first one waits for a second caller that the loop will not
 * send until the first has returned, and the race below reports that rather
 * than hanging for the suite's timeout.
 */
function barrier(expected: number) {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived === expected) open();
      let timer: ReturnType<typeof setTimeout>;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`only ${arrived} of ${expected} projects were in flight at once`)),
          250,
        );
      });
      try {
        await Promise.race([all, late]);
      } finally {
        clearTimeout(timer!);
      }
    },
  };
}

/**
 * A project that answered, carrying only what the fold reads.
 *
 * `recipe` and `client` are on a resolved filter and are the *asking*'s, not
 * the fold's — nothing below this point looks at either.
 */
function resolvedFilter(name: string, kinds: string[]) {
  return {
    project: name,
    ok: true,
    kinds,
    backoffMs: 0,
    repair: { on: true, maxAttempts: 1 },
    plan: new Map(),
  } as unknown as Extract<ProjectQueue, { state: "listed" }>["filter"];
}

function listed(name: string, kinds: string[], refs: string[]): ProjectQueue {
  return {
    state: "listed",
    filter: resolvedFilter(name, kinds),
    offered: { runnable: [], skipped: [], kindColors: {}, dependenciesUnread: null },
    runnable: refs.map((ref) => ({
      taskId: `wi-${name}-${ref}`,
      issue: ref,
      title: `issue ${ref}`,
      kind: kinds[0]!,
    })),
  };
}

describe("the projects on a board", () => {
  it("are all asked at once, not one after the one before", async () => {
    const gate = barrier(2);
    const result = await queuedCards([project("lingtai"), project("nextloom-ai-admin")], async (p) => {
      await gate.wait();
      return listed(p.project!, ["bug"], ["1"]);
    });

    expect(result.cards.map((c) => c.project)).toEqual(["lingtai", "nextloom-ai-admin"]);
  });

  it("still fold in the order the projects were given, whichever answers first", async () => {
    const slow = new Map([["lingtai", 20]]);
    const result = await queuedCards(
      [project("lingtai"), project("nextloom-ai-admin")],
      async (p) => {
        await new Promise((r) => setTimeout(r, slow.get(p.project!) ?? 0));
        return listed(p.project!, p.project === "lingtai" ? ["bug"] : ["feature", "bug"], ["7"]);
      },
    );

    // First mention wins, and the first mention is the first *project* — the
    // rule the old loop got from being a loop, and the one concurrency is most
    // likely to take away.
    expect(result.kindOrder).toEqual(["bug", "feature"]);
    expect(result.repair.map((r) => r.project)).toEqual(["lingtai", "nextloom-ai-admin"]);
  });

  it("name a project GitHub would not answer for, and keep its filter", async () => {
    const result = await queuedCards([project("lingtai")], async (p) => ({
      state: "unanswered",
      filter: resolvedFilter(p.project!, ["bug"]),
      problem: "API rate limit exceeded",
    }));

    expect(result.problems).toEqual([{ project: "lingtai", reason: "API rate limit exceeded" }]);
    // The recipe resolved, so the column still knows what this project
    // prioritises even though its queue could not be listed.
    expect(result.kindOrder).toEqual(["bug"]);
  });
});

/** GitHub, minus GitHub: one recipe, one sha, and a count of each question. */
function fakeClient(recipe: string, sha: () => string) {
  const asked = { file: 0, ref: 0, branch: 0 };
  const client = {
    owner: "steven-zhc",
    repo: "lingtai",
    installation: { id: 1, permissions: {}, account: "steven-zhc", repositorySelection: "selected" },
    request: async () => {
      throw new Error("not used");
    },
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => {
      asked.branch += 1;
      return "main";
    },
    fileAt: async (path: string, ref: string) => {
      asked.file += 1;
      return path === ".lingtai/config.yaml" && ref === "main" ? recipe : null;
    },
    refSha: async () => {
      asked.ref += 1;
      return sha();
    },
    listOpenIssues: async () => [],
    getIssue: async () => {
      throw new Error("not used");
    },
    comment: async () => ({ id: 1 }),
    setLabels: async () => {},
    closeIssue: async () => {},
    updateBody: async () => {},
  } as unknown as GitHubClient;
  return { client, asked };
}

const RECIPE = `
version: 1
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [blocked] }
env: { required: [], plantAt: .env.local }
gates:
  proposed:
    - { name: build, run: "true", timeout: 2m }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

const OTHER = RECIPE.replace("kinds: [bug]", "kinds: [feature]");

describe("the recipe a render reads", () => {
  it("is fetched once while origin/main has not moved", async () => {
    forgetRecipes();
    const { client, asked } = fakeClient(RECIPE, () => "a".repeat(40));

    const first = await recipeAtHead(project("lingtai"), client);
    const second = await recipeAtHead(project("lingtai"), client);
    const third = await recipeAtHead(project("lingtai"), client);

    expect(first.recipe.source.kinds).toEqual(["bug"]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The sha is still asked every time. The cheap question replaces the
    // expensive one; a board that stopped asking would be a snapshot.
    expect(asked).toEqual({ file: 1, ref: 3, branch: 0 });
  });

  it("is fetched again the moment the branch moves", async () => {
    forgetRecipes();
    let head = "a".repeat(40);
    let body = RECIPE;
    const { client, asked } = fakeClient(RECIPE, () => head);
    // The file follows the sha, as it does on a real repository.
    const following = { ...client, fileAt: async () => body } as GitHubClient;

    const before = await recipeAtHead(project("lingtai"), following);
    head = "b".repeat(40);
    body = OTHER;
    const after = await recipeAtHead(project("lingtai"), following);

    expect(before.recipe.source.kinds).toEqual(["bug"]);
    expect(after.recipe.source.kinds).toEqual(["feature"]);
    expect(asked.ref).toBe(2);
  });

  it("resolves in full whenever the sha could not be had", async () => {
    forgetRecipes();
    const { client, asked } = fakeClient(RECIPE, () => {
      throw new Error("502 from GitHub");
    });

    await recipeAtHead(project("lingtai"), client);
    await recipeAtHead(project("lingtai"), client);

    // A ref lookup that failed is not evidence the recipe has not moved.
    expect(asked.file).toBe(2);
  });
});
