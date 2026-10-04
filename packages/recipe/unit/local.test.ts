/**
 * The recipe from this machine (0046 §3, #180). No filesystem: the reader is
 * a map from path to text, and the home is a name.
 */
import { describe, expect, it } from "vitest";
import {
  AgentUnresolvedError,
  LIMIT_DEFAULTS,
  MachineConfigInvalidError,
  RecipeInvalidError,
  RecipeMissingError,
  machineFiles,
  machinePath,
  recipePath,
  resolveLocalRecipe,
  resolveSource,
} from "../src/index.ts";

const HOME = "/home/me/.lingtai";

const RECIPE = `
version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`;

const files =
  (entries: Record<string, string>) =>
  async (path: string): Promise<string | null> =>
    entries[path] ?? null;

const signed = (...ids: ("claude-code" | "codex")[]) => async () => ids;

const withMachine = (machine: string | undefined, signedIn = signed("claude-code")) => ({
  home: HOME,
  signedIn,
  read: files({
    [recipePath("app", HOME)]: RECIPE,
    ...(machine === undefined ? {} : { [machinePath(HOME)]: machine }),
  }),
});

describe("resolveLocalRecipe", () => {
  it("reads ~/.lingtai/<project>/recipe.yml, with no request", async () => {
    const resolved = await resolveLocalRecipe("app", withMachine(undefined));
    expect(recipePath("app", HOME)).toBe(`${HOME}/app/recipe.yml`);
    expect(resolved.recipe.steps.proposed.map((a) => a.name)).toEqual(["build"]);
    expect(resolved.ref).toBe("main");
    expect(resolved.provenance?.["steps"]).toBe(
      `claim 0, admit 0, prepared 0, design 0, implement 0, build 0, review 0, proposed 1, merge 0, end 0 ← ${HOME}/app/recipe.yml`,
    );
    expect(resolved.provenance?.["repo.base"]).toBe(`main ← ${HOME}/app/recipe.yml`);
  });

  /**
   * **A schema default is not this file, and provenance may not say it is.**
   * `source.backoff` and every number in `runtime.budget` have one, so the
   * resolved recipe reads `1h` and `attempts 5` whether the file mentions them
   * or not — while the `←` half is read as *where to look*, by `lingtai
   * doctor` and by the board's recipe page (#218). A reader sent to
   * `recipe.yml` for a `budget:` block that is not in it concludes the tool is
   * reading some other file.
   */
  it("names a default as a default, and this file only for what this file carries", async () => {
    const silent = await resolveLocalRecipe("app", withMachine(undefined));
    expect(silent.provenance?.["source.backoff"]).toBe("1h ← default");
    expect(silent.provenance?.["runtime.budget.attempts"]).toBe("5 ← default");
    // `discuss:` is a recipe that names no discussion — the row exists and
    // says `default`, not nothing (#243).
    expect(silent.provenance?.["discuss.agent"]).toBe("claude-code ← default");
    expect(silent.provenance?.["discuss.limits.turns"]).toBe("40 ← default");

    const spoken = await resolveLocalRecipe("app", {
      home: HOME,
      signedIn: signed("claude-code"),
      read: files({
        [recipePath("app", HOME)]: `${RECIPE.replace("  kinds: [bug]", "  kinds: [bug]\n  backoff: 30m")}
runtime:
  budget: { attempts: 9 }
discuss:
  limits: { turns: 7 }
`,
      }),
    });
    expect(spoken.provenance?.["source.backoff"]).toBe(`30m ← ${HOME}/app/recipe.yml`);
    // Per field, as `runtime.limits` is: the three numbers beside `attempts`
    // are still the schema's, and saying otherwise is the same falsehood.
    expect(spoken.provenance?.["runtime.budget.attempts"]).toBe(`9 ← ${HOME}/app/recipe.yml`);
    expect(spoken.provenance?.["runtime.budget.diff"]).toBe("400000 ← default");
    // Same rule for `discuss.limits`: a file that names `turns` only is silent
    // about `wall`, and provenance may not say otherwise.
    expect(spoken.provenance?.["discuss.limits.turns"]).toBe(`7 ← ${HOME}/app/recipe.yml`);
    expect(spoken.provenance?.["discuss.limits.wall"]).toBe("5m ← default");
  });

  /**
   * **And the same is true of every other key with a default**, which is three
   * more: `source.exclude`, `env.required` and `gates`. The last is the one
   * that matters — it is what holds a run — and it is also the only key here
   * with a *third* origin, because `extends:` is a line about gates that never
   * names one. A reader asking where the `proposed: build` gate came from
   * opens `recipe.yml`, finds no `gates:` block, and has nowhere else to look
   * unless provenance says the preset (#218).
   */
  it("names the preset for what the preset decided, and never this file", async () => {
    const bare = `
version: 2
repo: { base: main }
source: { kinds: [bug] }
env: { plantAt: .env.local }
`;
    const read = (recipe: string) => ({
      home: HOME,
      signedIn: signed("claude-code"),
      read: files({ [recipePath("app", HOME)]: recipe }),
    });

    const extended = await resolveLocalRecipe("app", read(`${bare}extends: pnpm-workspace\n`));
    expect(extended.provenance?.["steps"]).toBe(
      "claim 0, admit 0, prepared 1, design 0, implement 0, build 0, review 0, proposed 1, merge 0, end 0 ← preset pnpm-workspace",
    );
    // The preset has no `source` and no `env`, so these two are the schema's
    // in both recipes — naming a file for either sends a reader to open it.
    expect(extended.provenance?.["source.exclude"]).toBe("(none) ← default");
    expect(extended.provenance?.["env.required"]).toBe("(none) ← default");

    // Without one, ten empty steps nobody wrote down — a default, and this
    // file is the one place the answer is not.
    const alone = await resolveLocalRecipe("app", read(bare));
    expect(alone.provenance?.["steps"]).toBe("claim 0, admit 0, prepared 0, design 0, implement 0, build 0, review 0, proposed 0, merge 0, end 0 ← default");

    // **And a `gates:` with its block commented out is this file saying
    // nothing**, which is what `applyPreset`'s `??` makes of it: `null ??
    // preset.gates` is the preset's, so the run gets `proposed: build` and a
    // reader who commented the block out and is asking why must be sent to the
    // preset. A key present and empty used to read as a key this file carried.
    const emptied = await resolveLocalRecipe("app", read(`${bare}extends: pnpm-workspace\nsteps:\n`));
    expect(emptied.recipe.steps.proposed).toHaveLength(1);
    expect(emptied.provenance?.["steps"]).toBe(
      "claim 0, admit 0, prepared 1, design 0, implement 0, build 0, review 0, proposed 1, merge 0, end 0 ← preset pnpm-workspace",
    );

    // And a file that carries them says so, in all three.
    const own = await resolveLocalRecipe(
      "app",
      read(`
version: 2
extends: pnpm-workspace
repo: { base: main }
source: { kinds: [bug], exclude: [blocked] }
env: { plantAt: .env.local, required: [DATABASE_URL] }
steps:
  proposed:
    - { name: build, run: pnpm test }
`),
    );
    const file = `${HOME}/app/recipe.yml`;
    // The file's gates replace the preset's whole, which is `applyPreset`'s
    // rule — so the one line names the file and not both.
    expect(own.provenance?.["steps"]).toBe(`claim 0, admit 0, prepared 0, design 0, implement 0, build 0, review 0, proposed 1, merge 0, end 0 ← ${file}`);
    expect(own.provenance?.["source.exclude"]).toBe(`blocked ← ${file}`);
    expect(own.provenance?.["env.required"]).toBe(`DATABASE_URL ← ${file}`);
  });

  it("refuses a missing recipe by its path", async () => {
    const options = { home: HOME, signedIn: signed("claude-code"), read: files({}) };
    await expect(resolveLocalRecipe("app", options)).rejects.toThrow(RecipeMissingError);
    await expect(resolveLocalRecipe("app", options)).rejects.toThrow(`${HOME}/app/recipe.yml`);
  });

  describe("runtime.agent", () => {
    it("is the one the file names, even with two signed in", async () => {
      const resolved = await resolveLocalRecipe(
        "app",
        withMachine("runtime:\n  agent: codex\n", signed("claude-code", "codex")),
      );
      expect(resolved.recipe.runtime.agent).toBe("codex");
      expect(resolved.provenance?.["runtime.agent"]).toBe(`codex ← ${HOME}/config.yml`);
    });

    it("is the project's over the machine's", async () => {
      const resolved = await resolveLocalRecipe(
        "app",
        withMachine("runtime:\n  agent: claude-code\nprojects:\n  app:\n    runtime:\n      agent: codex\n"),
      );
      expect(resolved.recipe.runtime.agent).toBe("codex");
      expect(resolved.provenance?.["runtime.agent"]).toContain("projects.app");
    });

    it("is the only one signed in, when nothing names one — and says it was detected", async () => {
      const resolved = await resolveLocalRecipe("app", withMachine(undefined, signed("codex")));
      expect(resolved.recipe.runtime.agent).toBe("codex");
      expect(resolved.provenance?.["runtime.agent"]).toContain("detected");
    });

    it("is asked for, never picked, when more than one is signed in", async () => {
      const resolving = resolveLocalRecipe("app", withMachine(undefined, signed("claude-code", "codex")));
      await expect(resolving).rejects.toThrow(AgentUnresolvedError);
      await expect(
        resolveLocalRecipe("app", withMachine(undefined, signed("claude-code", "codex"))),
      ).rejects.toThrow(/claude-code and codex are all signed in.*which one should run/);
    });

    it("refuses by name when none is signed in", async () => {
      await expect(resolveLocalRecipe("app", withMachine(undefined, signed()))).rejects.toThrow(
        /no agent runtime is signed in/,
      );
    });

    it("does not ask what is signed in when a file names one", async () => {
      let asked = false;
      await resolveLocalRecipe(
        "app",
        withMachine("runtime:\n  agent: claude-code\n", async () => {
          asked = true;
          return [];
        }),
      );
      expect(asked).toBe(false);
    });
  });

  describe("runtime.limits", () => {
    it("comes from the machine, key by key, and each says where from", async () => {
      const resolved = await resolveLocalRecipe(
        "app",
        withMachine("runtime:\n  limits:\n    rounds: 3\nprojects:\n  app:\n    runtime:\n      limits:\n        wall: 1h\n"),
      );
      expect(resolved.recipe.runtime.limits).toEqual({ ...LIMIT_DEFAULTS, rounds: 3, wall: "1h" });
      expect(resolved.provenance?.["runtime.limits.rounds"]).toBe(`3 ← ${HOME}/config.yml`);
      expect(resolved.provenance?.["runtime.limits.wall"]).toContain("projects.app");
      expect(resolved.provenance?.["runtime.limits.turns"]).toBe(`${LIMIT_DEFAULTS.turns} ← default`);
    });

    it("changes the hash, because a run under other limits is another run", async () => {
      const a = await resolveLocalRecipe("app", withMachine(undefined));
      const b = await resolveLocalRecipe("app", withMachine("runtime:\n  limits:\n    turns: 10\n"));
      expect(a.configHash).not.toBe(b.configHash);
    });

    /**
     * **`wall` is a duration, and this file is the one that has to say so.**
     * `wall: "90"` — the unit forgotten — used to resolve: nothing rejected it
     * here, and `parseDuration` threw later, out of whatever was reading the
     * resolved recipe. The board's recipe page caught that throw beside the
     * resolve's own and read it as *the recipe could not be read*, naming
     * `~/.lingtai/app/recipe.yml` — a file that may not carry `runtime.limits`
     * at all, so its reader opened it twice and found nothing (#218).
     */
    it("refuses a wall that is not a duration, by its key and in this file", async () => {
      const resolving = resolveLocalRecipe("app", withMachine('runtime:\n  limits: { wall: "90" }\n'));
      await expect(resolving).rejects.toThrow(MachineConfigInvalidError);
      await expect(
        resolveLocalRecipe("app", withMachine('runtime:\n  limits: { wall: "90" }\n')),
      ).rejects.toThrow(`${HOME}/config.yml is not valid`);
      await expect(
        resolveLocalRecipe("app", withMachine('runtime:\n  limits: { wall: "90" }\n')),
      ).rejects.toThrow(/runtime\.limits\.wall: must be a positive duration/);
      // And under a project's section, which is the other half of the same key.
      await expect(
        resolveLocalRecipe(
          "app",
          withMachine('projects:\n  app:\n    runtime:\n      limits: { wall: "90" }\n'),
        ),
      ).rejects.toThrow(/projects\.app\.runtime\.limits\.wall: must be a positive duration/);
    });
  });

  /** Whose tickets this project takes (0046 §2, #181) — the recipe's since `#373`. */
  describe("runtime.assignee", () => {
    it("is absent when neither file says anything — `both`, and the hash is unchanged", async () => {
      const resolved = await resolveLocalRecipe("app", withMachine(undefined));
      expect(resolved.recipe.runtime).not.toHaveProperty("assignee");
      expect(resolved.provenance?.["runtime.assignee.take"]).toBe("both ← default");
      expect(resolved.provenance?.["runtime.assignee.login"]).toBe("(none) ← default");

      // Built by hand with the same `agent`/`limits` merge and no `assignee`
      // key at all — `.optional()`, never `.default({})` (0104 §6). A resolve
      // that started writing the key in, even an empty one, would hash
      // differently from this.
      const byHand = resolveSource(RECIPE, "main", recipePath("app", HOME), (raw) => {
        raw["runtime"] = { agent: "claude-code", limits: { ...LIMIT_DEFAULTS } };
        return [];
      });
      expect(resolved.configHash).toBe(byHand.configHash);
    });

    it("takes the recipe's v1 spelling, both halves named back to the recipe", async () => {
      const read = files({
        [recipePath("app", HOME)]: `${RECIPE}runtime:\n  assignee:\n    login: alice\n    take: mine\n`,
      });
      const resolved = await resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read });
      expect(resolved.recipe.runtime.assignee).toEqual({ login: "alice", take: "mine" });
      expect(resolved.provenance?.["runtime.assignee.login"]).toBe(`alice ← ${recipePath("app", HOME)}`);
      expect(resolved.provenance?.["runtime.assignee.take"]).toBe(`mine ← ${recipePath("app", HOME)}`);
    });

    it("defaults `take` to both when only a login is named", async () => {
      const read = files({
        [recipePath("app", HOME)]: `${RECIPE}runtime:\n  assignee:\n    login: alice\n`,
      });
      const resolved = await resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read });
      expect(resolved.recipe.runtime.assignee).toEqual({ login: "alice", take: "both" });
      expect(resolved.provenance?.["runtime.assignee.take"]).toBe("both ← default");
      expect(resolved.provenance?.["runtime.assignee.login"]).toBe(`alice ← ${recipePath("app", HOME)}`);
    });

    it("refuses `mine` with no login, naming the recipe's path and not the machine file's", async () => {
      const read = files({
        [recipePath("app", HOME)]: `${RECIPE}runtime:\n  assignee:\n    take: mine\n`,
      });
      try {
        await resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(RecipeInvalidError);
        expect(String(err)).toContain(recipePath("app", HOME));
        expect(String(err)).toMatch(/runtime\.assignee\.login: take: mine needs a login/);
        expect(String(err)).not.toContain("config.yml");
      }
    });

    it("a `claim` `queue:` is the source for both halves, over the v1 spelling", async () => {
      const withClaim = RECIPE.replace(
        "steps:\n  proposed:",
        "steps:\n  claim:\n    - name: pick\n      queue:\n        kinds: [bug]\n        exclude: []\n        backoff: 1h\n        assignee:\n          take: unassigned\n  proposed:",
      );
      const read = files({ [recipePath("app", HOME)]: withClaim });
      const resolved = await resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read });
      expect(resolved.provenance?.["runtime.assignee.take"]).toBe(`unassigned ← ${recipePath("app", HOME)}`);
      expect(resolved.provenance?.["runtime.assignee.login"]).toBe(`(none) ← ${recipePath("app", HOME)}`);
    });

    it("is refused in the machine file by name, machine-wide and per project", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("runtime:\n  assignee:\n    take: both\n")),
      ).rejects.toThrow(
        new RegExp(`runtime\\.assignee: whose tickets this project takes.*${recipePath("app", HOME)}`),
      );
      await expect(
        resolveLocalRecipe("app", withMachine("projects:\n  app:\n    runtime:\n      assignee:\n        take: mine\n")),
      ).rejects.toThrow(
        new RegExp(`projects\\.app\\.runtime\\.assignee: whose tickets this project takes.*${recipePath("app", HOME)}`),
      );
    });
  });

  /** The page edits the agent and limits; an assignee is never theirs to move (#181, #373). */
  describe("machineFiles and runtime.assignee", () => {
    const parsed = async (machine: string | undefined) =>
      (await resolveLocalRecipe("app", withMachine(machine))).recipe;

    it("leaves one written in the recipe text in the recipe, and it never reaches the machine file", async () => {
      const recipe = await parsed(undefined);
      const split = machineFiles({
        file: `${RECIPE}runtime:\n  assignee:\n    take: unassigned\n`,
        recipe,
        project: "app",
        machine: null,
        home: HOME,
      });
      if (!split.ok || split.machine === null) throw new Error("expected a machine file");
      expect(split.recipe).toContain("assignee:");
      expect(split.recipe).toContain("take: unassigned");
      expect(split.machine).not.toContain("assignee");
    });

    it("does not add one to a machine file being edited, even when the recipe has one", async () => {
      const recipe = await parsed(undefined);
      const machine = "projects:\n  app:\n    runtime:\n      agent: claude-code\n      limits: {}\n";
      const split = machineFiles({
        file: `${RECIPE}runtime:\n  assignee:\n    login: alice\n    take: mine\n`,
        recipe,
        project: "app",
        machine,
        home: HOME,
        replace: true,
      });
      if (!split.ok) throw new Error("expected ok");
      expect(split.recipe).toContain("assignee:");
      expect(split.machine ?? "").not.toContain("assignee");
    });
  });

  describe("what belongs in the other file is refused, not dropped", () => {
    it("a steps key in the machine file is a parse error that says where a pass is configured", async () => {
      const resolving = resolveLocalRecipe("app", withMachine("steps:\n  proposed: []\n"));
      await expect(resolving).rejects.toThrow(MachineConfigInvalidError);
      await expect(resolveLocalRecipe("app", withMachine("steps:\n  merge: []\n"))).rejects.toThrow(
        `it is configured in the recipe, ${HOME}/app/recipe.yml`,
      );
    });

    it("so is one under a project's section", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("projects:\n  app:\n    steps:\n      merge: []\n")),
      ).rejects.toThrow(/projects\.app\.steps: a pass is not configured in the machine file/);
    });

    /**
     * **The pre-0061 spelling is refused by the schema now, not by name**
     * (`#247`). It was named here beside `steps:`, for somebody copying an
     * older block across — and it is one of the four retired words, so it could
     * not stay in `src/` and leave `doc/reference.md`'s allowlist empty.
     *
     * What it cost is the sentence and not the refusal: `projects.<name>` is a
     * `strictObject`, so an unknown key under a project is still refused by its
     * own name. At the top level the machine file is open by design — a section
     * some other reader owns is not this reader's to refuse — so a `gates:`
     * there is now ignored like any other stranger's block, which is the one
     * thing this change gave up.
     */
    it("names an unknown key under a project's section, whatever it is called", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("projects:\n  app:\n    gates:\n      merge: []\n")),
      ).rejects.toThrow(/gates/);
    });

    it("and anything else the machine's runtime does not own", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("runtime:\n  tier: guarded\n")),
      ).rejects.toThrow(MachineConfigInvalidError);
    });

    it("runtime.agent or runtime.limits in the recipe names the machine file", async () => {
      const read = files({
        [recipePath("app", HOME)]: `${RECIPE}runtime:\n  agent: claude-code\n  limits:\n    turns: 5\n`,
      });
      const resolving = resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read });
      await expect(resolving).rejects.toThrow(RecipeInvalidError);
      await expect(
        resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read }),
      ).rejects.toThrow(/runtime\.limits: moved to this machine.*config\.yml/);
    });
  });
});
