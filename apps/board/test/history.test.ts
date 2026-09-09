/**
 * Every event type renders something, and the ones the ticket named render the
 * thing they carry.
 *
 * The first test is driven off `EVENTS` — the catalogue itself, not the list a
 * test happened to think of — so a forty-first type is covered the moment it is
 * added. That is the property #87 was about: `summarise` handled six types and
 * the other thirty-four fell to a default that printed the empty string, so
 * *what actually happened* was a column of timestamps and type names.
 *
 * It asserts against an **empty** payload on purpose. A formatter is allowed
 * not to recognise what it is given; it is not allowed to say nothing.
 */
import { describe, expect, it } from "vitest";
import { EVENTS } from "@lingtai/domain";
import type { Envelope } from "@lingtai/domain";
import { describePayload, shortActor, summarise } from "../src/lib/history.ts";

function e(type: string, data: unknown, actor = "conductor"): Envelope {
  return {
    seq: 1n,
    streamId: "wi-lingtai-59",
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor,
    causation: null,
    at: new Date("2026-09-04T17:12:15Z"),
  };
}

describe("a line of history", () => {
  it("says something for every type in the catalogue, whatever the payload", () => {
    for (const type of Object.keys(EVENTS)) {
      for (const data of [{}, null, { of: "an unexpected shape" }]) {
        expect(summarise(e(type, data)), `${type} with ${JSON.stringify(data)}`).not.toBe("");
      }
    }
  });

  it("falls back to the payload for a type no formatter has learned", () => {
    // Not in the catalogue at all — the case a renderer is always one commit
    // away from, and the one that used to render as a blank row.
    const said = summarise(e("SomethingNobodyHasWrittenYet", { thing: "happened", n: 3 }));
    expect(said).toContain("thing=happened");
    expect(said).toContain("n=3");
  });

  it("keeps a null in the payload, because a null is a statement", () => {
    expect(describePayload({ prompt: null })).toBe("prompt=null");
  });

  /**
   * The two kinds of block, told apart on the row (#83). `held at the merge
   * gate: …` and `conflict: agent/112 does not merge into develop: …` were both
   * `WorkItemBlocked` with a string, and the history printed the string.
   */
  it("says which kind of block it was, and what it recommends", () => {
    const said = summarise(
      e("WorkItemBlocked", {
        question: "conflict: agent/112 does not merge into develop",
        needsFrom: "human",
        runId: "run-1",
        needs: "acknowledgement",
        diagnosis: {
          what: "agent/112 does not merge into develop.",
          done: null,
          raw: "CONFLICT (content): …",
          recommendation: { action: "requeue", why: "the base has moved" },
        },
      }),
    );
    expect(said).toContain("acknowledgement:");
    expect(said).toContain("conflict: agent/112 does not merge into develop");
    expect(said).toContain("recommends requeue");
  });

  it("prints a v1 block as the question alone, which is all it carries", () => {
    const said = summarise(
      e("WorkItemBlocked", { question: "held at the merge gate: agent/112 into develop", needsFrom: "human", runId: null }),
    );
    expect(said).toBe("held at the merge gate: agent/112 into develop");
  });

  it("names the action on a gate row, not only the point", () => {
    const build = e("GateStarted", { gate: "prepared", action: "build", runId: "run-1", onSha: "abc" });
    const lint = e("GateStarted", { gate: "prepared", action: "lint", runId: "run-1", onSha: "abc" });
    expect(summarise(build)).toBe("prepared · build");
    // Three gates at one point used to render as three identical rows.
    expect(summarise(build)).not.toBe(summarise(lint));
  });

  it("renders the plan GatesResolved carries, including the empty points", () => {
    const said = summarise(
      e("GatesResolved", {
        runId: "run-1",
        configHash: "3f8a1c2b9d04",
        points: [
          { gate: "admit", actions: [] },
          { gate: "prepared", actions: ["build", "lint"] },
          { gate: "proposed", actions: ["review"] },
          { gate: "merge", actions: [] },
          { gate: "end", actions: ["comment", "close"] },
        ],
      }),
    );
    // The evidence behind every `skipped` on the page: a point with nothing
    // planned reads as nothing planned, rather than as a point that vanished.
    expect(said).toBe("admit — · prepared build+lint · proposed review · merge — · end comment+close");
  });

  it("says what IssueUpdated changed and to what", () => {
    const said = summarise(
      e("IssueUpdated", { project: "lingtai", issue: "59", change: "labels", detail: "lingtai:working" }),
    );
    expect(said).toBe("labels: lingtai:working");
  });

  it("says how the run was started", () => {
    const said = summarise(
      e("RunStarted", {
        workItemId: "wi-lingtai-59",
        runtime: "claude-code",
        model: "opus-5",
        promptVersion: "ticket@1911",
        baseSha: "1f7d07be3c2a91",
        configHash: "3f8a1c2b9d04ee",
        worktree: "/tmp/wt",
        invocation: null,
      }),
    );
    expect(said).toBe("claude-code · opus-5 · base 1f7d07b · recipe 3f8a1c2b9d04");
  });

  it("gives RunPrompted a detail of its own, so its actor is not read as one", () => {
    const said = summarise(
      e("RunPrompted", { promptVersion: "ticket@1911", bytes: 4593, prompt: "…" }, "agent:run-78db72ff-d659"),
    );
    expect(said).toBe("ticket@1911, 4593 bytes");
  });

  it("shortens a run's actor to something an actor column can hold", () => {
    expect(shortActor("agent:run-78db72ff-d659-4515-a5d3-150a0e8a3b33")).toBe("agent:run-78db72ff");
    expect(shortActor("conductor")).toBe("conductor");
    expect(shortActor("human:steven")).toBe("human:steven");
  });
});
