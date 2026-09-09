import { describe, expect, it } from "vitest";
import { emptyWorkItem, reduceWorkItem } from "../src/index.ts";
import { makeStream, unknownEvent } from "./support.ts";

const discovered = {
  project: "nextloom-ai-admin",
  source: "github-issue" as const,
  externalRef: "117",
  title: "Migration hold",
  kind: "bug" as const,
  labels: ["agent:ready"],
};

describe("reduceWorkItem", () => {
  it("is backlog with nothing known before its first event", () => {
    const s = reduceWorkItem([]);
    expect(s).toEqual(emptyWorkItem);
    expect(s.lifecycle.status).toBe("backlog");
    expect(s.version).toBe(0);
  });

  it("records what discovery knew", () => {
    const e = makeStream("wi-nextloom-ai-admin-117");
    const s = reduceWorkItem([e("WorkItemDiscovered", discovered)]);

    expect(s.project).toBe("nextloom-ai-admin");
    expect(s.externalRef).toBe("117");
    expect(s.kind).toBe("bug");
    expect(s.labels).toEqual(["agent:ready"]);
    expect(s.lifecycle.status).toBe("backlog");
  });

  it("walks discovered → claimed → landed", () => {
    const e = makeStream("wi-nextloom-ai-admin-117");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", { runId: "run-01JX", worker: "conductor@host", title: null, kind: null }),
      e("WorkItemLanded", { mergeCommit: "abc1234", base: "develop" }),
    ]);

    expect(s.lifecycle).toEqual({ status: "landed", mergeCommit: "abc1234", base: "develop" });
    expect(s.runs).toEqual(["run-01JX"]);
    expect(s.version).toBe(3);
  });

  it("returns to the backlog when released, and the lease goes with it", () => {
    const e = makeStream("wi-p-1");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
      e("WorkItemReleased", { runId: "run-a", reason: "lease expired" }),
    ]);

    expect(s.lifecycle).toEqual({ status: "backlog" });
    // The run is still on the record — it happened — but it holds nothing.
    expect(s.runs).toEqual(["run-a"]);
  });

  it("carries the question when blocked, and drops it when unblocked", () => {
    const e = makeStream("wi-p-1");
    const events = [
      e("WorkItemDiscovered", discovered),
      e("WorkItemBlocked", {
        question: "Which base branch should this target?",
        needsFrom: "human" as const,
        runId: "run-a",
        needs: null,
        diagnosis: null,
      }),
    ];

    const blocked = reduceWorkItem(events);
    expect(blocked.lifecycle).toEqual({
      status: "blocked",
      question: "Which base branch should this target?",
      needsFrom: "human",
      runId: "run-a",
      // A block that carries only a question. Every one on the log at the time
      // #83 was written is this shape, and the fold says so rather than
      // inventing a kind for it.
      needs: null,
      diagnosis: null,
    });

    const unblocked = reduceWorkItem([
      ...events,
      e("WorkItemUnblocked", { by: "human:steven", note: "develop" }),
    ]);
    expect(unblocked.lifecycle).toEqual({ status: "backlog" });
  });

  /**
   * The two kinds of block, told apart on the log (#83).
   *
   * `held at the merge gate` and `conflict: agent/112 does not merge into
   * develop` were both `WorkItemBlocked` with a string, and they are opposite
   * kinds of thing: one wants a person's judgement, the other wants a diagnosis
   * nobody had written. A fold that cannot distinguish them cannot let a card
   * offer a default action, which is the whole of what the ticket asked for.
   */
  it("tells a judgement apart from a failure needing acknowledgement", () => {
    const e = makeStream("wi-nextloom-ai-admin-112");
    const judgement = reduceWorkItem([
      e("WorkItemBlocked", {
        question: "held at the merge gate: agent/112 into develop",
        needsFrom: "human" as const,
        runId: "run-a",
        needs: "judgement" as const,
        diagnosis: {
          what: "agent/112 is at 6bf1c02 and every gate passed.",
          done: null,
          raw: null,
          recommendation: { action: "approve" as const, why: "every gate passed on this diff" },
        },
      }),
    ]);
    const failure = reduceWorkItem([
      e("WorkItemBlocked", {
        question: "conflict: agent/112 does not merge into develop: user-lookup-panel.tsx",
        needsFrom: "human" as const,
        runId: "run-b",
        needs: "acknowledgement" as const,
        diagnosis: {
          what: "agent/112 does not merge into develop.",
          done: "develop was merged in first and it still would not merge.",
          raw: "CONFLICT (content): Merge conflict in apps/web/src/…",
          recommendation: { action: "requeue" as const, why: "the next attempt is cut from a base that has moved" },
        },
      }),
    ]);

    expect(judgement.lifecycle).toMatchObject({ status: "blocked", needs: "judgement" });
    expect(failure.lifecycle).toMatchObject({ status: "blocked", needs: "acknowledgement" });
    // And the recommendation is a value, not a sentence to parse: `approve` is a
    // legitimate one, which is what makes the board's default action possible.
    expect(
      judgement.lifecycle.status === "blocked" && judgement.lifecycle.diagnosis?.recommendation,
    ).toEqual({ action: "approve", why: "every gate passed on this diff" });
    // The raw failure survives the summary. A sentence that hides the git
    // output would be worse than the git output.
    expect(failure.lifecycle.status === "blocked" && failure.lifecycle.diagnosis?.raw).toContain(
      "CONFLICT (content)",
    );
  });

  /**
   * The regression this whole aggregate exists for. #35 held `agent:blocked` and
   * `agent:review` at once because labels are a set, not a state. Here the
   * lifecycle is one value, so the second transition replaces the first — there
   * is no state in which both are true, and no way to construct one.
   */
  it("cannot be blocked and claimed at the same time", () => {
    const e = makeStream("wi-nextloom-ai-admin-35");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemBlocked", {
        question: "?",
        needsFrom: "human" as const,
        runId: null,
        needs: null,
        diagnosis: null,
      }),
      e("WorkItemClaimed", { runId: "run-b", worker: "w", title: null, kind: null }),
    ]);

    expect(s.lifecycle.status).toBe("claimed");
    expect(Object.keys(s.lifecycle).sort()).toEqual(["runId", "status", "worker"]);
    expect(s.lifecycle).not.toHaveProperty("question");
  });

  it("links a filed bug to the merge that caused it, without duplicating", () => {
    const e = makeStream("wi-nextloom-ai-admin-134");
    const link = { relation: "caused-by" as const, otherRef: "58" };
    const s = reduceWorkItem([
      e("WorkItemDiscovered", { ...discovered, externalRef: "134" }),
      e("WorkItemLinked", link),
      e("WorkItemLinked", link),
    ]);

    expect(s.links).toEqual([link]);
  });

  it("keeps every refused dispatch rather than counting them", () => {
    const e = makeStream("wi-p-1");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("DispatchRefused", {
        requiredTier: "sandboxed" as const,
        runtime: "claude-code" as const,
        missing: ["filesystem-sandbox"],
      }),
    ]);

    expect(s.dispatchRefusals).toHaveLength(1);
    expect(s.dispatchRefusals[0]!.missing).toEqual(["filesystem-sandbox"]);
    // A refusal is not a transition: the item is still in the backlog, and the
    // tier was not silently downgraded to make it run.
    expect(s.lifecycle.status).toBe("backlog");
  });

  /**
   * How a run learns it is a repair, and it is only this.
   *
   * `RepairRequested` is appended just before the release, so between the two
   * the item carries a pending repair; the next claim consumes it. There is no
   * flag on `RunStarted` and no second event, because
   * [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) keeps a
   * repair an ordinary run — the only thing that differs is what its prompt was
   * told.
   */
  it("hands a pending repair to the next claim, and to no other", () => {
    const e = makeStream("wi-p-1");
    const bought = {
      runId: "run-a",
      reason: "conflict" as const,
      detail: "agent/1 does not merge into main: page.tsx",
      fingerprint: "0123456789ab",
      attempt: 1,
    };

    const pending = reduceWorkItem([
      e("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
      e("RepairRequested", bought),
      e("WorkItemReleased", { runId: "run-a", reason: "repairing conflict (attempt 1)" }),
    ]);
    // Queued, and carrying what the next attempt has to be told.
    expect(pending.lifecycle.status).toBe("backlog");
    expect(pending.pendingRepair?.after).toBe("run-a");
    expect(pending.repairs).toHaveLength(1);

    const claimed = reduceWorkItem([
      e("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
      e("RepairRequested", bought),
      e("WorkItemReleased", { runId: "run-a", reason: "repairing" }),
      e("WorkItemClaimed", { runId: "run-b", worker: "w", title: null, kind: null }),
    ]);
    expect(claimed.pendingRepair).toBeNull();
    // `after` is the run that *failed*; `runId` on the record is the run that
    // is repairing it. Two different runs, so two different names.
    const { runId: _bought, ...rest } = bought;
    expect(claimed.repairRun).toEqual({ runId: "run-b", of: { after: "run-a", ...rest } });

    // And the claim after *that* is an ordinary run again. Without this a
    // failure three attempts later would still count as an analysis of the
    // analysis and buy nothing.
    const later = reduceWorkItem([
      e("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
      e("RepairRequested", bought),
      e("WorkItemReleased", { runId: "run-a", reason: "repairing" }),
      e("WorkItemClaimed", { runId: "run-b", worker: "w", title: null, kind: null }),
      e("WorkItemReleased", { runId: "run-b", reason: "no commits" }),
      e("WorkItemClaimed", { runId: "run-c", worker: "w", title: null, kind: null }),
    ]);
    expect(later.repairRun).toBeNull();
    // The ceiling still counts it: the repair happened, whatever came after.
    expect(later.repairs).toHaveLength(1);
  });

  it("ignores an event type it has never heard of, but still advances", () => {
    const e = makeStream("wi-p-1");
    const first = e("WorkItemDiscovered", discovered);
    const s = reduceWorkItem([first, unknownEvent("wi-p-1", 2)]);

    expect(s.title).toBe("Migration hold");
    expect(s.lifecycle.status).toBe("backlog");
    // Version still advances, so the next append does not use a stale expectation.
    expect(s.version).toBe(2);
  });
});
