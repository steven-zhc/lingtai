/**
 * **A whole pass, against fakes, with no database — and in the gate.**
 *
 * This is the test `#68` said would decide whether the extraction happened. Its
 * own words: *can `conductor` run a whole pass against a fake `repo`, a fake
 * `agent` and a fake `event-store`, with no database — producing the events it
 * wants appended and the calls it wants made, for a test to assert?* It carried
 * that claim about `run-once.ts`; it carries it about `conduct.ts` now, and the
 * assertions are unchanged, which is the useful thing about it: **the engine was
 * replaced and the sentences a person reads off the log were not.**
 *
 * What it asserts is the *wiring*, and it is the only test that can. `pass.ts`'s
 * and `pass-steps.ts`'s tests own every decision the pass makes and own it more
 * sharply, against fake bodies and fake ports; what neither of them can see is
 * the order the four acquisitions release in, that the hook was proved to fail
 * closed before the agent started, that the labels went `working` then `waiting`,
 * or that the merge lane was never reached under `--no-merge`. Those are one
 * caller's, and this is it.
 *
 * Unit by [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import { STEPS } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
} from "../test/one-pass.ts";

describe("the conductor runs a whole pass, with no world to run in", () => {
  /**
   * **`--no-merge` holds, and it holds as the `human:` action it always was**
   * (#20).
   *
   * There is no flag read anywhere near the merge lane any more: `conduct.ts`
   * appends a `createHumanAction` named `no-merge` after `merge`'s declared list,
   * the pipeline emits the `ApprovalRequested` a `needs-approval` verdict asks
   * for, `endingOf` reads it as `held`, and `outcomeOf` says `blocked`. So the
   * assertion that the integrator was never reached is an assertion about the
   * *pass*, not about a branch somebody remembered to write.
   */
  it("holds at the merge, appends what it decided, and takes the worktree down", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const lines: string[] = [];

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
        log: (line) => lines.push(line),
      },
      fakePorts(did, store),
    );

    // Say what it actually did before asserting, so a refusal names its stage
    // rather than reading as `false`.
    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    // And it names the step that held it, which is the merge point — the thing a
    // person is being asked about.
    if (result.ok !== "held") throw new Error(`landed, and this run asked not to merge`);
    expect(result.step).toBe("merge");

    // The decision, as the log records it.
    const events = await store.read(`wi-${PROJECT}-7`);
    const item = events.map((e) => e.type);
    expect(item).toContain("WorkItemClaimed");
    expect(item).toContain("WorkItemBlocked");
    // Told GitHub inline, and recorded that it did (0022 — no outbox).
    expect(item.filter((t) => t === "IssueUpdated").length).toBeGreaterThan(0);

    /**
     * **The good hold carries the move it recommends** (#83).
     *
     * `--no-merge` is a `human:` action injected after `merge`'s declared list
     * since `#256` (#20), so the ordinary self-hosted ending — every step
     * passed, the operator asked it not to merge — now stops at `merge` with
     * `PassResult.stoppedAt` set rather than null. A recommendation gated on
     * *nothing stopped it* is therefore a recommendation this case never gets,
     * and `standing.tsx` draws no move for the one hold that most obviously has
     * one. A step only holds once every step before it passed, and `merge` is
     * the last before `end`, so the sentence is arithmetic here.
     */
    const asked = events.find((e) => e.type === "WorkItemBlocked")!.data as {
      needs: string;
      diagnosis: { recommendation: { action: string; why: string } | null };
    };
    expect(asked.needs).toBe("judgement");
    expect(asked.diagnosis.recommendation?.action).toBe("approve");
    expect(asked.diagnosis.recommendation?.why).toContain("every step passed");

    // `working` at the claim, `waiting` once a person is the thing being waited
    // on — and in that order, which is the whole of `#71`. `bug` survives both,
    // because a whole-set write takes the union with somebody else's labels.
    const labelWrites = said.filter((line) => line.startsWith("labels #7"));
    expect(labelWrites).toEqual(["labels #7 bug,lingtai:working", "labels #7 bug,lingtai:waiting"]);

    /**
     * **Every one of the ten ran, and `end` ran last** — asserted, rather than
     * claimed and then not looked at.
     *
     * The headline used to sit over `toContain` checks for six event types, and
     * every one of them survives a step being dropped: delete `design` from
     * `STEPS`, have `runPass` `continue` past a visit, let `stepsResolved`
     * record five points, and `RunStarted`/`GatesResolved`/`RunFinished` are all
     * still there. That is `#61`'s own shape — declared, recorded, drawn, never
     * fired — wearing the name of the test that would have caught it.
     *
     * What does catch it is the line `conduct.ts` prints from `pass.steps`,
     * which is one entry per *visit the loop actually made* and is the only
     * caller-side view of the walk. The step names in it, in order, have to be
     * `STEPS` — the ten `@lingtai/domain` exports so that nothing keeps a list
     * of its own — and `end` has to be the last of them, because `runPass` runs
     * it after the walk on every ending.
     */
    const walked = lines.find((line) => line.startsWith("pass: "));
    expect(walked, `no pass line among:\n${lines.join("\n")}`).toBeDefined();
    const visits = walked!.slice("pass: ".length).split(" ");
    expect(visits.map((v) => v.split("=")[0])).toEqual([...STEPS]);
    expect(visits.at(-1)).toBe("end=passed");
    // And the one that did not pass is the merge point, which is where the
    // injected `no-merge` action asked for a person.
    expect(visits).toContain("merge=held");

    // The plan the log records agrees with the walk: ten points, same order, so
    // *declared* and *ran* cannot drift apart unnoticed.
    const resolved = (await store.read(result.runId)).find((e) => e.type === "GatesResolved")!;
    expect((resolved.data as { points: { gate: string }[] }).points.map((p) => p.gate)).toEqual([
      ...STEPS,
    ]);

    const run = (await store.read(result.runId)).map((e) => e.type);
    expect(run).toContain("RunStarted");
    expect(run).toContain("GatesResolved");
    expect(run).toContain("RunFinished");
    expect(run).toContain("RunProducedDiff");
    expect(run).toContain("RunProposedCompletion");
    // The hold, asked for by the action rather than by the caller: `conduct.ts`
    // appends one only where nothing held, and here the `no-merge` action did.
    expect(run).toContain("ApprovalRequested");

    // The worktree is gone, and the integrator was never reached.
    expect(did).toContain(`provision ${result.runId}`);
    expect(did).toContain(`remove ${result.runId}`);
    expect(did).not.toContain("integrate");

    // The hook was wired and proved to fail closed before the agent started.
    expect(did.indexOf("smokeTest")).toBeLessThan(did.indexOf("git rev-parse"));
    // The socket was closed, by the scope and not by a `finally`, and before the
    // worktree it outlived — releases run in the reverse of acquisition.
    expect(did.indexOf("close")).toBeLessThan(did.indexOf(`remove ${result.runId}`));

    /**
     * **The log outlives the worktree, and a run that did not land keeps it.**
     *
     * Both halves of 0034 §2 and §4, and the ordering is `conduct.ts`'s two
     * finalizers rather than an arrangement: the log is acquired first and
     * released last, so whether the run landed is a fact by the time the fate is
     * decided. This one held at the merge for a person — nothing landed, so
     * nothing is deleted.
     */
    expect(did).toContain(`runLog /tmp/fake-home/runs/${PROJECT}/${result.runId}.log`);
    expect(did.indexOf(`remove ${result.runId}`)).toBeLessThan(did.indexOf("runLog keep"));
    expect(did).not.toContain("runLog delete");
    // And the hook socket's live view reached it.
    expect(did).toContain("note run finished: 3 turns, 0.42 usd");
  });

  /**
   * **Landed → delete**, which is the other half of the rule and the expensive
   * one to get wrong.
   *
   * `#84` cost $26.53 and, once landed, what it was thinking is gone. That is
   * accepted rather than regretted (0034 §4): the diff is on the branch and the
   * events are on the log, so an agent's account of a run that *worked* has the
   * least marginal value of anything here. What the rule buys is that no timer,
   * no sweeper and no retention period is needed.
   */
  it("deletes the log of a run that landed, and keeps nothing else to sweep", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result.ok).toBe(true);
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemLanded");
    // **A landed item carries no `lingtai:` label at all** — `labelsFor("landed")`
    // is `[]`, so the last whole-set write is somebody else's labels and nothing
    // of Lingtai's. Being on `main` is not a state Lingtai is waiting on, and the
    // label that said so is removed rather than replaced.
    expect(said.filter((line) => line.startsWith("labels #7")).at(-1)).toBe("labels #7 bug");

    // The decision is taken *after* the integrator, which is the whole reason the
    // log's scope is wider than the worktree's: at the moment the worktree goes,
    // whether the run landed is not yet a fact about the world.
    expect(did.indexOf("integrate")).toBeLessThan(did.indexOf("runLog delete"));
    expect(did).not.toContain("runLog keep");
    // And the merge lane was reached by the `merge` step, which means every step
    // before it passed — the sequence, asserted from outside it.
    expect(did.indexOf(`provision ${result.runId}`)).toBeLessThan(did.indexOf("integrate"));
  });
});
