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
} from "../src/index.ts";

const HOME = "/home/me/.lingtai";

const RECIPE = `
version: 1
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
gates:
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
    expect(resolved.recipe.gates.proposed.map((a) => a.name)).toEqual(["build"]);
    expect(resolved.ref).toBe("main");
    expect(resolved.provenance?.["gates"]).toBe(
      `admit 0, prepared 0, proposed 1, merge 0, end 0 ← ${HOME}/app/recipe.yml`,
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

    const spoken = await resolveLocalRecipe("app", {
      home: HOME,
      signedIn: signed("claude-code"),
      read: files({
        [recipePath("app", HOME)]: `${RECIPE.replace("  kinds: [bug]", "  kinds: [bug]\n  backoff: 30m")}
runtime:
  budget: { attempts: 9 }
`,
      }),
    });
    expect(spoken.provenance?.["source.backoff"]).toBe(`30m ← ${HOME}/app/recipe.yml`);
    // Per field, as `runtime.limits` is: the three numbers beside `attempts`
    // are still the schema's, and saying otherwise is the same falsehood.
    expect(spoken.provenance?.["runtime.budget.attempts"]).toBe(`9 ← ${HOME}/app/recipe.yml`);
    expect(spoken.provenance?.["runtime.budget.diff"]).toBe("400000 ← default");
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
version: 1
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
    expect(extended.provenance?.["gates"]).toBe(
      "admit 0, prepared 1, proposed 1, merge 0, end 0 ← preset pnpm-workspace",
    );
    // The preset has no `source` and no `env`, so these two are the schema's
    // in both recipes — naming a file for either sends a reader to open it.
    expect(extended.provenance?.["source.exclude"]).toBe("(none) ← default");
    expect(extended.provenance?.["env.required"]).toBe("(none) ← default");

    // Without one, five empty points nobody wrote down — a default, and this
    // file is the one place the answer is not.
    const alone = await resolveLocalRecipe("app", read(bare));
    expect(alone.provenance?.["gates"]).toBe("admit 0, prepared 0, proposed 0, merge 0, end 0 ← default");

    // And a file that carries them says so, in all three.
    const own = await resolveLocalRecipe(
      "app",
      read(`
version: 1
extends: pnpm-workspace
repo: { base: main }
source: { kinds: [bug], exclude: [blocked] }
env: { plantAt: .env.local, required: [DATABASE_URL] }
gates:
  proposed:
    - { name: build, run: pnpm test }
`),
    );
    const file = `${HOME}/app/recipe.yml`;
    // The file's gates replace the preset's whole, which is `applyPreset`'s
    // rule — so the one line names the file and not both.
    expect(own.provenance?.["gates"]).toBe(`admit 0, prepared 0, proposed 1, merge 0, end 0 ← ${file}`);
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
  });

  /** Whose tickets this machine takes (0046 §2, #181). */
  describe("runtime.assignee", () => {
    it("is absent when the machine says nothing — `both`, and the hash is unchanged", async () => {
      const resolved = await resolveLocalRecipe("app", withMachine(undefined));
      expect(resolved.recipe.runtime.assignee).toBeUndefined();
      expect(resolved.provenance?.["runtime.assignee.take"]).toBe("both ← default");
    });

    it("takes the login machine-wide and `take` per project", async () => {
      const resolved = await resolveLocalRecipe(
        "app",
        withMachine("runtime:\n  assignee:\n    login: alice\nprojects:\n  app:\n    runtime:\n      assignee:\n        take: mine\n"),
      );
      expect(resolved.recipe.runtime.assignee).toEqual({ login: "alice", take: "mine" });
      expect(resolved.provenance?.["runtime.assignee.login"]).toBe(`alice ← ${HOME}/config.yml`);
      expect(resolved.provenance?.["runtime.assignee.take"]).toContain("projects.app");
    });

    it("defaults `take` to both when only a login is named", async () => {
      const resolved = await resolveLocalRecipe("app", withMachine("runtime:\n  assignee:\n    login: alice\n"));
      expect(resolved.recipe.runtime.assignee).toEqual({ login: "alice", take: "both" });
    });

    it("refuses `mine` with no login, rather than taking nothing and saying nothing", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("runtime:\n  assignee:\n    take: mine\n")),
      ).rejects.toThrow(/runtime\.assignee\.login: take: mine needs a login/);
    });

    it("refuses a value that is not one of the three", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("runtime:\n  assignee:\n    take: everyone\n")),
      ).rejects.toThrow(MachineConfigInvalidError);
    });

    it("is the machine's: written in the recipe it is refused, naming the machine file", async () => {
      const read = files({
        [recipePath("app", HOME)]: `${RECIPE}runtime:\n  assignee:\n    take: both\n`,
      });
      await expect(
        resolveLocalRecipe("app", { home: HOME, signedIn: signed("claude-code"), read }),
      ).rejects.toThrow(/runtime\.assignee: moved to this machine.*config\.yml/);
    });
  });

  /** The page edits the agent and limits; the assignee it does not show is kept (#181). */
  describe("machineFiles and runtime.assignee", () => {
    const parsed = async (machine: string) => (await resolveLocalRecipe("app", withMachine(machine))).recipe;

    it("keeps the project's assignee when an edit replaces the section", async () => {
      const before =
        "projects:\n  app:\n    runtime:\n      agent: claude-code\n      assignee:\n        login: bob\n        take: mine\n";
      const current = await parsed(before);
      const edited = { ...current, runtime: { ...current.runtime, limits: { ...current.runtime.limits, rounds: 3 } } };
      const split = machineFiles({ file: RECIPE, recipe: edited, project: "app", machine: before, home: HOME, replace: true });
      if (!split.ok || split.machine === null) throw new Error("expected a machine file");
      const after = await parsed(split.machine);
      expect(after.runtime.limits.rounds).toBe(3);
      expect(after.runtime.assignee).toEqual({ login: "bob", take: "mine" });
    });

    it("does not copy a machine-wide login into the project's section", async () => {
      const before =
        "runtime:\n  assignee:\n    login: bob\nprojects:\n  app:\n    runtime:\n      agent: claude-code\n      assignee:\n        take: mine\n";
      const current = await parsed(before);
      const edited = { ...current, runtime: { ...current.runtime, limits: { ...current.runtime.limits, rounds: 3 } } };
      const split = machineFiles({ file: RECIPE, recipe: edited, project: "app", machine: before, home: HOME, replace: true });
      if (!split.ok || split.machine === null) throw new Error("expected a machine file");
      expect(split.machine).toMatch(/app:\n\s+runtime:[\s\S]*assignee:\n\s+take: mine\n/);
      expect(split.machine.match(/login: bob/g)).toHaveLength(1);
    });

    it("carries one written in the recipe text to the machine file, rather than deleting it", async () => {
      const split = machineFiles({
        file: `${RECIPE}runtime:\n  assignee:\n    take: unassigned\n`,
        recipe: await parsed(""),
        project: "app",
        machine: null,
        home: HOME,
      });
      if (!split.ok || split.machine === null) throw new Error("expected a machine file");
      expect(split.recipe).not.toContain("assignee");
      expect((await parsed(split.machine)).runtime.assignee).toEqual({ take: "unassigned" });
    });
  });

  describe("what belongs in the other file is refused, not dropped", () => {
    it("a gates key in the machine file is a parse error that says where gates live", async () => {
      const resolving = resolveLocalRecipe(
        "app",
        withMachine("gates:\n  proposed: []\n"),
      );
      await expect(resolving).rejects.toThrow(MachineConfigInvalidError);
      await expect(resolveLocalRecipe("app", withMachine("gates:\n  merge: []\n"))).rejects.toThrow(
        `they live in the recipe, ${HOME}/app/recipe.yml`,
      );
    });

    it("so is one under a project's section", async () => {
      await expect(
        resolveLocalRecipe("app", withMachine("projects:\n  app:\n    gates:\n      merge: []\n")),
      ).rejects.toThrow(/projects\.app\.gates: gates do not live in the machine file/);
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
