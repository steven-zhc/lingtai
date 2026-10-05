/**
 * `emitRecipe`, on a recipe silent about `runtime.limits` (#375).
 *
 * The git-diff behaviour of `emitRecipe`/`editRecipe` is
 * `integration/emit.test.ts` — it spawns `git`, so it is not this half. What
 * belongs here is the pure claim `#371`'s attempt asked about but never
 * checked: a recipe nobody wrote a ceiling into still states all four keys
 * once it is written down, because `Recipe.parse` fills the schema's
 * defaults before `new Document(...)` ever sees the object.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LIMIT_DEFAULTS, Recipe, emitRecipe } from "../src/index.ts";

describe("emitRecipe", () => {
  it("states every limit key, defaults included, for a recipe that named none", () => {
    const recipe = Recipe.parse({
      version: 2,
      repo: { base: "main" },
      source: { kinds: ["bug"] },
      env: { plantAt: ".env" },
      runtime: {},
    });
    const file = emitRecipe(recipe);
    const parsed = parse(file) as { runtime: { limits: Record<string, unknown> } };
    expect(parsed.runtime.limits).toEqual(LIMIT_DEFAULTS);
  });
});
