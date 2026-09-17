/**
 * What an action on the task page ran — the recipe **this run** was given,
 * proved by its hash, or another one named as another one (#190).
 *
 * "The project's recipe" is two documents on that page: head's is what the next
 * run gets, and `GatesResolved.configHash` is which one this run got. So the
 * assertions are about the proof rather than the fetch — a recipe read at the
 * right sha and never compared would pass a fetch test and still be wrong the
 * day the file at that sha is not what the conductor resolved.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { resolveRecipe } from "@lingtai/recipe";
import { foldRun, type Claim, type RunView } from "../src/lib/task.ts";
import { forgetRunRecipes, recipeOfRun } from "../src/lib/recipe.ts";
import { Attempt, RECORD_ROWS } from "../src/app/task/[id]/page.tsx";

const RECIPE = `
version: 1
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [blocked] }
env: { required: [], plantAt: .env.local }
gates:
  proposed:
    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;
/** Head, after a commit like `2d3353b`: the same action, a different command. */
const HEAD = RECIPE.replace("pnpm typecheck && pnpm test", "pnpm typecheck");

const BASE = "b".repeat(40);
const RUN = "run-44444444-0000-0000-0000-000000000000";
const hashOf = async (text: string) => (await resolveRecipe(async () => text, "x")).configHash;

let seq = 0n;
function e(type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId: RUN,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date("2026-09-16T10:00:00Z"),
  };
}

const claim: Claim = { runId: RUN, at: "2026-09-16T09:59:00.000Z", repair: false, released: null };

/** A finished run, with `GatesResolved` naming `configHash` — or with none. */
function runWith(configHash: string | null): RunView {
  return foldRun(claim, 1, [
    e("RunStarted", { baseSha: BASE, configHash: configHash ?? "unrelated" }),
    ...(configHash === null
      ? []
      : [
          e("GatesResolved", {
            runId: RUN,
            configHash,
            points: [
              { gate: "admit", actions: [] },
              { gate: "prepared", actions: [] },
              { gate: "proposed", actions: ["build"] },
              { gate: "merge", actions: [] },
              { gate: "end", actions: [] },
            ],
          }),
        ]),
    e("GateCheckPassed", { gate: "proposed", action: "build", onSha: "c".repeat(40) }),
    e("RunFinished", { turns: 1, durationMs: 1, costUsd: 0, exitCode: 0 }),
  ]);
}

/** GitHub, minus GitHub: a file per ref, and a count of what was asked. */
function fake(files: Record<string, string | Error>) {
  const asked: string[] = [];
  const client = {
    owner: "steven-zhc",
    repo: "lingtai",
    fileAt: async (_path: string, ref: string) => {
      asked.push(ref);
      const f = files[ref];
      if (f instanceof Error) throw f;
      return f ?? null;
    },
  } as unknown as GitHubClient;
  let heads = 0;
  const atHead = async () => {
    heads += 1;
    return resolveRecipe(async () => HEAD, "main");
  };
  return { client, asked, atHead, heads: () => heads };
}

const render = (run: RunView) =>
  renderToStaticMarkup(<Attempt run={run} alone={true} deciding={false} />);

beforeEach(() => forgetRunRecipes());

describe("the recipe beside an attempt's actions", () => {
  it("is read at the run's base commit and proved by the hash it recorded", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, asked, atHead, heads } = fake({ [BASE]: RECIPE });

    const recipe = await recipeOfRun(run, client, atHead);

    expect(recipe.of).toBe("run");
    expect(recipe.of === "run" && recipe.at).toEqual({ base: BASE });
    expect(asked).toEqual([BASE]);
    // Proved at base, so head's was never needed.
    expect(heads()).toBe(0);

    const html = render({ ...run, recipe });
    expect(html).toContain("pnpm typecheck &amp;&amp; pnpm test");
    expect(html).toContain("timeout 20m");
    expect(html).toContain("this run&#x27;s own, proved by the hash it recorded");
  });

  it("is not proved by the fetch: a file at base that hashes otherwise is head's, named", async () => {
    // The run recorded a hash that is neither base's file nor head's — the
    // fetch succeeds, and the proof must still refuse it.
    const run = runWith(await hashOf(RECIPE.replace("20m", "30m")));
    const { client, atHead } = fake({ [BASE]: RECIPE });

    const recipe = await recipeOfRun(run, client, atHead);

    expect(recipe.of).toBe("head");
    expect(recipe.of === "head" && recipe.why).toMatch(/hashes to .* and this run was given/);
    const html = render({ ...run, recipe });
    expect(html).toContain("Not this run&#x27;s recipe");
    expect(html).toContain("the head of main");
    // Head's command, shown only under that sentence.
    expect(html).toContain("<pre class=\"actcmd\">pnpm typecheck</pre>");
  });

  it("names head's recipe when the base commit cannot be fetched", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, atHead } = fake({ [BASE]: new Error("502 from GitHub") });

    const recipe = await recipeOfRun(run, client, atHead);

    expect(recipe.of).toBe("head");
    expect(recipe.of === "head" && recipe.why).toContain("could not be read: 502 from GitHub");
    expect(render({ ...run, recipe })).toContain("Not this run&#x27;s recipe");
  });

  it("names head's recipe for a stream with no GatesResolved, and never fetches the base", async () => {
    const run = runWith(null);
    expect(run.configHash).toBeNull();
    const { client, asked, atHead } = fake({ [BASE]: RECIPE });

    const recipe = await recipeOfRun(run, client, atHead);

    expect(recipe.of).toBe("head");
    expect(recipe.of === "head" && recipe.why).toContain("no GatesResolved");
    // Nothing to prove against, so the base is not worth a round trip.
    expect(asked).toEqual([]);
  });

  it("is proved by head's recipe when that is the same document", async () => {
    const run = runWith(await hashOf(HEAD));
    const { client, atHead } = fake({ [BASE]: new Error("502 from GitHub") });

    const recipe = await recipeOfRun(run, client, atHead);

    expect(recipe.of).toBe("run");
    expect(recipe.of === "run" && recipe.at).toEqual({ head: "main" });
  });

  it("leaves a point the recipe left empty reading skipped, with no command", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, atHead } = fake({ [BASE]: RECIPE });
    const html = render({ ...run, recipe: await recipeOfRun(run, client, atHead) });

    for (const point of ["admit", "prepared", "merge", "end"]) {
      expect(html).toMatch(new RegExp(`<span class="actpoint">${point}</span><span class="empty">skipped</span>`));
    }
    // One command, for the one action configured.
    expect(html.match(/class="actcmd"/g)).toHaveLength(1);
  });

  it("costs no round trip on a second render, because a base commit never moves", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, asked, atHead, heads } = fake({ [BASE]: RECIPE });

    const first = await recipeOfRun(run, client, atHead);
    const second = await recipeOfRun(run, client, atHead);

    expect(second).toEqual(first);
    expect(asked).toHaveLength(1);
    expect(heads()).toBe(0);
  });

  it("does not grow the record a fifth row", () => {
    expect(RECORD_ROWS).toEqual(["findings", "files", "attempts", "ticket"]);
  });
});
