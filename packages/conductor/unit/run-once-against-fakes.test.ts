/**
 * A whole pass, against fakes, with no database — and in the gate.
 *
 * **This is the test `#68` said would decide whether the extraction happened.**
 * Its own words: *can `conductor` run a whole pass against a fake `repo`, a
 * fake `agent` and a fake `event-store`, with no database — producing the
 * events it wants appended and the calls it wants made, for a test to assert?*
 * Before the ports it could not: every one of this package's tests appends real
 * events, and the suite refuses to start without `LINGTAI_TEST_DATABASE_URL`.
 *
 * **It was in `integration/` for one `describe`**, and its own header said so
 * and said what to do about it: *this is the file a tag is for — the one that
 * is mostly unit and reaches out once — and splitting it, by a tag or by moving
 * that `describe` out, is the way the claims below come back to the gate.*
 * `#251` is the ticket that paid for leaving it: a fix for a failure that had
 * cost three runs would have been guarded by a project the `build` gate does
 * not run and CLAUDE.md forbids an agent from running while doing a ticket. So
 * that `describe` is `integration/run-once-against-the-machines-recipe.test.ts`
 * now, the fixtures are `test/one-pass.ts`, and everything here is unit by
 * [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no disk.
 *
 * **The clock is the exception, and it is reachable from here.** `standDown`
 * takes an optional `now` and `standDownConductor` passes none, so the two
 * stand-down tests below resolve *resets 11pm (America/Chicago)* against the
 * host's real clock. Nothing mocks it, so an assertion about the answer must be
 * true at every instant: `wallHourIn` asserts the hour *in the zone the message
 * named*, and an assertion on the UTC hour is one that fails for the four
 * months a year that zone is not in daylight time (`#251`).
 *
 * What it asserts is the *decision*: which events a held run appends, in order,
 * and that the worktree is removed on the way out. Not the git, not the socket
 * — those have their own tests, in the packages that own them.
 */
import type { GitHubClient } from "@lingtai/github";
import type { Runtime } from "@lingtai/agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RunPorts } from "../src/ports.ts";
import { nextPrompt } from "../src/prompt.ts";
import { runOnce } from "../src/run-once.ts";
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
  quotaRuntime,
  refusingRuntime,
  restartRecipe,
  reviewerAtTheWall,
  reviewerThatCrashes,
  runtime,
  streams,
} from "../test/one-pass.ts";

/**
 * The hour a stored instant reads on `zone`'s own wall clock.
 *
 * What these tests claim is what the runtime's message said — *11pm
 * (America/Chicago)* — and that claim is one hour, always. The instant it
 * resolves to is not: `parseResetAt` finds the next moment Chicago reads 23:00,
 * which is `04:00Z` in daylight time and `05:00Z` in standard time, so
 * `getUTCHours()` was an assertion that went red on the first Sunday in
 * November and green again on the second in March — and since these ran in
 * `integration/`, where nothing runs them while a ticket is worked, it would
 * have gone red in the `build` gate on every diff instead (`#251`).
 */
const wallHourIn = (zone: string, at: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit" }).format(
    new Date(at),
  );

describe("runOnce, with no world to run in", () => {
  it("holds at the merge, appends what it decided, and takes the worktree down", async () => {
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
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    // Say what it actually did before asserting, so a refusal names its stage
    // rather than reading as `false`.
    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result.ok).toBe("held");

    // The decision, as the log records it.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemClaimed");
    expect(item).toContain("WorkItemBlocked");
    // Told GitHub inline, and recorded that it did (0022 — no outbox).
    expect(item.filter((t) => t === "IssueUpdated").length).toBeGreaterThan(0);

    // `working` at the claim, `waiting` once a person is the thing being waited
    // on — and in that order, which is the whole of `#71`. `bug` survives both,
    // because a whole-set write takes the union with somebody else's labels.
    const labelWrites = said.filter((line) => line.startsWith("labels #7"));
    expect(labelWrites).toEqual(["labels #7 bug,lingtai:working", "labels #7 bug,lingtai:waiting"]);

    // The worktree is gone, and the integrator was never reached.
    expect(did).toContain(`provision ${result.runId}`);
    expect(did).toContain(`remove ${result.runId}`);
    expect(did).not.toContain("integrate");

    // The hook was wired and proved to fail closed before the agent started.
    expect(did.indexOf("smokeTest")).toBeLessThan(did.indexOf("git rev-parse"));
    // The socket was closed, by the scope and not by a `finally`, and before
    // the worktree it outlived — releases run in the reverse of acquisition.
    expect(did.indexOf("close")).toBeLessThan(did.indexOf(`remove ${result.runId}`));

    /**
     * **The log outlives the worktree, and a run that did not land keeps it.**
     *
     * Both halves of 0034 §2 and §4. The worktree is removed before the merge —
     * git refuses to update a ref some worktree has checked out — so a log
     * inside it would die before the run had an outcome, and the log worth
     * reading is always the one from the run that just failed. This one held at
     * the merge for a person: nothing landed, so nothing is deleted.
     */
    expect(did).toContain(`runLog /tmp/fake-home/runs/${PROJECT}/${result.runId}.log`);
    expect(did.indexOf(`remove ${result.runId}`)).toBeLessThan(did.indexOf("runLog keep"));
    expect(did).not.toContain("runLog delete");
    // And the hook socket's live view reached it — the callback that has
    // existed since the socket did and had no consumer until now.
    expect(did).toContain(`note run finished: 3 turns, 0.42 usd`);
  });

  /**
   * **Landed → delete**, which is the other half of the rule and the expensive
   * one to get wrong.
   *
   * `#84` cost $26.53 and, once landed, what it was thinking is gone. That is
   * accepted rather than regretted (0034 §4): the diff is on the branch and the
   * events are on the log, so an agent's account of a run that *worked* has the
   * least marginal value of anything here. What the rule buys is that no timer,
   * no sweeper and no retention period is needed — what survives on disk is
   * exactly the set somebody might have to explain.
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

    // The decision is taken *after* the integrator, which is the whole reason
    // this scope is wider than the worktree's: at the moment the worktree goes,
    // whether the run landed is not yet a fact about the world.
    expect(did.indexOf("integrate")).toBeLessThan(did.indexOf("runLog delete"));
    expect(did).not.toContain("runLog keep");
  });

  /**
   * **Where the scope starts is a decision**, and this is the assertion of it.
   *
   * 0024 recorded what the first conversion taught: a `Layer` is built where it
   * is provided, so a scope opened too early acquires what a refusal would have
   * made unnecessary — `lingtai run no-such-project` opening a Postgres
   * connection to say a project does not exist. `runOnce` refuses on the
   * recipe, the environment, the dispatch tier and the claim before it
   * provisions anything, and the way to prove that is not to read the file: it
   * is to reach a refusal and find that the worktree was never asked for.
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

  /**
   * **Eighty events in ninety-two seconds, answered once.**
   *
   * Six runs, six claims, six worktrees, six branches and `costUsd` of nothing
   * on every one of them — because per-item backoff was answering a condition
   * that was never about the item
   * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3). Each
   * attempt still releases its own item and keeps its place; what is asserted
   * here is that the *account-wide* answer is given once, on the first one, and
   * that the five after it leave the pause exactly as they found it.
   *
   * A `run-once` cannot prove the other half — that nothing is taken while the
   * pause holds — because it is the daemon's loop that asks. That is
   * `work-loop.test.ts`'s, and this is the half that appends.
   */
  it("pauses the conductor once, however many runs never start", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await once(
        {
          project,
          client: fakeGitHub(said),
          runtime: quotaRuntime,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          merge: false,
          home: "/tmp/fake-home",
          store,
        },
        fakePorts(did, store),
      );
      expect(result.ok, `attempt ${attempt + 1}`).toBe(false);
    }

    // Every run said what it was, in the vocabulary that is checkable. `crash`
    // is what all six of them said before, which is why the night was
    // unreadable from the log.
    const runs = [...streams(store)].filter(([id]) => id.startsWith("run-"));
    const endings = runs.flatMap(([, events]) =>
      events.filter((e) => e.type === "RunFailed").map((e) => (e.data as { kind: string }).kind),
    );
    expect(endings).toEqual(Array.from({ length: 6 }, () => "never-started"));

    // The items keep their place: each attempt released, as any failed run does.
    const item = await store.read(`wi-${PROJECT}-7`);
    const releases = item.filter((e) => e.type === "WorkItemReleased");
    expect(releases).toHaveLength(6);

    // **And each release says what happened, which is the card's whole line.**
    // `WorkItemReleased.reason` overwrites the note the projection wrote from
    // `RunFailed`, so `run failed: ${kind}` was where the reason stopped: the
    // prose was in the history and the card said `run failed: crash` (0031 §6,
    // `#100`). Both halves are asserted because both were missing — the
    // runtime's own words, and that this attempt cost nothing, which is what
    // separates it from one that spent an agent and produced nothing.
    const reason = (releases[0]!.data as { reason: string }).reason;
    expect(reason).toContain("You've hit your session limit");
    expect(reason).toContain("nothing was spent");

    // And the account-wide answer was given exactly once.
    const control = await store.read("ctl-conductor");
    const paused = control.filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);

    const d = paused[0]!.data as { by: string; reason: string; until: string };
    expect(d.by).toBe("lingtai");
    // Read out of the message, not guessed at: 11pm in Chicago, as an instant —
    // and asked back in Chicago, because that is where the message said it.
    expect(wallHourIn("America/Chicago", d.until)).toBe("23");
    // The evidence the classification would not read is on the pause, because
    // this is the only place a person can learn what actually stopped the queue.
    expect(d.reason).toContain("You've hit your session limit");
  });

  /**
   * `#89`: a run stopped at its turns spent the most, and the log has to say so
   * where spend is read — `RunFinished.costUsd` — and not only in the prose.
   */
  it("records the receipt of a run stopped at its turns, and still ends it as failed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime: {
          ...runtime,
          run: async () => ({
            exitCode: 1,
            turns: 150,
            durationMs: 900_000,
            costUsd: 24.1,
            failure: { kind: "out-of-turns", detail: "150 turns, and the recipe allows 150 · $24.10" },
            text: null,
            sessionId: "sess-turns",
          }),
        },
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );
    expect(result.ok).toBe(false);

    const [, events] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const endings = events.filter((e) => e.type === "RunFinished" || e.type === "RunFailed");
    expect(endings.map((e) => e.type)).toEqual(["RunFinished", "RunFailed"]);
    expect(endings[0]!.data).toEqual({ exitCode: 1, turns: 150, durationMs: 900_000, costUsd: 24.1 });
    expect((endings[1]!.data as { kind: string }).kind).toBe("out-of-turns");

    // **Held, not released.** A release puts the item back in the queue, and
    // the next pass after the backoff would buy another run to the same limit
    // — every backoff, with nothing counting. The limit's reading is that the
    // ticket was wrong, which is a person's to fix.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemBlocked");
    expect(item).not.toContain("WorkItemReleased");
  });

  /**
   * **The wall met by the agent *inside a gate*, which is the path 0031 did not
   * have** (`#133`).
   *
   * 0031's tests pass today and this happened anyway: the run started, took
   * three turns and spent $0.42, so nothing about it is `never-started`. The
   * reviewer is a second agent asking the same account, and what came back was
   * turned into a failed verdict — *a review gate refused it*, a sentence about
   * this diff produced by a condition that has nothing to do with any diff.
   *
   * Four things are asserted because four things were wrong, and the fourth is
   * the one a person would have had to undo by hand:
   *
   *   the verdict   no `GateFailed`, and no `GatePassed` either — a gate whose
   *                 agent never started judged nothing, and both readings are
   *                 claims nobody is entitled to
   *   the conductor stood down, once, until the time the message named — not
   *                 this item backing off while the next one meets the same wall
   *   the item      released, so the queue brings it back on its own
   *   the card      no block, and no approval question, under `--no-merge` —
   *                 which is the flag this repository passes every single time
   */
  it("stands the conductor down when a step's agent never starts, and blames no diff", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // The flag self-hosting always passes. Without the classification this
        // is the line that asks a person to merge "anyway", naming a gate that
        // refused nothing.
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("step");

    // The run took turns and cost money, so its own ending is not 0031's — the
    // whole reason the dispatch path never sees this.
    const runId = result.runId!;
    const run = (await store.read(runId)).map((e) => e.type);
    expect(run).toContain("RunFinished");
    expect(run).not.toContain("RunFailed");

    // The point was reached and said so, in a type that is not a verdict.
    expect(run).toContain("GateNeverRan");
    expect(run).not.toContain("GateFailed");
    expect(run).not.toContain("GatePassed");
    const neverRan = (await store.read(runId)).find((e) => e.type === "GateNeverRan");
    const step = neverRan!.data as { gate: string; action: string; detail: string };
    expect(step).toMatchObject({ gate: "proposed", action: "review" });
    // The runtime's own words, kept whole: evidence about the account, and the
    // only place the reset time can be read back out of (0031 §4).
    expect(step.detail).toContain("You've hit your session limit");

    // Released, not blocked: the queue brings it back with nobody requeueing it,
    // and no question was put to a person about a diff nothing read.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemReleased");
    expect(item).not.toContain("WorkItemBlocked");
    expect(item).not.toContain("ApprovalRequested");
    expect(did).not.toContain("integrate");

    // And the card's own line says what happened rather than naming a refusal.
    const released = (await store.read(`wi-${PROJECT}-7`)).find(
      (e) => e.type === "WorkItemReleased",
    );
    const reason = (released!.data as { reason: string }).reason;
    expect(reason).toContain("never ran");
    expect(reason).toContain("nothing judged this diff");
    expect(reason).not.toContain("refused");
    // And not the *run*'s sentence either: this attempt did spend an agent, and
    // `the run never started — nothing was spent` would be a claim about a run
    // that took three turns and cost $0.42.
    expect(reason).not.toContain("nothing was spent");

    // The account-wide answer, given where 0031 gives it: once, on the control
    // stream, until the time the message named — 2pm, in the zone it named it in.
    const control = await store.read("ctl-conductor");
    const paused = control.filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const pause = paused[0]!.data as { by: string; reason: string; until: string };
    expect(pause.by).toBe("lingtai");
    expect(wallHourIn("America/Chicago", pause.until)).toBe("14");
    expect(pause.reason).toContain("You've hit your session limit");
    // And the chip's sentence is about the gate, not about the run. This pass
    // took three turns and cost $0.42, so 0031's opening would be false here —
    // the same wrong sentence as the card's, one screen along (0041 §3).
    expect(pause.reason).toContain("step's agent never started");
    expect(pause.reason).not.toContain("no turns taken, nothing spent");

    // Pushed before it let go, so the next attempt's `git fetch origin agent/<n>`
    // finds the work the implementer was paid for — and its own arm ref beside
    // it, because this claim is one `requeue` away from being attempt 2 and
    // attempt 2 must not be able to overwrite what attempt 1 left (0062 §1).
    expect(did).toContain("git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1");
    // And no round was bought from the account that just refused an agent.
    expect(run).not.toContain("FixRequested");
  });

  /**
   * **A push that fails does not take the stand-down with it.**
   *
   * The push is for the next attempt; the pause is the answer to the account.
   * When the push went first and failed, the pass ended as `push: …` — released
   * with no pause, so the next claim met the same wall and the card blamed a
   * push for a quota. A lease `agent/<n>` moved past, or a dropped network, is
   * all it took.
   */
  it("stands the conductor down even when the branch will not push", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const fake = fakePorts(did, store);
    const ports: RunPorts = {
      ...fake,
      repo: {
        ...fake.repo,
        git: (args, o) =>
          args[0] === "push"
            ? Effect.fail({ _tag: "RepoFailed", operation: "git push", detail: "stale info: agent/7 moved" } as never)
            : fake.repo.git(args, o),
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("step");

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);

    const item = await store.read(`wi-${PROJECT}-7`);
    const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string }).reason;
    expect(reason).toContain("never ran");
    expect(reason).not.toMatch(/^push:/);
    // Said, rather than swallowed: the next attempt will not find the branch.
    expect(reason).toContain("was not pushed");
  });

  /**
   * **And what it says there is git's word, never the bookkeeping's** (`#251`).
   *
   * The sentence above is interpolated into `WorkItemReleased.reason`, which is
   * the card a person reads to decide whether there is anything to rescue — so
   * the reason a branch is not on origin has to be the reason it is not on
   * origin. This pass gets the half-rejection `arm-only` exists for, and *then*
   * the store drops the correction that outcome owes. `appendAtEnd` is an
   * `Effect.promise`, so that is a defect, and the handler used to answer the
   * whole publish with it: a record naming a Postgres disconnect as the thing
   * origin refused, on a run where origin refused a stale lease.
   */
  it("names git's refusal on the card when the correction's append dies, not the store's", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const fake = fakePorts(did, store);
    const rejected = "! [rejected] agent/7 -> agent/7 (stale info)";
    const ports: RunPorts = {
      ...fake,
      repo: {
        ...fake.repo,
        // Only the refspec carrying the lease, so origin takes the arm: the
        // later push of the arm alone has no lease and goes through.
        git: (args, o) =>
          args[0] === "push" && args.some((a) => a.startsWith("--force-with-lease="))
            ? Effect.fail({ _tag: "RepoFailed", operation: "git push", detail: rejected } as never)
            : fake.repo.git(args, o),
      },
    };
    // The one append the store drops is the correction — `RunProducedDiff`
    // naming the arm — and it drops it once, so the finalizer's call repairs it.
    const appended = store.append.bind(store);
    let dropTheCorrection = 1;
    store.append = async (stream, at, events) => {
      const correction = events.some(
        (e) =>
          e.type === "RunProducedDiff" && (e.data as { branch: string }).branch.endsWith("-attempt-1"),
      );
      if (correction && dropTheCorrection > 0) {
        dropTheCorrection -= 1;
        throw new Error("the store would not take the diff record");
      }
      return appended(stream, at, events);
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("step");

    const item = await store.read(`wi-${PROJECT}-7`);
    const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string }).reason;
    expect(reason).toContain("was not pushed");
    expect(reason).toContain("stale info");
    expect(reason).not.toContain("the store would not take");

    // And the correction is asked for again on the way out, so the next attempt
    // is sent to the ref that holds this run's commits rather than to the one
    // that rejected the push.
    const run = await store.read(result.runId!);
    expect(
      run.filter((e) => e.type === "RunProducedDiff").map((e) => (e.data as { branch: string }).branch),
    ).toEqual(["agent/7", "agent/7-attempt-1"]);
  });

  /**
   * **The third agent in a pass meets the same wall.**
   *
   * A refused review buys a fixer (0038), and the fixer asks the same account.
   * Arriving as a crash, it used to end as a declined round — a block, asking a
   * person about a refusal nothing had tried to answer, and needing a person to
   * requeue it once the limit lifted. It is the account's ending, so it is
   * answered as the gate's is (0041).
   */
  it("stands the conductor down when the fixing agent never starts, rather than blocking", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: {
          ...refusingRuntime,
          run: async (request) =>
            request.runId.includes(":fix:")
              ? {
                  exitCode: 1,
                  turns: 0,
                  durationMs: 5_000,
                  costUsd: 0,
                  failure: {
                    kind: "never-started",
                    detail: "You've hit your session limit · resets 2pm (America/Chicago)",
                  },
                  text: null,
                  sessionId: "sess-fix",
                }
              : refusingRuntime.run(request),
        },
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("fix");

    const run = (await store.read(result.runId!)).map((e) => e.type);
    // The review did refuse, and a round was bought — both true, both kept.
    expect(run).toContain("GateFailed");
    expect(run).toContain("FixRequested");

    const item = await store.read(`wi-${PROJECT}-7`);
    const types = item.map((e) => e.type);
    expect(types).toContain("WorkItemReleased");
    expect(types).not.toContain("WorkItemBlocked");
    expect(types).not.toContain("ApprovalRequested");
    expect(did).not.toContain("integrate");
    const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string }).reason;
    expect(reason).toContain("never started");

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const pause = paused[0]!.data as { reason: string };
    expect(pause.reason).toContain("fix review");
    expect(pause.reason).not.toContain("no turns taken, nothing spent");
  });

  /**
   * **The defect `#196` is about: a reviewer that crashed bought a fix round.**
   *
   * The sequence, measured on `#192`'s `run-9e510ffc`: the reviewer exits 1 in
   * one second with no receipt, `agent-gate.ts` returns `failed`, `gate.ts`
   * appends `GateFailed` — the same event a reviewer that read the diff and
   * refused it appends — and `run-once.ts` buys a round. The fixing agent's own
   * first sentence was *I'm not fixing anything this round … the review never
   * looked at the change.*
   *
   * Five things, because five were wrong:
   *
   *   the verdict   no `GateFailed`, and no `GatePassed` — nothing judged the
   *                 diff, and both readings are claims nobody is entitled to
   *   the log       `GateDidNotFinish`, once, for the one run of the action. An
   *                 event and a field, never the evidence text (0057 §1)
   *   the money     **no `FixRequested`** — nothing was learned about the diff,
   *                 so there is nothing for a fixing agent to carry (§2)
   *   the conductor **not** stood down. A crash is local, and stopping the
   *                 queue for it is 0041's category error pointed the other
   *                 way (§3)
   *   the item      a person's, blocked with a diagnosis about the machinery
   */
  it("buys no round for a reviewer that crashed, runs it once, and asks a person", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const tried = { n: 0 };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerThatCrashes(tried),
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("step");

    // Once, and only once (`#234`). 0057 §4's retry recomputed the crashed
    // attempt's session id, so it was refused in zero seconds having reviewed
    // nothing — and the log then said this action did not finish *twice*.
    expect(tried.n).toBe(1);

    const run = await store.read(result.runId!);
    const types = run.map((e) => e.type);
    // The implementer ran and was paid, so this is not the run's own ending.
    expect(types).toContain("RunFinished");
    expect(types).not.toContain("RunFailed");

    expect(types).not.toContain("GateFailed");
    expect(types).not.toContain("GatePassed");
    // Nor 0041's: `never-started` is the adapter's word for an account-wide
    // wall, and nothing here re-read a message to claim one.
    expect(types).not.toContain("GateNeverRan");

    const didNot = run.filter((e) => e.type === "GateDidNotFinish");
    expect(didNot.map((e) => e.data)).toMatchObject([{ gate: "proposed", action: "review" }]);
    // And nothing on it claiming an attempt number: the two fields went with the
    // retry (`#234`), so a reader cannot be told a second attempt happened.
    expect(didNot[0]!.data).not.toHaveProperty("attempt");
    expect(didNot[0]!.data).not.toHaveProperty("retrying");
    // The runtime's own words, about the machinery.
    expect((didNot[0]!.data as { detail: string }).detail).toContain("already in use");

    // **The line this ticket exists for.** `decideFix` never saw it, so no
    // agent was paid to answer a question nobody asked.
    expect(types).not.toContain("FixRequested");
    expect(types).not.toContain("FixDeclined");

    // The conductor is untouched. Every other item in the queue is unaffected
    // by one machine's crashed reviewer.
    expect(await store.read("ctl-conductor")).toHaveLength(0);

    // And the item is a person's, with a diagnosis that names the machinery
    // rather than the diff — blocked, because a release is a backoff and another
    // claim, and the bad settings path or broken binary underneath would meet
    // the next pass the same way, for ever, with nothing counting it.
    const item = await store.read(`wi-${PROJECT}-7`);
    const itemTypes = item.map((e) => e.type);
    expect(itemTypes).toContain("WorkItemBlocked");
    expect(itemTypes).not.toContain("WorkItemReleased");
    expect(did).not.toContain("integrate");
    const block = item.find((e) => e.type === "WorkItemBlocked")!.data as {
      needs: string;
      diagnosis: { what: string; raw: string } | null;
    };
    expect(block.needs).toBe("acknowledgement");
    expect(block.diagnosis?.what).toContain("nothing judged this diff");
    expect(block.diagnosis?.what).not.toContain("refused");
    expect(block.diagnosis?.raw).toContain("already in use");

    // Pushed on the way out, so the person being asked has the work to read —
    // and on this claim's own ref too, since a `requeue` makes this attempt 1
    // of an item whose attempt 2 takes `agent/7` over (0062 §1).
    expect(did).toContain("git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1");
  });

  /**
   * **"Every exit appends", as a test rather than as a comment.**
   *
   * It was a `catch (err)` whose own comment admitted what it was: *"the
   * catch-all that keeps 'every exit appends' true for anything unforeseen"*.
   * A defect is what "unforeseen" means once the failures have types, so this
   * throws one from a port that the type system says cannot fail, and asks the
   * log the question the comment was answering.
   */
  it("releases and appends when something no type predicted goes wrong", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const ports = fakePorts(did, store);
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
      {
        ...ports,
        agent: {
          ...ports.agent,
          // Not a refusal — `smokeTest` answers `{ ok: false }` for that. This
          // is the port breaking its own contract, which is a defect.
          smokeTest: () =>
            Effect.sync(() => {
              throw new Error("the socket directory is not writable");
            }),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("unexpected");
    expect(result.detail).toContain("not writable");

    // The item is back in the queue rather than claimed by a run that is over,
    // and the log says so. That is the whole of the guarantee.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemClaimed");
    expect(item).toContain("WorkItemReleased");

    // And the worktree it had already taken went with it.
    expect(did).toContain(`remove ${result.runId}`);
  });

  /**
   * **`rounds` bound depth; `restarts` bound breadth**
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
   *
   * Both arms of the same pass, because the interesting claim is the
   * *difference* between them and either alone would read as correct:
   *
   *   `restarts: 1`   the item is **released**, the arm is on the log, and the
   *                   next claim is an ordinary fresh pass
   *   `restarts: 0`   the item is **blocked** and asks, which is what it did
   *                   before this key existed — 0040 §4's default
   *
   * `--no-merge` is passed in both, as Lingtai passes it to itself, and it is
   * deliberately not a reason to refuse a restart: the flag says *do not merge
   * without me*, and a restart merges nothing. Excluding it would make this
   * branch unreachable on the one repository that has to prove it.
   */
  describe("when the rounds are spent and the review still refuses", () => {
    const spentPass = async (restarts: number) => {
      const store = memoryStore();
      const did: string[] = [];
      const said: string[] = [];
      const result = await once(
        {
          project,
          client: fakeGitHub(said, restartRecipe(restarts)),
          runtime: refusingRuntime,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          merge: false,
          home: "/tmp/fake-home",
          store,
        },
        fakePorts(did, store),
      );
      return { result, store, did, said, item: await store.read(`wi-${PROJECT}-7`) };
    };

    it("releases the item for a fresh pass when the recipe buys one", async () => {
      const { result, item, did, said } = await spentPass(1);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.stage).toBe("restart");

      // **Released and not blocked**, which is the whole of the change: a
      // question for a person sits in "Waiting on you" and a released item is
      // back in the queue, where the next pass claims it.
      const types = item.map((e) => e.type);
      expect(types).toContain("PassRestarted");
      expect(types).toContain("WorkItemReleased");
      expect(types).not.toContain("WorkItemBlocked");

      // Recorded *before* the release, which is the mechanism and not an
      // ordering preference: the fold has to carry the arm before anything can
      // claim the next one, or the ceiling counts one restart short for ever.
      expect(types.indexOf("PassRestarted")).toBeLessThan(types.indexOf("WorkItemReleased"));

      // The arm carries what refused it, because its run's stream is not read
      // by any later pass — so this is where a person asked after the *last*
      // restart finds out what the first approach was refused for.
      const arm = item.find((e) => e.type === "PassRestarted")!.data as {
        restart: number;
        of: number;
        action: string;
        branch: string;
        findings: { claim: string }[];
      };
      // **The arm's own ref, not the working branch.** `agent/7` is what the
      // next prompt names, so the arm after this one takes it over — and a
      // person shown every arm at the end would then be reading shas origin
      // dropped. `agent/7-attempt-1` is written by this claim and by nothing
      // else, so the heading on that card stays fetchable.
      //
      // **`attempt-1` and not `restart-1`** (0062 §2). This is the item's first
      // claim, and it is the *first* restart — so the two counters disagree by
      // one here, which is exactly why keeping both would give one set of
      // commits two names. The attempt ordinal is the one that also exists for
      // the ending below that never restarted at all.
      expect(arm).toMatchObject({
        restart: 1,
        of: 1,
        action: "review",
        branch: "agent/7-attempt-1",
      });
      expect(arm.findings[0]!.claim).toBe("the approach cannot work");

      // **And both branches are on origin.** The only push in a pass is
      // after its gates pass, which a spent review never reaches, so these
      // commits were in a `--force --detach` worktree with no ref anywhere —
      // while `attempts.ts` tells the next agent `git fetch origin agent/7`,
      // which is the whole of the mechanism (0040 §2). One push, two refspecs:
      // the working branch moves to the newest arm and the arm's own ref
      // keeps this one. Pushed while the worktree still exists, which is the
      // only place those commits are.
      const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
      expect(did).toContain(push);
      expect(did.indexOf(push)).toBeLessThan(did.indexOf(`remove ${result.runId}`));
      // And exactly once. The finalizer that publishes every *other* ending
      // sees the head this push already put up and does nothing — a second
      // push here would be a second round trip for a ref that has not moved.
      expect(did.filter((d) => d === push)).toHaveLength(1);

      // And the release says which arm, in the sentence that becomes both the
      // card's line and the next attempt's own history row.
      const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string })
        .reason;
      expect(reason).toContain("restart 1 of 1");
      expect(reason).toContain("approach is abandoned");

      // Back in the queue as far as GitHub is concerned, not waiting on anyone
      // — which is what makes the next claim possible at all: an issue left
      // reading `lingtai:working` is one a person has to go and fix by hand.
      expect(said.filter((l) => l.startsWith("labels #7"))).toEqual([
        "labels #7 bug,lingtai:working",
        "labels #7 bug",
      ]);
      expect(did).toContain(`remove ${result.runId}`);
    });

    /**
     * 0040 §4: the default is today's behaviour. One ticket of evidence does
     * not turn a new way to spend an agent on for every project, so with the
     * key left alone the pass stops and asks — and the card says what happened
     * and why nothing more was bought.
     */
    it("asks a person when the recipe buys none, and says which ceiling stopped it", async () => {
      const { result, item } = await spentPass(0);

      expect(result.ok).toBe("held");

      const types = item.map((e) => e.type);
      expect(types).toContain("WorkItemBlocked");
      expect(types).not.toContain("PassRestarted");

      // **Both ceilings in one sentence.** A card that named only the rounds
      // would report a ceiling a reader can see and hide the one they cannot.
      const blocked = item.find((e) => e.type === "WorkItemBlocked")!.data as {
        question: string;
        diagnosis: { done: string; raw: string | null } | null;
      };
      // **And not "two agents disagreed"** (`#197`): `rounds: 0` is the recipe
      // buying nobody to answer the reviewer, so exactly one agent looked at
      // this diff. The ceiling is still both ceilings' to name, below.
      expect(blocked.question).not.toContain("two agents disagreed");
      expect(blocked.question).toContain("buys no fix round");
      expect(blocked.question).not.toContain("restart");
      expect(blocked.diagnosis!.done).toContain("runtime.limits.rounds: 0");
      expect(blocked.diagnosis!.done).toContain("runtime.limits.restarts: 0");
      // And the findings are still the evidence, unframed — no headings, because
      // there is only one approach to tell apart.
      expect(blocked.diagnosis!.raw).toContain("deadlocks on the lock the first took");
      expect(blocked.diagnosis!.raw).not.toContain("## this approach");
    });
  });

  /**
   * **A claim that produced commits leaves a ref, whatever ending it had**
   * ([0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md) §1,
   * `#239`).
   *
   * `#237` met the wall at 151 turns having made 36 edits, and
   * `git ls-remote --heads origin refs/heads/agent/237` returned nothing. Both
   * halves had to fail: the agent never committed, *and* an `out-of-turns`
   * ending is not `second.restart`, so a committed one would have had no ref
   * either. This is the half the conductor owns, and the two arms below are the
   * whole of it — the difference between them is one `rev-parse`.
   *
   * The ending is deliberately the one that never restarts. There is no restart
   * ordinal here to name a ref by, which is why the scheme is the attempt's.
   */
  describe("when the agent meets the wall", () => {
    const atTheWall: Runtime = {
      ...runtime,
      run: async () => ({
        exitCode: 1,
        turns: 151,
        durationMs: 1_800_000,
        costUsd: 20.81,
        failure: { kind: "out-of-turns", detail: "151 turns, and the recipe allows 151 · $20.81" },
        text: null,
        sessionId: "sess-237",
      }),
    };

    /** The budget's shape, at the recipe's defaults — this asserts the brief, not the bound. */
    const budget = { evidence: 2_000, attempts: 3, findings: 5 };

    /**
     * A `RepoFailed`, shaped rather than imported (`#251`).
     *
     * `Effect.either` reads `.detail` and nothing else, and `@lingtai/repo`
     * loads `node:child_process` at import — which is the one thing keeping
     * this half of the suite out of the `integration` project.
     */
    const pushRefusedWith = (detail: string) =>
      Effect.fail({ _tag: "RepoFailed", operation: "git push", detail } as never);

    const hitTheWall = async (
      committed: boolean,
      /**
       * What goes wrong underneath the publish, and all three are things that
       * actually can (`#251`): a push origin rejects, a push origin *half*
       * rejects, and a store that will not take the row accounting for either.
       *
       * `leasedBranch` is the half: only the command carrying
       * `--force-with-lease` is refused, which is what origin does when a
       * sibling claim has moved `agent/<n>` since the worktree was cut. The
       * forced arm refspec in the same command is taken, and a later push of
       * the arm alone is a no-op that succeeds — so the fake lets it through.
       *
       * `theDiff` is how many `RunProducedDiff` appends the store drops before
       * it starts taking them — the Postgres disconnect CLAUDE.md documents for
       * `#157`, arriving on the one row `attemptBrief` reads.
       */
      breaks: { push?: string; leasedBranch?: string; theRow?: boolean; theDiff?: number } = {},
    ) => {
      const store = memoryStore();
      const did: string[] = [];
      const said: string[] = [];
      const ports = fakePorts(did, store);
      /**
       * **The appends go on the same list as the git calls**, because what `#250`
       * needed said is an ordering *between* them.
       *
       * A push that only ever happens while the scope unwinds happens after the
       * `WorkItemBlocked` and after GitHub has been told, and a person asked a
       * question wants the branch already there to answer it with. Two lists
       * could not state that, and `did` already holds every side effect in the
       * order it happened.
       */
      const appended = store.append.bind(store);
      let dropDiffs = breaks.theDiff ?? 0;
      store.append = async (stream, at, events) => {
        if (breaks.theRow && events.some((e) => e.type === "RunRefsPublished")) {
          throw new Error("the store would not take the row");
        }
        if (dropDiffs > 0 && events.some((e) => e.type === "RunProducedDiff")) {
          dropDiffs -= 1;
          throw new Error("the store would not take the diff record");
        }
        for (const e of events) did.push(`append ${e.type}`);
        return appended(stream, at, events);
      };
      const refuse = breaks.push ?? breaks.leasedBranch;
      if (refuse !== undefined) {
        const inner = ports.repo.git;
        const refused = (args: readonly string[]) =>
          args[0] === "push" &&
          (breaks.push !== undefined || args.some((a) => a.startsWith("--force-with-lease=")));
        ports.repo.git = (args, o) =>
          refused(args)
            ? Effect.sync(() => {
                did.push(`git push ${args.filter((a) => a.includes(":refs/heads/")).join(" ")}`);
              }).pipe(Effect.andThen(pushRefusedWith(refuse)))
            : inner(args, o);
      }
      if (!committed) {
        // The worktree's HEAD is still the base: the agent edited and never ran
        // `git commit`, which is exactly what `#237` did.
        const inner = ports.repo.git;
        ports.repo.git = (args, o) =>
          args[0] === "rev-parse"
            ? Effect.sync(() => {
                did.push("git rev-parse");
                return "a".repeat(40);
              })
            : inner(args, o);
      }
      const result = await once(
        {
          project,
          client: fakeGitHub(said),
          runtime: atTheWall,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          merge: false,
          home: "/tmp/fake-home",
          store,
        },
        ports,
      );
      const [runId, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
      return { result, did, runId, run, item: await store.read(`wi-${PROJECT}-7`) };
    };

    it("publishes the commits it made, and names them for the next attempt", async () => {
      const { result, did, runId, run, item } = await hitTheWall(true);
      expect(result.ok).toBe(false);

      // **Both refs, from the ending that promises them.** One `lingtai
      // requeue` makes this attempt 2, `attemptBrief` runs, and it will say
      // `git fetch origin agent/7` — for a ref that now exists. `agent/7` is
      // the newest and `agent/7-attempt-1` is this claim's own, so the claim
      // after this one cannot overwrite what this one left.
      const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
      expect(did).toContain(push);
      // Pushed while the worktree still exists, which is the only place those
      // commits are.
      expect(did.indexOf(push)).toBeLessThan(did.indexOf(`remove ${runId}`));

      // **And recorded, or the ref is one nobody will fetch.** `attemptBrief`
      // reads `RunProducedDiff` and nothing else; a pass that meets the wall
      // never reaches the append at section 9, so the publish makes it.
      const produced = run.find((e) => e.type === "RunProducedDiff");
      expect(produced).toBeDefined();
      expect(produced!.data).toMatchObject({ branch: "agent/7", headSha: "b".repeat(40) });

      // The next attempt's prompt, composed the way `run-once` composes it.
      const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
      expect(brief).toContain("git fetch origin agent/7");
      expect(brief).not.toContain("It committed no change");
    });

    /**
     * **And nothing when there is nothing.** A ref to an empty branch would be
     * a worse lie than the absence: it would tell the next agent there is an
     * approach to build on and hand it the base branch. `attemptBrief` already
     * has the honest word.
     */
    it("publishes nothing when the agent committed nothing, and says so", async () => {
      const { result, did, run, item } = await hitTheWall(false);
      expect(result.ok).toBe(false);

      expect(did.filter((d) => d.startsWith("git push"))).toEqual([]);
      expect(run.some((e) => e.type === "RunProducedDiff")).toBe(false);

      const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
      expect(brief).toContain("It committed no change, so there is no branch to build on");
      expect(brief).not.toContain("git fetch origin");
    });

    /**
     * **And the whole of it is on the log, which is what `#251` is** (0062 §1).
     *
     * `#239` landed the two arms above and `#250` was the first real claim to
     * take this ending. It left no ref — and, because the only account the
     * publish gave was `runLog.note`, no way to find out which of four things
     * happened: it found nothing, it was refused, it succeeded and something
     * removed the refs, or it never ran. A run log is a trace and not a record
     * (0034 §8), a *successful* push wrote nothing to it at all, and the two
     * silent returns wrote nothing either. $26.84 survived as unreachable git
     * objects and one night of archaeology, and the four readings are still not
     * decidable.
     *
     * So the five assertions below are one assertion in five postures: **after
     * this ending, the log says what the publish did.** The arms above already
     * pin the push and the `RunProducedDiff`; these pin the account, and the
     * ordering that stops the account arriving after the question.
     */
    it("pushes before the person is asked, and the log says both refs went", async () => {
      const { result, did, run } = await hitTheWall(true);
      expect(result.ok).toBe(false);

      // **Before the block, not while the scope unwinds.** This is the ordering
      // `#250` could not have had: the push lived only in the finalizer, which
      // releases after every append this pass makes.
      const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
      expect(did).toContain(push);
      expect(did.indexOf(push)).toBeLessThan(did.indexOf("append WorkItemBlocked"));

      // Two rows, and the second is the finalizer saying it ran: it finds the
      // head already where it wanted it and pushes nothing. *The finalizer
      // fired* is the fact `#250` had to infer from a `RUN_LOG_END` line.
      const rows = run.filter((e) => e.type === "RunRefsPublished");
      expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual([
        "published",
        "already-published",
      ]);
      expect(rows[0]!.data).toMatchObject({
        branch: "agent/7",
        arm: "agent/7-attempt-1",
        headSha: "b".repeat(40),
        detail: null,
      });
      expect(did.filter((d) => d.startsWith("git push"))).toEqual([push]);
    });

    /**
     * **An absence that is meant is said, or it cannot be told from one that is
     * not.** This is the reading `#250` most needed excluded and could not
     * exclude: the publish ran, found the head still at the base, and returned
     * `null` without a word — which on the page is the same nothing as a
     * finalizer that never fired.
     */
    it("says nothing was committed, rather than leaving that absence to be read", async () => {
      const { run, did } = await hitTheWall(false);

      const rows = run.filter((e) => e.type === "RunRefsPublished");
      expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual([
        "nothing-committed",
        "nothing-committed",
      ]);
      expect(rows[0]!.data).toMatchObject({ headSha: null, detail: null });
      expect(did.filter((d) => d.startsWith("git push"))).toEqual([]);
    });

    /**
     * **A refused push keeps git's own words, and the stop still stands.**
     *
     * The head is on the row because that is what says whether anything was
     * lost: a rejection with commits behind it is a run somebody can still
     * rescue from the worktree's objects, and `#250`'s was. The person is asked
     * the same question either way — a push that failed is not a second opinion
     * about the ticket.
     */
    it("keeps git's words when the push is refused, and blocks the item anyway", async () => {
      const rejected = "! [remote rejected] agent/7 -> agent/7 (stale info)";
      const { result, run, item } = await hitTheWall(true, { push: rejected });
      expect(result.ok).toBe(false);
      expect((result as { stage?: string }).stage).toBe("run");

      const rows = run.filter((e) => e.type === "RunRefsPublished");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.data).toMatchObject({
          outcome: "refused",
          headSha: "b".repeat(40),
          detail: expect.stringContaining("stale info"),
        });
      }
      expect(item.some((e) => e.type === "WorkItemBlocked")).toBe(true);
    });

    /**
     * **A push that half worked is not a push that failed** (`#251`).
     *
     * `git push` is not atomic and this pass sends two refspecs in one command.
     * The arm is forced and uncontended; `agent/7` carries a
     * `--force-with-lease` that a sibling claim, a manual push or a re-run of
     * the sweep can invalidate between the cut and the wall. Origin then takes
     * the arm, rejects the branch, and exits non-zero — one bit about two refs.
     *
     * Believed as a refusal that is the loss this whole ticket is about: a row
     * saying *nothing was pushed* over commits that are on origin, and a next
     * attempt told *Nothing* because `attemptBrief` reads `RunProducedDiff` and
     * nothing else. So the publish asks the arm directly before it decides, and
     * what it records is the arm — the ref that holds this run's work, and the
     * one the brief has to name, because `agent/7` now holds whatever
     * invalidated the lease.
     */
    it("finds the arm that survived a half-rejected push, and sends the next attempt to it", async () => {
      const rejected = "! [rejected] agent/7 -> agent/7 (stale info)";
      const { result, did, run, item } = await hitTheWall(true, { leasedBranch: rejected });
      expect(result.ok).toBe(false);

      // The combined push failed; the arm was then asked on its own and said
      // yes, which is the fact the exit code could not carry.
      expect(did).toContain("git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1");
      expect(did).toContain("git push +HEAD:refs/heads/agent/7-attempt-1");

      const rows = run.filter((e) => e.type === "RunRefsPublished");
      expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual([
        "arm-only",
        "arm-only",
      ]);
      expect(rows[0]!.data).toMatchObject({
        branch: "agent/7",
        arm: "agent/7-attempt-1",
        headSha: "b".repeat(40),
        detail: expect.stringContaining("stale info"),
      });

      // **The arm, and once.** Naming `agent/7` here would send the next agent
      // to fetch the commits that rejected this push.
      const produced = run.filter((e) => e.type === "RunProducedDiff");
      expect(produced).toHaveLength(1);
      expect(produced[0]!.data).toMatchObject({
        branch: "agent/7-attempt-1",
        headSha: "b".repeat(40),
      });

      const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
      expect(brief).toContain("git fetch origin agent/7-attempt-1");
      expect(brief).not.toContain("It committed no change");
      // The stop still stands: a push origin argued with is not a second
      // opinion about the ticket.
      expect(item.some((e) => e.type === "WorkItemBlocked")).toBe(true);
    });

    /**
     * **The account is worth a row and is not worth an ending.**
     *
     * `appendAtEnd` is an `Effect.promise`, so a store that will not take the row
     * arrives as a defect — and a defect raised from inside a finalizer reaches
     * the handler at the bottom of `runOnce` and comes back as `unexpected`,
     * which would replace the ending the run actually had with the failure of
     * its own bookkeeping. It must also not cost the `RunProducedDiff` that
     * follows it, which is the row `attemptBrief` reads and the reason a next
     * attempt is told the branch is there.
     */
    it("does not let a refused row change the ending or cost the diff record", async () => {
      const { result, did, run, item } = await hitTheWall(true, { theRow: true });
      expect(result.ok).toBe(false);
      expect((result as { stage?: string }).stage).toBe("run");

      expect(run.some((e) => e.type === "RunRefsPublished")).toBe(false);
      expect(run.some((e) => e.type === "RunFailed")).toBe(true);
      expect(did).toContain("git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1");
      expect(run.find((e) => e.type === "RunProducedDiff")?.data).toMatchObject({
        branch: "agent/7",
        headSha: "b".repeat(40),
      });
      expect(item.some((e) => e.type === "WorkItemBlocked")).toBe(true);
    });

    /**
     * **A dropped append must not mark the answer given** (`#251`).
     *
     * `RunProducedDiff` is the row `attemptBrief` reads and nothing else is, so
     * losing it over a ref that *is* on origin is `#250`'s loss arriving by a
     * second road — and a store that drops one append is the ordinary way it
     * gets lost, not an exotic one: CLAUDE.md documents exactly that
     * disconnect for `#157`, and `appendAtEnd` is an `Effect.promise`, so it
     * arrives as a defect rather than a failure the publish can see.
     *
     * The guard against two answers is therefore keyed on what the store
     * *took*. This ending publishes twice — inline before the person is asked,
     * and again from the finalizer — so the second call is the one place left
     * that can give the row the first call owed, which is why
     * `already-published` records as well as reports.
     */
    it("asks again for the diff record a dropped append cost, and keeps its own ending", async () => {
      const { result, did, run, item } = await hitTheWall(true, { theDiff: 1 });
      expect(result.ok).toBe(false);
      // The bookkeeping is not the ending: this is still the wall, not
      // `unexpected`, and the person is still asked.
      expect((result as { stage?: string }).stage).toBe("run");
      expect(item.some((e) => e.type === "WorkItemBlocked")).toBe(true);

      // Both refs went, and the account of the publish is unchanged by it.
      expect(did).toContain("git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1");
      expect(
        run
          .filter((e) => e.type === "RunRefsPublished")
          .map((e) => (e.data as { outcome: string }).outcome),
      ).toEqual(["published", "already-published"]);

      // **Once, and there.** The first append died; the second call gave it.
      const produced = run.filter((e) => e.type === "RunProducedDiff");
      expect(produced).toHaveLength(1);
      expect(produced[0]!.data).toMatchObject({ branch: "agent/7", headSha: "b".repeat(40) });

      // Which is the whole point of the row: the next attempt is sent to fetch.
      const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
      expect(brief).toContain("git fetch origin agent/7");
      expect(brief).not.toContain("It committed no change");
    });
  });

  /**
   * **The half-rejected push is not the wall's alone, and the correction has to
   * reach the endings that already answered** (`#251`).
   *
   * Section 9 appends a `RunProducedDiff` naming `agent/<n>` for every pass
   * that reaches the gates, which is every ending but the wall and the crash.
   * So a hold — a `human:` action here, the tamper watch in this repository —
   * publishes with that answer already on the stream, and if origin then takes
   * only the arm, the row a next attempt reads names the ref that rejected the
   * push: the sibling's commits, at a head this run never made.
   *
   * `attemptOutcome` folds `RunProducedDiff` last-wins, so the correction is a
   * second row. What must not come back is a *third*: the finalizer publishes
   * again on the way out, finds the same half-rejection, and has nothing new to
   * say about it.
   */
  describe("when the pass reaches the steps and a person is asked", () => {
    it("corrects the ref a half-rejected push left, though the steps were already told the branch", async () => {
      const store = memoryStore();
      const did: string[] = [];
      const said: string[] = [];
      const ports = fakePorts(did, store);

      // Only the refspec carrying the lease is refused, which is what origin
      // does when a sibling claim moved `agent/7` after this worktree was cut.
      const rejected = "! [rejected] agent/7 -> agent/7 (stale info)";
      const inner = ports.repo.git;
      ports.repo.git = (args, o) =>
        args[0] === "push" && args.some((a) => a.startsWith("--force-with-lease="))
          ? Effect.sync(() => {
              did.push(`git push ${args.filter((a) => a.includes(":refs/heads/")).join(" ")}`);
            }).pipe(
              Effect.andThen(
                Effect.fail({
                  _tag: "RepoFailed",
                  operation: "git push",
                  detail: rejected,
                } as never),
              ),
            )
          : inner(args, o);

      const held = RECIPE.replace(
        "steps: {}",
        'steps:\n  proposed:\n    - { name: approval, human: "look at it before it merges" }',
      );
      const result = await once(
        {
          project,
          client: fakeGitHub(said, held),
          runtime,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          // Nothing else is to hold this: the `human:` action at `proposed` is,
          // and `fakePorts` throws if the integrator is reached anyway.
          merge: true,
          home: "/tmp/fake-home",
          store,
        },
        ports,
      );
      if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
      expect(result).toMatchObject({ ok: "held", step: "proposed" });
      expect(did).not.toContain("integrate");

      const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
      // The gates were told `agent/7`; the publish on the way out corrects it
      // to the arm, and the finalizer's second call adds nothing.
      const produced = run.filter((e) => e.type === "RunProducedDiff");
      expect(produced.map((e) => (e.data as { branch: string }).branch)).toEqual([
        "agent/7",
        "agent/7-attempt-1",
      ]);
      expect(produced[1]!.data).toMatchObject({
        branch: "agent/7-attempt-1",
        headSha: "b".repeat(40),
      });
      expect(
        run
          .filter((e) => e.type === "RunRefsPublished")
          .map((e) => (e.data as { outcome: string }).outcome),
      ).toEqual(["arm-only", "arm-only"]);
      expect(did).toContain("git push +HEAD:refs/heads/agent/7-attempt-1");

      // And the next attempt is sent to the ref that holds this run's work.
      const item = await store.read(`wi-${PROJECT}-7`);
      const brief = nextPrompt({
        base: "ticket@1",
        budget: { evidence: 2_000, attempts: 3, findings: 5 },
        item,
        lastRun: run,
      }).failure;
      expect(brief).toContain("git fetch origin agent/7-attempt-1");
    });
  });
});

/**
 * `env.refuseHosts` reaches the tripwire, which is the whole of `#51`.
 *
 * A field carried through the recipe and handed to nothing is `#89`'s shape,
 * and it would pass every test in `agent-env`: the tripwire works there with
 * whatever patterns it is given. This asserts the conductor gives it these.
 */
describe("runOnce hands the recipe's production hosts to the environment", () => {
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
describe("runOnce refuses an extension's production value before anything is claimed", () => {
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
describe("runOnce runs the agent the recipe names, or nothing", () => {
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
