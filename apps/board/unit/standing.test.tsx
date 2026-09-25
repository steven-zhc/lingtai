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
import type { OutgoingView } from "../src/lib/prompt.ts";
import { Coords, Standing, soWhat } from "../src/app/standing.tsx";

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
      e(RUN_1, "GateFailed", { step: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
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
   * The attempt a quota stopped, named as itself (#133).
   *
   * The run *finished* — exit 0, turns taken, money spent — so nothing about its
   * own outcome says why the pass ended, and without this the page reaches back
   * to attempt 1's genuine refusal and puts an old red line at the top of a page
   * whose actual answer is that the account ran out. What it says instead names
   * the gate, says nothing judged the diff, and calls nothing a refusal.
   */
  it("names a gate that never ran, rather than an earlier attempt's refusal", () => {
    const one = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_1, "GateFailed", { step: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    const two = foldRun(claim(RUN_2, "2026-09-08T04:00:00.000Z"), 2, [
      e(RUN_2, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_2, "GatePassed", { step: "proposed", action: "build", onSha: SHA, evidence: "ok" }),
      e(RUN_2, "GateNeverRan", {
        step: "proposed",
        action: "review",
        onSha: SHA,
        detail: "You've hit your session limit · resets 2pm (America/Chicago)",
      }),
      e(RUN_2, "RunFinished", { turns: 3, durationMs: 60_000, costUsd: 0.42, exitCode: 0 }),
    ]);

    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemReleased", { runId: RUN_1, reason: "the proposed:build gate refused it" }),
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
      ],
      [one, two],
    );

    expect(standing.deciding?.attempt).toBe(2);
    expect(standing.deciding?.source).toBe("proposed / review");
    expect(standing.deciding?.line).toContain("never ran");
    expect(standing.deciding?.line).toContain("You've hit your session limit");
    expect(standing.deciding?.line).not.toContain("refused");
    expect(standing.deciding?.line).not.toContain("TS2741");
  });

  /**
   * The neighbouring ending, and the same trap
   * ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md), `#196`).
   *
   * The reviewer started and crashed — and this run also *finished*, exit 0,
   * three turns, forty-two cents. Looking for a refusal first would put attempt
   * 1's build failure at the top of a page whose actual answer is that the
   * reviewer never produced a verdict. And the line must not call it a refusal:
   * nothing judged the diff.
   *
   * One `GateDidNotFinish`, because the action is run once (`#234`).
   */
  it("names a gate that did not finish, rather than an earlier attempt's refusal", () => {
    const one = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_1, "GateFailed", { step: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    const two = foldRun(claim(RUN_2, "2026-09-08T04:00:00.000Z"), 2, [
      e(RUN_2, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_2, "GatePassed", { step: "proposed", action: "build", onSha: SHA, evidence: "ok" }),
      e(RUN_2, "GateDidNotFinish", {
        step: "proposed",
        action: "review",
        onSha: SHA,
        detail: "the reviewer did not finish (crash): Error: Session ID 0f1e is already in use.",
      }),
      e(RUN_2, "RunFinished", { turns: 3, durationMs: 60_000, costUsd: 0.42, exitCode: 0 }),
    ]);

    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemReleased", { runId: RUN_1, reason: "the proposed:build gate refused it" }),
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
      ],
      [one, two],
    );

    expect(standing.deciding?.attempt).toBe(2);
    expect(standing.deciding?.source).toBe("proposed / review");
    expect(standing.deciding?.line).toContain("did not finish");
    expect(standing.deciding?.line).toContain("already in use");
    // Not a refusal, and not the stale build from attempt 1.
    expect(standing.deciding?.line).not.toContain("refused");
    expect(standing.deciding?.line).not.toContain("TS2741");
    // And not 0041's sentence either: nothing here says the account is walled.
    expect(standing.deciding?.line).not.toContain("never ran");
  });

  /**
   * The same attempt, two rounds: a refusal the fixer answered, then the quota.
   *
   * `foldRun` keeps one entry per gate for the whole attempt, so round 1's
   * `proposed:test` refusal is still there when round 2's review never runs —
   * and `test` never runs again to replace it. Looking for a refusal first put
   * that stale line, about a commit that is no longer the head, where the quota
   * that actually ended the pass should be.
   */
  it("names the gate that never ran over an earlier round's refusal in the same attempt", () => {
    const FIXED = "c".repeat(40);
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_1, "GatePassed", { step: "proposed", action: "review", onSha: SHA, evidence: "ok" }),
      e(RUN_1, "GateFailed", { step: "proposed", action: "test", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunProposedCompletion", { headSha: FIXED }),
      e(RUN_1, "GateNeverRan", {
        step: "proposed",
        action: "review",
        onSha: FIXED,
        detail: "You've hit your session limit · resets 2pm (America/Chicago)",
      }),
      e(RUN_1, "RunFinished", { turns: 3, durationMs: 60_000, costUsd: 0.42, exitCode: 0 }),
    ]);

    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 })], [run]);

    expect(standing.deciding?.source).toBe("proposed / review");
    expect(standing.deciding?.line).toContain("never ran");
    expect(standing.deciding?.line).not.toContain("TS2741");
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

  /**
   * `wi-lingtai-89`, and the reason the block had no pointer at all on
   * 2026-09-09 (#111). The repair is the named attempt and it ended *well* — exit
   * 0, no commits, no gate ever reported — so it refused nothing; the failure
   * everybody is looking at is attempt 1's. A pointer that only ever looked at
   * the named run found nothing, and the flattened `question` became the only
   * evidence on screen.
   *
   * The design's own example reads exactly this way: *from attempt 2 of 2* at the
   * top, *in attempt 1 ↓* on the evidence.
   */
  it("walks back to the attempt that refused when the named one refused nothing", () => {
    const first = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_1, "GateFailed", { step: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    // The repair, from a log written before `#143` retired the purchase: it
    // finished, cleanly, and produced nothing.
    const repair = foldRun(
      { runId: RUN_2, at: "2026-09-08T06:00:00.000Z", repair: true, released: null },
      2,
      [e(RUN_2, "RunStarted", { baseSha: SHA }), e(RUN_2, "RunFinished", { turns: 5, durationMs: 60_000, costUsd: 5.23, exitCode: 0 })],
    );

    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        // Retired, and still read: this is an old ticket's stream, and the
        // walk below has to work on one (`#143`).
        e(ITEM, "RepairRequested", { runId: RUN_1, reason: "gate-failed", detail: TAIL, fingerprint: "x", attempt: 1 }),
        e(ITEM, "WorkItemReleased", { runId: RUN_1, reason: "repair" }),
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "the repair could not fix it",
          needsFrom: "human",
          runId: RUN_2,
          needs: "acknowledgement",
          diagnosis: null,
        }),
      ],
      [first, repair],
    );

    expect(standing.attempt).toBe(2);
    expect(standing.deciding?.attempt).toBe(1);
    expect(standing.deciding?.source).toBe("proposed / build");
  });
});

/**
 * **No log is ever rendered as prose** (#106's rule, #111's instance).
 *
 * `WorkItemBlocked.question` is a sentence with a gate's tail appended to it, and
 * a `<p>` collapses its newlines: the block opened with `pnpm -r typecheck` and
 * fifteen workspace projects announcing themselves, flattened into one
 * paragraph. The clip is in the fold rather than in CSS, because a log shortened
 * by a rule is still a log rendered as prose.
 */
describe("the question", () => {
  const LOG = [
    "the repair could not fix it — gate-failed: build: pnpm typecheck && pnpm test exited 2",
    "$ pnpm -r --if-present typecheck",
    "Scope: 15 of 16 workspace projects",
    "packages/domain typecheck$ tsc --noEmit",
    "packages/env typecheck: Done",
  ].join("\n");

  it("carries its deciding line and leaves the tail where the tail is", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemBlocked", {
          question: LOG,
          needsFrom: "human",
          runId: RUN_1,
          needs: "acknowledgement",
          diagnosis: null,
        }),
      ],
      [],
    );

    expect(standing.question).toBe(
      "the repair could not fix it — gate-failed: build: pnpm typecheck && pnpm test exited 2",
    );
    expect(standing.question).not.toContain("Scope: 15 of 16");
    expect(standing.question).not.toContain("tsc --noEmit");
  });

  it("clips a single line that is a log all by itself", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
        e(ITEM, "WorkItemBlocked", {
          question: `x${"y".repeat(400)}`,
          needsFrom: "human",
          runId: RUN_1,
          needs: "acknowledgement",
          diagnosis: null,
        }),
      ],
      [],
    );

    expect(standing.question?.length).toBe(140);
    expect(standing.question?.endsWith("…")).toBe(true);
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
      e(RUN_1, "ApprovalRequested", { step: "proposed", action: "human", onSha: "b".repeat(40) }),
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
      e(RUN_1, "ApprovalRequested", { step: "merge", action: "human", onSha: SHA }),
      e(RUN_1, "ApprovalGranted", { step: "merge", action: "human", onSha: SHA, by: "human:steven" }),
    ]);
    const standing = standingOf([e(ITEM, "WorkItemClaimed", { runId: RUN_1 }), blocked(RUN_1)], [run]);

    expect(standing.awaitingSha).toBeNull();
  });

  it("asks nothing of anybody while a run is still in flight", () => {
    const run = foldRun(claim(RUN_1, "2026-09-08T03:00:00.000Z"), 1, [
      e(RUN_1, "ApprovalRequested", { step: "proposed", action: "human", onSha: SHA }),
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
  asked: false,
  askedQuestion: null,
  headSha: SHA,
  failed: [],
  saidBy: null,
  deciding: { attempt: 1, source: "proposed / build", line: "error TS2741: …" },
};

describe("the block, rendered", () => {
  /**
   * #83's own requirement, and the reason this is one component rather than
   * two: the fields it fills are absent on every block written before it, and
   * those have to keep rendering.
   */
  it("degrades to the state, the age, the question and the move when nothing is diagnosed", () => {
    const html = renderToStaticMarkup(<Standing subject={null} standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);

    expect(html).toContain("blocked");
    // The coordinate is the bar's now (#152), and still says which attempt.
    expect(renderToStaticMarkup(<Coords standing={HELD} taskId="wi-lingtai-112" queued={null} />)).toContain(
      "from attempt 2 of 2",
    );
    expect(html).toContain("conflict: agent/112 does not merge into develop");
    // The move that is left when there is no diff to approve (#84).
    expect(html).toContain("Back to the queue");
    // Nothing pretends to a diagnosis nobody wrote.
    expect(html).not.toContain('class="diag"');
    expect(html).not.toContain('class="rec"');
  });

  /**
   * The four ranks (#132), on the block that has all of them.
   *
   * Two things this asserts that the block used to get wrong: the refusal is
   * quoted rather than named — *the review gate refused it* on `#121` was every
   * word true and said a reviewer had read the diff, when the reviewer had
   * never run — and the question is not printed beside a diagnosis that says
   * the same thing better.
   */
  it("quotes what refused, and drops the question the diagnosis supersedes", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          needs: "acknowledgement",
          diagnosis: {
            what: "the branch does not merge into develop",
            done: "a repair for conflict produced this diff",
            raw: "CONFLICT (content): Merge conflict in apps/web/page.tsx",
            recommendation: { action: "requeue", why: "develop has moved; a fresh branch should merge" },
          },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );

    // Rank 3, as the one sentence it now is (#152): who is needed and what the
    // diagnosis recommends. What was done is the record's, not the block's.
    expect(html).toContain(
      "a failure needs acknowledging — recommends requeue, because develop has moved; a fresh branch should merge",
    );
    expect(html).not.toContain("a repair for conflict produced this diff");
    expect(html).toContain("the branch does not merge into develop");
    // Rank 2: the refusal in its own words, and open — the evidence was on this
    // page the whole time, three ranks down behind a disclosure, and the block
    // whose job is to say why a task stopped had a gate's name to say it with.
    // Git's words and no gate's, so unattributed (see the test below).
    expect(html).toContain("CONFLICT (content)");
    expect(html).toContain('<details class="sreason" open=""');
    expect(html).toContain("what refused, verbatim");
    // And the question is gone, because `what`, `did` and `rec` say what it
    // said: three sentences overlapping was the defect, not a feature.
    expect(html).not.toContain("conflict: agent/112 does not merge into develop");
  });

  /**
   * The merge lane's words under a gate's name. `proposed:build` failed, a
   * person merged over it, and the lane then refused with a conflict: `failed`
   * still names the build, and `raw` is git's. Heading the one with the other
   * is the mislabelled cause #132 is about.
   */
  it("does not name a gate as the source of words that gate never said", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "conflict: agent/112 does not merge into develop",
          needsFrom: "human",
          runId: RUN_2,
          needs: "acknowledgement",
          diagnosis: {
            what: "the branch does not merge into develop",
            done: null,
            raw: "CONFLICT (content): Merge conflict in apps/web/page.tsx",
            recommendation: null,
          },
        }),
      ],
      [
        foldRun(claim(RUN_2, "2026-09-08T03:00:00.000Z"), 1, [
          e(RUN_2, "RunStarted", { baseSha: SHA }),
          e(RUN_2, "GateFailed", { step: "proposed", action: "build", evidence: TAIL }),
        ]),
      ],
    );
    expect(standing.failed).toEqual(["proposed:build"]);
    expect(standing.saidBy).toBeNull();

    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={standing}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("CONFLICT (content)");
    expect(html).toContain("what refused, verbatim");
    expect(html).not.toContain("proposed / build");
  });

  it("names the gate whose own evidence is the quote", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "build refused",
          needsFrom: "human",
          runId: RUN_2,
          needs: "judgement",
          diagnosis: { what: "the proposed:build gate refused it", done: null, raw: TAIL, recommendation: null },
        }),
      ],
      [
        foldRun(claim(RUN_2, "2026-09-08T03:00:00.000Z"), 1, [
          e(RUN_2, "RunStarted", { baseSha: SHA }),
          e(RUN_2, "GateFailed", { step: "proposed", action: "build", evidence: TAIL }),
        ]),
      ],
    );
    expect(standing.saidBy).toBe("proposed:build");
  });

  /**
   * The disagreement hold, which is the commonest gate hold there is. Its `raw`
   * is `quoteFindings` — a bracketed severity and the scenario — and the review
   * gate's evidence is its own summary with a turns line, so the evidence is in
   * no quote and the gate has to be recognised by its findings.
   */
  it("names the reviewer whose findings a disagreement quotes", () => {
    const finding = {
      severity: "major",
      file: "src/x.ts",
      line: 4,
      claim: "claim",
      failureScenario: "scenario",
    };
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "two agents disagreed",
          needsFrom: "human",
          runId: RUN_2,
          needs: "judgement",
          diagnosis: {
            what: "Two agents disagreed.",
            done: null,
            // `quoteFindings([finding])`, verbatim.
            raw: "[major] src/x.ts:4 — claim\n\nscenario",
            recommendation: null,
          },
        }),
      ],
      [
        foldRun(claim(RUN_2, "2026-09-08T03:00:00.000Z"), 1, [
          e(RUN_2, "RunStarted", { baseSha: SHA }),
          e(RUN_2, "GateFailed", {
            step: "proposed",
            action: "review",
            // `agent-gate.ts`'s `summarise` and its turns line.
            evidence: "major src/x.ts:4 — claim\n\n(12 turns · $0.40)",
            findings: [finding],
          }),
        ]),
      ],
    );
    expect(standing.saidBy).toBe("proposed:review");

    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={standing}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("proposed / review");
    expect(html).not.toContain("what refused, verbatim");
  });

  /**
   * A command that printed nothing and stayed red. `diagnoseUnfixed` writes
   * `raw: null` for blank evidence — not `""` — so a block that read null as
   * *nothing refused* left rank 2 empty under *`test` still refuses*.
   */
  it("still gives a refusal whose diagnosis quoted nothing a second rank", () => {
    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_2 }),
        e(ITEM, "WorkItemBlocked", {
          question: "test still refuses agent/112 into develop after 2 fix round(s)",
          needsFrom: "human",
          runId: RUN_2,
          needs: "judgement",
          diagnosis: {
            what: "`test` still refuses agent/112 at aaaaaaa.",
            done: "2 round(s) of fix-and-recheck ran.",
            raw: null,
            recommendation: null,
          },
        }),
      ],
      [
        foldRun(claim(RUN_2, "2026-09-08T03:00:00.000Z"), 1, [
          e(RUN_2, "RunStarted", { baseSha: SHA }),
          e(RUN_2, "GateFailed", { step: "proposed", action: "test", evidence: "" }),
        ]),
      ],
    );

    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={standing}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("sevidence");
    expect(html).toContain("proposed / test");
    expect(html).toContain("refused, and said nothing");
  });

  it("states the absence where the refusal is known and no line of it is", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          failed: ["proposed:review"],
          deciding: null,
          diagnosis: { what: "Two agents disagreed.", done: null, raw: null, recommendation: null },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("The proposed / review gate refused, and nothing it said was recorded here to quote.");
  });

  /**
   * 0016 §4, one page along: a rank that renders empty looks exactly like a
   * rank that failed to render, and only one of those is our bug.
   */
  it("states an absence where a gate refused and recorded nothing", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          failed: ["proposed:review"],
          saidBy: "proposed:review",
          diagnosis: { what: "the review gate refused it", done: null, raw: "", recommendation: null },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("The proposed / review gate recorded no output");
    expect(html).not.toContain('class="sreason"');
  });

  /** Nothing refused, so there is nothing to quote — and no hole where one would be. */
  it("leaves no second rank at all when every gate passed", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          failed: [],
          deciding: null,
          diagnosis: {
            what: "agent/112 is at 293fe3a and every gate passed. The merge point holds for no-merge.",
            done: null,
            raw: null,
            recommendation: { action: "approve", why: "every gate passed on this diff" },
          },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("every gate passed");
    expect(html).not.toContain('class="sreason"');
    expect(html).not.toContain("sevidence");
  });

  /**
   * The same block with `deciding` filled, which is the ordinary shape of it.
   *
   * `decidingOf` is a *search*: it takes the named attempt's refusal and, where
   * there is none, walks back through the earlier ones — so a block whose own
   * gates all passed routinely carries attempt 1's build failure in that field.
   * Rank 2 is *why this task stopped*, and `proposed / build · error TS2741`
   * printed there under a sentence that says every gate passed is a cause this
   * hold does not have — which is the whole of what #132 is about, made worse.
   *
   * So a diagnosis answers rank 2 or nothing does. The way to attempt 1 is rank
   * 4's, and it is a coordinate rather than a reason.
   */
  it("does not print an earlier attempt's refusal as this hold's reason", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          failed: [],
          // Attempt 1's, while the block is attempt 2's. See `HELD`.
          deciding: { attempt: 1, source: "proposed / build", line: "error TS2741: …" },
          diagnosis: {
            what: "agent/112 is at 293fe3a and every gate passed. The merge point holds for no-merge.",
            done: null,
            raw: null,
            recommendation: { action: "approve", why: "every gate passed on this diff" },
          },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html).toContain("every gate passed");
    expect(html).not.toContain("error TS2741");
    expect(html).not.toContain("proposed / build");
  });

  /**
   * The block used to print `run-5cb24ac5` twice — once as a coordinate and
   * once inside the sentence about the repair that produced the diff. The
   * conductor's sentence no longer names it and the block names it once.
   */
  it("prints no identifier twice", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{
          ...HELD,
          failed: ["proposed:review"],
          diagnosis: {
            what: "agent/112 is at 293fe3a and the review gate refused it.",
            done: "a repair for gate-failed produced this diff",
            raw: "the reviewer's answer was not readable as findings",
            recommendation: null,
          },
        }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    // What a reader sees, with the markup taken out: an id in a `title` is a
    // tooltip on the one place it is printed, not a second printing of it. The
    // block prints none — they are the bar's, and the attempt row's (#152).
    const read = html.replace(/<[^>]*>/g, " ");
    expect(read.split(RUN_2.slice(0, 12)).length - 1).toBe(0);
  });

  it("points at the attempt rather than reprinting it", () => {
    const html = renderToStaticMarkup(<Standing subject={null} standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
    expect(html).toContain('href="#attempt-1"');
    expect(html).toContain("in attempt 1");
  });

  /**
   * Amber means *a human is being waited on* and nothing else in this palette
   * does, so the rule that states the block's extent is amber on exactly one
   * kind of item — and the block itself is drawn for all of them.
   */
  it("spends its amber only when a person is the thing being waited on", () => {
    const on = renderToStaticMarkup(<Standing subject={null} standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
    expect(on).toContain('class="standing onyou"');

    const off = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{ ...HELD, state: "running", onYou: false, who: "an agent is working", question: null }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    // Not the bare class: a running item paints teal, and the rule the
    // component states is that `live` paints only when nothing is on you. The
    // claim here is that the amber is unspent, which is what these two say.
    expect(off).toContain('class="standing live"');
    expect(off).not.toContain("onyou");
    expect(off).toContain("an agent is working");
    // Nothing is being asked, so nothing offers to answer it.
    expect(off).not.toContain("Back to the queue");
  });

  it("states the state with no move at all when the id is not a work item", () => {
    const html = renderToStaticMarkup(<Standing subject={null} standing={HELD} project={null} issue={null} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
    expect(html).toContain("blocked");
    expect(html).not.toContain("Back to the queue");
  });

  /**
   * #111 §2: the block opened with an entire build log flattened into a
   * sentence, because `<p>` collapses newlines and the question was handed over
   * verbatim. The fold clips it; this is the assertion that the render does not
   * put it back.
   */
  it("never renders a log as prose", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={{ ...HELD, question: "gate-failed: build exited 2\nScope: 15 of 16 workspace projects" }}
        project="lingtai"
        issue={112}
        taskId="wi-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    // The view is what clips; a component that re-expanded it would be the
    // second copy of one fact design §2 is about.
    expect(html).toContain("gate-failed: build exited 2");
  });
});

// ------------------------------------------------------------------ moves ----

/**
 * The column ends in something that sends.
 *
 * `#104` put the composed prompt on the page and made it editable, and on
 * 2026-09-09 the whole interactive surface of a blocked task was `Edit`, `Ask`
 * and `Back to the queue` — a person could compose exactly the right instruction
 * and had nothing that committed it (#111 §1).
 */
const OUTGOING: OutgoingView = {
  text: "#111 — the ticket\n\nthe body\n",
  version: "ticket@1924+failure@1c5708ba",
  basedOn: "ticket@1924+failure@1c5708ba",
  attempt: 3,
  edit: null,
  delta: { added: 0, removed: 0 },
  problem: null,
};

/** Just the row of moves: the Ask button inside the discussion is amber too. */
const moves = (html: string) => html.slice(html.indexOf('class="btnrow smoves"'), html.indexOf('class="spair"'));

const render = (standing: StandingView, outgoing: OutgoingView | null) =>
  renderToStaticMarkup(
    <Standing
      subject={null}
      standing={standing}
      project="lingtai"
      issue={112}
      taskId="wi-lingtai-112"
      discussions={[]}
      outgoing={outgoing}

      queued={null}
    />,
  );

describe("the moves the column ends in", () => {
  it("offers Send, numbered the way the box above it is, and Leave blocked beside it", () => {
    const html = render(HELD, OUTGOING);

    expect(html).toContain("Send attempt 3");
    expect(html).toContain("Leave blocked");
    // The box says `attempt 3 only` and the button says `Send attempt 3`: one
    // number, said twice, because that is how long the edit lasts (0032 §5).
    expect(html).toContain("attempt 3 only");
    // Named for the document it hands over, not for the queue it joins.
    expect(html).not.toContain("Back to the queue");
  });

  /**
   * #150: two of the four buttons left the card where it was. Reject appended
   * `ApprovalRevoked` and the run asked again; Waive appended `GateWaived` and
   * nothing read it. Approve absorbs the waiver, and neither is offered —
   * including on a card whose refusal is exactly what a waiver was for.
   */
  it("offers Approve beside Send, and no Reject or Waive, wherever there is an approval open", () => {
    const html = render({ ...HELD, awaitingSha: SHA, failed: ["proposed:review"] }, OUTGOING);

    expect(html).toContain("Send attempt 3");
    expect(html).toContain("Approve");
    expect(html).toContain("Leave blocked");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Waive");
  });

  /**
   * #150: Requeue was the else of *is there an approval open*, so the card
   * adjudicating a disagreement — where *I agree with the reviewer, run it
   * again* is the move — was the one card without it. A peer of Approve now,
   * and the amber is still spent once.
   */
  it("offers Back to the queue beside Approve on a card asking for approval", () => {
    const html = render(
      { ...HELD, awaitingSha: SHA },
      { ...OUTGOING, problem: "lingtai is not a registered project" },
    );

    expect(html).toContain("Approve");
    expect(html).toContain("Back to the queue");
    expect(moves(html).match(/btn pri/g)).toHaveLength(1);
  });

  /**
   * **Amber appears once per screen** (layout notes), and the row of moves is
   * one of the two places on this page that spends it — the other is the rule at
   * the left. Approve wears it where there is a diff to merge, Send where there
   * is not, and a row carrying both dilutes the one thing amber means.
   */
  it("spends the row's amber on one button", () => {
    expect(moves(render(HELD, OUTGOING)).match(/btn pri/g)).toHaveLength(1);

    const approving = moves(render({ ...HELD, awaitingSha: SHA }, OUTGOING));
    expect(approving.match(/btn pri/g)).toHaveLength(1);
    // Approve's, because that is the move a diff asks for.
    expect(approving).toContain('class="btn pri">Approve');
  });

  it("keeps Back to the queue for the item whose prompt could not be composed", () => {
    const html = render(HELD, { ...OUTGOING, problem: "lingtai is not a registered project" });

    expect(html).toContain("Back to the queue");
    expect(html).not.toContain("Send attempt");
  });

  /**
   * #147. A question asked before any run wants an answer, and Send would hand
   * it to `requeue()` — so the row offers Answer and Withdraw, and no Send
   * either here or in the editor above it.
   */
  it("offers Answer and Withdraw, and no Send, on a question asked before any run", () => {
    const html = render(
      { ...HELD, asked: true, askedQuestion: "which design?", who: "waiting for your answer", attempt: null, attempts: 0, runId: null, deciding: null },
      { ...OUTGOING, attempt: 1 },
    );

    expect(html).not.toContain("Send attempt");
    expect(moves(html)).toContain('class="btn pri">Answer');
    expect(moves(html)).toContain("Withdraw");
    expect(moves(html).match(/btn pri/g)).toHaveLength(1);
  });

  it("offers no move at all on an item nobody is being asked about", () => {
    const html = render({ ...HELD, state: "queued", onYou: false, question: null }, OUTGOING);

    expect(html).not.toContain("Send attempt");
    expect(html).not.toContain("Leave blocked");
  });

  /**
   * #111 §3. The viewport is 1440 and the column was a single stack: DOM order
   * is reading order is tab order, so the prompt is first in the markup and the
   * CSS reorders nothing.
   *
   * **And the moves are above the pair** (#152). Under it, a discussion that
   * grew pushed the button you were deciding with off the screen; above it,
   * nothing that grows comes before them in the page.
   */
  it("puts the prompt and the discussion in one pair, the prompt first, under the moves", () => {
    const html = render(HELD, OUTGOING);

    expect(html).toContain('class="spair"');
    expect(html.indexOf("will be sent")).toBeLessThan(html.indexOf("discussion"));
    expect(html.indexOf('class="btnrow smoves"')).toBeLessThan(html.indexOf('class="spair"'));
  });
});

// -------------------------------------------------------------- rank 3 ----

/**
 * **Rank 3 is one sentence** (#152). It was `describeHold`'s lines printed in a
 * row — *your judgement is needed*, the rounds and the decline (#142), the
 * recommendation with the restart refusal (0040) in its why — four tickets'
 * sentences and nobody's one. `soWhat` returns a string, and the block renders
 * that string in one element; these pin both halves.
 */
describe("what the refusal means for the decision", () => {
  const LONG_WHY = [
    "`review` is a check that stayed red rather than a judgement, and for one of those the work is still there.",
    "",
    "**Why:** starting over would throw away a branch whose remedy is mechanical (0039 §2). And no second approach.",
  ].join("\n");

  const diagnosed = (recommendation: { action: "approve" | "requeue" | "reject"; why: string } | null) => ({
    ...HELD,
    needs: "judgement" as const,
    failed: ["proposed:review"],
    saidBy: "proposed:review",
    diagnosis: {
      what: "`review` still refuses agent/147 at a4e9df9.",
      done: "2 round(s) of fix-and-recheck ran, and the action refused what they produced.\n\nNo further agent was bought.",
      raw: "the reviewer did not finish (crash)",
      recommendation,
    },
  });

  it("is one sentence on one line, whatever the diagnosis carries", () => {
    const cases: StandingView[] = [
      HELD,
      diagnosed(null),
      diagnosed({ action: "requeue", why: LONG_WHY }),
      diagnosed({ action: "approve", why: "x".repeat(900) }),
      diagnosed({ action: "reject", why: "" }),
      { ...HELD, state: "running", onYou: false, who: "an agent is working", question: null },
      { ...HELD, state: "queued", onYou: false, who: "waiting for a conductor to take it", question: null },
    ];
    for (const standing of cases) {
      const said = soWhat(standing);
      expect(said).not.toBe("");
      expect(said).not.toContain("\n");
      // One sentence: no full stop followed by another sentence inside it.
      expect(said).not.toMatch(/[.!?]\s+\S/);
      expect(said.length).toBeLessThanOrEqual(240);
    }
    expect(soWhat(diagnosed({ action: "requeue", why: LONG_WHY }))).toBe(
      "your judgement is needed — recommends requeue, because `review` is a check that stayed red rather than a judgement, and for one of those the work is still there",
    );
  });

  it("renders in one element, and no line of `describeHold` beside it", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={diagnosed({ action: "requeue", why: LONG_WHY })}
        project="lingtai"
        issue={147}
        taskId="wi-lingtai-147"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );
    expect(html.split('data-rank="so-what"').length - 1).toBe(1);
    // The four sentences it replaces are not in the block at all.
    expect(html).not.toMatch(/class="(needs|did|rec)"/);
    expect(html).not.toContain("fix-and-recheck");
    expect(html).not.toContain("And no second approach");
    // Between rank 3 and the moves there is nothing but the end of the body.
    const after = html.slice(html.indexOf('data-rank="so-what"'), html.indexOf('data-rank="moves"'));
    expect(after.match(/<p\b/g) ?? []).toHaveLength(0);
  });
});

/**
 * **What is being decided about, on the screen the decision is made on.**
 *
 * #87 put the title, the body and the URL on this page and its comment in
 * `task.ts` still says the page "had no reference to a title, a body or a URL".
 * That was true when it was written. #152 then arranged the page into a
 * standing and a record, and the ticket went into the record's last row — a
 * closed `<details>` at the foot of the page, labelled `prompt` after the
 * document that comes second inside it. Measured on `wi-lingtai-159`: the
 * GitHub link rendered at y=1103 of an 1126px page, and the title's `innerText`
 * came back empty because a closed `<details>` renders none of it. The page
 * opened on *Approve / Send attempt 3 / Leave blocked / Close* and named the
 * thing it was asking about `wi-lingtai-159`.
 *
 * So these assert the subject is in the standing block, not that it exists
 * somewhere in the markup — which was already true and was not the point.
 */
describe("the subject, at the top", () => {
  it("names the ticket and links out to it, above the reason it stopped", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={{
          ref: "159",
          title: "Stopping the daemon should not make starting it a two-command job",
          url: "https://github.com/steven-zhc/lingtai/issues/159",
        }}
        standing={HELD}
        project="lingtai"
        issue={159}
        taskId="wi-lingtai-159"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );

    expect(html).toContain("Stopping the daemon should not make starting it a two-command job");
    expect(html).toContain('href="https://github.com/steven-zhc/lingtai/issues/159"');
    // Above rank 2. A subject under the refusal is a subject you find after
    // you have already read what you could not identify.
    expect(html.indexOf('data-rank="subject"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-rank="subject"')).toBeLessThan(html.indexOf('data-rank="why"'));
  });

  /**
   * The title and the URL are GitHub's; the ref is the log's (`task.ts`'s two
   * sources, in that order). A GitHub that will not answer costs the page its
   * sentence and not its identity — the same distinction #113 drew between *it
   * does not exist* and *I could not ask*.
   */
  it("still says which ticket this is when GitHub could not be asked", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={{ ref: "159", title: null, url: null }}
        standing={HELD}
        project="lingtai"
        issue={159}
        taskId="wi-lingtai-159"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );

    expect(html).toContain("#159");
    expect(html).toContain("GitHub did not answer");
    // No link, rather than a link that goes nowhere.
    expect(html).not.toMatch(/<a[^>]*class="sref"/);
  });

  /** An id that is not `wi-<p>-<n>` has no ticket, and the line is simply absent. */
  it("draws no subject line where there is no ticket", () => {
    const html = renderToStaticMarkup(
      <Standing
        subject={null}
        standing={HELD}
        project={null}
        issue={null}
        taskId="not-a-work-item"
        discussions={[]}
        outgoing={null}
        queued={null}
      />,
    );

    expect(html).not.toContain('data-rank="subject"');
  });
});
