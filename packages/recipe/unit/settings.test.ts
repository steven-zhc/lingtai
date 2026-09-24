/**
 * The accessors, and the claim that nothing reaches past them.
 *
 * The first half is ordinary — they return what the recipe holds. **The second
 * half is the one that earns the file**: it walks every `src/` in the workspace
 * and fails on a reader that still reaches into `recipe.runtime.limits`,
 * `recipe.repo.base` or `recipe.source.kinds` by hand.
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
import { baseOf, kindsOf, limitsFor } from "../src/settings.ts";

const RECIPE: Recipe = Recipe.parse({
  version: 2,
  repo: { base: "develop" },
  source: { kinds: ["bug", "tech-debt"] },
  env: { plantAt: ".env.local" },
  runtime: {},
});

describe("the accessors", () => {
  it("read what the recipe holds today", () => {
    expect(baseOf(RECIPE)).toBe("develop");
    expect(kindsOf(RECIPE)).toEqual(["bug", "tech-debt"]);
    expect(limitsFor(RECIPE, "implement")).toBe(RECIPE.runtime.limits);
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
          if (/\brecipe\.(runtime\.limits|repo\.base|source\.kinds)\b/.test(line)) {
            reaching.push(`${path}: ${line.trim()}`);
          }
        }
      }
    }

    expect(
      reaching,
      "use limitsFor / baseOf / kindsOf — 0061 §4 moves these onto their steps, " +
        "and a reader that reaches past the accessor is a file that ticket has to edit",
    ).toEqual([]);
  });
});
