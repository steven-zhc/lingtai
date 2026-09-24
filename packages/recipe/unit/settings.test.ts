/**
 * The accessors, and the claim that nothing reaches past them.
 *
 * The first half is ordinary — they return what the recipe holds. **The second
 * half is the one that earns the file**: it walks every `src/` in the workspace
 * and fails on a reader that still reaches into one of the seven settings
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4 and
 * [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3 move.
 *
 * **It was three, and three is what `#231` found wrong with it.** The guard
 * named `runtime.limits`, `repo.base` and `source.kinds`, which are the three
 * that had an accessor — so it read as *nothing reaches past the accessors*
 * while `repo.submodules`, `source.exclude` and `source.backoff` were read by
 * hand in nine files and the same ADR moves all six. A guard sized to the
 * accessors that exist rather than to the settings that move is a guard that
 * goes green as the diff it exists to prevent is being written.
 *
 * **And `recipe.` was the required receiver**, so `parsed.data.repo.base` in
 * `wizard.ts` walked past it — a reader of the same setting off a recipe that
 * had not been given that name yet. The rule below asks only that the path be
 * *read off something*: an identifier character, a dot, then the setting. That
 * is what tells a reader from the many places these six are named as text — a
 * provenance key, a wizard field id, a refusal naming the key to fix — without
 * having to decide what is a string, which the multi-line templates in
 * `fix.ts`, `lingtai.ts` and `wall-limit.ts` make a losing game.
 *
 * **What it still cannot see is a destructured read**, and `planOf` in
 * `queued.ts` is the shape: `runtime.limits.turns` off a parameter. That one is
 * not a reader of the recipe — it is a pure function over a shape, and its
 * caller is the reader — but a genuine `const { source } = recipe` would slip
 * past, so this is a guard against the mistake rather than a proof.
 *
 * Without it the accessors are a suggestion. With it,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4's move —
 * every setting onto the step that owns it — is a change to `settings.ts` and
 * to nothing else, which is the whole reason they exist. A reader added later
 * that skips them would put the sixty-file diff back without anybody deciding
 * to.
 *
 * Reading this repository's own source as a fixture is what
 * `conductor/unit/gate-matrix.test.ts` and `domain/unit/retired-names.test.ts`
 * already do, and this follows them.
 */
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Recipe } from "../src/recipe.ts";
import { assigneeOf, backoffOf, baseOf, excludeOf, kindsOf, limitsFor, submodulesOf } from "../src/settings.ts";

const WRITTEN = {
  version: 2,
  repo: { base: "develop", submodules: true },
  source: { kinds: ["bug", "tech-debt"], exclude: ["agent:hold"], backoff: "45m" },
  env: { plantAt: ".env.local" },
  runtime: {},
};
const RECIPE: Recipe = Recipe.parse(WRITTEN);

describe("the accessors", () => {
  it("read what the recipe holds today", () => {
    expect(baseOf(RECIPE)).toBe("develop");
    expect(kindsOf(RECIPE)).toEqual(["bug", "tech-debt"]);
    expect(limitsFor(RECIPE, "implement")).toBe(RECIPE.runtime.limits);
  });

  /**
   * The three the guard below used to have no accessor for. One per setting
   * 0061 §4 moves, so that the move stays a change to `settings.ts`.
   */
  it("read the other three the same ADR moves", () => {
    expect(submodulesOf(RECIPE)).toBe(true);
    expect(excludeOf(RECIPE)).toEqual(["agent:hold"]);
    expect(backoffOf(RECIPE)).toBe("45m");
  });

  /**
   * **The seventh, and the one whose v1 name is not `source:`'s** (`#244`,
   * 0063 §3). `assignee` is `queue:`'s fourth field and a person writes it in
   * the machine file under `runtime:`, so where it is read from and where it
   * is going are two different keys — which is exactly what the accessor is
   * for. Absent is returned absent: *nothing was written* and *both* are the
   * same behaviour and not the same reading.
   */
  it("reads the `assignee` 0063 §3 adds to that list", () => {
    expect(assigneeOf(RECIPE)).toBeUndefined();

    const mine = Recipe.parse({
      ...WRITTEN,
      runtime: { assignee: { login: "steven-zhc", take: "mine" } },
    });
    expect(assigneeOf(mine)).toEqual({ login: "steven-zhc", take: "mine" });
  });

  /**
   * Not an implementation detail: the step is unread *today* and the two calls
   * are not the same question, so a caller passing the step it is at is right
   * both before 0061 §4's move and after it.
   */
  it("answer the same for every step, because the settings have not moved yet", () => {
    expect(limitsFor(RECIPE, "build")).toEqual(limitsFor(RECIPE, "implement"));
  });

  it("do not invent a default — a resolved recipe has every value", () => {
    expect(limitsFor(RECIPE, "implement").turns).toBeGreaterThan(0);
    expect(kindsOf(RECIPE).length).toBeGreaterThan(0);
  });
});

/** Every `src/` in the workspace, as paths. */
async function sources(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const at = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...(await sources(at)));
    else if (/\.tsx?$/.test(entry.name)) out.push(at);
  }
  return out;
}

/**
 * The seven settings 0061 §4 moves, as the dotted path a reader of one writes.
 *
 * Read off the ADR's own five-line table and not off `settings.ts`: the point
 * of the guard is to fail while an accessor is *missing*, which it cannot do if
 * the list it walks is the list of accessors that exist.
 *
 * **`runtime.assignee` is the seventh, and it arrived from a different ADR**
 * (`#244`, [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md)
 * §3): `assignee` is a field of `queue:` rather than a plugin beside it, which
 * makes it a setting that moves onto a step exactly as the other six do. It
 * was read by hand in three files — `discover.ts`, the filter's reading and the
 * board's — and none of them was visible to this list, which is `1a7267f`'s
 * lesson arriving a second time: **the list is the ADRs' and not
 * `settings.ts`'s**, so a setting one ADR moves and another names is on it
 * either way.
 *
 * The leading `\w\.` is what makes it a *read*: `recipe.source.kinds` and
 * `parsed.data.repo.base` match, and the same words after a backtick, a quote
 * or a space — which is every mention of them in prose and in a refusal — do
 * not.
 */
const MOVING =
  /\w\.(runtime\.(limits|assignee)|repo\.(base|submodules)|source\.(kinds|exclude|backoff))\b/;

describe("nothing reaches past them", () => {
  it("has no reader of a moving setting outside settings.ts", async () => {
    const root = new URL("../../../", import.meta.url);
    const roots = [new URL("packages/", root), new URL("apps/", root)];
    const reaching: string[] = [];

    for (const at of roots) {
      for (const file of await sources(at)) {
        const path = file.pathname.slice(root.pathname.length);
        // `settings.ts` is the one place that may, and a `src/` path is the
        // only thing this is about: a test may build a recipe by hand.
        if (!path.includes("/src/") || path.endsWith("recipe/src/settings.ts")) continue;
        const text = await readFile(file, "utf8");
        for (const line of text.split("\n")) {
          // A doc comment naming the old shape is prose, not a reader.
          if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
          if (MOVING.test(line)) reaching.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(
      reaching,
      "use the accessors in recipe/src/settings.ts — 0061 §4 and 0063 §3 move all seven of these onto their " +
        "steps, " +
        "and a reader that reaches past the accessor is a file that ticket has to edit",
    ).toEqual([]);
  });
});
