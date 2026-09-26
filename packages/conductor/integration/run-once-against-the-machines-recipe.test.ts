/**
 * The one claim about a pass that needs a world: **which `recipe.yml` judged it.**
 *
 * It was the last `describe` of the old engine's fakes test and the only
 * reason that file — nineteen unit assertions about a pass — sat in the half
 * the `build` gate does not run. The file's own header named the split and
 * `#251` paid for it not having happened. Everything else it held is
 * `unit/conduct-before-the-claim.test.ts`'s and
 * `unit/conduct-what-a-claim-leaves.test.ts`'s; this is here because it writes a real
 * `recipe.yml` under a temporary `LINGTAI_HOME` and sets `process.env`, and the
 * filesystem and the real environment are outside the system
 * ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1).
 *
 * **Through the default read, not an injected one**, which is exactly why it
 * needs that world: no `recipe` is passed, so a `runOnce` whose default went
 * back to reading the repository would be handed the disarmed copy and merge.
 */
import type { GitHubClient } from "@lingtai/github";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runOnce } from "../src/conduct.ts";
import {
  PROJECT,
  RECIPE,
  fakeGitHub,
  fakePorts,
  issue,
  memoryStore,
  project,
  runtime,
  withPorts,
} from "../test/one-pass.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


/**
 * The governance rule, at the point where it bites: which recipe judges a
 * change is decided where the recipe is resolved.
 *
 * `packages/actions/unit/tamper-watch.test.ts` proves the watch holds when it is
 * in the recipe. Since 0046 §3 the recipe is this machine's file and nothing in
 * the repository is read for it, so this hands `runOnce` a repository whose
 * every ref carries a disarmed copy, a machine recipe that has the watch, and
 * the diff that deletes it — and the machine's is what holds.
 *
 * **Through the default read, not an injected one.** No `recipe` is passed:
 * the armed copy is a real `recipe.yml` under a `LINGTAI_HOME` this test owns,
 * so a `runOnce` whose default went back to reading the repository would be
 * handed the disarmed copy and merge.
 */
describe("runOnce judges a change by the machine's recipe, not by any file in the repository", () => {
  it("holds a diff that deletes the tamper watch, though the repository's own copy no longer has one", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store, true);
    const git = ports.repo.git;
    ports.repo.git = (...call: Parameters<typeof git>) =>
      call[0][0] === "diff" && call[0][1] === "--name-only"
        ? git(...call).pipe(Effect.as(".lingtai/config.yaml\npackages/actions/src/watch-action.ts\n"))
        : git(...call);

    const armed = RECIPE.replace(
      "steps: {}",
      'steps:\n  proposed:\n    - name: tamper\n      watch: [".lingtai/config.yaml", "packages/actions/**"]\n      then: request-approval',
    );
    const client = {
      ...fakeGitHub([], RECIPE),
      fileAt: async (path: string) => (path !== ".lingtai/config.yaml" ? null : RECIPE),
    } as unknown as GitHubClient;

    // The machine's half: the recipe without `runtime`, and the agent named in
    // `config.yml` so nothing is asked what is signed in.
    const lingtaiHome = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await mkdir(join(lingtaiHome, PROJECT));
    await writeFile(join(lingtaiHome, PROJECT, "recipe.yml"), armed.replace(/^runtime:.*$/m, ""));
    await writeFile(join(lingtaiHome, "config.yml"), "runtime:\n  agent: claude-code\n  limits: { turns: 10, wall: 2m }\n");
    const saved = process.env["LINGTAI_HOME"];
    process.env["LINGTAI_HOME"] = lingtaiHome;

    const result = await Effect.runPromise(
      runOnce({
        project,
        client,
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      }).pipe(Effect.provide(withPorts(ports))),
    ).finally(async () => {
      if (saved === undefined) delete process.env["LINGTAI_HOME"];
      else process.env["LINGTAI_HOME"] = saved;
      await rm(lingtaiHome, { recursive: true, force: true });
    });

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result).toMatchObject({ ok: "held", step: "proposed" });
    // Held by the machine's watch, which the repository's copy does not have.
    const asked = (await store.read(result.runId)).filter((e) => e.type === "ApprovalRequested");
    expect(asked.map((e) => e.data)).toMatchObject([{ gate: "proposed", action: "tamper" }]);
    expect(did).not.toContain("integrate");
  });
});
