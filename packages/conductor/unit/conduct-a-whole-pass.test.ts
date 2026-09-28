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
 * Unit by [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import type { Envelope, ToAppend } from "@lingtai/domain";
import { STEPS } from "@lingtai/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  HUMAN_AT_MERGE,
  JUDGED,
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
    expect(did.indexOf("smokeTest")).toBeLessThan(did.indexOf("git rev-parse"));
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
   * **A person declared at `merge` holds it, with no `--no-merge` anywhere** —
   * `#58`, and the claim `CLAUDE.md` rests on when it says this repository merges
   * its own work unattended *by configuration rather than by a gap*.
   *
   * It was pinned by the old engine's own integration test — *holds at a human
   * action at the merge point, with no --no-merge anywhere* — which `#256`
   * deleted along with the engine it tested. The flag is a `createHumanAction` injected after
   * `merge`'s declared list now (#20), so **a test that passes `merge: false`
   * cannot make this claim at all**: it exercises the injected action and says
   * nothing about the declared one. That is exactly how `#58` stayed hidden for
   * four days — every test held its run with the flag, and the daemon does not
   * pass it.
   *
   * So the recipe is the only thing asking, `merges` is `true` on the fake so a
   * pipeline that let this past would really call the lane, and the assertion is
   * that it was never called.
   */
  it("holds at a human action declared at the merge point, with no --no-merge anywhere", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, HUMAN_AT_MERGE),
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
    if (result.ok !== "held") throw new Error("it merged, and a person had been declared at merge");
    expect(result.step).toBe("merge");
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
      step: "merge",
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
   * is asked to acknowledge a database blip. The one append in reach of this
   * fixture is the pipeline's own `StepRequested` for the person declared at
   * `merge` — it is `emit`'s, from inside the walk, which is the whole class.
   */
  it("releases the item when the store refused an append the pass made, rather than holding a person", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const refusing: typeof store = {
      ...store,
      append: async (streamId: string, expected: number, events: readonly ToAppend[]) => {
        if (events.some((e) => e.type === "StepRequested")) {
          throw new Error("terminating connection due to administrator command");
        }
        return store.append(streamId, expected, events) as Promise<Envelope[]>;
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, HUMAN_AT_MERGE),
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
   * tree** (`#268`, [0065](../../../doc/decisions/0065-the-default-is-a-plugin.md)
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
   * `heldBeforeTheLane` is the placement, and the two shapes are the two branches
   * of it. **The lane in the list** is the case above and the ordinary one: the
   * hold goes before it, and `holds at the merge` asserts `integrate` was never
   * reached. **No lane in the list** is this one — a recipe that declared a person
   * there and nothing that lands — where the flag's hold is appended after what the
   * recipe declared, which is where the old loop asked. Either way the recipe's own
   * actions run first and nothing reaches the base branch.
   */
  it("asks the recipe's own person first and still reaches no lane under --no-merge", async () => {
    const store = memoryStore();
    const did: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub([], HUMAN_AT_MERGE),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // Both are asking: the recipe declares a person, and the flag appends one.
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      // `true`, so a pipeline that let either past would really call the lane.
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    if (result.ok !== "held") throw new Error("it merged, and two people had been asked");
    expect(result.step).toBe("merge");
    expect(did).not.toContain("integrate");

    // The recipe's `approval` asked, and the flag's `no-merge` never had to: the
    // pipeline stops at the first action that does not pass, so the declared hold
    // is the one a person sees.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const asked = run.filter((e) => e.type === "ApprovalRequested");
    expect(asked.map((e) => (e.data as { action: string }).action)).toEqual(["approval"]);
  });

  /**
   * **The lane is a plugin's, and the three shapes a recipe can be in land the same
   * branch** (`#270`, [0065](../../../doc/decisions/0065-the-default-is-a-plugin.md)
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
});
