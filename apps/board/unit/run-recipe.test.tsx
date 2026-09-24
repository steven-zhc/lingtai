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
import { Recipe, resolveRecipe, withheld, type PluginSecrets } from "@lingtai/recipe";
import { foldRun, type Claim, type RunView } from "../src/lib/task.ts";
import { changesFromHead, describeAction, forgetRunRecipes, recipeOfRun } from "../src/lib/recipe.ts";
import { Attempt, RECORD_ROWS } from "../src/app/task/[id]/page.tsx";

const RECIPE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [blocked] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;
/** Head, after a commit like `2d3353b`: the same action, a different command. */
const HEAD = RECIPE.replace("pnpm typecheck && pnpm test", "pnpm typecheck");

/** Two actions at one point, and the same two in the other order — nothing else. */
const ORDERED = RECIPE.replace(
  '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }',
  '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }\n' +
    '    - { name: lint, run: "pnpm lint", timeout: 5m }',
);
const SWAPPED = RECIPE.replace(
  '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }',
  '    - { name: lint, run: "pnpm lint", timeout: 5m }\n' +
    '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }',
);

const BASE = "b".repeat(40);
const RUN = "run-44444444-0000-0000-0000-000000000000";
const hashOf = async (text: string) => (await resolveRecipe(async () => text, "x")).configHash;

let seq = 0n;
function e(type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId: RUN,
    version: 2,
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
    // Proved at base — and head is still read, to say what differs from it
    // (#217). It is this machine's file since 0046 §3, not a request, and the
    // caller reads it once however many attempts the page has.
    expect(heads()).toBe(1);

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
    // Head is read per call here because this fake does not memoise it; the
    // board's `recipesFor` does, so a page with six attempts reads it once.
    expect(heads()).toBe(2);
  });

  it("does not grow the record a fifth row", () => {
    expect(RECORD_ROWS).toEqual(["findings", "files", "attempts", "ticket"]);
  });
});

/**
 * *What was this attempt run under* — the other question the same data answers
 * (#217), and the one that had no answer on the page at all.
 *
 * The assertions are about the reading and about the comparison, because those
 * are the two things a dump of 3.5KB of sorted JSON would also technically
 * contain and nobody would find.
 */
describe("the recipe an attempt was given", () => {
  it("reads in lingtai status's rows and its words", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, atHead } = fake({ [BASE]: RECIPE });
    const html = render({ ...run, recipe: await recipeOfRun(run, client, atHead) });

    expect(html).toContain("<dt>picks up</dt><dd>bug</dd>");
    expect(html).toContain("<dt>excludes</dt><dd>blocked</dd>");
    // `describeAssignee`'s sentence, not a second wording of it.
    expect(html).toContain("any issue, whoever it is assigned to");
    // All ten, including the nine nothing is configured at (0016 §4, 0061 §5).
    expect(html).toContain(
      "claim 0 · admit 0 · prepared 0 · design 0 · implement 0 · build 0 · review 0 · proposed 1 · merge 0 · end 0",
    );
    // `passCeiling`'s sentence, which is what `lingtai status` prints.
    expect(html).toContain("10 turns");
    expect(html).toContain("<dt>budget</dt>");
    expect(html).toContain("evidence 2000 · attempts 5 · findings 5 · diff 400000");
  });

  it("says the record carries no comments, so a bare number is not one with no reasoning", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client, atHead } = fake({ [BASE]: RECIPE });
    const html = render({ ...run, recipe: await recipeOfRun(run, client, atHead) });

    expect(html).toContain("What the log records is the canonical recipe");
    expect(html).toContain("comments discarded (0047 §2)");
  });

  it("shows what differs from head, naming the value and both sides", async () => {
    // `2d3353b`, exactly: the attempt's `build` ran the suite and head's does
    // not, and until now the runs from both sides of it sat in one list saying
    // nothing.
    const run = runWith(await hashOf(RECIPE));
    const { client, atHead } = fake({ [BASE]: RECIPE });

    const recipe = await recipeOfRun(run, client, atHead);
    expect(recipe.of === "run" && recipe.from).toEqual({
      of: "changed",
      ref: "main",
      changes: [
        {
          path: "steps.proposed.build.run",
          run: "pnpm typecheck && pnpm test",
          head: "pnpm typecheck",
        },
      ],
    });

    const html = render({ ...run, recipe });
    expect(html).toContain("This is not the recipe at the head of main");
    expect(html).toContain("1 value");
    expect(html).toContain("steps.proposed.build.run");
  });

  it("says nothing differs rather than saying nothing", async () => {
    // Proved at its own base commit, and that document is head's.
    const run = runWith(await hashOf(HEAD));
    const { client, atHead } = fake({ [BASE]: HEAD });

    const recipe = await recipeOfRun(run, client, atHead);
    expect(recipe.of === "run" && recipe.at).toEqual({ base: BASE });
    expect(recipe.of === "run" && recipe.from).toEqual({ of: "same", ref: "main" });
    expect(render({ ...run, recipe })).toContain(
      "Nothing differs from the recipe at the head of main",
    );
  });

  it("keeps the attempt's own recipe when head cannot be read, and says the comparison was not made", async () => {
    const run = runWith(await hashOf(RECIPE));
    const { client } = fake({ [BASE]: RECIPE });
    const atHead = async () => {
      throw new Error("no recipe at ~/.lingtai/lingtai/recipe.yml");
    };

    const recipe = await recipeOfRun(run, client, atHead);
    // The attempt's recipe is still proved and still shown; only the
    // comparison is lost.
    expect(recipe.of).toBe("run");
    expect(recipe.of === "run" && recipe.from).toEqual({
      of: "unknown",
      why: "no recipe at ~/.lingtai/lingtai/recipe.yml",
    });

    const html = render({ ...run, recipe });
    expect(html).toContain("pnpm typecheck &amp;&amp; pnpm test");
    expect(html).toContain("What differs from the recipe at head is not known");
  });

  it("never reads head's recipe as this attempt having run under what you have now", async () => {
    const run = runWith(await hashOf(RECIPE.replace("20m", "30m")));
    const { client, atHead } = fake({ [BASE]: RECIPE });

    const html = render({ ...run, recipe: await recipeOfRun(run, client, atHead) });
    expect(html).toContain("Not this run&#x27;s recipe");
    expect(html).not.toContain("Nothing differs");
    expect(html).toContain("there is nothing to compare it with");
  });

  it("keys a gate's actions by name, so inserting one is one change and not three", async () => {
    const two = RECIPE.replace(
      '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }',
      '    - { name: lint, run: "pnpm lint", timeout: 5m }\n' +
        '    - { name: build, run: "pnpm typecheck && pnpm test", timeout: 20m }',
    );
    const run = runWith(await hashOf(two));
    const { client } = fake({ [BASE]: two });
    const atHead = async () => resolveRecipe(async () => RECIPE, "main");

    const recipe = await recipeOfRun(run, client, atHead);
    expect(recipe.of === "run" && recipe.from.of).toBe("changed");
    const changes = recipe.of === "run" && recipe.from.of === "changed" ? recipe.from.changes : [];
    // `build` is untouched and says nothing: the added action is named, and the
    // point says what now runs in what order, which is the other thing the
    // insertion did.
    expect(changes.map((c) => c.path)).toEqual([
      "steps.proposed",
      "steps.proposed.lint.env",
      "steps.proposed.lint.name",
      "steps.proposed.lint.run",
      "steps.proposed.lint.timeout",
    ]);
    expect(changes[0]).toEqual({ path: "steps.proposed", run: "lint > build", head: "build" });
    // Everything the walk names under a name is new; nothing of `build`'s is.
    expect(changes.slice(1).every((c) => c.head === null)).toBe(true);
  });

  /**
   * **The hash sees order and a diff keyed by name does not**, so the order is
   * a value the walk names for itself — without it a swapped pair is a
   * `changed` carrying nothing, a page that says a difference and shows none,
   * and the one thing that moved is the one thing never drawn.
   *
   * Order is not decoration at a gate point: `proposed`'s first action is the
   * one whose refusal stops the pass.
   */
  it("names a reordered gate, which the hash sees and a name-keyed walk does not", async () => {
    const run = runWith(await hashOf(ORDERED));
    const { client } = fake({ [BASE]: ORDERED });
    const atHead = async () => resolveRecipe(async () => SWAPPED, "main");

    const recipe = await recipeOfRun(run, client, atHead);
    expect(recipe.of === "run" && recipe.from).toEqual({
      of: "changed",
      ref: "main",
      changes: [{ path: "steps.proposed", run: "build > lint", head: "lint > build" }],
    });

    const html = render({ ...run, recipe });
    expect(html).toContain("1 value");
    expect(html).toContain("build &gt; lint");
    // Never a heading over an empty list.
    expect(html).not.toContain('<ul class="rchanges"></ul>');
  });

  it("counts the reorder in the mixed case, where an edit would otherwise stand for both", async () => {
    const run = runWith(await hashOf(ORDERED));
    const { client } = fake({ [BASE]: ORDERED });
    const edited = SWAPPED.replace("pnpm lint", "pnpm lint --fix");
    const atHead = async () => resolveRecipe(async () => edited, "main");

    const recipe = await recipeOfRun(run, client, atHead);
    const changes = recipe.of === "run" && recipe.from.of === "changed" ? recipe.from.changes : [];
    expect(changes.map((c) => c.path)).toEqual(["steps.proposed", "steps.proposed.lint.run"]);
    expect(render({ ...run, recipe })).toContain("2 values");
  });

  it("never says 0 values differ when the walk can name none of them", async () => {
    // Two documents the hash tells apart that the walk reads alike all the way
    // down: a list of one string against a list of two, which join the same.
    const mine = RECIPE.replace("exclude: [blocked]", 'exclude: ["blocked, held"]');
    const theirs = RECIPE.replace("exclude: [blocked]", "exclude: [blocked, held]");
    const run = runWith(await hashOf(mine));
    const { client } = fake({ [BASE]: mine });
    const atHead = async () => resolveRecipe(async () => theirs, "main");

    const recipe = await recipeOfRun(run, client, atHead);
    // `changed` stands on the hash; the walk is what has nothing to name.
    expect(recipe.of === "run" && recipe.from.of).toBe("changed");
    expect(recipe.of === "run" && recipe.from.of === "changed" && recipe.from.changes).toEqual([]);

    const html = render({ ...run, recipe });
    expect(html).toContain("This is not the recipe at the head of main");
    expect(html).toContain("not a value this page can name");
    expect(html).not.toContain("0 value");
    expect(html).not.toContain('<ul class="rchanges"></ul>');
  });
});

/**
 * **A `no_log` field never reaches the page** (`#228`,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §9).
 *
 * The walk below is the one reading on this page that renders an action's field
 * values whatever they are — everything else asks for a field by name — so it
 * is where a secret would arrive if the strip were a convention rather than a
 * declaration. Nothing in the closed set declares one today, which is why the
 * plugin here is the test's own: a guard asserted over an empty set asserts
 * nothing.
 *
 * What it cannot cover is the disclosure below the reading, which is the recipe
 * file's own bytes: a value *written in the file* is on the screen whatever a
 * schema says, and the rule that keeps it out is 0021's — the file holds names
 * and the values resolve from somewhere the agent cannot see.
 */
describe("what the page may render of an action", () => {
  /**
   * `PluginSecrets` and not a whole plugin: the strip reads a key and a list of
   * `no_log` fields, so that is what it asks for, and this file needs no schema
   * — nor zod, which the board does not depend on — to drive it.
   * `packages/recipe/unit/plugin.test.ts` is where those two are proved to come
   * off a schema's own declaration rather than off a list somebody keeps.
   *
   * **The key is a real one and the marked field is the test's own.** Both
   * readings below ask what the *page* makes of an action, and what it makes of
   * one comes off `kindOfAction`, which reads the closed set in
   * `@lingtai/recipe` — so under a key nobody declares there is nothing to
   * assert but the kind the reading falls back to. None of the six declares a
   * secret field, so `token:` is invented here; the actions are built rather
   * than resolved, because what is under test is the reading and not the schema.
   */
  const payingRun: PluginSecrets = { key: "run", secrets: ["token"] };
  const base = Recipe.parse({
    version: 2,
    repo: { base: "main" },
    source: { kinds: ["bug"] },
    env: { plantAt: ".env.local" },
    runtime: {},
  });
  const paying = (token: string, timeout = "15m") =>
    ({
      ...base,
      steps: { ...base.steps, proposed: [{ name: "pay", run: "pay-the-bill", timeout, token }] },
    }) as unknown as Recipe;

  it("walks the two recipes with every secret value already withheld", () => {
    const changed = changesFromHead(paying("sk-live-0000"), paying("sk-live-1111", "30m"), [payingRun]);

    // **Two rows: the field that is not withheld, and the fact that the one
    // that is has changed.** Asserting only the absence of the secret would be
    // green on a walk that had stopped naming anything at all — and dropping
    // the second row would have the page tell an operator that a run whose
    // credential was rotated under it differs from head in its timeout alone.
    expect(changed).toHaveLength(2);
    expect(changed[0]!.path).toContain("proposed.pay.timeout");
    expect(changed[0]).toMatchObject({ run: "15m", head: "30m" });
    expect(changed[1]!.path).toContain("proposed.pay.token");
    expect(changed[1]).toMatchObject({
      run: withheld("sk-live-0000"),
      head: withheld("sk-live-1111"),
    });
    expect(JSON.stringify(changed)).not.toContain("sk-live");
  });

  /** And a rotation on its own is a row, rather than a page saying nothing. */
  it("names the withheld field when it is the only thing that differs", () => {
    const changed = changesFromHead(paying("sk-live-0000"), paying("sk-live-1111"), [payingRun]);

    expect(changed).toHaveLength(1);
    expect(changed[0]!.path).toContain("proposed.pay.token");
    expect(JSON.stringify(changed)).not.toContain("sk-live");
  });

  it("says what an action does with its secret value withheld", () => {
    const said = describeAction(
      { name: "pay", run: "pay-the-bill", timeout: "15m", token: "sk-live-0000" } as never,
      [payingRun],
    );

    // **Still the reading a command gets**: the strip took the marked field and
    // nothing that says which plugin this is. A `does` of "asks a person:
    // undefined" carries no secret either, and is the page telling an operator
    // the action is something it is not.
    expect(said).toEqual({ does: "pay-the-bill", bound: "timeout 15m" });
    expect(JSON.stringify(said)).not.toContain("sk-live");
  });

  /** And a recipe with nothing to strip reads exactly as it read before. */
  it("names what differs in a recipe no plugin marks", () => {
    const mine = base;
    const head = { ...base, source: { ...base.source, backoff: "2h" } };

    expect(changesFromHead(mine, head)).toEqual([
      { path: "source.backoff", run: "1h", head: "2h" },
    ]);
  });
});
