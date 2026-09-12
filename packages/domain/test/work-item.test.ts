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

  /**
   * The second ceiling, counted off the log rather than remembered
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §2).
   *
   * The property that matters is what it does *not* have: no pending record, and
   * nothing a claim consumes. A repair needs one because the next claim has to
   * *become* the repair; a restart is an ordinary claim, told what every second
   * attempt is told, so the only thing the fold owes anybody is the count and
   * each arm's evidence.
   */
  it("counts the approaches a ticket abandoned, and hands the next claim nothing", () => {
    const e = makeStream("wi-p-1");
    const arm = (runId: string, restart: number) => ({
      runId,
      restart,
      of: 2,
      action: "review",
      rounds: 3,
      branch: "agent/1",
      headSha: "8634c5d",
      findings: [
        {
          file: "packages/daemon/src/daemon.ts",
          line: 124,
          claim: "startBeacon sits inside the lock",
          failureScenario: "the first beat throws and the lock is never released",
          severity: "major" as const,
        },
      ],
    });

    const after = reduceWorkItem([
      e("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
      e("PassRestarted", arm("run-a", 1)),
      e("WorkItemReleased", { runId: "run-a", reason: "…restart 1 of 2" }),
      e("WorkItemClaimed", { runId: "run-b", worker: "w", title: null, kind: null }),
    ]);

    // The claim does not consume it, unlike a pending repair: this is a bound
    // on the ticket and not an instruction to the next run.
    expect(after.restarts).toHaveLength(1);
    expect(after.restarts[0]!.after).toBe("run-a");
    expect(after.pendingRepair).toBeNull();
    expect(after.repairRun).toBeNull();
    // And it is claimed, not blocked — a restart is not a state an item is in.
    expect(after.lifecycle.status).toBe("claimed");

    // **Each arm's findings survive**, which is the criterion 0040 §3 rests on:
    // the run that was refused is on a stream no later pass reads, so if they
    // were not here a person asked after the last restart would see one
    // refusal and have to guess about the others.
    expect(after.restarts[0]!.findings[0]!.failureScenario).toContain("never released");

    const twice = reduceWorkItem([
      e("PassRestarted", arm("run-a", 1)),
      e("PassRestarted", arm("run-b", 2)),
    ]);
    expect(twice.restarts.map((r) => r.restart)).toEqual([1, 2]);
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

  /**
   * The one-shot edit
   * ([0032](../../../doc/decisions/0032-the-page-is-organised-by-attempt.md)
   * §5). It applies to the next run and to no other, which is what makes a
   * stale instruction impossible rather than merely guarded against — the same
   * shape `pendingRepair` has, and cleared by the same event.
   */
  it("holds a prompt edit until the next claim, and no longer", () => {
    const e = makeStream("wi-p-1");
    const edited = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("PromptEdited", { text: "pass --max-turns", hash: "a91f2e", by: "human:steven", basedOn: "ticket@1924", chatId: "chat-1" }),
    ]);
    expect(edited.pendingPrompt).toEqual({ text: "pass --max-turns", by: "human:steven" });

    const f = makeStream("wi-p-2");
    const consumed = reduceWorkItem([
      f("WorkItemDiscovered", discovered),
      f("PromptEdited", { text: "pass --max-turns", hash: "a91f2e", by: "human:steven", basedOn: "ticket@1924", chatId: "chat-1" }),
      f("WorkItemClaimed", { runId: "run-a", worker: "w", title: null, kind: null }),
    ]);
    expect(consumed.pendingPrompt).toBeNull();
  });

  /** A second edit replaces the first: two sentences nobody re-read is a prompt nobody approved. */
  it("keeps the last edit rather than stacking them", () => {
    const e = makeStream("wi-p-3");
    const state = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("PromptEdited", { text: "first", hash: "f1", by: "human:steven", basedOn: null, chatId: null }),
      e("PromptEdited", { text: "second", hash: "f2", by: "human:steven", basedOn: null, chatId: null }),
    ]);
    expect(state.pendingPrompt?.text).toBe("second");
  });

  /**
   * *Remove the edit* is an append, not a deletion. The page offers it beside
   * the box (#104) and this is the whole of what it does — which also closes a
   * gap in the version: a blank edit produced no block in the prompt, because
   * `humanBrief` trims, and still a `human@…` in `promptVersion`.
   */
  it("takes the edit back off when the text is blank", () => {
    const e = makeStream("wi-p-4");
    const state = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("PromptEdited", { text: "pass --max-turns", hash: "a91f2e", by: "human:steven", basedOn: null, chatId: null }),
      e("PromptEdited", { text: "  \n ", hash: null, by: "human:steven", basedOn: null, chatId: null }),
    ]);
    expect(state.pendingPrompt).toBeNull();
  });

});