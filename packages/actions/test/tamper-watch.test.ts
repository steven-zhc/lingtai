/**
 * This repository's own `tamper` watch, read from this repository's own recipe
 * (#31): the gate cannot be allowed to edit the gate.
 *
 * Not a fixture. A test against a copy would go on passing after somebody took
 * a path out of `.lingtai/config.yaml`, which is exactly the edit it exists to
 * notice.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type GateAction, RECIPE_PATH, resolveRecipe } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { gatesFromRecipe } from "../src/from-recipe.ts";
import { runGatePipeline } from "../src/gate.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const context = { runId: "run-1", onSha: "b".repeat(40), cwd: root, env: {} };

/** `main` is the file on disk; any other ref is whatever the test says it is. */
const reader = (branches: Record<string, string>) => async (path: string, ref: string) =>
  path !== RECIPE_PATH ? null : ref === "main" ? readFile(`${root}${RECIPE_PATH}`, "utf8") : (branches[ref] ?? null);

const watchesAt = (actions: readonly GateAction[]) => actions.filter((action) => "watch" in action);

/** The `proposed` point's watches, judging a diff of exactly these files. */
async function judge(ref: string, files: string[], branches: Record<string, string> = {}) {
  const { recipe } = await resolveRecipe(reader(branches), ref);
  const gates = gatesFromRecipe(watchesAt(recipe.gates.proposed), { watch: { changedFiles: async () => files } });
  return runGatePipeline({ point: "proposed", gates, context, emit: () => {} });
}

describe("this repository's tamper watch", () => {
  it.each([
    ".lingtai/config.yaml",
    "packages/conductor/src/run-once.ts",
    "packages/event-store/src/db.ts",
    "packages/hook/src/lingtai-hook.ts",
    "packages/actions/src/watch-gate.ts",
    "packages/recipe/src/recipe.ts",
    "packages/domain/src/index.ts",
    "package.json",
    "packages/actions/package.json",
    "packages/conductor/vitest.config.ts",
  ])("holds a diff touching %s for a person", async (file) => {
    const result = await judge("main", ["README.md", file]);

    // Held, not failed: nothing is wrong with the change, it is just not the
    // machine's to wave through.
    expect(result.heldAt).toBe("tamper");
    expect(result.failedAt).toBeNull();
  });

  it("asks nothing about a diff that touches none of it", async () => {
    const result = await judge("main", ["apps/board/src/app/page.tsx", "doc/README.md"]);

    expect(result.ok).toBe(true);
  });

  it("is the last action at `proposed`, so a person is only asked about a change everything else passed", async () => {
    const { recipe } = await resolveRecipe(reader({}), "main");

    expect(recipe.gates.proposed.at(-1)).toMatchObject({ name: "tamper", then: "request-approval" });
  });

  /**
   * The attack, in one merge: the agent's branch deletes the watch and edits
   * the conductor under it. The run is governed by `main` (0005), so the
   * deletion changes nothing about it — and the deletion is itself in the
   * watched file, so the diff is held however it was written.
   */
  it("cannot be weakened by the change it is judging", async () => {
    const onMain = await readFile(`${root}${RECIPE_PATH}`, "utf8");
    const disarmed = onMain.replace(/^ {4}- name: tamper\n(?: {6}.*\n| {8}.*\n)+/m, "");
    const branches = { "agent/31": disarmed };

    // The edit really does disarm it, so the test is not passing because both
    // refs say the same thing.
    const { recipe: theirs } = await resolveRecipe(reader(branches), "agent/31");
    expect(theirs.gates.proposed.map((action) => action.name)).not.toContain("tamper");
    expect((await judge("agent/31", [RECIPE_PATH], branches)).ok).toBe(true);

    const result = await judge("main", [RECIPE_PATH, "packages/actions/src/watch-gate.ts"], branches);

    expect(result.heldAt).toBe("tamper");
  });
});
