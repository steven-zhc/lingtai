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
