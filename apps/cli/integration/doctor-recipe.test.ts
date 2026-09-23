/**
 * `lingtai doctor`'s recipe row on a machine with no GitHub App (#180).
 *
 * The recipe is `~/.lingtai/<project>/recipe.yml`, so checking it needs no
 * App — a person who wrote the file is told it resolved, and from where each
 * value came, rather than `skip`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectState } from "@lingtai/domain";
import { projectFilter } from "@lingtai/conductor";
import { declaredEnvironment, recipeClientFor, recipeGovernsItsBase, recipeRow } from "../src/doctor.ts";

const RECIPE = `
version: 1
repo: { base: main }
source: { kinds: [bug] }
env: { plantAt: .env.local }
gates:
  proposed:
    - { name: build, run: "true" }
`;

describe("the recipe row, with no App configured", () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lingtai-doctor-"));
    await mkdir(join(home, "app"));
    await writeFile(join(home, "app", "recipe.yml"), RECIPE);
    await writeFile(join(home, "config.yml"), "runtime:\n  agent: claude-code\n");
    saved = process.env["LINGTAI_HOME"];
    process.env["LINGTAI_HOME"] = home;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env["LINGTAI_HOME"];
    else process.env["LINGTAI_HOME"] = saved;
    await rm(home, { recursive: true, force: true });
  });

  it("resolves the machine's file and says where each value came from", async () => {
    const state = { project: "app", owner: "me", base: "main" } as ProjectState;
    const filter = await projectFilter(state, recipeClientFor({}));

    if (!filter.ok) throw new Error(filter.problem);
    expect(filter.kinds).toEqual(["bug"]);
    expect(filter.provenance["runtime.agent"]).toBe(`claude-code ← ${join(home, "config.yml")}`);
    expect(filter.provenance["gates"]).toContain(join(home, "app", "recipe.yml"));
  });

  /**
   * A machine that names codex resolves, and every pass of it is refused by
   * `runOnce` before its claim — so the row that says what a run will do is a
   * fail in that refusal's words, not an ok that prints `codex` (#180).
   */
  it("fails when runtime.agent names a runtime this conductor does not dispatch", async () => {
    await writeFile(join(home, "config.yml"), "runtime:\n  agent: codex\n");
    const state = { project: "app", owner: "me", base: "main" } as ProjectState;
    const filter = await projectFilter(state, recipeClientFor({}));

    const row = recipeRow(filter, "claude-code");
    expect(row.status).toBe("fail");
    expect(row.detail).toContain("runtime.agent is codex");
    expect(row.detail).toContain("this conductor runs claude-code");

    await writeFile(join(home, "config.yml"), "runtime:\n  agent: claude-code\n");
    expect(recipeRow(await projectFilter(state, recipeClientFor({})), "claude-code").status).toBe("ok");
  });

  /**
   * The rows under it read the same file, so they run on the same machine
   * rather than skipping for an App nothing in them asks.
   */
  it("checks the declared environment and the base against that same file", async () => {
    const state = { project: "app", owner: "me", base: "develop" } as ProjectState;
    const load = async () => [state];

    const envRows = await declaredEnvironment({}, load);
    expect(envRows.map((r) => r.name)).toContain("env: app");
    for (const row of envRows) expect(row.detail).not.toContain("no App configured");
    expect(envRows.find((r) => r.name === "env: app")?.status).toBe("ok");

    const [base] = await recipeGovernsItsBase({}, load);
    expect(base?.name).toBe("base: app");
    // Registered against develop, and the machine's recipe says main.
    expect(base?.status).toBe("fail");
    expect(base?.detail).toContain("develop");
  });
});
