/**
 * Resolving a recipe. No network: `resolveRecipe` takes a reader, and the only
 * thing that matters about the real one is that its `ref` is a server-side ref.
 */
import { describe, expect, it } from "vitest";
import { RECIPE_PATH, RecipeInvalidError, RecipeMissingError, hashRecipe, resolveRecipe } from "../src/index.ts";

const VALID = `
version: 1
repo:
  base: develop
  submodules: true
source:
  kinds: [bug, feature]
  exclude: [blocked]
env:
  required: [DATABASE_URL, CLERK_SECRET_KEY]
  plantAt: apps/web/.env.local
gates:
  proposed:
    - name: build
      run: pnpm verify
runtime:
  agent: claude-code
`;

/** A reader that only answers for the refs it was given. */
const reader = (files: Record<string, string>) => async (path: string, ref: string) =>
  files[`${ref}:${path}`] ?? null;

describe("resolveRecipe", () => {
  it("reads the recipe at the ref it was asked for", async () => {
    const resolved = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");

    expect(resolved.ref).toBe("develop");
    expect(resolved.recipe.repo.base).toBe("develop");
    expect(resolved.recipe.gates.proposed).toHaveLength(1);
    // The four a recipe did not mention are present and empty — which is what
    // makes "nothing is configured here" visible rather than absent.
    expect(resolved.recipe.gates.admit).toEqual([]);
    expect(resolved.recipe.gates.end).toEqual([]);
    expect(resolved.recipe.repo.submodules).toBe(true);
  });

  /**
   * The governance rule, as a test. The agent's branch has a recipe with no
   * gates at all; resolving against the base branch must not see it.
   */
  it("does not read the agent's branch, even when it has one", async () => {
    const tampered = VALID.replace("- name: build\n      run: pnpm verify", "- name: nothing\n      run: 'true'");
    const files = {
      [`develop:${RECIPE_PATH}`]: VALID,
      [`agent/117:${RECIPE_PATH}`]: tampered,
    };

    const resolved = await resolveRecipe(reader(files), "develop");
    expect(resolved.recipe.gates.proposed[0]!.name).toBe("build");

    // And the tampered one really would have resolved differently, so the test
    // is not passing because both branches say the same thing.
    const other = await resolveRecipe(reader(files), "agent/117");
    expect(other.recipe.gates.proposed[0]!.name).toBe("nothing");
    expect(other.configHash).not.toBe(resolved.configHash);
  });

  it("says which branch has no recipe, and that the agent's does not count", async () => {
    await expect(resolveRecipe(reader({}), "develop")).rejects.toBeInstanceOf(RecipeMissingError);
    await expect(resolveRecipe(reader({}), "develop")).rejects.toThrow(/not read, by design/);
  });

  it("names the offending field rather than saying the file is bad", async () => {
    const missingPlantAt = VALID.replace("  plantAt: apps/web/.env.local\n", "");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: missingPlantAt }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toContain("env.plantAt");
  });

  /**
   * The half-move ADR 0017 was written about, caught this time. A recipe that
   * still says `diff:` is not "a recipe with no gates configured" — it is a
   * repository whose build and tests would have stopped running with the board
   * reporting `skipped`, which looks exactly like a deliberate choice.
   */
  it("refuses a recipe still naming the point `diff`, rather than skipping it", async () => {
    const stale = VALID.replace("  proposed:\n", "  diff:\n");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: stale }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/diff/);
  });

  /**
   * `allow` is back, and it means something else.
   *
   * It used to mean "plant these if they exist", which is the half-move 0020
   * cost $0.97 and ten turns for; the schema then made it **fail to resolve**,
   * so that a recipe still saying it could not quietly become "declares
   * nothing". `#60` returns it as a *filter over data that already exists*
   * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
   *
   * Reintroducing a word with a new meaning is only safe because the old
   * meaning made a recipe **refuse to resolve**: no recipe in service can be
   * carrying `allow` written under the old sense, so none can be silently
   * reinterpreted. Checked against both live recipes when this landed.
   *
   * What must not come back is the *old* meaning, and this is that assertion:
   * `allow` alone declares nothing required, so it refuses nothing.
   */
  it("takes `allow` as a filter, and it declares nothing required", async () => {
    const filtered = VALID.replace("  required: [", "  allow: [");
    const resolved = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: filtered }),
      "develop",
    );

    expect(resolved.recipe.env.allow).toBeDefined();
    expect(resolved.recipe.env.required).toEqual([]);
  });

  /** An unknown key in `env` still names itself, which is what keeps the above honest. */
  it("refuses an env key that is not one of the four", async () => {
    const typo = VALID.replace("  required: [", "  requried: [");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: typo }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/requried/);
  });

  /**
   * `subscribers:` — 0037 §3. The declaration and the subscription are one
   * thing, so everything worth testing here is about `on:`.
   */
  const WITH_SUBSCRIBER =
    VALID +
    `subscribers:
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked, RunFailed]
    run: npx @lingtai/telegram
`;

  it("takes a subscriber, and a recipe without one declares none", async () => {
    const with_ = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: WITH_SUBSCRIBER }), "develop");
    expect(with_.recipe.subscribers).toHaveLength(1);
    expect(with_.recipe.subscribers[0]!.on).toEqual(["WorkItemLanded", "WorkItemBlocked", "RunFailed"]);
    expect(with_.recipe.subscribers[0]!.run).toBe("npx @lingtai/telegram");

    // Empty rather than absent, like the four gate points a recipe never
    // mentions: "declared none" is a thing that can be rendered.
    const without = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");
    expect(without.recipe.subscribers).toEqual([]);
  });

  /**
   * The failure this check exists for is not a bad recipe, it is a *good*
   * one that never fires — a subscription you only notice by the message you
   * did not get. So the name has to be in the message.
   */
  it("refuses an event name that is not in the catalogue, naming it", async () => {
    const typo = WITH_SUBSCRIBER.replace("WorkItemLanded", "WorkItemLandeed");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: typo }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/WorkItemLandeed/);
  });

  /** Spelled right, in the catalogue, and nothing appends it: the same nothing. */
  it("refuses a retired event type, and says that is what it is", async () => {
    const retired = WITH_SUBSCRIBER.replace("RunFailed", "OutboxDelivered");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: retired }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/OutboxDelivered.*retired/);
  });

  /** Strict, for the reason `GateMap` and `env` are: `events:` is a draft of 0037. */
  it("refuses a subscriber key that is not one of the three", async () => {
    const stale = WITH_SUBSCRIBER.replace("    on: [", "    events: [");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: stale }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/events/);
  });

  it("rejects YAML that is not a recipe at all", async () => {
    await expect(
      resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: "just: a map" }), "develop"),
    ).rejects.toBeInstanceOf(RecipeInvalidError);
    await expect(
      resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: "a: [1,\n" }), "develop"),
    ).rejects.toThrow(/YAML/);
  });
});

describe("hashRecipe", () => {
  it("is stable across key order and comments, because it hashes the resolved form", async () => {
    const reordered = `
# a comment that changes nothing about the run
version: 1
source:
  exclude: [blocked]
  kinds: [bug, feature]
repo:
  submodules: true
  base: develop
runtime:
  agent: claude-code
gates:
  proposed:
    - run: pnpm verify
      name: build
env:
  plantAt: apps/web/.env.local
  required: [DATABASE_URL, CLERK_SECRET_KEY]
`;
    const a = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");
    const b = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: reordered }), "develop");

    // "Did results change after I edited the pipeline?" should answer no when
    // the edit was cosmetic.
    expect(b.configHash).toBe(a.configHash);
    expect(a.source).not.toBe(b.source);
  });

  it("changes when the run would change", async () => {
    const a = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");
    const b = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: VALID.replace("pnpm verify", "pnpm verify --fast") }),
      "develop",
    );

    expect(b.configHash).not.toBe(a.configHash);
    expect(hashRecipe(a.recipe)).toBe(a.configHash);
  });
});
