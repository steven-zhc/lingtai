/**
 * Resolving a recipe. No network: `resolveRecipe` takes a reader, and the only
 * thing that matters about the real one is that its `ref` is a server-side ref.
 */
import { describe, expect, it } from "vitest";
import {
  LIMIT_DEFAULTS,
  RECIPE_PATH,
  RecipeInvalidError,
  RecipeMissingError,
  canonicalRecipe,
  formatDuration,
  hashRecipe,
  parseDuration,
  resolveRecipe,
} from "../src/index.ts";

const VALID = `
version: 2
repo:
  base: develop
  submodules: true
source:
  kinds: [bug, feature]
  exclude: [blocked]
env:
  required: [DATABASE_URL, CLERK_SECRET_KEY]
  plantAt: apps/web/.env.local
steps:
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
    expect(resolved.recipe.steps.proposed).toHaveLength(1);
    // The four a recipe did not mention are present and empty — which is what
    // makes "nothing is configured here" visible rather than absent.
    expect(resolved.recipe.steps.admit).toEqual([]);
    expect(resolved.recipe.steps.end).toEqual([]);
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
    expect(resolved.recipe.steps.proposed[0]!.name).toBe("build");

    // And the tampered one really would have resolved differently, so the test
    // is not passing because both branches say the same thing.
    const other = await resolveRecipe(reader(files), "agent/117");
    expect(other.recipe.steps.proposed[0]!.name).toBe("nothing");
    expect(other.configHash).not.toBe(resolved.configHash);
  });

  it("reads env.refuseHosts, empty when a recipe names none", async () => {
    const plain = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");
    expect(plain.recipe.env.refuseHosts).toEqual([]);

    const named = VALID.replace("  plantAt:", "  refuseHosts: [eliwlauokdzgsqfgczkv]\n  plantAt:");
    const resolved = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: named }), "develop");
    expect(resolved.recipe.env.refuseHosts).toEqual(["eliwlauokdzgsqfgczkv"]);

    const host = VALID.replace("  plantAt:", "  refuseHosts: [db.eliwlauokdzgsqfgczkv.supabase.co, prod-db]\n  plantAt:");
    const whole = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: host }), "develop");
    expect(whole.recipe.env.refuseHosts).toEqual(["db.eliwlauokdzgsqfgczkv.supabase.co", "prod-db"]);

    // An entry with an empty segment could never match, so it is not accepted.
    const inert = VALID.replace("  plantAt:", "  refuseHosts: [.supabase.co]\n  plantAt:");
    await expect(resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: inert }), "develop")).rejects.toBeInstanceOf(
      RecipeInvalidError,
    );

    // Nor one copied out of a connection string with what a hostname does not hold.
    for (const entry of [
      '"db.eliwlauokdzgsqfgczkv.supabase.co:5432"',
      '"postgresql://db.eliwlauokdzgsqfgczkv.supabase.co"',
      '"postgres.eliwlauokdzgsqfgczkv@aws-0-us-east-1.pooler.supabase.com"',
      '"db.eliwlauokdzgsqfgczkv.supabase.co/postgres"',
    ]) {
      const copied = VALID.replace("  plantAt:", `  refuseHosts: [${entry}]\n  plantAt:`);
      await expect(resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: copied }), "develop")).rejects.toBeInstanceOf(
        RecipeInvalidError,
      );
    }
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
    env: [TELEGRAM_BOT_TOKEN]
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
   * 0037 §1, in the schema: an extension's environment is declared beside it,
   * and the declared set is the whole set.
   *
   * The empty default is the load-bearing half. An extension that names nothing
   * has *named nothing* — the alternative reading, "give it whatever the daemon
   * has", is the thing 0037 §1 replaced, and a default of `[]` is what makes
   * that unsayable rather than merely discouraged.
   */
  it("takes an environment beside an extension, and defaults it to nothing", async () => {
    const resolved = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: WITH_SUBSCRIBER }),
      "develop",
    );

    expect(resolved.recipe.subscribers[0]!.env).toEqual(["TELEGRAM_BOT_TOKEN"]);
    // The `run:` gate in VALID declares none, so it gets none.
    const build = resolved.recipe.steps.proposed[0]!;
    expect("run" in build && build.env).toEqual([]);
  });

  /**
   * `LINGTAI_DATABASE_URL` is this system's own log, and 0037 §1 names it as
   * the reason an extension's code is not trusted. The message has to name the
   * variable: a recipe that will not resolve and does not say which line is a
   * recipe nobody can fix.
   */
  it("refuses one of Lingtai's own names for an extension, and names it", async () => {
    const reaching = WITH_SUBSCRIBER.replace("TELEGRAM_BOT_TOKEN", "LINGTAI_DATABASE_URL");
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: reaching }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/LINGTAI_DATABASE_URL/);
  });

  /** The same rule at the other extension point, because `run:` is the one point. */
  it("refuses it on a run: action too", async () => {
    const reaching = VALID.replace(
      "      run: pnpm verify",
      "      run: pnpm verify\n      env: [LINGTAI_TEST_DATABASE_URL]",
    );
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: reaching }),
      "develop",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as RecipeInvalidError).problems.join("\n")).toMatch(/LINGTAI_TEST_DATABASE_URL/);
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

  /** Strict, for the reason `StepMap` and `env` are: `events:` is a draft of 0037. */
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
version: 2
source:
  exclude: [blocked]
  kinds: [bug, feature]
repo:
  submodules: true
  base: develop
runtime:
  agent: claude-code
steps:
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

  /**
   * **The digest of a `version: 2` recipe, pinned as a literal.** It is not
   * computed from anything here on purpose: a hash is the identity of a
   * document (0047 §2), so the literal is the only thing that catches a change
   * to `canonical` that nobody meant.
   *
   * **The pin moved once and this is the record of why.** It was `d64081da…`,
   * the digest of the same text under `version: 1` with a `gates:` key, kept so
   * that hashes already on the log stayed provable. `steps:` replacing `gates:`
   * ends that: the recorded hashes are all of v1 documents, and a v1 file is
   * now **refused by name**, so the task page cannot re-hash a past run's
   * recipe at its base commit at all — it does not get a different answer, it
   * gets a refusal (`apps/board/src/lib/recipe.ts:285`).
   *
   * **That is 0061 §7's accepted cost rather than a defect**: there is no
   * migration for the file and none for the log, and the thing that settles it
   * is the reset (`the-pipeline.md`'s T5), not an upcaster. Until then, an
   * attempt recorded before this commit cannot have its recipe proved, and the
   * board says so.
   */
  it("gives a v2 recipe a digest nothing recomputes it from", async () => {
    const a = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");

    expect(a.configHash).toBe("cefec6a9497a47f86eb56b9bd3b8d23fe78793bc34888ffad6dedf27f6399a85");
    // And the body on the event is the document that digest is of (0047 §2),
    // so the five are out of both or neither — a strip on one side only makes
    // `hashRecipe(GatesResolved.recipe) === configHash` false.
    expect(Object.keys(canonicalRecipe(a.recipe)["steps"] as object).sort()).toEqual([
      "admit",
      "end",
      "merge",
      "prepared",
      "proposed",
    ]);
  });

  /**
   * The other half, and the half that expires first: the five are out of the
   * hash **because they are empty**, not because of their names. `KINDS_AT`
   * refuses every kind at all five today, so the list is always `[]` and the
   * canonical form is dropping a field that carries nothing. The day 0058's
   * plan builds one and a recipe configures it, it is in the hash and the hash
   * moves — because the configuration did.
   */
  it("puts a step back in the hash the moment something is configured at it", async () => {
    const { recipe } = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");
    const empty = hashRecipe(recipe);

    // Past the schema, which refuses the pair until the step has a call site
    // (`whyNoKindAt`) — this is the shape a resolved recipe takes once it does
    // not, and the hash has to move with it.
    recipe.steps.build.push({ name: "build", run: "pnpm test", timeout: "20m", env: [] });

    expect(hashRecipe(recipe)).not.toBe(empty);
    expect(Object.keys(canonicalRecipe(recipe)["steps"] as object)).toContain("build");
  });
});

/**
 * A key that used to mean something has to be refused, not dropped.
 *
 * `Recipe` is `z.object` and not `z.strictObject` — a key it does not know is
 * silently discarded. For `repair`, retired by
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §4,
 * that would leave a repository running on `rounds`' default while its own
 * committed file said `maxAttempts: 3`: a setting present, believed, and
 * connected to nothing. That is this project's most-repeated bug class, and it
 * is worth a test rather than a comment.
 */
describe("a retired key", () => {
  const withRepair = `${VALID}repair:\n  on: true\n  maxAttempts: 3\n`;

  it("refuses the recipe rather than dropping the key", async () => {
    await expect(
      resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: withRepair }), "develop"),
    ).rejects.toBeInstanceOf(RecipeInvalidError);
  });

  it("names the key and where it went, because a person has to edit the file", async () => {
    const err = await resolveRecipe(
      reader({ [`develop:${RECIPE_PATH}`]: withRepair }),
      "develop",
    ).catch((e: unknown) => e as RecipeInvalidError);

    const message = String((err as Error).message);
    expect(message).toContain("repair:");
    expect(message).toContain("runtime.limits.rounds");
    // And says what the off switch became, since that is the one a project is
    // most likely to have set deliberately.
    expect(message).toContain("rounds: 0");
  });

  it("says nothing about a recipe that does not carry it", async () => {
    const resolved = await resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: VALID }), "develop");

    expect(resolved.recipe.runtime.limits.rounds).toBe(LIMIT_DEFAULTS.rounds);
  });
});

/**
 * `formatDuration` exists so a sentence about cost can be computed from the
 * numbers that decide it. The contract is the round trip: **anything it prints,
 * `parseDuration` reads back.**
 */
describe("durations, both ways", () => {
  it("round-trips through parseDuration", () => {
    for (const ms of [1_000, 90_000, 3_600_000, 5_400_000, 10_800_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });

  it("prefers whole units, so a reader never does arithmetic", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(10_800_000)).toBe("3h");
    // Not `1.5h`: a fraction is where arithmetic starts.
    expect(formatDuration(5_400_000)).toBe("90m");
    expect(formatDuration(30_000)).toBe("30s");
  });

  it("falls back to milliseconds rather than lying", () => {
    expect(formatDuration(1_500)).toBe("1500ms");
  });
});
