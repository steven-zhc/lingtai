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
  issue,
  memoryStore,
  once,
  project,
  runtime,
  streams,
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


/**
 * **The `claim` step declining is not a person's problem, and it must not be
 * written down as one.**
 *
 * `claim` cannot refuse (0058 §2): it answers *took it* or one of three ways of
 * *did not*, all of them `did-not-finish`, and `ARRIVE_AT_THE_ROUTER` leaves the
 * step off — so `PassResult.stoppedAt` is `{step: "claim"}` and `outcomeOf`,
 * which reads any non-`never-ran` stop as `blocked`, sends it to the blocked
 * ending. Left there, `conduct.ts` appends `ApprovalRequested` to a run stream
 * with no `RunStarted`, appends `WorkItemBlocked` to the item, comments
 * **Lingtai is waiting on you** and writes `lingtai:waiting` — about an item
 * this pass never took.
 *
 * `run-once.ts` returned `discover`/`claim` here and wrote nothing at all, and
 * the two tests below are the two items that get written on: one nobody holds
 * and one somebody else does.
 */
describe("a claim that took nothing writes nothing", () => {
  /** The ticket as GitHub offers it while somebody has put a hold on it. */
  const HELD_BACK = RECIPE.replace("exclude: []", "exclude: [hold]");
  const held = { ...issue, labels: [...issue.labels, { name: "hold", color: "#ededed" }] };
  // `getIssue` and not `listOpenIssues`: `runnableNow` is called with
  // `only: [7]`, which reads the ticket by number.
  const onHold = (said: string[]): GitHubClient =>
    ({ ...fakeGitHub(said, HELD_BACK), getIssue: async () => held }) as GitHubClient;

  /**
   * **A ticket the queue passed over stays queued**, which is the whole of it.
   *
   * `task_view`'s state would become `blocked`, and `selectRunnable` takes only
   * `queued` (`queue.ts`) — so an operator's `pnpm lingtai run 7` on a ticket
   * carrying a hold label would take it out of the queue for good, and removing
   * the label would no longer bring it back.
   */
  it("says nothing about an issue GitHub passed over, and leaves its stream empty", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: onHold(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: false, stage: "claim" });
    expect((result as { detail: string }).detail).toContain("excluded-label");
    // Not one event on the item: not the block, and not the release the
    // `ensuring` at the bottom of `runOnce` would otherwise append.
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
    // And nothing was said to GitHub — no `lingtai:waiting`, no comment.
    expect(said).toEqual([]);
    /**
     * **And nothing on disk either**, which is the half `run-once.ts` got for
     * free and this file has to assert.
     *
     * There, discovery and the claim both ran *above* the scope that opened the
     * run log and wrote the cold reviewer's settings, so a candidate that was
     * never taken left nothing. Since `#256` the claim is the pass's first step,
     * and acquiring either eagerly put two files under `~/.lingtai` per
     * passed-over ticket and per lost race — the log **kept**, because `didLand`
     * is false, closing on a line calling itself *the only account of why* a run
     * that never started did not land. Against 0034 §4's *what is kept is exactly
     * the investigable set, and the rule needs no timer, no sweeper and no
     * retention period.*
     *
     * The worktree's removal is the one entry, and it is a no-op: the finalizer
     * is unconditional because `repo.remove` tolerates a path nothing cut (0039
     * §1), which is cheaper than a flag somebody has to keep true.
     */
    expect(did).toEqual([`remove ${(result as { runId: string }).runId}`]);
  });

  /**
   * **The item another conductor is mid-run on**, which is the expensive one.
   *
   * `claimWorkItem` answers `held` and the pass declines; a block here replaces
   * that run's lifecycle with `blocked` and relabels its issue while its agent
   * is still working, and `releaseWorkItem` appends `WorkItemReleased` to
   * whoever holds it rather than only to this run.
   */
  it("touches nothing on an item another run holds", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const itemId = `wi-${PROJECT}-7`;
    await store.append(itemId, 0, [
      {
        type: "WorkItemClaimed",
        actor: "conductor",
        data: { runId: "run-somebody-else", worker: "other:1", title: null, kind: null },
      },
    ]);

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: false, stage: "claim" });
    expect((result as { detail: string }).detail).toContain("held");
    // The other run's item, exactly as it was.
    expect((await store.read(itemId)).map((e) => e.type)).toEqual(["WorkItemClaimed"]);
    expect(said).toEqual([]);
    // And nothing on disk for a candidate this pass never took: see above.
    expect(did).toEqual([`remove ${(result as { runId: string }).runId}`]);
  });
});

/**
 * **The one thing this file's own scope used to acquire, and what its failure
 * cost.**
 *
 * The cold reviewer's settings file was written above the pass as
 * `host.unhookedSettings(…).pipe(Effect.orDie)`, which is a *defect* channel
 * inside the scope the `catchAllDefect` at the bottom of `runOnce` guards — and
 * that handler answers with `release("unexpected failure: …")`. `releaseWorkItem`
 * reads the stream and appends unconditionally (`claim.ts:137`), so on a pass
 * whose item another conductor claimed a second earlier an ENOSPC here appended
 * `WorkItemReleased{runId: <this run>}` to that conductor's live item, folded it
 * to `backlog`, and wrote `lingtai:queued` over its `lingtai:working` while its
 * agent was still working — after which `selectRunnable` hands it to a third
 * pass. The `claim` branch's `released = true` guards declines the pass *reports*;
 * a defect raised between entering the scope and the `claim` step reaches the
 * handler with `released` still false.
 *
 * It is asked for at `admit` now, which is after the claim and inside a step that
 * can report. So the failure is `notCut` on an item this run holds, the walk stops
 * there, and no `release` — nor any `unexpected` — is involved.
 */
describe("a failure acquiring what a step needs is answered at that step", () => {
  it("reports a settings file it could not write as admit not cutting, and releases nobody", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);
    ports.agent.unhookedSettings = () =>
      Effect.fail({
        _tag: "AgentHostFailed",
        operation: "writeUnhookedSettings",
        detail: "ENOSPC: no space left on device, mkdir '/home/x/.lingtai/runs'",
      } as never);

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
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

    // **Not `unexpected`.** A machine fact the step met, reported by the step.
    expect(result).toMatchObject({ ok: "held", step: "admit" });
    expect(did).not.toContain("wire");
    expect(did.filter((line) => line.startsWith("provision"))).toEqual([]);

    const item = await store.read(`wi-${PROJECT}-7`);
    const types = item.map((e) => e.type);
    // This run claimed it, so this run is what holds it — and a person is asked
    // rather than the queue, because the next pass meets the same disk.
    expect(types).toContain("WorkItemClaimed");
    expect(types).toContain("WorkItemBlocked");
    expect(types).not.toContain("WorkItemReleased");

    const blocked = item.find((e) => e.type === "WorkItemBlocked")!.data as {
      question: string;
      diagnosis: { raw: string | null };
    };
    expect(blocked.question).toContain("the cold reviewer had no settings");
    expect(blocked.diagnosis.raw).toContain("ENOSPC");
    // Nothing was cut, so there is nothing on origin and nothing to approve.
    const run = [...streams(store)].find(([id]) => id.startsWith("run-"));
    expect((run?.[1] ?? []).map((e) => e.type)).not.toContain("ApprovalRequested");
  });
});
