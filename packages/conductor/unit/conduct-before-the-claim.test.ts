/**
 * **Everything the conductor refuses before it claims anything**, against fakes,
 * with no database — and in the gate.
 *
 * It is the surviving half of `unit/run-once-against-fakes.test.ts`, which `#256`
 * deleted with the engine it was written for. Every claim in that file about the
 * *pass* is now `unit/pass.test.ts`'s and `unit/pass-steps.test.ts`'s, where it is
 * asserted against the loop that makes the decision rather than against a
 * five-gate-point wrapper around it. **What has no home there is this**: the
 * recipe, the environment and the runtime are resolved by `conduct.ts` before
 * `runPass` is called at all, and they are the refusals that must cost nothing.
 *
 * So the shape of every test below is one sentence — *it stopped, nothing was
 * claimed, and nothing was acquired* — and `did` being empty is the assertion
 * that carries it. The lesson 0024 recorded about where a scope *starts* is kept
 * here as a test rather than as an intention.
 *
 * Unit by [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no disk. The fixtures are `test/one-pass.ts`.
 */
import type { GitHubClient } from "@lingtai/github";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  PROJECT,
  RECIPE,
  REVIEWED,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
} from "../test/one-pass.ts";

describe("nothing is claimed and nothing is acquired", () => {
  /**
   * **The refusals come first, deliberately.**
   *
   * Everything above the pass acquires nothing, so a run that stops at an
   * unreadable recipe has provisioned no worktree to release. The only way to
   * assert that is to reach a refusal and find that the worktree was never asked
   * for.
   */
  it("refuses before it acquires anything, so there is no worktree to release", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        // No recipe on the base branch. The first refusal there is.
        client: { ...fakeGitHub(said), fileAt: async () => null } as GitHubClient,
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("recipe");
    // Nothing was claimed, so there is nothing to release …
    expect(result.workItemId).toBeNull();
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
    // … and nothing was acquired, so there is nothing to unwind.
    expect(did).toEqual([]);
  });
});

/**
 * `env.refuseHosts` reaches the tripwire, which is the whole of `#51`.
 *
 * A field carried through the recipe and handed to nothing is `#89`'s shape,
 * and it would pass every test in `agent-env`: the tripwire works there with
 * whatever patterns it is given. This asserts the conductor gives it these.
 */
describe("the conductor hands the recipe's production hosts to the environment", () => {
  it("passes env.refuseHosts to resolveEnv, before anything is claimed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store);
    let seen: readonly string[] | undefined;
    ports.agent.resolveEnv = (options) => {
      seen = options.patterns;
      return Effect.succeed({ values: {}, names: [], refusal: "refused here" }) as never;
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([], RECIPE.replace("required: [],", "required: [], refuseHosts: [abcdefghijklmnopqrst],")),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result).toMatchObject({ ok: false, stage: "env" });
    // The recipe's added to the default, which a file the agent can edit must not remove.
    expect(seen).toEqual(["prod", "production", "abcdefghijklmnopqrst"]);
  });
});

/**
 * The same tripwire over what an **extension** declares, before the claim.
 *
 * `resolveEnv` checks the agent's values, after `deny`, so a denied production
 * value a `run:` extension declares used to pass stage `env` and first throw at
 * `gates.prepared` — past the claim and the worktree, as a defect mid-run.
 */
describe("the conductor refuses an extension's production value before anything is claimed", () => {
  it("stops at stage env when a run: extension declares a denied production host", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store);
    const prod = "postgresql://postgres:s3cr3t@db.eliwlauokdzgsqfgczkv.supabase.co:5432/postgres";
    ports.agent.resolveEnv = () =>
      Effect.succeed({
        values: {},
        merged: { PROD_DATABASE_URL: prod },
        names: [],
        missing: [],
        deferred: [],
        file: "/tmp/fake-home/env/demo.env",
        refusal: null,
      }) as never;

    const recipe = RECIPE.replace("required: [],", "required: [], deny: [PROD_DATABASE_URL], refuseHosts: [eliwlauokdzgsqfgczkv],").replace(
      "steps: {}",
      "steps:\n  prepared:\n    - name: migrate\n      run: pnpm migrate\n      env: [PROD_DATABASE_URL]",
    );
    const result = await once(
      {
        project,
        client: fakeGitHub([], recipe),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result).toMatchObject({ ok: false, stage: "env", workItemId: null });
    expect((result as { detail: string }).detail).toMatch(/PROD_DATABASE_URL looks like production.*"eliwlauokdzgsqfgczkv"/);
    expect((result as { detail: string }).detail).not.toContain("s3cr3t");
    // Nothing claimed, nothing provisioned.
    expect(did).toEqual([]);
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
  });
});

/**
 * **The agent the recipe resolved to is the one that runs** (#180). A machine
 * file naming `codex` resolves, `lingtai doctor` prints it, and a conductor
 * handed `claude-code` must not run that on the ticket and record claude-code.
 */
describe("the conductor runs the agent the recipe names, or nothing", () => {
  it("refuses before the claim when runtime.agent is not the runtime it was handed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const codex = RECIPE.replace("agent: claude-code", "agent: codex");

    const result = await once(
      {
        project,
        client: fakeGitHub([], codex),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: false, stage: "recipe", workItemId: null });
    expect((result as { detail: string }).detail).toContain("runtime.agent is codex");
    expect((result as { detail: string }).detail).toContain("this conductor runs claude-code");
    expect(did).toEqual([]);
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
  });

  /**
   * **And a step's `agent:` is a runtime too since `#245`** — the same rule one
   * level down, where nothing enforced it.
   *
   * `runtime.agent: claude-code` with `steps.proposed`'s `review` naming
   * `codex` resolved cleanly: the gates are handed `options.runtime`, so the
   * cold review ran on claude-code, no refusal was raised, and nothing on the
   * log recorded that the runtime the recipe named was not the one used. That
   * is 0046 §3's silent pick with a different name on it. Per-step dispatch is
   * not built; the honest answer is the one `runtime.agent` already gets, and
   * it names the point and the action so a reader knows which line is wrong.
   */
  it("refuses before the claim when a step's agent: is not the runtime it was handed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const codexReview = REVIEWED.replace("agent: claude-code\n      prompt:", "agent: codex\n      prompt:");

    const result = await once(
      {
        project,
        client: fakeGitHub([], codexReview),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: false, stage: "recipe", workItemId: null });
    expect((result as { detail: string }).detail).toContain('steps.proposed\'s "review" action names agent codex');
    expect((result as { detail: string }).detail).toContain("this conductor runs claude-code");
    // Nothing was claimed, so nothing was spent and no verdict was recorded
    // against a review that ran on a runtime nobody named.
    expect(did).toEqual([]);
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
  });
});

