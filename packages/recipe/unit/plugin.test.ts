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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RuntimeId, STEPS } from "@lingtai/domain";
import {
  BUILT_IN_JUDGES,
  StepMap,
  PLUGINS,
  Recipe,
  agentPlugin,
  canonicalRecipe,
  definePlugin,
  disclose,
  discloseSteps,
  hashRecipe,
  judgePlugin,
  mergePlugin,
  noLog,
  pluginOf,
  queuePlugin,
  readFields,
  refsPlugin,
  runPlugin,
  whyNoKindAt,
  withheld,
  worktreePlugin,
  type GateAction,
} from "../src/index.ts";

/** The smallest recipe that resolves, so a case can put one action in it. */
const BASE: Recipe = Recipe.parse({
  version: 2,
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
  return { ...BASE, steps: { ...BASE.steps, proposed: [action] } };
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
    const refused = StepMap.safeParse({
      proposed: [{ name: "review", agent: "claude-code", prompt: "read the diff", env: ["OPENAI_API_KEY"] }],
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
    const taken = StepMap.safeParse({
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
    const none = StepMap.safeParse({ proposed: [{ name: "nothing" }] });
    expect(none.error!.issues[0]!.message).toContain('"nothing" action at the "proposed" step names no plugin');
    expect(none.error!.issues[0]!.message).toContain('"run", "agent", "watch", "human", "close", "labels"');

    const two = StepMap.safeParse({ proposed: [{ name: "both", run: "x", human: "ok?" }] });
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
    const refused = StepMap.safeParse({ prepared: [{ name: "review", agent: "x", env: ["A"] }] });

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
    const refused = StepMap.safeParse({
      proposed: [
        { name: "build", run: "pnpm verify", timeout: 15 },
        { name: "review", agent: "claude-code", prompt: "read it", env: ["A"] },
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
    const refused = StepMap.safeParse({
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

    expect(discloseSteps(recipe.steps).proposed).toEqual([build]);
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
    const resolved = StepMap.parse({
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

    const refused = StepMap.safeParse({
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

/**
 * **Which ticket is taken, and whether this machine may take it** (`#236`,
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §2 and §3;
 * `#244`, [0063](../../../doc/decisions/0063-every-setting-is-the-recipes.md) §3).
 *
 * **It was two plugins and it is one.** 0063 §3 makes `assignee` a *field* of
 * `queue:` rather than a plugin beside it, because the two answer one question
 * and `discover.ts` applies them in one pass over one GitHub response: two
 * plugins that must both be present and must agree is 0053's *one decision
 * across two sources*, one level down.
 *
 * Like `worktree:` and `merge:` above, it is a name for code that already
 * runs — `runnableNow`, `considerIssue` and `assigneeSkip` in
 * `packages/conductor/src/discover.ts`, and `claimWorkItem` in
 * `packages/conductor/src/claim.ts` — and it is not read from the recipe yet.
 * So what these cases hold is what makes declaring it now worth anything:
 *
 * - **It wraps rather than reimplements.** Three of `queue:`'s four fields
 *   *are* `source:`'s three — one declaration, `SOURCE_FIELDS` — and the
 *   fourth *is* `AssigneeRule`, refinement and all. A second copy of either
 *   would be two answers to one question while both shapes exist.
 * - **Refused at all ten steps, by a sentence that says where the code is** and
 *   how `claim` will reduce the list when it reads it. The first half is the
 *   same property `worktree:` and `merge:` have; the second is this plugin's
 *   own, and `packages/conductor/unit/gate-matrix.test.ts` is where it is
 *   pinned.
 */
describe("the one `claim` will hold", () => {
  it("is refused at every one of the ten steps, and names the file instead", () => {
    for (const step of STEPS) {
      expect(whyNoKindAt(step, "queue"), `${step} × queue is accepted`).not.toBeNull();
    }

    expect(whyNoKindAt("claim", "queue")).toContain("packages/conductor/src/discover.ts");
    expect(whyNoKindAt("claim", "queue")).toContain("source.kinds");
    // The fourth field's own half of the sentence, which used to be
    // `assignee:`'s own refusal and is now carried by this one.
    expect(whyNoKindAt("claim", "queue")).toContain("runtime.assignee");
    expect(whyNoKindAt("claim", "queue")).toContain("packages/conductor/src/claim.ts");
  });

  /**
   * **`assignee:` is not a plugin, and the closed set is what says so.** A name
   * the schema no longer knows must be refused as *an action naming no plugin*
   * rather than accepted into a cell nothing walks — which is the same rule,
   * read the other way, that put it in `PLUGINS` in the first place.
   */
  it("has no `assignee:` plugin left in the closed set", () => {
    expect(PLUGINS.map((plugin) => plugin.key)).not.toContain("assignee");
    expect(PLUGINS).toHaveLength(12);
    expect(pluginOf({ name: "whose", assignee: { take: "both" } })).toBeNull();
  });

  /**
   * **One declaration, read by two shapes.** `source:` is the v1 spelling of
   * three of these fields and `queue:` is the v2 one; while both exist, a
   * `kinds` the plugin required and `source:` did not would be two answers to
   * *what is a kind* — and the one list doing three jobs is the reason that
   * must not happen twice. Asserted by parsing the same input through both and
   * getting the same defaults, rather than by comparing schema objects.
   *
   * **And the fourth is absent from both when nothing writes it**, which is
   * what keeps `source:` from growing a `source.assignee` nothing reads.
   */
  it("gives `queue:` the same three fields `source:` has, defaults and all", () => {
    expect(queuePlugin.declares).toEqual(["name", "queue"]);

    const written = { kinds: ["bug", "feature"] };
    expect(queuePlugin.schema.parse({ name: "what to work on", queue: written })).toEqual({
      name: "what to work on",
      queue: Recipe.shape.source.parse(written),
    });
    expect(Object.keys(Recipe.shape.source.shape)).not.toContain("assignee");

    // And the same refusals: `backoff: 0` is the absence of the guard rather
    // than a shorter one, and `kinds: []` is a recipe that takes nothing.
    expect(queuePlugin.schema.safeParse({ name: "q", queue: { kinds: [] } }).success).toBe(false);
    expect(
      queuePlugin.schema.safeParse({ name: "q", queue: { kinds: ["bug"], backoff: "0s" } }).success,
    ).toBe(false);
  });

  /**
   * Nothing here spawns a process — the queue runs in the conductor's own — so
   * `env:` is refused by name, which is the case 0061 §9 is written about.
   */
  it("declares no `env:`, and says what it does declare", () => {
    const problems = readFields(queuePlugin, {
      name: "take work",
      queue: { kinds: ["bug"] },
      env: ["GITHUB_TOKEN"],
    }).problems!;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("env");
    expect(problems[0]!.why).toContain(`"queue" declares no "env" field`);
  });

  /**
   * **`AssigneeRule` itself, so its one refinement is not a second refusal.**
   * `take: mine` with nobody named matches no issue at all, and an empty queue
   * reads exactly like a repository with nothing to do (0046 §2) — so the
   * schema refuses it, and it must go on refusing it from inside `queue:`
   * (0063 §3). By name, and on the field that has to change: the message names
   * `login`, so a person reading it is told what to add rather than what to
   * remove.
   */
  it("keeps the rule that `assignee: { take: mine }` needs a login", () => {
    const q = { kinds: ["bug"] };
    expect(
      queuePlugin.schema.parse({ name: "q", queue: { ...q, assignee: {} } }),
    ).toMatchObject({ queue: { assignee: { take: "both" } } });

    const refused = queuePlugin.schema.safeParse({
      name: "q",
      queue: { ...q, assignee: { take: "mine" } },
    });
    expect(refused.success).toBe(false);
    expect(refused.error!.issues[0]!.message).toContain("take: mine needs a login");
    expect(refused.error!.issues[0]!.path).toEqual(["queue", "assignee", "login"]);

    expect(
      queuePlugin.schema.parse({
        name: "q",
        queue: { ...q, assignee: { take: "mine", login: "steven-zhc" } },
      }),
    ).toMatchObject({ queue: { assignee: { take: "mine", login: "steven-zhc" } } });

    // And the enum: a fourth `take` is refused rather than dropped.
    expect(
      queuePlugin.schema.safeParse({ name: "q", queue: { ...q, assignee: { take: "everyone" } } })
        .success,
    ).toBe(false);
  });
});

/**
 * **The one `proposed` will hold, and the only one of the five with design
 * content** (`#238`, [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * `judge:` is a name for `buyRound`'s decision at `run-once.ts:1761`, and like
 * the four above it is read by no step yet. What is different is that two
 * rules have to hold before it can ever be read, and both are in the schema
 * rather than in prose — the other half of each, the set a judge is handed and
 * the refusal of an answer outside it, is
 * `packages/conductor/unit/judge.test.ts`.
 */
describe("the one `proposed` will hold", () => {
  /**
   * **And the one `proposed` will hold** (`#238`,
   * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §3).
   *
   * `judge:` is a name for `buyRound`'s decision at `run-once.ts:1761` and is
   * read by no step either, but it is the one of the five with design content:
   * two rules make a replaceable judge safe, and both are in the schema rather
   * than in prose.
   *
   * **One entry per `when:`** — required and undefaulted, so no entry can
   * answer for all five directions. One judge for all of them pays an agent
   * sixty times to reach a mechanical conclusion, and makes anyone replacing it
   * reimplement the mechanical branches correctly or the loop never terminates.
   *
   * **And it carries no ceiling**, which is the half that costs money if it is
   * got wrong: a judge that could carry its own `rounds` could answer *back to
   * `implement`* for ever at ~$3.40 a round with nothing reporting a fault. The
   * bounds stay the workflow's — `packages/conductor/unit/judge.test.ts` is
   * where the other side of that is held.
   */
  it("makes `judge:` one entry per `when:`, with no ceiling of its own", () => {
    expect(judgePlugin.declares).toEqual(["name", "judge", "when"]);

    expect(
      judgePlugin.schema.parse({ name: "the approach", judge: "claude-code", when: "findings" }),
    ).toEqual({ name: "the approach", judge: "claude-code", when: "findings" });

    // No default: a judge that said nothing about which direction it answers
    // would be the one judge for all five this split exists to prevent.
    expect(judgePlugin.schema.safeParse({ name: "any", judge: "claude-code" }).success).toBe(false);
    // And `when:`'s vocabulary is this step's, not `end`'s: a `landed` judge is
    // an outcome where a reason belongs (0061 §3).
    expect(judgePlugin.schema.safeParse({ name: "any", judge: "claude-code", when: "landed" }).success).toBe(
      false,
    );

    for (const ceiling of ["rounds", "restarts"] as const) {
      const problems = readFields(judgePlugin, {
        name: "the approach",
        judge: "claude-code",
        when: "findings",
        [ceiling]: 9,
      }).problems!;
      expect(problems).toHaveLength(1);
      expect(problems[0]!.field).toBe(ceiling);
      expect(problems[0]!.why).toContain(`"judge" declares no "${ceiling}" field`);
      expect(problems[0]!.why).toContain('"name", "judge", "when"');
    }
  });

  /**
   * **A judge the schema accepts is a judge something answers.** The built-ins
   * are `BUILT_IN` in `packages/conductor/src/judge.ts`, a total record over
   * this list, so the two lists cannot come apart; an agent judge is a runtime
   * and nothing else. 0061 §3's example yaml also names `ask-or-assume`, and it
   * is in neither list because nothing implements it — a name the schema takes
   * and no code answers is `#61` arriving through the door a replaceable plugin
   * opens.
   */
  it("accepts the built-ins that exist and the runtimes, and no invented name", () => {
    expect(BUILT_IN_JUDGES).toEqual(["same-worktree"]);
    for (const name of [...BUILT_IN_JUDGES, ...RuntimeId.options]) {
      expect(
        judgePlugin.schema.safeParse({ name: "j", judge: name, when: "red" }).success,
        name,
      ).toBe(true);
    }
    expect(judgePlugin.schema.safeParse({ name: "j", judge: "ask-or-assume", when: "needs-input" }).success).toBe(
      false,
    );
  });
});

/**
 * **This file's own header, counted rather than remembered** (`#238`).
 *
 * The decision *not* to hoist `when:` and `timeout:` as 0061 §2's universal
 * keys is sized in prose from how many plugins carry one today — and `judge:`
 * made that number false the day it declared a `when:`, with nothing going
 * red. A ticket reading that sentence budgets the hoist from a set one plugin
 * short, writes `when: WHEN.default("any")` onto every plugin, and silently
 * replaces `judge:`'s vocabulary — `JudgeWhen` is the reason the last step
 * gave, and `WHEN` is the work item's outcome — which is the one mistake the
 * sentence exists to stop somebody making.
 *
 * So the numerals come off `PLUGINS`, and the whitespace is normalised first
 * so that re-wrapping the comment is not a failure.
 */
/**
 * **The one that deletes** (`#240`).
 *
 * `refs:` is unlike every plugin declared before it in two ways worth holding
 * with cases. It is the first that is not one of 0061 §3's names for code the
 * pass already runs — it does something nothing did — and it is the first whose
 * effect cannot be undone by running the pass again: a deleted ref is gone.
 *
 * So the schema carries the safety rather than the operator. `when:` is a
 * `z.literal("landed")`, not `WHEN`, because for an item that did **not** land
 * the `agent/<n>-attempt-<k>` refs are the only surviving account of what was
 * tried — `#239` creates them precisely so a later attempt can fetch them, and
 * a cleanup on any other ending destroys the thing that ticket was written to
 * preserve. A value nobody can write is a mistake nobody can make, and the
 * refusal arrives when the recipe resolves rather than after the delete.
 */
describe("the one that deletes", () => {
  it("is refused at all nine steps that are not `end`", () => {
    for (const step of STEPS) {
      if (step === "end") {
        expect(whyNoKindAt(step, "refs")).toBeNull();
        continue;
      }
      expect(whyNoKindAt(step, "refs"), `${step} × refs is accepted`).not.toBeNull();
    }
    expect(whyNoKindAt("proposed", "refs")).toContain("only the `end` point carries out effects");
  });

  /**
   * **This is the case that earns the plugin.** The other two effects take
   * `WHEN` and there is nothing wrong with `labels: … when: any`; here the same
   * word is the difference between tidying up after a landing and destroying an
   * abandoned attempt's only record.
   */
  it("takes `when: landed` and refuses every other ending, by name, at resolve", () => {
    const at = (when: string) =>
      StepMap.safeParse({ end: [{ name: "sweep", refs: true, when }] });

    expect(at("landed").success).toBe(true);
    for (const when of ["any", "blocked", "failed", "closed"]) {
      const refused = at(when);
      expect(refused.success, `"when: ${when}" resolved`).toBe(false);
      const message = refused.error!.issues[0]!.message;
      expect(message).toContain('"sweep"');
      expect(message).toContain('"refs"');
      expect(message).toContain('"end"');
      expect(message).toContain('"when"');
    }
  });

  /**
   * Absent means `landed` too, so a file that leaves the key out gets the safe
   * reading rather than the widest one — and `branch:` is **off**: after a
   * merge `agent/<n>`'s commits are reachable from `main`, but it is the ref a
   * person follows from the merge commit, so a cleanup keeps it unless asked.
   */
  it("keeps `agent/<n>` unless the recipe asks for it, and defaults to the landing", () => {
    expect(refsPlugin.schema.parse({ name: "sweep", refs: true })).toEqual({
      name: "sweep",
      refs: true,
      branch: false,
      when: "landed",
    });
    expect(refsPlugin.schema.parse({ name: "sweep", refs: true, branch: true })).toMatchObject({
      branch: true,
    });
  });

  /** A plugin refuses a field it does not understand, this one included (0061 §9). */
  it("declares four fields and refuses a fifth", () => {
    expect(refsPlugin.declares).toEqual(["name", "refs", "branch", "when"]);
    const problems = readFields(refsPlugin, { name: "sweep", refs: true, older_than: "30d" })
      .problems!;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("older_than");
    expect(problems[0]!.why).toContain('"refs" declares no "older_than" field');
  });
});

describe("plugin.ts's own count of who carries a universal key", () => {
  const NUMERAL = [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ] as const;
  const carrying = (field: string) =>
    PLUGINS.filter((plugin) => plugin.declares.includes(field)).length;

  it("says how many plugins carry `when:` and `timeout:`, and how many a hoist would reach", () => {
    const prose = readFileSync(new URL("../src/plugin.ts", import.meta.url), "utf8")
      .replace(/\n\s*\*/g, " ")
      .replace(/\s+/g, " ");
    expect(
      prose,
      "plugin.ts's header disagrees with PLUGINS about who carries `when:` or `timeout:`",
    ).toContain(
      `\`when:\` is legal on ${NUMERAL[carrying("when")]} plugins and \`timeout:\` on ` +
        `${NUMERAL[carrying("timeout")]}`,
    );
    expect(
      prose,
      "plugin.ts's header disagrees with PLUGINS about how many plugins a hoist would reach",
    ).toContain(`hoisting either would make it legal on all ${NUMERAL[PLUGINS.length]}`);
  });

  /**
   * **And the two numerals that size the `no_log` claim**, which is the one
   * that goes quietly wrong: *every field the N plugins have is a name, a
   * command …* is an audit a reader can perform, and performing it over six of
   * eleven answers a question nobody asked. The plugins arrived four and five
   * at a time (`#235`, `#236`, `#238`) and not one of those tickets was about
   * `no_log`, so nothing in the diff that made the sentence false was anywhere
   * near it.
   *
   * The claim's other half is `secrets`, and that one is asserted rather than
   * counted — a plugin that declared a `noLog` field would make *nothing
   * declares one today* false whatever the numeral says.
   */
  it("says how many plugins the closed set and the `no_log` claim are about", () => {
    const prose = readFileSync(new URL("../src/plugin.ts", import.meta.url), "utf8")
      .replace(/\n\s*\*/g, " ")
      .replace(/\s+/g, " ");
    for (const sentence of [
      `beside the ${NUMERAL[PLUGINS.length]} declarations`,
      `every field the ${NUMERAL[PLUGINS.length]} plugins have`,
    ]) {
      expect(prose, "plugin.ts's header disagrees with PLUGINS about the size of the set").toContain(
        sentence,
      );
    }
    expect(
      PLUGINS.filter((plugin) => plugin.secrets.length > 0),
      "a plugin declares a no_log field, and plugin.ts's header says nothing does",
    ).toEqual([]);
  });
});
