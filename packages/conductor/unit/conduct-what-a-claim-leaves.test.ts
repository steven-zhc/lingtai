/**
 * **What a claim leaves behind, whatever ending it had** — 0062 §1, and the
 * three incidents that wrote it.
 *
 * Carried from the old engine's fakes test when `#256` deleted the engine it
 * was written for. The publish is the one block of that file that moved
 * into `conduct.ts` essentially verbatim, so these are the assertions that say it
 * moved *correctly* — and they are the assertions this repository has paid the
 * most for:
 *
 * - **`#250`** met the wall with two commits in its worktree, left neither
 *   `agent/250` nor `agent/250-attempt-1` on origin, and was collected. $26.84
 *   survived as unreachable git objects and one night of archaeology. The reason
 *   it could not be diagnosed is that **four different things wrote the same
 *   nothing**: a push that worked wrote no line, both silent returns wrote none,
 *   and the two refusals wrote only to the run log — which is a trace and never a
 *   record (0034 §8).
 * - **`#251`** is the row that fixes that, and the half-rejected push it found:
 *   `git push` is not atomic, so origin can take the forced arm and reject the
 *   leased branch in one command with one exit code.
 * - **`#252`** is the append asked for twice within one call, because the store
 *   drops a connection on exactly the row `attemptBrief` reads.
 *
 * The ending under test is the wall — an agent stopped at its turns — because it
 * is the ending with **no inline push of its own**: `merge` never runs, so the
 * refs exist only if this machinery puts them there. Unit by 0060 §1: no process,
 * no socket, no network.
 */
import type { Runtime } from "@lingtai/agent";
import type { EventStore } from "@lingtai/event-store";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nextPrompt } from "../src/prompt.ts";
import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
  streams,
} from "../test/one-pass.ts";

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
   * `Effect.either` reads `.detail` and nothing else, and `@lingtai/repo` loads
   * `node:child_process` at import — which is the one thing keeping this half of
   * the suite out of the `integration` project.
   */
  const pushRefusedWith = (detail: string) =>
    Effect.fail({ _tag: "RepoFailed", operation: "git push", detail } as never);

  const hitTheWall = async (
    committed: boolean,
    /**
     * What goes wrong underneath the publish, and all three are things that
     * actually can: a push origin rejects, a push origin *half* rejects, and a
     * store that will not take the row accounting for either.
     *
     * `leasedBranch` is the half: only the command carrying `--force-with-lease`
     * is refused, which is what origin does when a sibling claim has moved
     * `agent/<n>` since the worktree was cut. The forced arm refspec in the same
     * command is taken, and a later push of the arm alone is a no-op that
     * succeeds — so the fake lets it through.
     *
     * `theDiff` is how many `RunProducedDiff` appends the store drops before it
     * starts taking them — the Postgres disconnect CLAUDE.md documents for `#157`,
     * arriving on the one row `attemptBrief` reads.
     */
    breaks: { push?: string; leasedBranch?: string; theRow?: boolean; theDiff?: number } = {},
  ) => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);
    /**
     * **The appends go on the same list as the git calls**, because what `#250`
     * needed said is an ordering *between* them: a person asked a question wants
     * the branch already there to answer it with.
     */
    const appended = store.append.bind(store) as EventStore["append"];
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

  /**
   * **The wall is a `did-not-finish` at `implement`, and it holds the item.**
   *
   * The result reads `held` where the old engine returned `ok: false, stage: "run"`
   * *and* appended `WorkItemBlocked` — a failure and a hold at once, which is what
   * the two vocabularies cost. Under the pass there is one answer: the commit is
   * the receipt (0057 §2), an agent that ran out of turns left none, and
   * `outcomeOf` reads the ending as `blocked`. Nothing else about the ending
   * changed: the receipt is still both events, the diagnosis still says *the limit
   * is a scope alarm*, and the item still waits on a person.
   */
  it("records the receipt of a run stopped at its turns, and holds the item for a person", async () => {
    const { result, run, item } = await hitTheWall(true);
    if (result.ok !== "held") throw new Error(`expected a hold, got ${JSON.stringify(result)}`);
    expect(result.step).toBe("implement");

    // **Both, and in that order.** Turns were taken and money was spent, so the
    // receipt is a fact; the ending is what `RunFailed` says.
    const types = run.map((e) => e.type);
    expect(types.indexOf("RunFinished")).toBeLessThan(types.indexOf("RunFailed"));
    expect(run.find((e) => e.type === "RunFinished")!.data).toMatchObject({
      turns: 151,
      costUsd: 20.81,
    });

    const blocked = item.find((e) => e.type === "WorkItemBlocked");
    expect(blocked).toBeDefined();
    expect(blocked!.data).toMatchObject({ needsFrom: "human", needs: "acknowledgement" });
    const question = (blocked!.data as { question: string }).question;
    expect(question).toContain("out-of-turns");
    // The recommendation is *narrow or split the ticket*, which is the whole of
    // why the turn limit keeps a diagnosis of its own.
    const diagnosis = (blocked!.data as { diagnosis: { what: string; recommendation: unknown } })
      .diagnosis;
    expect(diagnosis.what).toContain("scope alarm");
    expect(diagnosis.recommendation).toMatchObject({ action: "requeue" });
  });

  it("publishes the commits it made, and names them for the next attempt", async () => {
    const { result, did, runId, run, item } = await hitTheWall(true);
    expect(result.ok).toBe("held");

    // **Both refs, from the ending that promises them.** One `lingtai requeue`
    // makes this attempt 2, `attemptBrief` runs, and it will say `git fetch origin
    // agent/7` — for a ref that now exists. `agent/7` is the newest and
    // `agent/7-attempt-1` is this claim's own, so the claim after this one cannot
    // overwrite what this one left.
    const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
    expect(did).toContain(push);
    // Pushed while the worktree still exists, which is the only place those
    // commits are.
    expect(did.indexOf(push)).toBeLessThan(did.indexOf(`remove ${runId}`));

    // **And recorded, or the ref is one nobody will fetch.** `attemptBrief` reads
    // `RunProducedDiff` and nothing else.
    const produced = run.find((e) => e.type === "RunProducedDiff");
    expect(produced).toBeDefined();
    expect(produced!.data).toMatchObject({ branch: "agent/7", headSha: "b".repeat(40) });

    // The next attempt's prompt, composed the way the conductor composes it.
    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("git fetch origin agent/7");
    expect(brief).not.toContain("It committed no change");
  });

  /**
   * **And nothing when there is nothing.** A ref to an empty branch would be a
   * worse lie than the absence: it would tell the next agent there is an approach
   * to build on and hand it the base branch.
   */
  it("publishes nothing when the agent committed nothing, and says so", async () => {
    const { result, did, run, item } = await hitTheWall(false);
    expect(result.ok).toBe("held");

    expect(did.filter((d) => d.startsWith("git push"))).toEqual([]);
    expect(run.some((e) => e.type === "RunProducedDiff")).toBe(false);

    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("It committed no change, so there is no branch to build on");
    expect(brief).not.toContain("git fetch origin");
  });

  /**
   * **And it offers nobody *merge it anyway*, on either arm** — because nothing
   * judged this diff (`#84`: a card offers the move that is left, never a control
   * that refuses).
   *
   * The wall is a `did-not-finish` at `implement`: the pass never reached `build`,
   * `review`, `proposed` or `merge`, so no `GateFailed`, `GateNeverRan` or
   * `GateDidNotFinish` row exists about it. `refusingOn` (`approve.ts`) therefore
   * answers `[]`, and an `ApprovalRequested` here is a live **Approve** on the
   * board (`standing.tsx` draws one wherever `task_view.awaitingSha` is set) that
   * merges a half-finished diff with no reason required, no `GateWaived` and
   * nothing on the log recording that the build and the cold reviewer were
   * skipped. On a card whose own diagnosis reads *the limit is a scope alarm …
   * requeue*. The old engine appended no request on this ending and Requeue was the
   * only move; `conduct.ts` asks whether anything **refused** the diff, and this
   * ending refused nothing.
   *
   * Which is not `onOrigin`'s job and does not replace it: the arms still differ
   * in whether the refs went, the `false` arm publishes nothing, and the question
   * on the card differs with it. What they no longer differ in is whether a person
   * is handed a merge button.
   *
   * **`headSha` could not have told them apart either**, which is worth keeping:
   * `headReached` is the last `head` a *visit* reported, `admit` reports the base
   * sha so the head the pass is judged against always has a value
   * (`pass-steps.ts`), and this ending reports none — so it is the base sha in
   * both arms, including the one where origin is holding two commits at another.
   * A request bound to it would have been refused as `stale` by `approve()`
   * (`#92`) while the board drew the item `awaitingApproval` at a sha nothing is
   * at. Where a request *is* made, it is bound to what the publish put on origin:
   * `unit/conduct-asks-for-approval.test.ts`.
   */
  it("offers no approval on an ending nothing judged, whether or not it committed", async () => {
    for (const committed of [false, true]) {
      const { result, run, item } = await hitTheWall(committed);
      expect(result.ok).toBe("held");
      expect(
        run.some((e) => e.type === "ApprovalRequested"),
        `nothing judged this diff, so there is nothing to approve (committed: ${committed})`,
      ).toBe(false);
      // Still a person's, and still with the move that is actually left on it.
      const blocked = item.find((e) => e.type === "WorkItemBlocked")!;
      expect(blocked.data).toMatchObject({ needs: "acknowledgement" });
      expect(
        (blocked.data as { diagnosis: { recommendation: { action: string } | null } }).diagnosis
          .recommendation,
      ).toMatchObject({ action: "requeue" });
    }

    // And the refs still went on the arm that committed, which is what the next
    // attempt is promised and what a person reads while deciding to requeue.
    const committed = await hitTheWall(true);
    expect(committed.run.find((e) => e.type === "RunProducedDiff")!.data).toMatchObject({
      branch: "agent/7",
      headSha: "b".repeat(40),
    });
  });

  /**
   * **The push happens before the person is asked**, which is the ordering `#250`
   * could not have had: the publish lived only in the finalizer, which releases
   * after every append the pass makes.
   *
   * Two rows, and the second is the finalizer saying it ran: it finds the head
   * already where it wanted it and pushes nothing. *The finalizer fired* is the
   * fact `#250` had to infer from a `RUN_LOG_END` line.
   */
  it("pushes before the person is asked, and the log says both refs went", async () => {
    const { result, did, run } = await hitTheWall(true);
    expect(result.ok).toBe("held");

    const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
    expect(did).toContain(push);
    expect(did.indexOf(push)).toBeLessThan(did.indexOf("append WorkItemBlocked"));

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
   * not.** This is the reading `#250` most needed excluded and could not exclude:
   * the publish ran, found the head still at the base, and returned `null` without
   * a word — which on the page is the same nothing as a finalizer that never fired.
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
   * The head is on the row because that is what says whether anything was lost: a
   * rejection with commits behind it is a run somebody can still rescue from the
   * worktree's objects, and `#250`'s was. The person is asked the same question
   * either way — a push that failed is not a second opinion about the ticket.
   */
  it("keeps git's words when the push is refused, and holds the item anyway", async () => {
    const rejected = "! [remote rejected] agent/7 -> agent/7 (stale info)";
    const { result, run, item } = await hitTheWall(true, { push: rejected });
    expect(result.ok).toBe("held");

    const rows = run.filter((e) => e.type === "RunRefsPublished");
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual(["refused", "refused"]);
    expect(rows[0]!.data).toMatchObject({ headSha: "b".repeat(40), detail: rejected });
    // The item is still held, and the card carries what git said — a rescue starts
    // from knowing whether the commits reached origin.
    const blocked = item.find((e) => e.type === "WorkItemBlocked");
    expect(blocked).toBeDefined();
    expect(JSON.stringify(blocked!.data)).toContain("was not pushed");
  });

  /**
   * **One exit code for two refspecs, so a failure is asked which** (`#251`).
   *
   * Origin takes the forced arm, rejects the leased `agent/<n>`, and the command
   * exits non-zero with the commits on origin. Read as a plain refusal it is the
   * exact loss the publish exists to end: a row saying *nothing was pushed* over a
   * ref that is there, and — because `attemptBrief` reads `RunProducedDiff` and
   * nothing else — a next attempt told *Nothing*, starting over from the base while
   * the arm sits unfetched.
   *
   * So the record names **the arm**, not the branch: naming `agent/<n>` would send
   * the next agent to fetch a ref holding whatever invalidated the lease.
   */
  it("finds the arm that survived a half-rejected push, and sends the next attempt to it", async () => {
    const stale = "! [remote rejected] agent/7 -> agent/7 (stale info)";
    const { run, item } = await hitTheWall(true, { leasedBranch: stale });

    const rows = run.filter((e) => e.type === "RunRefsPublished");
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual([
      "arm-only",
      "arm-only",
    ]);
    const produced = run.find((e) => e.type === "RunProducedDiff");
    expect(produced).toBeDefined();
    expect(produced!.data).toMatchObject({
      branch: "agent/7-attempt-1",
      headSha: "b".repeat(40),
    });

    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("git fetch origin agent/7-attempt-1");
  });

  /**
   * **The account never costs the thing it is an account of.**
   *
   * A store that will not take `RunRefsPublished` is swallowed: raising it would
   * abort the body before the `RunProducedDiff` that `attemptBrief` reads, and a
   * ref nobody will fetch is a worse outcome than a missing explanation of a ref
   * that is there.
   */
  it("does not let a refused row change the ending or cost the diff record", async () => {
    const { result, run, item } = await hitTheWall(true, { theRow: true });
    expect(result.ok).toBe("held");
    expect(run.some((e) => e.type === "RunRefsPublished")).toBe(false);
    expect(run.find((e) => e.type === "RunProducedDiff")!.data).toMatchObject({
      branch: "agent/7",
    });
    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("git fetch origin agent/7");
  });

  /**
   * **Asked again within the call that owed the row** (`#252`).
   *
   * `appendNow` throws on a dropped connection, arriving on the one row
   * `attemptBrief` reads and nothing else does. Leaving the repair to *a later
   * call* made it a repair only the endings that publish inline get — and the wall
   * publishes once. So the row is asked for twice inside one call: a round trip on
   * a path that has already failed, and nothing on the path that has not.
   */
  it("asks again for the diff record a dropped append cost, and keeps its own ending", async () => {
    const { result, run, item } = await hitTheWall(true, { theDiff: 1 });
    expect(result.ok).toBe("held");
    expect(run.find((e) => e.type === "RunProducedDiff")!.data).toMatchObject({
      branch: "agent/7",
      headSha: "b".repeat(40),
    });
    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("git fetch origin agent/7");
  });

  /**
   * **And where both asks die the loss is said rather than swallowed.**
   *
   * An `unrecorded` row names the ref, the head and the store's words, so a run
   * whose brief will say *Nothing* over commits that are on origin carries the
   * contradiction on the log where a person can find it.
   */
  it("says the refs are on origin and unrecorded when both asks are refused", async () => {
    const { run } = await hitTheWall(true, { theDiff: 2 });
    const rows = run.filter((e) => e.type === "RunRefsPublished");
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toContain("unrecorded");
    expect(
      rows.find((e) => (e.data as { outcome: string }).outcome === "unrecorded")!.data,
    ).toMatchObject({ headSha: "b".repeat(40) });
  });
});

/**
 * **The other ending that publishes nothing of its own, and it is the one that
 * reaches the merge lane** (0062 §2).
 *
 * `land` pushes `agent/<n>` alone — the lane is about to merge that ref, and an
 * arm written for a landing is one 0062 §4's sweep takes straight back off — and
 * it records the head as published. So a lane that then *refuses* leaves the
 * branch on origin and the arm on none, and the end-of-pass publish used to read
 * its own `published` as the whole answer, short-circuit as `already-published`,
 * push nothing, and write a row naming an `arm` that has never existed.
 *
 * What that costs is exactly what the arm exists to prevent. The card blocks
 * recommending a requeue, attempt 2's `--force-with-lease` matches the lease and
 * overwrites `agent/<n>` from a fresh base, and attempt 1's commits — the diff
 * the live `ApprovalRequested` named — are unreachable on origin with no ref of
 * their own, under a log row asserting both refs went up.
 */
describe("when the merge lane refuses what every step passed", () => {
  const budget = { evidence: 2_000, attempts: 3, findings: 5 };

  /**
   * A lane that says no, with a reason no judge answers.
   *
   * `dirty-base` is one of the five `directionOf` calls null — they stop the lane
   * before the diff is what is in doubt — so the pass is held for a person with
   * no round bought and no second agent, which keeps this test about the refs.
   * `conflict`, `no-commits` and `pending-migration` reach the same publish.
   */
  const theLaneRefuses = async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store, true);
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push("integrate");
        return { ok: false, reason: "dirty-base", detail: "the base branch has local changes" } as never;
      });
    const appended = store.append.bind(store) as EventStore["append"];
    store.append = async (stream, at, events) => {
      for (const e of events) did.push(`append ${e.type}`);
      return appended(stream, at, events);
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // No `--no-merge`: the lane has to be reached for this ending to exist.
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );
    const [runId, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    return { result, did, runId, run, item: await store.read(`wi-${PROJECT}-7`) };
  };

  it("leaves this attempt's own arm on origin, and does not call it already published", async () => {
    const { result, did, run, item } = await theLaneRefuses();
    expect(result.ok, JSON.stringify(result)).toBe("held");

    // The lane pushed the branch on its way in, and the ending published the arm
    // beside it — the second push is the one that was missing.
    const both = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-attempt-1";
    expect(did).toContain("git push HEAD:refs/heads/agent/7");
    expect(did).toContain(both);
    expect(did.indexOf("integrate")).toBeLessThan(did.indexOf(both));
    // Before the person is asked, like every other ending that asks one.
    expect(did.indexOf(both)).toBeLessThan(did.indexOf("append WorkItemBlocked"));

    // And the log says so rather than claiming the refs were already up: the
    // first row is this publish, the second is the finalizer finding nothing
    // left to do.
    const rows = run.filter((e) => e.type === "RunRefsPublished");
    expect(rows.map((e) => (e.data as { outcome: string }).outcome)).toEqual([
      "published",
      "already-published",
    ]);
    expect(rows[0]!.data).toMatchObject({
      branch: "agent/7",
      arm: "agent/7-attempt-1",
      headSha: "b".repeat(40),
    });

    // The whole of what the arm is for: one `lingtai requeue` makes this attempt
    // 2, and the ref its brief names is on origin.
    const brief = nextPrompt({ base: "ticket@1", budget, item, lastRun: run }).failure;
    expect(brief).toContain("git fetch origin agent/7");
  });
});
