/**
 * **The plugin contract, and the six plugins behind it** (`#228`,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §9).
 *
 * Three properties, and each is a thing a convention used to hold:
 *
 * - **A plugin owns its schema.** There is no registry of fields anywhere, so
 *   the only way to find out whether `agent:` takes an `env:` is to ask
 *   `agent:` — and a recipe that writes one is refused by name rather than
 *   having it accepted and dropped.
 * - **Every problem in one answer.** A resolve that stopped at the first bad
 *   field would make a person fix one thing per attempt, which is `#222`'s
 *   lesson about the build step applied to configuration.
 * - **A field marked `no_log` is withheld mechanically**, not by everybody
 *   remembering to — its value replaced by a digest of itself, so that two
 *   recipes differing in a credential stay two documents (0047 §2) while
 *   neither says what the credential is. A mark that could not be honoured is
 *   refused where it is written rather than read as a declaration that
 *   withholds nothing.
 *   **Nothing in the closed set declares one today**, which is why the cases
 *   below define a plugin of their own and drive the real `canonicalRecipe`,
 *   `hashRecipe` and `changesFromHead` with it: a guard asserted over an empty
 *   set asserts nothing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STEPS } from "@lingtai/domain";
import {
  GateMap,
  PLUGINS,
  Recipe,
  agentPlugin,
  canonicalRecipe,
  definePlugin,
  disclose,
  discloseSteps,
  hashRecipe,
  mergePlugin,
  noLog,
  pluginOf,
  readFields,
  runPlugin,
  whyNoKindAt,
  withheld,
  worktreePlugin,
  type GateAction,
} from "../src/index.ts";

/** The smallest recipe that resolves, so a case can put one action in it. */
const BASE: Recipe = Recipe.parse({
  version: 1,
  repo: { base: "main" },
  source: { kinds: ["bug"] },
  env: { plantAt: ".env.local" },
  runtime: {},
});

/**
 * A plugin that spends money and is handed the key to do it — the first shape
 * that would want `no_log`, written here rather than in `src/` because the
 * closed set has no such plugin and this ticket adds none.
 *
 * **The secret sits beside `spend:` rather than on it**, which is the only place
 * a mark is honoured: marking the key would have `disclose` withhold what this
 * action *does*, and `definePlugin` refuses that — the case for it is below.
 */
const spendPlugin = definePlugin("spend", { spend: z.string(), token: noLog(z.string()) });
const PAY = { name: "pay", spend: "50 USD", token: "sk-live-0000-9999" } as unknown as GateAction;

/** `BASE` with one action at `proposed`, which is a step that runs four kinds. */
function withAction(action: GateAction): Recipe {
  return { ...BASE, gates: { ...BASE.gates, proposed: [action] } };
}

describe("the contract", () => {
  it("gives every plugin `name` and nothing else it did not declare", () => {
    for (const plugin of PLUGINS) {
      expect(plugin.declares, `${plugin.key} does not declare name`).toContain("name");
      expect(plugin.declares[0], `${plugin.key}'s fields do not start with name`).toBe("name");
    }
  });

  it("reads a field's `no_log` off the schema, not off a list", () => {
    expect(spendPlugin.secrets).toEqual(["token"]);
    expect(definePlugin("loud", { loud: z.string() }).secrets).toEqual([]);
  });

  /**
   * Today's answer, pinned so that the first plugin to want a secret field
   * arrives as a visible diff rather than as a quiet one. It is not an
   * oversight: every field the six have is a name, a command, a prompt or a
   * glob, and 0021 keeps values out of the file in the first place.
   */
  it("has no secret field in the closed set today", () => {
    expect(PLUGINS.flatMap((plugin) => plugin.secrets)).toEqual([]);
  });

  it("finds the plugin an action names, and refuses none and two", () => {
    expect(pluginOf({ name: "build", run: "x" })?.key).toBe("run");
    expect(pluginOf({ name: "build" })).toBeNull();
    expect(pluginOf({ name: "build", run: "x", agent: "y" })).toBeNull();
    expect(pluginOf("not an object")).toBeNull();
  });
});

describe("a plugin refuses a field it does not understand", () => {
  /**
   * 0061 §9's own example. `env:` is `run:`'s because `run:` is the one that
   * spawns a process (0037 §1); a plugin that spawns nothing has no such field,
   * and the refusal says so and lists what it does have.
   */
  it("refuses `env:` on a plugin that spawns nothing, by name", () => {
    const refused = GateMap.safeParse({
      proposed: [{ name: "review", agent: "read the diff", env: ["OPENAI_API_KEY"] }],
    });

    expect(refused.success).toBe(false);
    const said = refused.error!.issues[0]!.message;
    expect(said).toContain('"review"');
    expect(said).toContain('"agent"');
    expect(said).toContain('"proposed"');
    expect(said).toContain('"agent" declares no "env" field');
    expect(said).toContain('"name", "agent"');
    // And the path reaches the field, so an editor lands on the line.
    expect(refused.error!.issues[0]!.path).toEqual(["proposed", 0, "env"]);
  });

  it("takes `env:` on the plugin that does spawn", () => {
    const taken = GateMap.safeParse({
      proposed: [{ name: "build", run: "pnpm verify", env: ["TURBO_TOKEN"] }],
    });

    expect(taken.success).toBe(true);
    expect(taken.data!.proposed[0]).toEqual({
      name: "build",
      run: "pnpm verify",
      timeout: "15m",
      env: ["TURBO_TOKEN"],
    });
  });

  it("names the plugins when an action names none, or two", () => {
    const none = GateMap.safeParse({ proposed: [{ name: "nothing" }] });
    expect(none.error!.issues[0]!.message).toContain('"nothing" action at the "proposed" step names no plugin');
    expect(none.error!.issues[0]!.message).toContain('"run", "agent", "watch", "human", "close", "labels"');

    const two = GateMap.safeParse({ proposed: [{ name: "both", run: "x", human: "ok?" }] });
    expect(two.error!.issues[0]!.message).toContain("names 2 plugins");
    expect(two.error!.issues[0]!.message).toContain('"run" and "human"');
  });

  /**
   * **The step's answer comes first, and it is the true one.** An `agent:` at
   * `prepared` is refused because nothing has been committed there — not
   * because of anything about its fields — so `whyNoKindAt`'s sentence is what
   * a person gets, and the field checks do not run at all.
   */
  it("says why the step refuses before it says anything about a field", () => {
    const refused = GateMap.safeParse({ prepared: [{ name: "review", agent: "x", env: ["A"] }] });

    expect(refused.error!.issues).toHaveLength(1);
    expect(refused.error!.issues[0]!.message).toMatch(/nothing has been committed/);
  });
});

describe("every problem in one answer", () => {
  /**
   * Three bad fields across two steps, refused **once**, each naming its step,
   * its plugin and its field. Before the contract this was a union error about
   * six schemas that had all failed, and a person fixed one thing per attempt.
   */
  it("names all three bad fields, with their step and plugin", () => {
    const refused = GateMap.safeParse({
      proposed: [
        { name: "build", run: "pnpm verify", timeout: 15 },
        { name: "review", agent: "read it", env: ["A"] },
      ],
      end: [{ name: "close it", close: true, when: "someday" }],
    });

    expect(refused.success).toBe(false);
    const said = refused.error!.issues.map((issue) => issue.message);
    expect(said).toHaveLength(3);

    expect(said[0]).toContain('"build"');
    expect(said[0]).toContain('"timeout" field');
    expect(said[0]).toContain('"proposed"');

    expect(said[1]).toContain('"review"');
    expect(said[1]).toContain('"env" field');

    expect(said[2]).toContain('"close it"');
    expect(said[2]).toContain('"when" field');
    expect(said[2]).toContain('"end"');

    // The same sentence the step's own refusal opens with, so the two read as
    // one rule rather than as two mechanisms (0061 §8).
    for (const one of said) expect(one).toMatch(/^the ".+" action is a ".+" at the ".+" point, and /);
    for (const one of said) expect(one).toContain("before a worktree, before an agent, before any money");
  });

  it("does not let one bad action hide the next, or one step the other nine", () => {
    const refused = GateMap.safeParse({
      prepared: [{ name: "install", run: "pnpm i", timeout: 10 }],
      merge: [{ name: "approve", human: 7 }],
    });

    expect(refused.error!.issues.map((issue) => issue.path)).toEqual([
      ["prepared", 0, "timeout"],
      ["merge", 0, "human"],
    ]);
  });
});

describe("a `no_log` field never leaves its plugin", () => {
  it("is replaced by a digest of itself, and the field stays", () => {
    // The value is gone and everything that says what this is stays: the key,
    // the name, the field that is not marked — **and that the marked field was
    // written at all**, which is what a deletion would take with it.
    const shown = disclose(PAY, [spendPlugin]) as Record<string, unknown>;
    expect(shown).toEqual({ name: "pay", spend: "50 USD", token: withheld("sk-live-0000-9999") });
    expect(shown["token"]).not.toContain("sk-live");

    // **Two values are two stand-ins**, which is the whole point of a stand-in
    // rather than nothing: the identity of the document follows the credential.
    expect(withheld("KEY_A")).not.toBe(withheld("KEY_B"));
    // And a stand-in stands in for itself, so a body read back off the log and
    // put through this again is the same body.
    expect(withheld(withheld("KEY_A"))).toBe(withheld("KEY_A"));

    // An action with nothing to withhold is the object it was given, so the
    // six plugins in use today are untouched by any of this.
    const build: GateAction = { name: "build", run: "x", timeout: "15m", env: [] };
    expect(disclose(build, PLUGINS)).toBe(build);
    // An optional secret nobody wrote is not invented, so a recipe without one
    // is not made into a recipe with one.
    expect(disclose({ name: "pay", spend: "50 USD" }, [spendPlugin])).toEqual({
      name: "pay",
      spend: "50 USD",
    });
  });

  it("never reaches the log's body, nor the hash taken over it", () => {
    const recipe = withAction(PAY);
    const body = JSON.stringify(canonicalRecipe(recipe, [spendPlugin]));

    expect(body).not.toContain("sk-live-0000-9999");
    // **The action on the log still names its plugin**, whole and in the
    // canonical form's own order, **and still says it carried a token**. A
    // strip that took the key with it would write an action the log cannot say
    // the kind of; one that took the field would write an action the log cannot
    // say was ever given a credential at all.
    expect(body).toContain(`{"name":"pay","spend":"50 USD","token":"${withheld("sk-live-0000-9999")}"}`);
    // Two actions that differ in what is *not* withheld are still two.
    expect(hashRecipe(recipe, [spendPlugin])).not.toBe(
      hashRecipe(withAction({ ...PAY, spend: "80 USD" } as unknown as typeof PAY), [spendPlugin]),
    );
  });

  /**
   * **A rotated credential is a new document, and the board rests on that.**
   *
   * `fromHead` (`apps/board/src/lib/recipe.ts`) settles *is this run's recipe
   * the one at head* by comparing two `configHash`es and nothing else — 0047
   * §2's *two documents with one hash are one document*. So a withheld value
   * that left the hash would have the task page tell an operator the run ran
   * under the recipe head has, when the run spent money against the key before
   * the rotation and head holds the key after it. It is the one property a
   * deletion cannot have, and the reason the value is replaced rather than
   * dropped.
   */
  it("keeps two recipes that differ only in a secret two documents", () => {
    const a = withAction({ name: "pay", spend: "50 USD", token: "KEY_A" } as unknown as GateAction);
    const b = withAction({ name: "pay", spend: "50 USD", token: "KEY_B" } as unknown as GateAction);

    expect(hashRecipe(a, [spendPlugin])).not.toBe(hashRecipe(b, [spendPlugin]));
    // And an action that carries a credential is not the same document as the
    // same action carrying none.
    expect(hashRecipe(a, [spendPlugin])).not.toBe(
      hashRecipe(withAction({ name: "pay", spend: "50 USD" } as unknown as GateAction), [spendPlugin]),
    );
    // Neither body says which key, and both say there was one.
    for (const recipe of [a, b]) {
      const body = JSON.stringify(canonicalRecipe(recipe, [spendPlugin]));
      expect(body).not.toContain("KEY_");
      expect(body).toContain('"token":"no_log:sha256:');
    }
  });

  /**
   * **The body verifies against the hash beside it**, which is what a reader
   * without trust in the writer does with `GatesResolved` (0047 §2) — and is
   * `conductor/unit/recorded-recipe.test.ts`'s own move. It works only because
   * a stand-in stands in for itself: the body has been through `disclose`
   * already by the time anybody re-hashes it.
   */
  it("hashes the recorded body back to the hash recorded beside it", () => {
    const recipe = withAction(PAY);
    const recorded = canonicalRecipe(recipe, [spendPlugin]) as unknown as Recipe;

    expect(hashRecipe(recorded, [spendPlugin])).toBe(hashRecipe(recipe, [spendPlugin]));
  });

  /** The board's half of this is `apps/board/unit/run-recipe.test.tsx`. */
  it("never reaches a refusal's text", () => {
    const read = readFields(spendPlugin, { name: "pay", spend: "50 USD", token: 4321 });

    expect(read.problems).toHaveLength(1);
    expect(read.problems![0]!.why).toContain('"token" field');
    expect(read.problems![0]!.why).toContain("declared no_log");
    expect(read.problems![0]!.why).not.toContain("4321");
  });

  /**
   * **A mark that would strip nothing is refused where it is written.**
   * `definePlugin` reads `.meta()` off each field, and zod keeps meta on the
   * instance `noLog` was called on — so a mark inside a nested object, or under
   * a wrapper applied after it, is a declaration that reads as marked and
   * strips nothing at all. That is the failure `noLog` exists to remove, so it
   * is an error at import rather than an empty `secrets`.
   */
  it("refuses a mark written below the field, however deep", () => {
    expect(() => definePlugin("notify", { notify: z.object({ token: noLog(z.string()) }) })).toThrow(
      /marks no_log below its "notify" field/,
    );
    expect(() => definePlugin("late", { late: noLog(z.string()).optional() })).toThrow(
      /marks no_log below its "late" field/,
    );
    expect(() => definePlugin("deep", { deep: z.array(z.object({ token: noLog(z.string()) })).default([]) })).toThrow(
      /marks no_log below its "deep" field/,
    );
    // And the way round that does work is the way round the wording asks for.
    expect(definePlugin("fine", { fine: z.string(), token: noLog(z.string().optional()) }).secrets).toEqual(["token"]);
  });

  /**
   * **And a mark on what names the action is refused too.** `disclose` withholds
   * whole fields, so marking the key would withhold the one thing saying what an
   * action does: the log would record that something ran without saying what,
   * and `close: true` would read as a string its own schema refuses. `name` is
   * the address a verdict, a waiver and every reading use, and goes the same
   * way.
   */
  it("refuses a mark on the key, and on `name`", () => {
    expect(() => definePlugin("spend", { spend: noLog(z.string()) })).toThrow(
      /"spend" marks its own "spend" field no_log/,
    );
    expect(() => definePlugin("spend", { spend: z.string(), name: noLog(z.string()) })).toThrow(
      /"spend" marks its own "name" field no_log/,
    );
    // The same rule at the strip, because a `PluginSecrets` is written by hand
    // where there is no schema to have refused it — and answering an action
    // naming no plugin would be the quiet failure one layer further down.
    expect(() => disclose({ name: "pay", spend: "sk-live-0000" }, [{ key: "spend", secrets: ["spend"] }])).toThrow(
      /goes beside the key/,
    );
    expect(() => disclose({ name: "pay", spend: "50 USD" }, [{ key: "spend", secrets: ["name"] }])).toThrow(
      /marks its own "name" field no_log/,
    );
  });

  /** What the six do today, so the strip cannot be silently costing anything. */
  it("changes nothing for a recipe with no secret field in it", () => {
    const build: GateAction = { name: "build", run: "pnpm verify", timeout: "15m", env: [] };
    const recipe = withAction(build);

    expect(discloseSteps(recipe.gates).proposed).toEqual([build]);
    expect(hashRecipe(recipe)).toBe(hashRecipe(recipe, PLUGINS));
  });
});

describe("the six behind the contract", () => {
  /**
   * **Wrap, do not reimplement** is the whole of this ticket, and this is the
   * case that says so: the defaults a recipe has relied on since `run:` and
   * `close:` were written are still the ones it gets.
   */
  it("resolves the defaults the six had before the contract", () => {
    const resolved = GateMap.parse({
      proposed: [
        { name: "build", run: "pnpm verify" },
        { name: "tamper", watch: ["**/recipe.yml"] },
      ],
      end: [
        { name: "close it", close: true },
        { name: "label it", labels: ["lingtai:done"] },
      ],
    });

    expect(resolved.proposed[0]).toEqual({ name: "build", run: "pnpm verify", timeout: "15m", env: [] });
    expect(resolved.proposed[1]).toEqual({
      name: "tamper",
      watch: ["**/recipe.yml"],
      then: "request-approval",
    });
    expect(resolved.end[0]).toEqual({ name: "close it", close: true, when: "landed" });
    expect(resolved.end[1]).toEqual({ name: "label it", labels: ["lingtai:done"], when: "any" });
  });

  it("keeps `LINGTAI_*` out of the one plugin that has an `env:`", () => {
    expect(runPlugin.declares).toContain("env");
    expect(agentPlugin.declares).not.toContain("env");

    const refused = GateMap.safeParse({
      proposed: [{ name: "build", run: "x", env: ["LINGTAI_DATABASE_URL"] }],
    });
    expect(refused.error!.issues[0]!.message).toContain("LINGTAI_DATABASE_URL");
  });
});

/**
 * **The branch a pass owns, cut and landed** (`#235`,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * Both are names for code that already runs — `provisionWorktree` and the
 * integrator — and neither is read from the recipe yet. So what these cases
 * hold is the pair of properties that makes declaring them now worth anything:
 *
 * - **Refused at all ten steps, by a sentence that says where the code is.**
 *   Outside the closed set the refusal would be *names no plugin*, which is
 *   true and about the wrong thing; inside it, an operator is told which file
 *   cuts their worktree today. That the *schema* carries that sentence — the
 *   action, its plugin, its step — is asserted of all twenty cells by
 *   `packages/conductor/unit/gate-matrix.test.ts`, which walks the closed set
 *   rather than a list of its own; what is here is the sentence itself.
 * - **`merge:` declares no `base:`.** `base` is one value that flows (§4), and
 *   a second declaration would manufacture a disagreement between what a pass
 *   cut and what it lands — which cannot happen today and is not made possible
 *   here.
 */
describe("the two the pass calls itself", () => {
  it("is refused at every one of the ten steps, and names the file instead", () => {
    for (const step of STEPS) {
      for (const kind of ["worktree", "merge"] as const) {
        expect(whyNoKindAt(step, kind), `${step} × ${kind} is accepted`).not.toBeNull();
      }
    }

    expect(whyNoKindAt("admit", "worktree")).toContain("packages/repo/src/worktree.ts");
    expect(whyNoKindAt("admit", "worktree")).toContain("repo.base");
    expect(whyNoKindAt("merge", "merge")).toContain("packages/repo/src/integrate.ts");
  });

  /**
   * The watch-out this ticket was written around. A `base:` under `merge:` is
   * an unrecognized key inside the plugin's own map, and it has to stay one.
   */
  it("gives `merge:` no `base:` of its own", () => {
    expect(mergePlugin.declares).toEqual(["name", "merge"]);
    expect(JSON.stringify(mergePlugin.schema.safeParse({ name: "x", merge: {} }))).not.toContain("base");

    const refused = mergePlugin.schema.safeParse({
      name: "land it",
      merge: { base: "main", strategy: "merge-commit" },
    });
    expect(refused.success).toBe(false);

    // And the refusal is the map's own words rather than the plugin's field
    // list: `base` is not one of `merge:`'s fields, and naming `"name",
    // "merge"` beside it would send a reader to a depth where neither is legal.
    const problems = readFields(mergePlugin, {
      name: "land it",
      merge: { base: "main" },
    }).problems!;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.at).toEqual(["merge"]);
    expect(problems[0]!.why).toContain("base");
    expect(problems[0]!.why).not.toContain('what it declares is');
  });

  /** The values today's code is called with, and no others. */
  it("carries what the code it wraps is configured by, and nothing more", () => {
    expect(worktreePlugin.schema.parse({ name: "cut", worktree: { base: "main" } })).toEqual({
      name: "cut",
      worktree: { base: "main", submodules: false },
    });

    // One strategy, because `integrate.ts` offers one. A second value here
    // would be a behaviour this repository does not have, declared as though
    // it did.
    expect(mergePlugin.schema.parse({ name: "land", merge: {} })).toEqual({
      name: "land",
      merge: { strategy: "merge-commit" },
    });
    expect(mergePlugin.schema.safeParse({ name: "land", merge: { strategy: "squash" } }).success).toBe(
      false,
    );
  });
});
