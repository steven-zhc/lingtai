/**
 * Proposing a recipe by reading a repository (#161). No network: the client is
 * a fake that answers `GET`s from a fixture and **fails any other method**, so
 * every test here is also the test that nothing is written to GitHub.
 */
import { describe, expect, it } from "vitest";
import { Recipe, envNames, proposeRecipe, type RepositoryReader } from "../src/index.ts";

interface Fixture {
  base?: string;
  labels?: string[];
  files: Record<string, string>;
}

class NotFound extends Error {
  status = 404;
}

function fakeClient(slug: string, fixture: Fixture): RepositoryReader & { calls: string[] } {
  const base = fixture.base ?? "main";
  const root = `/repos/${slug}`;
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string, path: string): Promise<T> {
      calls.push(`${method} ${path}`);
      if (method !== "GET") throw new Error(`a proposal wrote to GitHub: ${method} ${path}`);
      if (path === root) return { default_branch: base } as T;
      if (path.startsWith(`${root}/labels?`)) {
        const page = Number(new URL(path, "https://x").searchParams.get("page"));
        return (page === 1 ? (fixture.labels ?? []).map((name) => ({ name })) : []) as T;
      }
      if (path === `${root}/git/trees/${base}?recursive=1`) {
        return { tree: Object.keys(fixture.files).map((p) => ({ path: p, type: "blob" })), truncated: false } as T;
      }
      const contents = new RegExp(`^${root}/contents/(.+)\\?ref=${base}$`).exec(path);
      if (contents) {
        const file = fixture.files[decodeURIComponent(contents[1]!)];
        if (file === undefined) throw new NotFound();
        return { content: Buffer.from(file).toString("base64"), encoding: "base64" } as T;
      }
      throw new NotFound(path);
    },
  };
}

const pkg = (scripts: Record<string, string>, name = "x") => JSON.stringify({ name, scripts });

describe("proposeRecipe", () => {
  it("fills every fast row from the repository, and the recipe passes Recipe.parse", async () => {
    const client = fakeClient("acme/app", {
      base: "develop",
      labels: ["Bug", "feature", "documentation"],
      files: {
        ".gitmodules": "[submodule \"vendor\"]\n",
        "package-lock.json": "{}",
        "package.json": pkg({ test: "vitest run", dev: "vite" }),
        ".env.example": "DATABASE_URL=postgres://localhost/app\n",
      },
    });

    const { recipe, found, refusals } = await proposeRecipe("acme/app", client, { signedIn: ["claude-code"] });

    expect(Recipe.parse(recipe)).toEqual(recipe);
    expect(recipe.repo).toEqual({ base: "develop", submodules: true });
    // The repository's own spelling, in the proposal's order.
    expect(recipe.source.kinds).toEqual(["Bug", "feature"]);
    expect(recipe.source.exclude).toContain("agent:hold");
    expect(recipe.gates.proposed).toEqual([{ name: "build", run: "npm run test", timeout: "20m", env: [] }]);
    expect(recipe.gates.end).toEqual([{ name: "close the ticket", when: "landed", close: true }]);
    expect(recipe.gates.merge).toEqual([]);
    expect(recipe.env.required).toEqual(["DATABASE_URL"]);
    expect(recipe.runtime.agent).toBe("claude-code");
    expect(found.scripts.map((s) => [s.name, s.guessed])).toEqual([
      ["test", true],
      ["dev", false],
    ]);
    expect(refusals).toEqual([]);
  });

  it("a monorepo whose root names every half: `pnpm typecheck && pnpm test && pnpm test:db`", async () => {
    const client = fakeClient("steven-zhc/lingtai", {
      labels: ["bug", "tech-debt", "feature"],
      files: {
        "pnpm-lock.yaml": "",
        "package.json": pkg({
          build: "pnpm -r --if-present build",
          test: "pnpm -r --workspace-concurrency=1 --if-present test",
          typecheck: "pnpm -r --if-present typecheck",
          "test:db": "pnpm -r --workspace-concurrency=1 --if-present test:db",
          "db:migrate": "pnpm --filter @lingtai/event-store db:migrate",
        }),
        "packages/event-store/package.json": pkg({ typecheck: "tsc", test: "vitest run", "test:db": "vitest run -c db" }),
      },
    });

    const { recipe, found, refusals } = await proposeRecipe("steven-zhc/lingtai", client, { signedIn: ["codex"] });

    expect(recipe.gates.proposed).toEqual([
      { name: "build", run: "pnpm typecheck && pnpm test && pnpm test:db", timeout: "20m", env: [] },
    ]);
    // Every script is found, the unpicked ones included.
    expect(found.scripts.filter((s) => s.dir === "").map((s) => [s.name, s.guessed])).toEqual([
      ["build", false],
      ["test", true],
      ["typecheck", true],
      ["test:db", true],
      ["db:migrate", false],
    ]);
    expect(found.scripts.filter((s) => s.dir === "packages/event-store")).toHaveLength(3);
    expect(found.scripts.every((s) => typeof s.guessed === "boolean")).toBe(true);
    expect(recipe.runtime.agent).toBe("codex");
    expect(refusals).toEqual([]);
  });

  it("a monorepo whose root `test` is not the whole suite: the package's `test:db` is listed, unpicked, and refused by name", async () => {
    const client = fakeClient("acme/admin", {
      labels: ["bug"],
      files: {
        "pnpm-lock.yaml": "",
        "package.json": pkg({ test: "pnpm -r test", typecheck: "pnpm -r typecheck" }),
        "apps/api/package.json": pkg({ test: "vitest run", "test:db": "vitest run -c vitest.db.ts" }),
      },
    });

    const { recipe, found, refusals } = await proposeRecipe("acme/admin", client, { signedIn: ["claude-code"] });

    expect(recipe.gates.proposed).toEqual([
      { name: "build", run: "pnpm typecheck && pnpm test", timeout: "20m", env: [] },
    ]);
    expect(found.scripts).toContainEqual({
      dir: "apps/api",
      name: "test:db",
      command: "vitest run -c vitest.db.ts",
      run: "pnpm --dir apps/api test:db",
      guessed: false,
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("apps/api");
    expect(refusals[0]).toContain("`test:db`");
  });

  it("guesses nothing when only the packages have checks, and says so", async () => {
    const client = fakeClient("acme/split", {
      labels: ["feature"],
      files: {
        "pnpm-lock.yaml": "",
        "package.json": pkg({ build: "turbo build" }),
        "apps/web/package.json": pkg({ test: "vitest run" }),
        "apps/api/package.json": pkg({ test: "vitest run" }),
      },
    });

    const { recipe, found, refusals } = await proposeRecipe("acme/split", client, { signedIn: ["claude-code"] });

    expect(Recipe.parse(recipe)).toEqual(recipe);
    expect(recipe.gates.proposed).toEqual([]);
    expect(found.scripts.filter((s) => s.guessed)).toEqual([]);
    expect(found.scripts.filter((s) => s.name === "test")).toHaveLength(2);
    expect(refusals.join("\n")).toMatch(/2 package\(s\)/);
  });

  it("a repository with no matching label still parses, and comes back with a refusal", async () => {
    const client = fakeClient("acme/bare", { labels: ["question", "wontfix"], files: {} });

    const { recipe, found, refusals } = await proposeRecipe("acme/bare", client);

    expect(Recipe.parse(recipe)).toEqual(recipe);
    expect(recipe.source.kinds.length).toBeGreaterThan(0);
    expect(refusals.some((r) => r.includes("labels"))).toBe(true);
    // Nothing checks a diff, and no runtime was said to be signed in: both refused.
    expect(recipe.gates.proposed).toEqual([]);
    expect(refusals.some((r) => r.includes("no check scripts"))).toBe(true);
    expect(found.runtime).toBeNull();
    expect(refusals.some((r) => r.includes("runtime"))).toBe(true);
    expect(found.packageManager).toBeNull();
  });

  it("carries the names in .env.example and no value ever leaves it", async () => {
    const values = ["postgres://user:hunter2@db.example.com/app", "sk_live_9f8e7d6c5b4a", "s3cr3t-with=equals"];
    const example = [
      "# the application's database",
      `DATABASE_URL=${values[0]}`,
      `export STRIPE_SECRET_KEY="${values[1]}"`,
      "",
      `SESSION_SECRET = ${values[2]}`,
      "EMPTY=",
      "not a variable line",
    ].join("\n");
    const client = fakeClient("acme/secrets", {
      labels: ["bug"],
      files: { ".env.example": example, "apps/web/.env.example": `DATABASE_URL=${values[0]}\nNEXT_PUBLIC_KEY=pk_abc123\n` },
    });

    const proposal = await proposeRecipe("acme/secrets", client, { signedIn: ["claude-code"] });

    expect(proposal.recipe.env.required).toEqual([
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "SESSION_SECRET",
      "EMPTY",
      "NEXT_PUBLIC_KEY",
    ]);
    const everything = JSON.stringify(proposal);
    for (const value of [...values, "hunter2", "sk_live", "s3cr3t", "pk_abc123"]) {
      expect(everything).not.toContain(value);
    }
    // Two places to plant it is a question, not a guess.
    expect(proposal.refusals.some((r) => r.includes(".env.example is in 2 places"))).toBe(true);
  });

  it("plants the env file beside the only .env.example", async () => {
    const client = fakeClient("acme/nested", { labels: ["bug"], files: { "apps/web/.env.example": "A=1\n" } });
    const { recipe } = await proposeRecipe("acme/nested", client, { signedIn: ["claude-code"] });
    expect(recipe.env.plantAt).toBe("apps/web/.env.local");
  });

  it("reads with GET and nothing else — the fake refuses any other method", async () => {
    const client = fakeClient("acme/app", {
      labels: ["bug"],
      files: { "package.json": pkg({ test: "vitest" }), ".env.example": "A=1\n", ".gitmodules": "" },
    });
    await proposeRecipe("acme/app", client, { signedIn: ["claude-code"] });
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.every((c) => c.startsWith("GET "))).toBe(true);

    const writer: RepositoryReader = {
      request: async (method) => {
        throw new Error(`refused ${method}`);
      },
    };
    await expect(proposeRecipe("acme/app", writer)).rejects.toThrow("refused GET");
  });

  it("refuses a slug that is not owner/repo before asking GitHub anything", async () => {
    const client = fakeClient("acme/app", { files: {} });
    await expect(proposeRecipe("not a slug", client)).rejects.toThrow("is not owner/repo");
    expect(client.calls).toEqual([]);
  });
});

describe("envNames", () => {
  it("reads names and never the value side", () => {
    expect(envNames("A=1\n# B=2\nexport C='x=y'\n  D =\nE\n")).toEqual(["A", "C", "D"]);
  });
});
