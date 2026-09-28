/**
 * **Eighty events in ninety-two seconds, answered once** —
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3, carried
 * across when `#256` replaced the engine it was written against.
 *
 * Six runs, six claims, six worktrees, six branches and `costUsd` of nothing on
 * every one of them, because per-item backoff was answering a condition that was
 * never about the item. The item is still *released* as any failed run's is — it
 * keeps its place and nothing is taken from anybody. What changes is that nothing
 * else is taken either, until the pause lifts.
 *
 * **The pass says this and the caller does it**, and that division is the whole of
 * what has to be checked here: the `agent:` action at `implement` answers
 * `never-ran`, `endingOf` reports it as the step's ending (`#266`; it was the
 * body reading a port until then), `outcomeOf` reads that as `failed`, and
 * `conduct.ts` is what appends `ConductorPaused` — once, on the control stream,
 * whichever item met the wall. A `did-not-finish` would hold the item for a person
 * and leave the account-wide condition unsaid, and the next queue pass would claim
 * the next ticket and walk into the same wall. That is 0031's own incident.
 *
 * **The clock is the exception, and it is reachable from here.** `standDown` takes
 * an optional `now` and `standDownConductor` passes none, so *resets 11pm
 * (America/Chicago)* resolves against the host's real clock. Nothing mocks it, so
 * an assertion about the answer must be true at every instant: `wallHourIn`
 * asserts the hour *in the zone the message named*, and an assertion on the UTC
 * hour is one that fails for the four months a year that zone is not in daylight
 * time (`#251`).
 */
import type { Runtime } from "@lingtai/agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DRAFTED,
  PROJECT,
  RECIPE,
  REVIEWED,
  JUDGED_BY_AN_AGENT,
  designerAtTheWall,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  quotaRuntime,
  reviewerAtTheWall,
  reviewerThatCrashes,
  runtime,
  streams,
} from "../test/one-pass.ts";

/**
 * The hour a stored instant reads on `zone`'s own wall clock.
 *
 * What this claims is what the runtime's message said — *11pm (America/Chicago)* —
 * and that claim is one hour, always. The instant it resolves to is not:
 * `parseResetAt` finds the next moment Chicago reads 23:00, which is `04:00Z` in
 * daylight time and `05:00Z` in standard time, so `getUTCHours()` was an assertion
 * that went red on the first Sunday in November and green again on the second in
 * March.
 */
const wallHourIn = (zone: string, at: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit" }).format(
    new Date(at),
  );

describe("when a run never starts", () => {
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
      // **`failed` and not `held`**, which is the distinction the whole ADR is
      // about: a wall about the account asks nobody, so the claim goes back to the
      // queue rather than onto somebody's *Waiting on you*.
      expect(result.ok, `attempt ${attempt + 1}`).toBe(false);
      if (result.ok === false) expect(result.stage, `attempt ${attempt + 1}`).toBe("implement");
    }

    // Every run said what it was, in the vocabulary that is checkable. `crash` is
    // what all six of them said before, which is why the night was unreadable.
    const runs = [...streams(store)].filter(([id]) => id.startsWith("run-"));
    const endings = runs.flatMap(([, events]) =>
      events.filter((e) => e.type === "RunFailed").map((e) => (e.data as { kind: string }).kind),
    );
    expect(endings).toEqual(Array.from({ length: 6 }, () => "never-started"));

    // The items keep their place: each attempt released, as any failed run does.
    const item = await store.read(`wi-${PROJECT}-7`);
    expect(item.filter((e) => e.type === "WorkItemReleased")).toHaveLength(6);

    // **And each release says what happened, which is the card's whole line.**
    // `WorkItemReleased.reason` overwrites the note the projection wrote from
    // `RunFailed`, so `run failed: ${kind}` was where the reason stopped (0031 §6,
    // `#100`) — the prose was in the history and the card said `crash`.
    const released = item.filter((e) => e.type === "WorkItemReleased");
    const reason = (released[0]!.data as { reason: string }).reason;
    expect(reason).toContain("You've hit your session limit");
    // And which step met it, because the release is read beside nine others.
    expect(reason).toContain("implement");

    // And the account-wide answer was given exactly once.
    const control = await store.read("ctl-conductor");
    const paused = control.filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);

    const d = paused[0]!.data as { by: string; reason: string; until: string };
    // `lingtai` and not a person: a pause with nobody's name on it would read as a
    // bug rather than as a decision.
    expect(d.by).toBe("lingtai");
    // Read out of the message, not guessed at: 11pm in Chicago, as an instant —
    // and asked back in Chicago, because that is where the message said it.
    expect(wallHourIn("America/Chicago", d.until)).toBe("23");
    // The evidence is on the pause, because this is the only place a person can
    // learn what actually stopped the queue.
    expect(d.reason).toContain("You've hit your session limit");

    // **Nothing was spent, and nothing was left half done.** Six worktrees cut and
    // six removed — the finalizer is unconditional, so a pass that stopped at the
    // wall still unwinds.
    expect(did.filter((line) => line.startsWith("provision "))).toHaveLength(6);
    expect(did.filter((line) => line.startsWith("remove "))).toHaveLength(6);
    // And no merge lane was reached on any of them.
    expect(did).not.toContain("integrate");
  });

  /**
   * **The `end` step's effects are carried out on this ending too, and not only
   * recorded.**
   *
   * The pass runs `end` on every outcome and appends `EndActionsResolved`;
   * `tellGitHubAbout` is what carries the plan out, and it reads it from
   * `appended` and from nowhere else (`tell.ts`). The `landed` and `blocked`
   * endings always handed it over; the `failed` ending — this one, and the
   * restart — called `release`, which is declared above the scope holding the
   * plan and so passed `labels` and nothing else.
   *
   * What that costs is silent in both directions. No `closeIssue` runs and no
   * `IssueUpdateFailed` is recorded for `converge.ts` to retry; and because
   * `resolveEndActions` resolves once per outcome (`end-step.ts`), every later
   * pass resolves nothing, so `endedWithoutEndActions` finds a matching row and
   * reports nothing wrong. A recipe's `end:` is simply not obeyed, for ever,
   * with the log saying it was.
   */
  it("carries out the end actions a failed ending resolved, rather than only recording them", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const closing = RECIPE.replace(
      "steps: {}",
      "steps:\n  end:\n    - { name: close it, when: failed, close: true }",
    );

    const result = await once(
      {
        project,
        client: fakeGitHub(said, closing),
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
    expect(result).toMatchObject({ ok: false, stage: "implement" });

    // The plan reached the log, which is the half that already worked.
    const item = await store.read(`wi-${PROJECT}-7`);
    const resolved = item.find((e) => e.type === "EndActionsResolved");
    expect(resolved, "the end step resolved nothing").toBeDefined();
    expect(resolved!.data).toMatchObject({ outcome: "failed" });

    // And it reached GitHub, which is the half that did not.
    expect(said).toContain("close #7");
    // Recorded as done, so `converge.ts` has nothing to retry and
    // `endedWithoutEndActions` has nothing to report.
    expect(item.map((e) => e.type)).not.toContain("IssueUpdateFailed");
  });
});

/**
 * **The second agent in a pass, and the two ways it can produce no verdict** —
 * `#133`/[0041](../../../doc/decisions/0041-a-gate-that-never-ran.md) §3 and
 * `#196`/[0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md).
 *
 * The distinction is the whole point and it is a caller-side one: a `never-ran`
 * measured the **account**, so the conductor stands down and the item goes back
 * to the queue; a `did-not-finish` is local — a reused session id, a settings
 * path that is not there — so nothing about the queue changes and a person is
 * asked. Standing the queue down for the second would be 0041's own category
 * error pointed the other way.
 *
 * Neither could be asserted anywhere after `#256` deleted
 * the old engine's two test files: `reviewerAtTheWall`
 * and `reviewerThatCrashes` survived in `test/one-pass.ts` carrying these two
 * citations and no test imported either, so the sentence a person is woken by at
 * 2am was guarded by nothing. `quotaRuntime` above cannot make the claim — it is
 * the *run's* own wall, which is `{of: "run"}` and the one branch that was
 * covered.
 */
describe("when an agent inside the pass produces no verdict", () => {
  /**
   * **The reviewer met the wall, and the sentence says so about the reviewer.**
   *
   * The implementer ran, took turns and was paid for them, so *a run ended
   * without ever starting — no turns taken, nothing spent* is false about this
   * pass in every clause (`never-started.ts`'s three variants). The pause is the
   * same; the words are not, and the board's chip and `lingtai doctor` are where
   * they are read.
   */
  it("names the step's agent that met the wall, not the run that was paid for", async () => {
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
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    // Released rather than held: the wall is about the account, so it asks
    // nobody — the same ending `quotaRuntime` gets, at the step that met it.
    expect(result).toMatchObject({ ok: false, stage: "proposed" });

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    // **The run started and was paid**, which is the fact that makes the
    // `{of: "run"}` sentence a lie here rather than merely imprecise.
    expect(run.find((e) => e.type === "RunFinished")!.data).toMatchObject({
      turns: 3,
      costUsd: 0.42,
    });
    // And the reviewer judged nothing — `never-ran`, not a refusal of the diff.
    const never = run.find((e) => e.type === "StepNeverRan")!;
    expect(never.data).toMatchObject({ step: "proposed", action: "review" });

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const reason = (paused[0]!.data as { reason: string }).reason;
    // Which agent, by name, and where it was declared.
    expect(reason).toContain("the proposed:review step's agent never started");
    expect(reason).toContain("the run that reached it did start, and was paid for");
    // The falsehood the three variants exist to prevent.
    expect(reason).not.toContain("no turns taken, nothing spent");
    // The runtime's own words, because this is the only place a person can learn
    // what stopped the queue.
    expect(reason).toContain("You've hit your session limit");

    // The item keeps its place, as any failed run's does.
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemReleased");
  });

  /**
   * **The *first* agent a pass can buy, and its own sentence** — the `agent:` a
   * recipe declares at `design` (`#265`).
   *
   * It is the one wall met inside a run that started and has paid for **no** agent:
   * `agentPlugin.at` opens at `design` before any other step, so `claim`, `admit`
   * and `prepared` have run and nothing has been dispatched. Both of the sentences
   * that already existed are false about that pass. `{of: "run"}` opens *a run
   * ended without ever starting — no turns taken, nothing spent*, about a pass that
   * claimed the ticket and cut a worktree — and it is what `conduct.ts` selected,
   * on the stated premise that `design` had no cell open, which is what this ticket
   * makes untrue. `{of: "step"}` ends *nothing judged the diff*, and one step before
   * `implement` there is no diff.
   *
   * What the pause has to carry is the same three things every other depth's does:
   * which agent, until when, and where the time came from — so the step and the
   * action are in it by name, and a person reading the board's chip is told the
   * design was not written rather than that a run never started.
   */
  it("names the drafting agent when the first agent a pass buys meets the wall", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, DRAFTED),
        runtime: designerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    // Released rather than held, at the step that met it — the wall is about the
    // account, so it asks nobody.
    expect(result).toMatchObject({ ok: false, stage: "design" });

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    // The drafting agent is the one that ran, by name, and nothing after it did:
    // `RunStarted` is `firstDispatch`'s and is never reached.
    expect(run.find((e) => e.type === "StepNeverRan")!.data).toMatchObject({
      step: "design",
      action: "draft",
    });
    expect(run.map((e) => e.type)).not.toContain("RunStarted");
    expect(run.map((e) => e.type)).not.toContain("RunFinished");
    expect(did).not.toContain("wire");

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const reason = (paused[0]!.data as { reason: string }).reason;
    // Which agent, by name, and what did not happen because of it.
    expect(reason).toContain("the design:draft step's agent never started");
    expect(reason).toContain("nothing drafted the design");
    // The falsehood `{of: "run"}` would have written here, and the one
    // `{of: "step"}` would have.
    expect(reason).not.toContain("no turns taken, nothing spent");
    expect(reason).not.toContain("nothing judged the diff");
    // The runtime's own words, because this is the only place a person can learn
    // what stopped the queue.
    expect(reason).toContain("You've hit your session limit");

    // The item keeps its place, as any failed run's does.
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemReleased");
  });

  /**
   * **The third agent in a pass, and the third sentence** — the agent a round
   * bought, which meets the same wall at the same step the implementer did.
   *
   * `never-started.ts` has exactly three variants because there are three agents,
   * and `{of: "fix"}` is the one nothing constructed: the pass has one `implement`
   * step and `conduct.ts` dispatches two different agents at it, while
   * `StepNeverRan` carries the runtime's id rather than which of the two it was.
   * So `stopped.step === "implement"` selected `{of: "run"}` for both, and the
   * pause read *a run ended without ever starting — no turns taken, nothing
   * spent* about a pass whose implementer ran for 3 turns and $0.42 and whose lane
   * then refused it. Every clause false, in `ConductorPaused.reason` — the board's
   * pause chip and `lingtai doctor` — which is `#133`'s own species of sentence
   * one agent further down.
   *
   * The route is the mechanical one and it has to be: a `verify-failed` from the
   * lane is what `BUILT_IN_FOR` answers `same-worktree` to, so `implement` is
   * offered and a round is spent. A refusal at `proposed` itself buys nothing —
   * `ARRIVE_AT_THE_ROUTER` does not include the step — and `conflict`,
   * `needs-input` and `findings` have a person as their floor.
   */
  it("names the agent a round bought when that is what met the wall", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);
    // The lane refuses with the one reason a round is bought for.
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push("integrate");
        return { ok: false, reason: "verify-failed", detail: "policy: this branch may not land" } as never;
      });

    /** The implementer works and is paid; the agent the round buys never starts. */
    const fixerAtTheWall: Runtime = {
      ...runtime,
      run: async (request) =>
        request.runId.includes(":fix:")
          ? {
              exitCode: 1,
              turns: 0,
              durationMs: 7_000,
              costUsd: 0,
              failure: {
                kind: "never-started",
                detail: "You've hit your session limit \u00b7 resets 11pm (America/Chicago)",
              },
              text: null,
              sessionId: "sess-fix",
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
        client: fakeGitHub(said),
        runtime: fixerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // No hold at `merge`: the lane has to be reached for it to refuse.
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    // Released, at the step the wall was met at — `implement`, because that is
    // where a round's agent runs.
    expect(result).toMatchObject({ ok: false, stage: "implement" });

    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    // A round *was* bought, or this is not the branch under test.
    expect(run.find((e) => e.type === "FixRequested")!.data).toMatchObject({
      round: 1,
      action: "merge",
    });
    /**
     * **And the decision that bought it is on the log, not only in the run log**
     * (`#271`).
     *
     * `runLog.note` still says it while the pass is in flight, and that file is
     * kept only while something is owed an explanation (0034) — so on a landing
     * there was no account anywhere of why a round was spent. This run does not
     * land, which is exactly the ending whose run log survives: asserting the
     * event here says the append does not depend on the ending.
     */
    expect(run.find((e) => e.type === "PassRouted")!.data).toEqual({
      from: "merge",
      chose: "implement",
      to: "implement",
      why: expect.stringContaining("same-worktree"),
      ceiling: null,
    });
    // And the run that reached it was paid for, which is what makes the
    // `{of: "run"}` sentence a lie here rather than merely imprecise.
    expect(run.find((e) => e.type === "RunFinished")!.data).toMatchObject({
      turns: 3,
      costUsd: 0.42,
    });

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const reason = (paused[0]!.data as { reason: string }).reason;
    // The fixing agent, by name, and what it was bought to answer.
    expect(reason).toContain("the agent bought to fix merge (round 1) never started");
    expect(reason).toContain("the run that reached it did start, and was paid for");
    // The falsehood the three variants exist to prevent.
    expect(reason).not.toContain("no turns taken, nothing spent");
    expect(reason).toContain("You've hit your session limit");
  });

  /**
   * **The fourth agent in a pass is the judge, and its wall is the account's**
   * (0031 §3, `#277`).
   *
   * The comment above says there are three agents, and `#277` added a fourth: a
   * `judge:` naming a runtime is dispatched and paid for. It arrived treating
   * every failure alike — `askTheAgent` answered `next: "waiting"` for all of
   * them — and its own docblock argued for it, on the grounds that *the pass
   * stops at `proposed` for a person either way*. That is true about this pass
   * and is not what §3 decides. §3 is about the **conductor**: a quota is
   * account-wide, so every queued item would meet it, and per-item backoff is
   * the wrong instrument — `80` events in `92` seconds is what using it looked
   * like. A hold also loses §5: a pause lifts by itself at the reset, and a
   * `waiting` ticket waits for a person.
   *
   * So the wall is the judge's and the answer is the same as every other
   * depth's: the item is released like any other failure, nothing else is
   * taken until the pause lifts, and the runtime's own words carry the reset.
   *
   * **A crash is still a person's**, which is the other half — see the next
   * case for the reviewer, and `askTheAgent`'s `held` for the judge. The split
   * is `kind === "never-started"` and is the adapter's classification, never
   * re-derived here (0031 §1).
   */
  it("pauses the conductor when the judge it dispatched never started", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const ports = fakePorts(did, store);

    /** Everything runs and is paid for; only the judge meets the wall. */
    const ran: string[] = [];
    const judgeAtTheWall = {
      ...refusingRuntime,
      run: async (request: Parameters<typeof refusingRuntime.run>[0]) => {
        ran.push(request.runId);
        if (!request.runId.includes(":judge:")) return refusingRuntime.run(request);
        return {
          exitCode: 1,
          turns: 0,
          durationMs: 5_000,
          costUsd: 0,
          failure: {
            kind: "never-started" as const,
            detail: "You've hit your session limit \u00b7 resets 11pm (America/Chicago)",
          },
          text: null,
          sessionId: "sess-judge",
        };
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, JUDGED_BY_AN_AGENT),
        runtime: judgeAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    // It was asked, or this is not the branch under test.
    expect(ran.filter((id) => id.includes(":judge:"))).toHaveLength(1);

    // **Released, not held** — the distinction the whole case is about. A hold
    // answers `ok: "held"` and leaves the item for a person.
    expect(result).toMatchObject({ ok: false, stage: "proposed" });

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const reason = (paused[0]!.data as { reason: string }).reason;
    // The step whose agent met it, and the clause that is the point of §3.
    expect(reason).toContain("proposed");
    expect(reason).toContain("Every queued item would meet the same thing");
    // The reset came from the message, not from the recipe's backoff (0031 §4).
    expect(reason).not.toContain("it named no reset time");
    expect(reason).toContain("You've hit your session limit");
    // And the run that reached the judge did start and was paid for, so the
    // sentence must not be the one written for a run that took no turns.
    expect(reason).not.toContain("no turns taken, nothing spent");
  });

  /**
   * **A reviewer that started and left no receipt goes to a person, and the
   * queue is untouched** (0057 §1–§3).
   *
   * `#192` spent rounds 2 and 3 on a reviewer that died in one second, because
   * the evidence said *the reviewer did not finish* and the verdict beside it
   * said `failed` — the verdict a reviewer that read the diff and refused it
   * returns. The pass stops here instead: no round is bought, nothing is routed
   * (`goesToTheRouter` refuses a crash), and what a person is shown is about the
   * machinery rather than about the change.
   */
  it("sends a reviewer that left no verdict to a person, and pauses nothing", async () => {
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

    // Held at the step that produced nothing, and a person holds it.
    expect(result).toMatchObject({ ok: "held", step: "proposed" });
    // Run once (`#234`): 0057 §4's retry is gone, and a second attempt would be
    // the same machine failing the same way at the same price.
    expect(tried.n).toBe(1);

    // **The queue is not stood down.** A crash is local, so pausing every other
    // ticket for it is 0041's category error with the sign flipped.
    expect(await store.read("ctl-conductor")).toEqual([]);

    const item = await store.read(`wi-${PROJECT}-7`);
    const types = item.map((e) => e.type);
    expect(types).toContain("WorkItemBlocked");
    expect(types).not.toContain("WorkItemReleased");

    const blocked = item.find((e) => e.type === "WorkItemBlocked")!.data as {
      needs: string;
      question: string;
      diagnosis: { raw: string | null };
    };
    // Nothing is being asked of anybody's judgement about the diff: the
    // machinery broke and the log is asking for it to be acknowledged.
    expect(blocked.needs).toBe("acknowledgement");
    expect(blocked.question).toContain("did-not-finish");
    // The reviewer's own ending, verbatim, rather than a sentence about the diff.
    expect(blocked.diagnosis.raw).toContain("the reviewer did not finish (crash)");
    expect(blocked.diagnosis.raw).toContain("already in use");

    // And no round was bought to answer a judgement nobody made.
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    expect(run.map((e) => e.type)).not.toContain("FixRequested");
    expect(run.find((e) => e.type === "StepDidNotFinish")!.data).toMatchObject({
      step: "proposed",
      action: "review",
    });
  });
});
