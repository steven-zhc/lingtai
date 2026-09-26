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
 * what has to be checked here: `implement`'s body reads `NeverStarted` from its
 * port and reports `never-ran`, `outcomeOf` reads that as `failed`, and
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
import { describe, expect, it } from "vitest";
import {
  PROJECT,
  RECIPE,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  quotaRuntime,
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
