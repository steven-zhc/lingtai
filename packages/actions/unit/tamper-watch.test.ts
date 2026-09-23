/**
 * The `tamper` watch (#31): the gate cannot be allowed to edit the gate.
 *
 * **Read from `doc/tamper-watch.md`, because this repository does not wire it.**
 * It was at `proposed` for one night and held six consecutive items that had
 * passed `build` and `review`; the trade and the reason it came out are in that
 * document. The capability is untouched — what is gone is the wiring.
 *
 * The document is the canonical list, not a copy of one, which is what keeps
 * this from being the fixture the original version of this file refused to be:
 * there is nowhere else for a path to be taken out of. What cannot be asserted
 * while the watch is off is *cannot be weakened by the change it is judging* —
 * that needs the watch to really be at `proposed`, and it comes back with the
 * block. Everything else below judges the documented list against the real
 * gate code.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type GateAction, RECIPE_PATH, resolveRecipe } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { gatesFromRecipe } from "../src/from-recipe.ts";
import { runGatePipeline } from "../src/gate.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const context = { runId: "run-1", onSha: "b".repeat(40), cwd: root, env: {} };

/**
 * The block as `doc/tamper-watch.md` publishes it, which is where it lives while
 * it is not wired. Parsed rather than duplicated: an edit to the document is an
 * edit to what this test judges, and there is no second copy to drift from.
 */
async function documented(): Promise<GateAction[]> {
  const md = await readFile(`${root}doc/tamper-watch.md`, "utf8");
  const fence = md.match(/```yaml\n([\s\S]*?)```/);
  if (!fence) throw new Error("doc/tamper-watch.md has no yaml block — the watch list has no home");

  // Spliced into this repository's own recipe and resolved by `resolveRecipe`,
  // rather than parsed here. Two things follow from that and both are wanted:
  // the block is validated by the real schema, so a document that has drifted
  // out of what a recipe may say fails here — and this test needs no YAML
  // parser of its own, in a package the watch list covers.
  const action = fence[1]!.slice(fence[1]!.indexOf("    - name:"));
  const live = await readFile(`${root}${RECIPE_PATH}`, "utf8");
  const spliced = live.replace(/^ {2}proposed:\n/m, `  proposed:\n${action}`);
  const { recipe } = await resolveRecipe(
    async (path, ref) => (path === RECIPE_PATH && ref === "main" ? spliced : null),
    "main",
  );
  return recipe.gates.proposed.filter((gate) => "watch" in gate);
}

/** The documented watches, judging a diff of exactly these files. */
async function judge(files: string[]) {
  const gates = gatesFromRecipe("proposed", await documented(), { watch: { changedFiles: async () => files } });
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
    "vitest.config.ts",
    "packages/github/src/client.ts",
    "packages/agent-env/src/index.ts",
    "packages/daemon/src/index.ts",
    // Spawned rather than loaded, so the walk below never reaches it — and it
    // is the code a bot token is handed to.
    "packages/telegram/src/telegram.ts",
    // Loaded by the CLI and Telegram by relative path, with no dependency
    // declared on it, so the walk below cannot reach this one either — and it
    // renders the text the token is sent with.
    "packages/extension/src/index.ts",
    "packages/repo/src/integrate.ts",
    "apps/cli/src/lingtai.ts",
    "apps/board/src/app/actions.ts",
    "apps/board/src/app/decide.tsx",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "packages/actions/tsconfig.json",
    ".npmrc",
    "packages/foo/.npmrc",
  ])("holds a diff touching %s for a person", async (file) => {
    const result = await judge(["README.md", file]);

    // Held, not failed: nothing is wrong with the change, it is just not the
    // machine's to wave through.
    expect(result.heldAt).toBe("tamper");
    expect(result.failedAt).toBeNull();
  });

  /**
   * The list kept correct by something other than the list. Every workspace
   * package the conductor and the CLI load, however indirectly, is part of what
   * judges a change — so a new dependency, or a package renamed, fails here
   * until the watch covers it.
   *
   * And every workspace that depends on the conductor is a root, because that
   * is how a process reaches `@lingtai/conductor/decide` and appends a person's
   * approval: a hold is only as sound as what records the decision lifting it.
   * That is how `apps/board` is found, and how the next thing that decides is.
   */
  it("holds every workspace package the conductor and the CLI load, and everything that decides", async () => {
    const manifest = async (dir: string) =>
      JSON.parse(await readFile(`${root}${dir}/package.json`, "utf8")) as { dependencies?: Record<string, string> };
    const seen = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      if (seen.has(dir)) return;
      seen.add(dir);
      const deps = (await manifest(dir)).dependencies ?? {};
      for (const name of Object.keys(deps).filter((dep) => deps[dep]!.startsWith("workspace:"))) {
        await visit(`packages/${name.replace("@lingtai/", "")}`);
      }
    };
    await visit("packages/conductor");
    await visit("packages/hook");
    await visit("apps/cli");
    for (const parent of ["apps", "packages"]) {
      for (const name of await readdir(`${root}${parent}`)) {
        const deps = (await manifest(`${parent}/${name}`).catch(() => ({}))) as { dependencies?: Record<string, string> };
        if (deps.dependencies?.["@lingtai/conductor"]) await visit(`${parent}/${name}`);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(seen).toContain("apps/board");

    for (const dir of seen) {
      expect((await judge([`${dir}/src/index.ts`])).heldAt, dir).toBe("tamper");
    }
  });

  it("asks nothing about a diff that touches none of it", async () => {
    const result = await judge(["apps/site/src/app/page.tsx", "doc/README.md"]);

    expect(result.ok).toBe(true);
  });

  /**
   * Two cases live in this file's history rather than here, because both need
   * the watch to really be at `proposed`: *is the last action there*, and
   * *cannot be weakened by the change it is judging*. The second is the whole
   * security argument — an agent's branch deleting the watch changes nothing,
   * because 0005 reads the recipe from the base — and it comes back when the
   * block does. That the recipe is read from the base is still asserted, in
   * `packages/conductor/integration/run-once-against-fakes.test.ts`.
   */
  it("is not wired in this repository, and the documented block is where it lives", async () => {
    const { recipe } = await resolveRecipe(
      async (path, ref) => (path === RECIPE_PATH && ref === "main" ? readFile(`${root}${RECIPE_PATH}`, "utf8") : null),
      "main",
    );

    expect(recipe.gates.proposed.map((action) => action.name)).not.toContain("tamper");
    expect((await documented()).map((action) => action.name)).toEqual(["tamper"]);
  });
});
