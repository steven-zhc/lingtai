/**
 * The page says why a task is not moving, and says it first.
 *
 * The failure this is written against is a reading failure: the state had to be
 * inferred by reading to the bottom of a 30–80 row history, and on 2026-09-08
 * that produced a wrong reading four times (#80, #87, #89, #94). So the
 * assertions are about the two halves that were absent — *what state, for how
 * long, from which attempt*, and *one line of evidence with a pointer to the
 * whole of it* — and about the degradation #83 requires: a block with no
 * diagnosis renders as it does today rather than breaking.
 *
 * The fold is settled by envelopes, the way every fold in `task.ts` is. The
 * rendering is asserted on the markup, for the reason #101 established: the
 * question was never a fact about the payload, it appears in the render.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import { foldRun, standingOf, type Claim, type StandingView } from "../src/lib/task.ts";
import { Standing } from "../src/app/standing.tsx";

let seq = 0n;

function e(streamId: string, type: string, data: unknown, at = "2026-09-08T04:12:15Z"): Envelope {
  seq += 1n;
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date(at),
  };
}

const ITEM = "wi-lingtai-89";
const RUN_1 = "run-11111111-0000-0000-0000-000000000000";
const RUN_2 = "run-22222222-0000-0000-0000-000000000000";
const SHA = "a".repeat(40);

const claim = (runId: string, at: string): Claim => ({ runId, at, repair: false, released: null });

/** The failure as a gate hands it over: a tail, not a line. */
const TAIL = [
  "packages/actions typecheck: test/agent-gate.test.ts(36,5): error TS2741:",
  "  Property 'enforcesLimits' is missing in type '{ id: \"claude-code\"; … }'",
  "Exit code 2",
].join("\n");

describe("the state, and how long it has held", () => {
  it("states the block and dates it from the block, not from the last event", () => {
    // The clock is on *how long you have been the bottleneck*. A link filed
    // against the item while the hold stands is not the hold starting again.
    const standing = standingOf(
      [
        e(ITEM, "WorkItemDiscovered", { project: "lingtai", externalRef: "89" }, "2026-09-06T09:00:00Z"),
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }, "2026-09-08T03:00:00Z"),
        e(ITEM, "WorkItemBlocked", {
          question: "approve the diff for #89?",
          needsFrom: "human",
          runId: RUN_1,
          needs: "judgement",
          diagnosis: null,
        }, "2026-09-08T04:12:15Z"),
        e(ITEM, "WorkItemLinked", { relation: "follows-up", otherRef: "58" }, "2026-09-08T08:24:00Z"),
      ],
      [],
    );

    expect(standing.state).toBe("blocked");
    expect(standing.since).toBe("2026-09-08T04:12:15.000Z");
    expect(standing.onYou).toBe(true);
    expect(standing.who).toBe("waiting on you");
    expect(standing.question).toBe("approve the diff for #89?");
  });

  /**
   * #94's reading: the item was not stuck at all and would have returned on its
   * own. The absence of the word "blocked" was the only thing saying so, at the
   * bottom of an 80-row list.
   */
  it("says an item nobody is holding is queued, and that nobody is waiting on you", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }, "2026-09-08T03:00:00Z"),
        e(ITEM, "WorkItemReleased", { runId: RUN_1, reason: "timeout" }, "2026-09-08T04:00:00Z"),
      ],
      [],
    );

    expect(standing.state).toBe("queued");
    expect(standing.onYou).toBe(false);
    expect(standing.who).toBe("waiting for a conductor to take it");
    expect(standing.since).toBe("2026-09-08T04:00:00.000Z");
  });

  it("reads a run in flight as running rather than as an absence", () => {
    const standing = standingOf(
      [e(ITEM, "WorkItemClaimed", { runId: RUN_1, worker: "daemon" }, "2026-09-08T03:00:00Z")],
      [],
    );

    expect(standing.state).toBe("running");
    expect(standing.onYou).toBe(false);
    expect(standing.who).toBe("an agent is working");
  });

  it("names the attempt that produced the state, and how many there have been", () => {
    const runs = [
      foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, []),
      foldRun(claim(RUN_2, "2026-09-08T06:00:00.000Z"), 2, []),
    ];
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemReleased", { runId: RUN_1, reason: "repair" }),
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "conflict: agent/89 does not merge into main",
          needsFrom: "human",
          runId: RUN_2,
          needs: "acknowledgement",
          diagnosis: null,
        }),
      ],
      runs,
    );

    expect(standing.attempt).toBe(2);
    expect(standing.attempts).toBe(2);
    expect(standing.runId).toBe(RUN_2);
  });
});

describe("the evidence", () => {
  it("carries one line and names the attempt that holds the whole of it", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_1, "GateFailed", { gate: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemBlocked", {
          question: "the build refused it",
          needsFrom: "human",
          runId: RUN_1,
          needs: "acknowledgement",
          diagnosis: null,
        }),
      ],
      [run],
    );

    expect(standing.deciding).toEqual({
      attempt: 1,
      source: "proposed / build",
      line: "packages/actions typecheck: test/agent-gate.test.ts(36,5): error TS2741:",
    });
    // A pointer, and not a copy. Printing the failing gate twice — at the top
    // and inside its attempt — is how two copies of one fact come to disagree.
    expect(standing.deciding?.line).not.toContain("Exit code 2");
    expect(standing.failed).toEqual(["proposed:build"]);
  });

  /**
   * The case a gate-shaped summary could never name: a run that died before any
   * verdict landed. `#89`'s `error_max_turns` is exactly this.
   */
  it("falls back to the attempt's own outcome when no gate ever reported", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunStarted", { baseSha: SHA }),
      e(RUN_1, "RunFailed", { kind: "error_max_turns" }),
    ]);
    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 })], [run]);

    expect(standing.deciding).toEqual({ attempt: 1, source: "failed", line: "error_max_turns" });
  });

  it("points at nothing when there is nothing that went wrong to point at", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunStarted", { baseSha: SHA }),
      e(RUN_1, "RunFinished", { turns: 12, durationMs: 60_000, costUsd: 1, exitCode: 0 }),
    ]);
    expect(standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 })], [run]).deciding).toBeNull();
  });
});

describe("the move the block ends in", () => {
  const blocked = (runId: string) =>
    e(ITEM, "WorkItemBlocked", {
      question: "approve?",
      needsFrom: "human",
      runId,
      needs: "judgement",
      diagnosis: null,
    });

  it("sends the sha the run is asking about, not the one it produced", () => {
    // #92: they differ the moment a branch is repaired and approval re-requested
    // on a new head, and sending the wrong one refuses what the CLI accepts.
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "ApprovalRequested", { gate: "proposed", action: "human", onSha: "b".repeat(40) }),
      e(RUN_1, "RunProducedDiff", { headSha: SHA, branch: "agent/89", files: 2, insertions: 9, deletions: 1 }),
    ]);
    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 }), blocked(RUN_1)], [run]);

    expect(standing.awaitingSha).toBe("b".repeat(40));
    expect(standing.headSha).toBe(SHA);
  });

  /**
   * #84: an item whose approved merge hit a conflict has no open question, and
   * Approve refuses every click. The block must not offer one.
   */
  it("has nothing to approve once the approval was spent", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "ApprovalRequested", { gate: "merge", action: "human", onSha: SHA }),
      e(RUN_1, "ApprovalGranted", { gate: "merge", action: "human", onSha: SHA, by: "human:steven" }),
    ]);
    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 }), blocked(RUN_1)], [run]);

    expect(standing.awaitingSha).toBeNull();
  });

  it("asks nothing of anybody while a run is still in flight", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "ApprovalRequested", { gate: "proposed", action: "human", onSha: SHA }),
    ]);
    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 })], [run]);

    expect(standing.state).toBe("running");
    expect(standing.awaitingSha).toBeNull();
  });
});

// --------------------------------------------------------------- rendered ----

const HELD: StandingView = {
  state: "blocked",
  since: "2026-09-08T04:12:15.000Z",
  onYou: true,
  who: "waiting on you",
  question: "conflict: agent/112 does not merge into develop: apps/web/page.tsx",
  needs: null,
  diagnosis: null,
  attempt: 2,
  attempts: 2,
  runId: RUN_2,
  awaitingSha: null,
  headSha: SHA,
  failed: [],
  deciding: { attempt: 1, source: "proposed / build", line: "error TS2741: …" },
};

describe("the block, rendered", () => {
  /**
   * #83's own requirement, and the reason this is one component rather than
   * two: the fields it fills are absent on every block written before it, and
   * those have to keep rendering.
   */
  it("degrades to the state, the age, the question and the move when nothing is diagnosed", () => {
    const html = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} />);

    expect(html).toContain("blocked");
    expect(html).toContain("from attempt 2 of 2");
    expect(html).toContain("conflict: agent/112 does not merge into develop");
    // The move that is left when there is no diff to approve (#84).
    expect(html).toContain("Back to the queue");
    // Nothing pretends to a diagnosis nobody wrote.
    expect(html).not.toContain('class="diag"');
    expect(html).not.toContain('class="rec"');
  });

  it("fills the diagnosis and the recommendation into the same block, leaving the question where it was", () => {
    const html = renderToStaticMarkup(
      <Standing
        standing={{
          ...HELD,
          needs: "acknowledgement",
          diagnosis: {
            what: "the branch does not merge into develop",
            done: "a repair for conflict ran as run-2 and produced this diff",
            raw: "CONFLICT (content): Merge conflict in apps/web/page.tsx",
            recommendation: { action: "requeue", why: "develop has moved; a fresh branch should merge" },
          },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
      />,
    );

    expect(html).toContain("a failure needs acknowledging");
    expect(html).toContain("the branch does not merge into develop");
    expect(html).toContain("recommends requeue");
    expect(html).toContain("conflict: agent/112 does not merge into develop");
    // The raw failure stays where the whole of it is. A copy at the top is the
    // second version of one fact that design §2 is about.
    expect(html).not.toContain("CONFLICT (content)");
  });

  it("points at the attempt rather than reprinting it", () => {
    const html = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} />);
    expect(html).toContain('href="#attempt-1"');
    expect(html).toContain("in attempt 1");
  });

  /**
   * Amber means *a human is being waited on* and nothing else in this palette
   * does, so the rule that states the block's extent is amber on exactly one
   * kind of item — and the block itself is drawn for all of them.
   */
  it("spends its amber only when a person is the thing being waited on", () => {
    const on = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} />);
    expect(on).toContain('class="standing onyou"');

    const off = renderToStaticMarkup(
      <Standing
        standing={{ ...HELD, state: "running", onYou: false, who: "an agent is working", question: null }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
      />,
    );
    expect(off).toContain('class="standing"');
    expect(off).toContain("an agent is working");
    // Nothing is being asked, so nothing offers to answer it.
    expect(off).not.toContain("Back to the queue");
  });

  it("states the state with no move at all when the id is not a work item", () => {
    const html = renderToStaticMarkup(<Standing standing={HELD} project={null} issue={null} taskId="wi-lingtai-112" discussions={[]} />);
    expect(html).toContain("blocked");
    expect(html).not.toContain("Back to the queue");
  });
});
