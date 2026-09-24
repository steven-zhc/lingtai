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
version: 2
repo: { base: main }
source: { kinds: [bug] }
env: { plantAt: .env.local }
steps:
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
    expect(filter.provenance["steps"]).toContain(join(home, "app", "recipe.yml"));
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
   * **And the remedy names the line that can change** (`#245`).
   *
   * A step's `agent:` is a runtime too since that ticket, so `runtime.agent:
   * claude-code` in the machine file and `review` naming `codex` in the recipe
   * is refused — and the row used to answer it with *name runtime.agent:
   * claude-code in ~/.lingtai/config.yml*, which is what that file already
   * says: it is the value `dispatched` was compared against and matched. An
   * operator following it re-writes the same line, re-runs doctor, reads the
   * identical fail, and the project takes no work the whole time, with the
   * action that is wrong never mentioned.
   */
  it("names the recipe's own action, not the machine file, when a step's agent: is refused", async () => {
    await writeFile(
      join(home, "app", "recipe.yml"),
      `${RECIPE}    - { name: review, agent: codex, prompt: "look at it coldly" }\n`,
    );
    const state = { project: "app", owner: "me", base: "main" } as ProjectState;

    const row = recipeRow(await projectFilter(state, recipeClientFor({})), "claude-code");
    expect(row.status).toBe("fail");
    expect(row.detail).toContain('steps.proposed\'s "review" action names agent codex');
    // The remedy: this action, in the file it is written in.
    expect(row.detail).toContain("Name agent: claude-code on that action");
    expect(row.detail).toContain(join(home, "app", "recipe.yml"));
    // And never the machine file's `runtime.agent`, which is already
    // `claude-code` here — editing it is the one thing that cannot help.
    expect(row.detail).not.toContain("Name runtime.agent:");

    const fixed = `${RECIPE}    - { name: review, agent: claude-code, prompt: "look at it coldly" }\n`;
    await writeFile(join(home, "app", "recipe.yml"), fixed);
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
