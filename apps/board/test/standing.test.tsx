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
      e(RUN_1, "GateFailed", { gate: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    const two = foldRun(claim(RUN_2, "2026-09-08T04:00:00.000Z"), 2, [
      e(RUN_2, "RunProposedCompletion", { headSha: SHA }),
      e(RUN_2, "GatePassed", { gate: "proposed", action: "build", onSha: SHA, evidence: "ok" }),
      e(RUN_2, "GateNeverRan", {
        gate: "proposed",
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
      e(RUN_1, "GateFailed", { gate: "proposed", action: "build", onSha: SHA, evidence: TAIL }),
      e(RUN_1, "RunFinished", { turns: 41, durationMs: 600_000, costUsd: 3.2, exitCode: 2 }),
    ]);
    // The repair: it finished, cleanly, and produced nothing.
    const repair = foldRun(
      { runId: RUN_2, at: "2026-09-08T06:00:00.000Z", repair: true, released: null },
      2,
      [e(RUN_2, "RunStarted", { baseSha: SHA }), e(RUN_2, "RunFinished", { turns: 5, durationMs: 60_000, costUsd: 5.23, exitCode: 0 })],
    );

    const standing = standingOf(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN_1 }),
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
    const html = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);

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
        outgoing={null}
        queued={null}
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
    const html = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
    expect(html).toContain('href="#attempt-1"');
    expect(html).toContain("in attempt 1");
  });

  /**
   * Amber means *a human is being waited on* and nothing else in this palette
   * does, so the rule that states the block's extent is amber on exactly one
   * kind of item — and the block itself is drawn for all of them.
   */
  it("spends its amber only when a person is the thing being waited on", () => {
    const on = renderToStaticMarkup(<Standing standing={HELD} project="lingtai" issue={112} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
    expect(on).toContain('class="standing onyou"');

    const off = renderToStaticMarkup(
      <Standing
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
    const html = renderToStaticMarkup(<Standing standing={HELD} project={null} issue={null} taskId="wi-lingtai-112" discussions={[]} outgoing={null} queued={null} />);
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
const moves = (html: string) => html.slice(html.indexOf('class="smoves"'));

const render = (standing: StandingView, outgoing: OutgoingView | null) =>
  renderToStaticMarkup(
    <Standing
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
   * #84's rule, and the one place this ticket is read against the code rather
   * than literally: Reject withdraws an approval, so it belongs exactly where
   * there is one to withdraw. A card must never offer only a control that
   * refuses — `reject()` accepts `awaiting-approval` and nothing else.
   */
  it("puts Reject beside Send wherever there is an approval to withdraw", () => {
    const html = render({ ...HELD, awaitingSha: SHA }, OUTGOING);

    expect(html).toContain("Send attempt 3");
    expect(html).toContain("Reject");
    expect(html).toContain("Approve");
    expect(html).toContain("Leave blocked");
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

  it("offers no move at all on an item nobody is being asked about", () => {
    const html = render({ ...HELD, state: "queued", onYou: false, question: null }, OUTGOING);

    expect(html).not.toContain("Send attempt");
    expect(html).not.toContain("Leave blocked");
  });

  /**
   * #111 §3. The viewport is 1440 and the column was a single stack: DOM order
   * is reading order is tab order, so the prompt is first in the markup and the
   * CSS reorders nothing.
   */
  it("puts the prompt and the discussion in one pair, the prompt first", () => {
    const html = render(HELD, OUTGOING);

    expect(html).toContain('class="spair"');
    expect(html.indexOf("will be sent")).toBeLessThan(html.indexOf("discussion"));
    expect(html.indexOf('class="spair"')).toBeLessThan(html.indexOf('class="smoves"'));
  });
});
