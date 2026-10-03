/**
 * **A whole pass, against fakes, with no database — and in the gate.**
 *
 * This is the test `#68` said would decide whether the extraction happened. Its
 * own words: *can `conductor` run a whole pass against a fake `repo`, a fake
 * `agent` and a fake `event-store`, with no database — producing the events it
 * wants appended and the calls it wants made, for a test to assert?* It carried
 * that claim about the old engine; it carries it about `conduct.ts` now, and the
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
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import type { Runtime } from "@lingtai/agent";
import type { Envelope, ToAppend } from "@lingtai/domain";
import { STEPS } from "@lingtai/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DRAFTED,
  HUMAN_BEFORE_THE_LANE,
  JUDGED,
  JUDGED_BY_AN_AGENT,
  JUDGED_BY_A_CHEAP_AGENT,
  TWO_RUNTIMES,
  PROJECT,
  RECIPE,
  cutAtAdmit,
  fakeGitHub,
  landAtMerge,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  runtime,
  streams,
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
     * record five points, and `RunStarted`/`StepsResolved`/`RunFinished` are all
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
    const resolved = (await store.read(result.runId)).find((e) => e.type === "StepsResolved")!;
    expect((resolved.data as { steps: { step: string }[] }).steps.map((p) => p.step)).toEqual([
      ...STEPS,
    ]);

    const run = (await store.read(result.runId)).map((e) => e.type);
    expect(run).toContain("RunStarted");
    expect(run).toContain("StepsResolved");
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
    //
    // **`lastIndexOf` since `#265`.** There are two `git rev-parse` calls around
    // the dispatch now rather than one after it: `firstDispatch` reads the head
    // the agent *found* before it wires anything, so that the receipt 0057 §2 asks
    // for is measured against that rather than against the base — which a `design:`
    // agent may have committed over. The first is that baseline and is deliberately
    // earlier than the smoke test; the ones after it are the receipt and the push,
    // and those are what this ordering is about.
    expect(did.indexOf("smokeTest")).toBeLessThan(did.lastIndexOf("git rev-parse"));
    /**
     * **And the step agents' settings were asked of the host, not written here.**
     *
     * `writeUnhookedSettings` `mkdir -p`s and writes under the `home` it is
     * handed, so while `conduct.ts` called it directly every pass that reached
     * this line wrote a real file into `/tmp/fake-home` — from the unit half,
     * which is integration by 0060 §1 and a directory per run nothing ever
     * removes. A direct call appears nowhere in `did`, which is the whole of
     * why this assertion is the one that would have caught it.
     */
    expect(did).toContain("unhookedSettings review");
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
   * **`RunFinished` carries what the runtime reported it billed** (#316, 0110
   * §3) — the conditional spread in `conduct.ts` forwarding `RunOutcome.usage`
   * rather than dropping it on the floor between the adapter and the log.
   */
  it("carries a run's own usage onto RunFinished", async () => {
    const store = memoryStore();
    const metered: Runtime = {
      ...runtime,
      run: async () => ({
        exitCode: 0,
        turns: 3,
        durationMs: 1234,
        costUsd: 0.42,
        failure: null,
        text: "done",
        sessionId: "sess-1",
        usage: [{ model: "claude-sonnet-5", tokens: { fresh: 100, output: 20 } }],
      }),
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime: metered,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts([], store),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    const run = await store.read(result.runId);
    const finished = run.find((e) => e.type === "RunFinished")!;
    expect((finished.data as { usage?: unknown }).usage).toEqual([
      { model: "claude-sonnet-5", tokens: { fresh: 100, output: 20 } },
    ]);
  });

  /** The ordinary stub reports no usage, and the field is absent rather than `[]` or `0`. */
  it("leaves usage off RunFinished when the runtime reported none", async () => {
    const store = memoryStore();

    const result = await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts([], store),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    const run = await store.read(result.runId);
    const finished = run.find((e) => e.type === "RunFinished")!;
    expect((finished.data as { usage?: unknown }).usage).toBeUndefined();
  });

  /**
   * **A person the recipe declared holds the merge, with no `--no-merge`
   * anywhere** — `#58`, and the claim `CLAUDE.md` rests on when it says this
   * repository merges its own work unattended *by configuration rather than by a
   * gap*.
   *
   * It was pinned by the old engine's own integration test — *holds at a human
   * action at the merge point, with no --no-merge anywhere* — which `#256`
   * deleted along with the engine it tested. The flag is a `createHumanAction` injected into
   * `merge`'s list now (#20), so **a test that passes `merge: false`
   * cannot make this claim at all**: it exercises the injected action and says
   * nothing about the declared one. That is exactly how `#58` stayed hidden for
   * four days — every test held its run with the flag, and the daemon does not
   * pass it.
   *
   * So the recipe is the only thing asking, `merges` is `true` on the fake so a
   * pipeline that let this past would really call the lane, and the assertion is
   * that it was never called.
   *
   * **The step the recipe writes it at is `proposed` since `#270`, and that is the
   * same claim rather than a weaker one.** `humanPlugin.at` lost `merge` with that
   * ticket: 0058 §3b gives the step three ways out and only `proposed` may send one
   * to a person, and once the landing is an action in `merge`'s own list an
   * approval written beside it is asked about a merge already made. `proposed` is
   * on the spine — every pass that got past `review` arrives there — so a hold
   * there is reached by the daemon, unprompted, one step before anything lands.
   * What is asserted is unchanged: `integrate` was never called and no
   * `WorkItemLanded` is on the item's stream.
   */
  it("holds at a person the recipe declared before the lane, with no --no-merge anywhere", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, HUMAN_BEFORE_THE_LANE),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // No `merge: false`. The recipe is the only thing asking.
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    if (result.ok !== "held") throw new Error("it merged, and a person had been declared before the lane");
    expect(result.step).toBe("proposed");
    // **Nothing reached the base branch.** That is the entire ticket.
    expect(did).not.toContain("integrate");
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).not.toContain("WorkItemLanded");

    // A real pipeline and not a special case: the action the recipe named is what
    // asked, through the same `ApprovalRequested` the flag asks with, bound to the
    // head the steps judged.
    const [, run] = [...store.streams].find(([id]) => id.startsWith("run-"))!;
    const asked = run.filter((e) => e.type === "ApprovalRequested");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.data).toMatchObject({
      step: "proposed",
      action: "approval",
      onSha: result.headSha,
    });
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

  /**
   * Which action a `StepRequested` is about, so a fixture can refuse one append
   * and not every one. `claim`'s take is the first the pipeline writes since
   * `#269`, and the two cases below are about different halves of that.
   */
  const requestedFor = (event: ToAppend): string =>
    (event.data as { action?: string }).action ?? "";

  /**
   * **A store that refused an append is not a step's verdict about the change.**
   *
   * `appendNow` says a store that will not append is a defect and that the
   * handler at the bottom is where defects are answered for, and that was true
   * of every append the old engine made. The swap to `pass.ts` quietly made it
   * false for the ones made from inside the walk: `runActionPipeline` does not
   * wrap `emit`, so the rejection propagates into `runStep`, which catches
   * whatever a step throws and reports *did-not-finish: threw*. `merge` is not
   * in `ARRIVE_AT_THE_ROUTER`, `outcomeOf` reads `blocked`, and a dropped
   * Postgres connection — the disconnect CLAUDE.md documents against `#157` —
   * came back as an item parked on *Waiting on you* with a diagnosis naming a
   * step that did its work, the verdict it was recording lost.
   *
   * So the item goes back to the queue instead, which is what the same rejection
   * did before the swap: the queue takes it again after the backoff and nobody
   * is asked to acknowledge a database blip. The append in reach of this fixture
   * is the pipeline's own `StepRequested` for the person declared at `proposed` —
   * it is `emit`'s, from inside the walk, which is the whole class.
   *
   * **Named rather than *any* `StepRequested`, since `#269`**, and the sibling
   * below is why: `claim`'s work is a `queue:` action now, so the first row `emit`
   * writes is the take's — *before* the item is claimed, where a release is
   * another conductor's item given back. That is a different rule, so it is a
   * different case.
   */
  it("releases the item when the store refused an append the pass made, rather than holding a person", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const refusing: typeof store = {
      ...store,
      append: async (streamId: string, expected: number, events: readonly ToAppend[]) => {
        if (events.some((e) => e.type === "StepRequested" && requestedFor(e) === "approval")) {
          throw new Error("terminating connection due to administrator command");
        }
        return store.append(streamId, expected, events) as Promise<Envelope[]>;
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, HUMAN_BEFORE_THE_LANE),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store: refusing,
      },
      fakePorts(did, refusing, true),
    );

    // The defect channel, and not a step's ending believed.
    expect(result).toMatchObject({ ok: false, stage: "unexpected" });
    expect((result as { detail: string }).detail).toContain("terminating connection");

    const types = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(types).toContain("WorkItemReleased");
    // Nobody is waiting on a person over a database blip.
    expect(types).not.toContain("WorkItemBlocked");
    // And the issue says so: `lingtai:working` is off it again, which is what a
    // whole-set write of `labelsFor("queued")` — no label of Lingtai's — leaves.
    expect(said.filter((line) => line.startsWith("labels #7"))).toEqual([
      "labels #7 bug,lingtai:working",
      "labels #7 bug",
    ]);
  });
  /**
   * **A run that took nothing releases nothing** (`#269`).
   *
   * The sibling above's rule, at the one step where it inverts. `claim`'s work is
   * a `queue:` action, so the first thing `emit` writes is that action's
   * `StepRequested` — **before** `claimWorkItem` has appended anything. A dropped
   * connection there is the same defect, and `release` is the same handler, but
   * what it would give back is an item this run never held: `releaseWorkItem`
   * appends whoever holds it, so `WorkItemReleased` lands on **another
   * conductor's live item** and `lingtai:queued` goes over its `lingtai:working`
   * while its agent is still working. That is the failure `#268` named when it
   * moved the reviewer's settings below the claim, arriving here through the step
   * whose own work moved above it.
   *
   * So: the item's stream is untouched and its labels are not written. The defect
   * is still reported — a store that will not append is a fact about this machine
   * and the run says so.
   */
  it("appends nothing to an item it never claimed, when the take's own row was refused", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const refusing: typeof store = {
      ...store,
      append: async (streamId: string, expected: number, events: readonly ToAppend[]) => {
        if (events.some((e) => e.type === "StepRequested" && requestedFor(e) === "take the ticket")) {
          throw new Error("terminating connection due to administrator command");
        }
        return store.append(streamId, expected, events) as Promise<Envelope[]>;
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, HUMAN_BEFORE_THE_LANE),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store: refusing,
      },
      fakePorts(did, refusing, true),
    );

    expect(result).toMatchObject({ ok: false, stage: "unexpected" });
    expect((result as { detail: string }).detail).toContain("terminating connection");

    // Nothing was claimed, so nothing is released and nothing is blocked — the
    // stream is as empty as it was before the pass started.
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
    // And the issue is not relabelled, either to `lingtai:working` or back out of
    // it: a whole-set write here is the one that would stamp on somebody else.
    expect(said.filter((line) => line.startsWith("labels #7"))).toEqual([]);
  });

  /**
   * **And the route's own row is the one append that must never cost the ending
   * it describes** (`#271`).
   *
   * It is the opposite rule to the one above, for the opposite kind of append.
   * A verdict lost is a pass whose report is a lie, so it is raised; a route lost
   * is an explanation missing from a pass that happened, and on a landing it is
   * the **only** store write between `runPass` returning and the atomic
   * `WorkItemLanded` + `endPlan` — `publishWhatIsCommitted` is skipped when the
   * change went in. Raised there, a dropped connection on a purely informational
   * row would release an item whose branch is already on `main`, leave `end`'s
   * plan unresolved, tell GitHub nothing, and hand the ticket to a second pass
   * that reworks a merged change.
   *
   * So the row is appended with `appendAt` and its refusal is said rather than
   * raised — `noteRefs`' rule, *the account never costs the thing it is an
   * account of* — and this is the test that a route nobody can read back is all
   * that is lost. The pass routes because the lane refuses `verify-failed` once,
   * which is the mechanical round `BUILT_IN_FOR` answers, and lands on the round
   * it bought.
   */
  it("lands though the store refused the row that says why it bought a round", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const refusing: typeof store = {
      ...store,
      append: async (streamId: string, expected: number, events: readonly ToAppend[]) => {
        if (events.some((e) => e.type === "PassRouted")) {
          throw new Error("terminating connection due to administrator command");
        }
        return store.append(streamId, expected, events) as Promise<Envelope[]>;
      },
    };

    const ports = fakePorts(did, refusing, true);
    /** The lane refuses once — the one reason a round is bought for — and then merges. */
    let lane = 0;
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push("integrate");
        lane += 1;
        return lane === 1
          ? ({ ok: false, reason: "verify-failed", detail: "the base moved under it" } as never)
          : ({ ok: true, mergeCommit: "c".repeat(40) } as never);
      });
    // And the agent the round buys commits something, or the pass stops at
    // `implement` with nothing to merge and never reaches the lane again: the
    // fixture's `rev-parse` answers one sha for ever, and a round that left the
    // head where it was is a round with no diff in it (`fix round 1: no commit`).
    const git = ports.repo.git;
    ports.repo.git = (args, o) =>
      args[0] === "rev-parse" && lane > 0 ? Effect.succeed("d".repeat(40)) : git(args, o);

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
        store: refusing,
      },
      ports,
    );

    // The change went in, which is the whole assertion: the ending survived the
    // refusal of the row about it.
    // Say what it actually did first, as the hold above does, so a stop names its
    // step rather than reading as a mismatched object.
    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, mergeCommit: "c".repeat(40) });
    expect(lane).toBe(2);

    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemLanded");
    expect(item).not.toContain("WorkItemReleased");

    // The row is not on the run's stream, and the run log says so in the words a
    // person reading a trace gets — which is all that was lost.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    expect(run.map((e) => e.type)).not.toContain("PassRouted");
    expect(
      did.some((line) => line.startsWith("note route merge \u2192 implement:") && line.includes("same-worktree")),
    ).toBe(true);
    expect(did.some((line) => line.startsWith("note route the 1 route(s) were not appended"))).toBe(true);
  });

  /**
   * **The cut is a plugin's, and the three shapes a recipe can be in cut the same
   * tree** (`#268`, [0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md)
   * §2–4).
   *
   * This is the wiring `pass-steps.test.ts` cannot see: `defaultsAt` is
   * `conduct.ts`'s and so is the `cut` that every one of the three reaches. The
   * three rows are the migration, in order — what a recipe says today (`admit:
   * []`, in both recipes on this machine), what a recipe that never mentioned the
   * step says, and the block `#268` tells a person to paste.
   *
   * **`[]` and an omitted key are the same at this seam and both cut**, which is
   * the safe direction and the reason the paste is optional: 0065 §2's *`[]` runs
   * nothing* needs a refusal on the file's own bytes before it can mean anything,
   * and until then a diff that read `[]` as *cut nothing* would have stopped every
   * pass on this machine at the first step that needs a tree.
   */
  it.each([
    { what: "`admit: []`, as both recipes on this machine have it", steps: cutAtAdmit("[]") },
    { what: "no `admit:` key at all", steps: RECIPE },
    {
      what: "the `worktree:` block a person pastes",
      steps: cutAtAdmit("\n    - name: cut the branch\n      worktree: { base: main, submodules: false }"),
    },
  ])("cuts from origin/main with $what", async ({ steps }) => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub([], steps),
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

    expect(did).toContain("cut from origin/main");
    expect(did.filter((line) => line.startsWith("cut from"))).toHaveLength(1);
    expect(did).toContain(`provision ${result.runId}`);
  });

  /**
   * **A hold composes and a default substitutes, and at `merge` the order is what
   * that means** (0065 §3, `#270`).
   *
   * `--no-merge` and a pending repair are `human:` actions `conduct.ts` appends
   * (#20), and while the landing happened in `merge`'s *body* they could go at the
   * end of the list: the body ran after the whole pipeline, so a hold anywhere in
   * it stopped the merge. Since the lane is an action, appending after it would
   * merge the branch and *then* ask a person whether to — `#58` reached by the
   * refactor that was supposed to make `#58` impossible.
   *
   * `heldBeforeTheLane` is the placement, and **the lane a person wrote out is the
   * case that makes it necessary**: `merge: [land the branch]` plus `--no-merge`
   * would, under an append, run the lane and then ask. So the hold is inserted
   * ahead of whatever has `kind === "merge"`, found by kind rather than by position,
   * and the assertion is that `integrate` was never reached at all.
   *
   * The other branch — no lane in the list — is what `alsoHeldAtMerge` falls back to
   * appending for, and since `#270` only a recipe that declares a *check* at
   * `merge:` and nothing that lands can be in that shape. Such a recipe does not
   * merge either way (§2: a default substitutes), so the append cannot put a hold
   * after a landing there.
   */
  it("asks before a lane the recipe declared itself, under --no-merge", async () => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(
          [],
          landAtMerge("\n    - name: land the branch\n      merge: { strategy: merge-commit }"),
        ),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // The recipe lands, and the flag says not this time.
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      // `true`, so a pipeline that let the hold past would really call the lane.
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    if (result.ok !== "held") throw new Error("it merged, and --no-merge had been passed");
    expect(result.step).toBe("merge");
    // **The whole of it**: the declared lane is in the list, the injected hold is
    // ahead of it, and nothing reached the base branch.
    expect(did).not.toContain("integrate");
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).not.toContain("WorkItemLanded");

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const asked = run.filter((e) => e.type === "ApprovalRequested");
    expect(asked.map((e) => (e.data as { action: string }).action)).toEqual(["no-merge"]);
  });

  /**
   * **The lane is a plugin's, and the three shapes a recipe can be in land the same
   * branch** (`#270`, [0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md)
   * §2–3, §6).
   *
   * `cuts from origin/main with $what`'s sibling one step from the end, and the more
   * expensive of the two to get wrong: 0065 §6 names this repository's own
   * `merge: []` as the migration trap, because under the substitution rule the same
   * three characters could mean *do not merge* and the failure would be silent — a
   * board showing a step that ran nothing and a branch that never landed.
   *
   * So the three rows are the migration in order — what both recipes on this
   * machine say today, what a recipe that never mentioned the step says, and the
   * block `#270` tells a person to paste — and every one of them reaches
   * `integrate` and records the landing.
   */
  it.each([
    { what: "`merge: []`, as both recipes on this machine have it", steps: landAtMerge("[]") },
    { what: "no `merge:` key at all", steps: RECIPE },
    {
      what: "the `merge:` block a person pastes",
      steps: landAtMerge("\n    - name: land the branch\n      merge: { strategy: merge-commit }"),
    },
  ])("lands onto main with $what", async ({ steps }) => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub([], steps),
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

    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`);
    // Once, and by the lane: two `integrate` calls would be 0065 §7's half-migrated
    // step, which at this one is the branch on `main` twice.
    expect(did.filter((line) => line === "integrate")).toHaveLength(1);
    expect(result.mergeCommit).toBe("c".repeat(40));
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemLanded");
  });

  /**
   * **A declared `merge:` produces a verdict**, which is `#268`'s first major
   * finding asserted for the second plugin to be wired (0065 §5).
   *
   * A declaration recorded in `StepsResolved` as planned and then producing nothing
   * is the `never-ran` mark the board reserves for Lingtai's own bug (0016 §4). The
   * step runs what is declared there, so the pair below is the whole proof: the
   * lane was planned, and it ran.
   */
  it("records a declared `merge:` as planned and then passes it", async () => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(
          [],
          landAtMerge("\n    - name: land the branch\n      merge: { strategy: merge-commit }"),
        ),
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

    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`);
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const planned = run.find((event) => event.type === "StepsResolved");
    expect(JSON.stringify(planned?.data)).toContain("land the branch");
    const verdicts = run
      .filter((event) => event.type === "StepStarted" || event.type === "StepPassed")
      .map(
        (event) =>
          `${event.type} ${(event.data as { step: string; action: string }).step}:${(event.data as { action: string }).action}`,
      );
    expect(verdicts).toContain("StepStarted merge:land the branch");
    expect(verdicts).toContain("StepPassed merge:land the branch");
  });

  /**
   * **A declared `design:` produces a verdict too**, and it is the first step whose
   * default is nothing (`#265`, 0065 §4).
   *
   * The same claim as the case above and worth making again here, because `design`
   * is the one opening where *declared and never run* could not be caught by the
   * step doing nothing: an unconfigured `design` runs nothing and passes, which is
   * exactly what a resolved-but-unwired declaration looks like from outside. So the
   * pair is the proof — the drafting action is in `StepsResolved` as planned, and it
   * produced a verdict of its own — and the run log line is the third thing,
   * because it is the only evidence in `did` that a *runtime* was dispatched rather
   * than a cell drawn on the board (0016 §4, and `#61`).
   *
   * **And the document is on the verdict *and* in the implementer's prompt.**
   * `evidence` is what a person reads off the card; the string the next agent works
   * from travels on the step's ending (`pass-steps.ts`'s `designOn`) and into
   * `renderPrompt`. The second half is the one that had nothing asserting it and
   * nothing doing it: `Brief.design` existed from the day the brief did and the
   * dispatch never read it, which is an agent run a recipe pays for and no reader
   * sees — `#61`'s silence with the money spent before it.
   */
  it("drafts at `design` when the recipe declares one, and hands it to the implementer", async () => {
    const store = memoryStore();
    const did: string[] = [];
    /** Every prompt dispatched, so the implementer's can be read back. */
    const prompts: { runId: string; prompt: string }[] = [];
    const drafting: Runtime = {
      ...runtime,
      run: async (request) => {
        prompts.push({ runId: request.runId, prompt: request.prompt });
        return {
          exitCode: 0,
          turns: 3,
          durationMs: 1234,
          costUsd: 0.42,
          failure: null,
          // The document at `design`, and the implementer's decline message
          // everywhere else — one runtime, as `runOnce` has (`one-pass.ts`).
          text: "Put it in `packages/recipe`, beside `whyNoKindAt`.",
          sessionId: "sess-1",
        };
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([], DRAFTED),
        runtime: drafting,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    if (result.ok !== true) throw new Error(`did not land: ${JSON.stringify(result)}`);
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const planned = run.find((event) => event.type === "StepsResolved");
    expect(JSON.stringify(planned?.data)).toContain("draft");
    const passed = run.find(
      (event) =>
        event.type === "StepPassed" && (event.data as { step: string }).step === "design",
    );
    expect(passed?.data).toMatchObject({ step: "design", action: "draft" });
    // The document, and a person's sentence about what it cost beside it.
    expect((passed?.data as { evidence: string }).evidence).toContain("beside `whyNoKindAt`");

    /**
     * **And the implementer was handed it**, which is the half nothing did before.
     *
     * Told apart by the run id, as the runtime above is: the drafting dispatch runs
     * under `<runId>:design:<name>` so its session cannot be the implementer's, so
     * the run's own id is the implementing one.
     */
    const implementing = prompts.find((each) => each.runId === result.runId);
    expect(implementing, `no dispatch under ${result.runId}: ${JSON.stringify(prompts)}`).toBeDefined();
    expect(implementing!.prompt).toContain("## The design, written for this run before any code");
    expect(implementing!.prompt).toContain("beside `whyNoKindAt`");
    // The ticket is still what was asked for, which is what the block says it is.
    expect(implementing!.prompt).toContain("the ticket is what was asked for");
    // A runtime was dispatched, under an id of its own so the session cannot be
    // the implementer's (`createDraftAction`) — and the run log says so under the
    // pipeline's own `<step>:<action>` tag.
    expect(
      did.some((line) => line.startsWith("note design:draft") && line.includes("drafting for #7")),
    ).toBe(true);
    // And the implementer still ran and still left the receipt, which is the half
    // 0065 §7 is about: the step before it does not stand in for one.
    expect(run.map((e) => e.type)).toContain("RunProposedCompletion");
  });

  /**
   * **A design agent can ask, and the question reaches a person** (`#294`,
   * 0058 §3c).
   *
   * The clause was decided, drawn and routed for and nothing could produce the
   * token: `ARRIVE_AT_THE_ROUTER` carries `design`, `goesToTheRouter` admits a
   * question, `the-pass.py` draws the fan — and `createDraftAction` had three
   * branches, none of which set it. So a design agent that found the ticket
   * unanswerable wrote its doubts into the document and handed them to the
   * implementer, which is the one reader that cannot answer them.
   *
   * **This is the whole path and not the action's branch**, which is what makes it
   * worth a pass: the answer is parsed, the pipeline reads `NEEDS_INPUT` and
   * answers `askedAt`, `endingOf` reports `asked` and `StepAsked` is on the log,
   * the loop lets it past `goesToTheRouter`, `directionOf` calls it a
   * `needs-input`, `BUILT_IN_FOR` has no built-in for one, and `DRAFTED` declares
   * no `judge:` — so a person is the floor `#253` set, and what they are handed is
   * the question.
   *
   * **`StepAsked` and not `StepDidNotFinish`** (`#296`). The two shared an event
   * until the ending split, so the one row on this stream that says *a person is
   * being asked something* read *did not finish* — the same sentence a crashed
   * reviewer writes.
   *
   * **Asserted on `events` and never on the run log** (0034): a run log is a trace
   * kept only while something is owed an explanation, and a question a person has
   * to answer outlives it.
   */
  it("carries a design agent's question to a person when nothing at `proposed` answers it", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const asked =
      "The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?";
    /** Answers a question at `design` and a document nowhere — `design` is all `DRAFTED` declares. */
    const asking: Runtime = {
      ...runtime,
      run: async (request) =>
        request.runId.includes(":design:")
          ? {
              exitCode: 0,
              turns: 2,
              durationMs: 1234,
              costUsd: 0.21,
              failure: null,
              text: `\`\`\`question\n${asked}\n\`\`\``,
              sessionId: "sess-design",
            }
          : {
              exitCode: 0,
              turns: 3,
              durationMs: 1234,
              costUsd: 0.42,
              failure: null,
              text: "done",
              sessionId: "sess-1",
            },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([], DRAFTED),
        runtime: asking,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    // The step that stopped it is `design` and not the router: what a person reads
    // is the step that did not pass, and where it was sent is `routes` (`take`).
    expect(result).toMatchObject({ ok: "held", step: "design" });

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const stopped = run.find((e) => e.type === "StepAsked")!;
    // The token is not on this event — it is what the *action* said, and what the
    // log carries is the words. The routing it bought is the assertion below.
    expect(stopped.data).toMatchObject({ step: "design", action: "draft" });
    expect((stopped.data as { detail: string }).detail).toBe(asked);
    // And the event a crash writes is not on this stream at all, which is the
    // whole of what the split bought a reader of it.
    expect(run.filter((e) => e.type === "StepDidNotFinish")).toEqual([]);

    // **And a person has it.** `WorkItemBlocked` is what the card reads, and
    // `raw` is the arriving step's own detail — the question, whole.
    const blocked = (await store.read(`wi-${PROJECT}-7`)).find((e) => e.type === "WorkItemBlocked")!
      .data as { needs: string; question: string; diagnosis: { raw: string } };
    expect(blocked.diagnosis.raw).toBe(asked);
    expect(blocked.question).toContain(asked);
    // **And what it needs is a judgement, not an acknowledgement** (the fix
    // round). `describeHold` renders this field as the hold's first line, and
    // *a failure needs acknowledging* is the wrong sentence over a step that did
    // not fail and is waiting for an answer.
    expect(blocked.needs).toBe("judgement");

    // Nothing was written and nothing landed: a question costs the pass and no
    // round, which is the half 0058 §3b calls *arriving at the router and refusing
    // are different things*.
    expect(run.map((e) => e.type)).not.toContain("RunProposedCompletion");
    expect(did).not.toContain("integrate");
  });

  /**
   * **A commit made before `implement` is not `implement`'s receipt** (`#265`, 0057
   * §2).
   *
   * `firstDispatch` read *the agent committed something* as `HEAD !== tree.baseSha`,
   * which is the same commit only while `implement` is the first step that can
   * write one. `agentPlugin` serves `design` now: the drafting agent runs in this
   * same worktree, unhooked and writable, and the prompt asking it not to commit is
   * the only thing between it and one — a prompt, not a guard.
   *
   * Left as it was, the pass below would have **passed** `implement`: `HEAD` is past
   * the base, so the receipt check skips, `RunProposedCompletion` names the commit
   * the implementer did not make, `build` and `review` run green on a branch holding
   * a design note, and with `merge: []` on this machine nothing holds it. The
   * fixture is that pass — a tree already past the base at `implement`, and an
   * implementer that commits nothing — and what it must produce is the stop.
   */
  it("does not read a commit made before `implement` as the implementer's receipt", async () => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub([], DRAFTED),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      // `provision` cuts at `a`*40 and the tree is at `d`*40 when `implement`
      // starts: the step before it committed. The implementer does not.
      fakePorts(did, store, true, { at: "d".repeat(40), implementerCommits: false }),
    );

    // The drafting step is the one that ran and passed — the setup this is about,
    // not a pass that failed earlier for some other reason.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    expect(
      run.some(
        (e) => e.type === "StepPassed" && (e.data as { step: string }).step === "design",
      ),
    ).toBe(true);

    // And `implement` stops, because *this* agent left no receipt. Held rather
    // than released: 0057 §2's class buys no round and asks a person, and there is
    // nothing about the account here for the conductor to stand down over.
    expect(result).toMatchObject({ ok: "held", step: "implement" });
    const blocked = (await store.read(`wi-${PROJECT}-7`)).find(
      (e) => e.type === "WorkItemBlocked",
    )!.data as { needs: string; diagnosis: { raw: string } };
    expect(blocked.needs).toBe("acknowledgement");
    expect(blocked.diagnosis.raw).toContain("produced no commits");
    // The claim that would have been false: nothing proposes the drafting agent's
    // commit as this run's completion, and nothing lands.
    expect(run.map((e) => e.type)).not.toContain("RunProposedCompletion");
    expect(did).not.toContain("integrate");
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).not.toContain("WorkItemLanded");
  });

  /**
   * **A declared `worktree:` produces a verdict, which is `#268`'s first major
   * finding closed** (0065 §5).
   *
   * It used to be recorded in `StepsResolved` as planned and then produce nothing
   * at all: no `StepStarted`, no `StepPassed`, no waiver. So a landed item had a
   * point the log said was configured and never ran, and the board drew it
   * `never-ran` — hatched in the fail colour, titled *configured and did not run,
   * which is Lingtai's bug* (0016 §4). That mark is reserved for Lingtai's own bug
   * and would have been permanently on, on every landed run, for every operator
   * who followed this ticket's own instructions.
   *
   * The step runs what is declared there now, so the verdict exists by
   * construction. `admit:cut the branch` is the key `task_view` and the board both
   * use, and the pair below is the whole proof: it was planned, and it ran.
   */
  it("records a declared `worktree:` as planned and then passes it", async () => {
    const store = memoryStore();
    const did: string[] = [];

    await once(
      {
        project,
        client: fakeGitHub([], cutAtAdmit("\n    - name: cut the branch\n      worktree: { base: main, submodules: true }")),
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

    // The declaration is what reached the cut, submodules included — the value
    // `repo.submodules: false` two blocks up no longer answers for it.
    expect(did).toContain("cut from origin/main with submodules");

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const planned = run.find((event) => event.type === "StepsResolved");
    expect(JSON.stringify(planned?.data)).toContain("cut the branch");
    const verdicts = run
      .filter((event) => event.type === "StepStarted" || event.type === "StepPassed")
      .map((event) => `${event.type} ${(event.data as { step: string; action: string }).step}:${(event.data as { action: string }).action}`);
    expect(verdicts).toContain("StepStarted admit:cut the branch");
    expect(verdicts).toContain("StepPassed admit:cut the branch");
  });

  /**
   * **The judge the recipe declared is asked, and the round it asks for is
   * bought** (`#274`).
   *
   * This is the only test that can say the *wiring* holds, which is this file's
   * whole subject: `conduct.ts`'s `ports.judge` is
   * `judgeDeclaredAt(recipe.steps.proposed, on.when) ?? { noJudge: true }`, and
   * everything either side of that line is asserted elsewhere — the lookup in
   * `judge.test.ts`, what the body does with the answer in `pass-steps.test.ts`.
   * Neither of them can see whether the conductor hands the recipe's own
   * `proposed:` list to it, and a port that answered `noJudge` for ever would pass
   * both: `findings` has no built-in, so the pass would park at `waiting` exactly
   * as `#267` and `#263` did with `rounds: 3` unspent.
   *
   * So what is asserted is the round: **two agents implemented, one review
   * refused each of them, and the route that joins them names the line of the
   * recipe that chose.** The second refusal has no round left and reaches a
   * person, which is the ceiling still bounding a declared judge (0064 §7).
   */
  it("buys the round a declared judge asked for, from the recipe's own `proposed:`", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);

    /** How many times each of the two agents ran, told apart by the run id. */
    const ran = { implement: 0, review: 0 };
    const counting: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        const reviewing = request.runId.includes(":review:");
        ran[reviewing ? "review" : "implement"] += 1;
        return refusingRuntime.run(request);
      },
    };
    // The round's agent has to commit something, or the pass stops at `implement`
    // with nothing to review: the fixture answers one sha for ever, and a round
    // that left the head where it was is a round with no diff in it.
    const git = ports.repo.git;
    ports.repo.git = (args, o) =>
      args[0] === "rev-parse" && ran.review > 0 ? Effect.succeed("d".repeat(40)) : git(args, o);

    const result = await once(
      {
        project,
        client: fakeGitHub(said, JUDGED),
        runtime: counting,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    // The round was bought: a second implementing agent ran, and a second review
    // read what it wrote.
    expect(ran).toEqual({ implement: 2, review: 2 });

    // And the route says who chose, by the name of the entry in the recipe — the
    // line a person edits, not the built-in a person would have to grep for.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const routed = run.filter((e) => e.type === "PassRouted").map((e) => e.data as {
      from: string;
      to: string;
      chose: string;
      why: string;
      ceiling: string | null;
    });
    expect(routed.map((row) => `${row.from} \u2192 ${row.to}`)).toEqual([
      "proposed \u2192 implement",
      "proposed \u2192 waiting",
    ]);
    expect(routed[0]!.why).toContain('"the lines, until the rounds are spent" judge');
    expect(routed[0]!.why).toContain("the recipe declares `judge: same-worktree`");
    expect(routed[0]!.ceiling).toBeNull();
    // The second arrival wanted the same round and there was none: a declared
    // judge is bounded by the workflow's numbers and never above them (0064 §7).
    expect(routed[1]).toMatchObject({ chose: "implement", to: "waiting", ceiling: "rounds" });

    // So the pass rests with a person at the router, and the item says so.
    expect(result).toMatchObject({ ok: "held", step: "proposed" });
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemBlocked");
  });

  /**
   * **And a declared *runtime* judge is dispatched, twice on one pass** (`#277`).
   *
   * The case above is the built-in, where `ports.judge` answers a name and
   * nothing is spent. This is the other half of the same line, and it is the only
   * test that can see it: `judgeDeclaredAt` answering a `runtime` is asserted in
   * `judge.test.ts` and what the body does with a `next` is asserted in
   * `pass-steps.test.ts`, and neither can say whether the conductor actually
   * dispatches one.
   *
   * **The session id is the thing this fixture exists for.** Two rounds means two
   * arrivals at `findings` on one pass, and a session id built from the direction
   * alone would be the same string both times — which Claude Code refuses by name
   * (*Session ID … is already in use*), for one second, with the round spent and
   * the question never read. That is `#195` exactly, and the crash was its lucky
   * outcome: a runtime that *resumed* instead would answer the second arrival
   * with the first one's context, which is a judge asked whether it still agrees
   * with itself.
   *
   * **And the third arrival is not bought at all.** With both rounds spent and no
   * restart, `waiting` is the only step on offer, and paying a model to pick the
   * only item on a list has judged nothing.
   */
  it("dispatches a runtime judge, with a session of its own each time it is asked", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);

    const ran: string[] = [];
    const judging: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        ran.push(request.runId);
        if (!request.runId.includes(":judge:")) return refusingRuntime.run(request);
        // The judge reads the findings and answers in the pass's own vocabulary;
        // `implement` is *the lines*, which is the round the arrival can pay for.
        return {
          ...(await refusingRuntime.run(request)),
          text: '```json\n{"next": "implement", "why": "the seam is right, two of its lines are wrong"}\n```',
        };
      },
    };
    // **A different head per round**, or the second one is a round with no diff
    // in it: `conduct.ts` only continues the loop where the fixing agent
    // committed, and the fixture answers one sha for ever. The judgements are
    // what count the rounds here, because each is asked before the round it buys.
    const git = ports.repo.git;
    ports.repo.git = (args, o) => {
      const rounds = ran.filter((id) => id.includes(":judge:")).length;
      return args[0] === "rev-parse" && rounds > 0
        ? Effect.succeed(`${"d".repeat(39)}${rounds}`)
        : git(args, o);
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, JUDGED_BY_AN_AGENT),
        runtime: judging,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    // Asked twice — once per arrival that had something to choose between — and
    // never with the same session, which is the whole of the case.
    const asked = ran.filter((id) => id.includes(":judge:"));
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(2);
    for (const id of asked) expect(id).toContain(":judge:findings:");

    // The round each answer asked for was bought: three agents implemented and
    // three reviews read what they wrote.
    expect(ran.filter((id) => id.includes(":review:"))).toHaveLength(3);

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const routed = run
      .filter((e) => e.type === "PassRouted")
      .map((e) => e.data as { to: string; chose: string; why: string; ceiling: string | null });
    expect(routed.map((row) => row.to)).toEqual(["implement", "implement", "waiting"]);
    // The judge's own words are on the card, with what they cost beside them —
    // `PassRouted.why` is the record, because there is no event of its own.
    expect(routed[0]!.why).toContain("two of its lines are wrong");
    expect(routed[0]!.why).toContain("5 turns");
    // And the third was never asked: nothing was on offer to choose between.
    expect(routed[2]!.why).toContain("the only step on offer");
    expect(routed[2]!.ceiling).toBeNull();

    expect(result).toMatchObject({ ok: "held", step: "proposed" });
  });

  /**
   * **Two runtimes in one pass** — the claim `#314` exists to be testable by,
   * and the one thing a single working runtime could not show
   * ([0070](../../../doc/decisions-archive/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md)
   * §7).
   *
   * `runtime.agent: claude-code` writes the change; `review`'s own `agent: codex`
   * reads it, bounded by a `limits:` of its own and asked for a model of its own.
   * Until this ticket that recipe was **refused before the claim** — the honest
   * answer while per-step dispatch was a placeholder — so the assertion that the
   * pass gets past `stage: "recipe"` at all is half of what is being proved.
   *
   * Three things are asserted and each is a different failure:
   *
   * - **who ran what.** The reviewer is `codex` and the implementer is not, which
   *   is the whole feature; a `runtimeFor` that answered the default would pass
   *   every other assertion here.
   * - **`RunStarted.runtime` is the implementer's.** That field answers *which
   *   runtime wrote this*, and a pass whose review runs elsewhere must not
   *   relabel the run.
   * - **the bound is the entry's.** `limits: { turns: 4 }` narrows the ceiling's
   *   10 for that one call and leaves the implementer at 10 — the substitution
   *   `spendFor` makes, field by field, so a `turns` without a `wall` keeps the
   *   pass's wall.
   */
  it("dispatches the runtime a step named, with that step's own model and bound", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const asked: { id: string; model: string | undefined; turns: number }[] = [];
    const recording = (id: "claude-code" | "codex"): Runtime => ({
      capabilities: { ...runtime.capabilities, id },
      run: async (request) => {
        asked.push({ id, model: request.model, turns: request.limits.turns });
        return runtime.run(request);
      },
    });
    const claude = recording("claude-code");
    const codex = recording("codex");

    const result = await once(
      {
        project,
        client: fakeGitHub([], TWO_RUNTIMES),
        runtime: claude,
        // The factory, and the whole of what a second runtime costs a caller.
        // Production hands `createRuntime`; this hands a fake that records.
        runtimeFor: () => codex,
        // `codex` is named at a step, so the pass asks what this machine has.
        // Answered rather than probed: a probe is a process (0060 §1).
        signedIn: async () => ["codex"],
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );
    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);

    // The implementer ran on the pass's own runtime at the ceiling's turns; the
    // reviewer ran on the one its line named, at its own.
    expect(asked).toEqual([
      { id: "claude-code", model: undefined, turns: 10 },
      { id: "codex", model: "gpt-5-codex", turns: 4 },
    ]);

    // And the log says which runtime wrote the change, which is still the first.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const started = run.find((e) => e.type === "RunStarted")!.data as { runtime: string };
    expect(started.runtime).toBe("claude-code");
  });

  /**
   * **A `judge:` names a model, and the dispatch uses it** — the measurement
   * 0070 §2 is built on: on `#300` the judgement answered in one turn for $0.42
   * beside an `implement` of 150 turns and $22.56, and it was the cheap call with
   * no way to ask for a cheap model.
   *
   * The model is asserted twice on purpose. Once on the request, which is the
   * feature; and once on `PassRouted.why`, which is the *record* — a judge has no
   * event of its own by decision (*what it cost is in the sentence*), so a model
   * the sentence does not carry is a saving nobody can prove afterwards.
   */
  it("buys a judgement from the model the judge: named, and says which", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const models: (string | undefined)[] = [];
    const judging: Runtime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(":judge:")) return refusingRuntime.run(request);
        models.push(request.model);
        return { ...(await refusingRuntime.run(request)), text: "implement — the lines are fixable" };
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([], JUDGED_BY_A_CHEAP_AGENT),
        runtime: judging,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );
    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);

    expect(models).toEqual(["haiku"]);
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const routed = run.filter((e) => e.type === "PassRouted").map((e) => e.data as { why: string });
    expect(routed[0]!.why).toContain("claude-code (haiku)");
  });
});
