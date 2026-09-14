/**
 * What `lingtai add` decides about the base — which, since #75, is nothing.
 *
 * No network and no database: `governing` takes a reader, exactly as
 * `resolveRecipe` does, so the three rows of the table are assertable about the
 * decision itself rather than about a command that also talks to GitHub.
 */
import { RECIPE_PATH } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { governing } from "../src/add.ts";

const recipe = (base: string) => `
version: 1
repo:
  base: ${base}
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`;

const reader = (files: Record<string, string>) => async (path: string, ref: string) =>
  files[`${ref}:${path}`] ?? null;

const SLUG = "steven-zhc/nextloom-ai-admin";

describe("the base lingtai add records", () => {
  it("is the recipe's, when the branch it was read from agrees", async () => {
    const found = await governing(
      reader({ [`develop:${RECIPE_PATH}`]: recipe("develop") }),
      { ref: "develop", named: true },
      SLUG,
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.resolved.recipe.repo.base).toBe("develop");
    expect(found.adoptedFrom).toBeNull();
  });

  /**
   * The bootstrap. The default branch is only where the file was found; the file
   * says which branch it governs, and the recipe that comes back — and so the
   * hash recorded beside the base — is the one on *that* branch.
   */
  it("is adopted from the recipe when nobody named a branch", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("develop").replace("kinds: [bug]", "kinds: [bug, tech-debt]"),
      }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.resolved.recipe.repo.base).toBe("develop");
    expect(found.resolved.ref).toBe("develop");
    expect(found.adoptedFrom).toBe("main");
    // Read again at the branch it governs, not carried over from `main`.
    expect(found.resolved.recipe.source.kinds).toEqual(["bug", "tech-debt"]);
  });

  it("refuses, naming both branches, when a person named one the recipe contradicts", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("develop"),
      }),
      { ref: "main", named: true },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("main");
    expect(found.refusal).toContain("develop");
    // And it says which of the two is the decision, rather than picking one.
    expect(found.refusal).toContain("repo.base");
  });

  it("refuses when the branch the recipe names has no recipe on it", async () => {
    const found = await governing(
      reader({ [`main:${RECIPE_PATH}`]: recipe("develop") }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("main");
    expect(found.refusal).toContain(`no ${RECIPE_PATH} on develop`);
  });

  /** One hop is a bootstrap; two is a recipe disagreeing with the branch it is on. */
  it("refuses rather than following a second hop", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("release"),
        [`release:${RECIPE_PATH}`]: recipe("release"),
      }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("develop");
    expect(found.refusal).toContain("release");
  });
});
