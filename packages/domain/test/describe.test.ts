/**
 * What an event says to a person.
 *
 * These moved here with `describeEvent` (#125), from
 * `packages/daemon/test/notify.test.ts`, where they were the desktop channel's.
 * Two channels format the same events now, so a message that lost its board
 * link or its question would be two channels wrong at once — which is the
 * reason the function is here and not in either of them.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/index.ts";
import { describeEvent } from "../src/index.ts";

const BOARD = "http://localhost:3200";

const event = (type: string, data: unknown, streamId = "wi-admin-155"): Envelope => ({
  seq: 1n,
  streamId,
  version: 1,
  type,
  schemaVer: 1,
  data,
  actor: "conductor",
  causation: null,
  at: new Date(),
});

describe("what the notification says", () => {
  it("carries the question, not just the fact", () => {
    const n = describeEvent(
      event("WorkItemBlocked", { question: "rerun the flaky importer test, or fix it?" }),
      BOARD,
    );
    // `agent:blocked` carried no question, which is the whole reason the old
    // review queue could not be worked without opening the issue.
    expect(n.body).toContain("rerun the flaky importer test");
    expect(n.title).toContain("#155");
  });

  it("links to the task's own page, so a click lands somewhere useful", () => {
    const n = describeEvent(event("ApprovalRequested", { question: "Merge?" }), BOARD);
    expect(n.url).toBe("http://localhost:3200/task/wi-admin-155");
  });

  it("says what landed where, rather than repeating the type", () => {
    // The event a desktop notification deliberately refuses and a Telegram
    // message wants (#125). Without its own case it read `WorkItemLanded`
    // twice and said nothing.
    const n = describeEvent(
      event("WorkItemLanded", { mergeCommit: "9f2c1b7d4e5a6f80", base: "main" }),
      BOARD,
    );
    expect(n.title).toBe("#155 landed");
    expect(n.body).toContain("main");
    expect(n.body).toContain("9f2c1b7d4e5a");
    expect(n.url).toBe("http://localhost:3200/task/wi-admin-155");
  });

  it("says why a run failed, which is the whole of what is actionable", () => {
    const n = describeEvent(event("RunFailed", { kind: "crash", detail: "session limit" }), BOARD);
    expect(n.title).toBe("#155 failed");
    expect(n.body).toBe("crash: session limit");
  });

  it("has no link for a stream that is not a task, and does not invent one", () => {
    const n = describeEvent(event("ConductorPaused", { by: "steven" }, "ctl-conductor"), BOARD);
    expect(n.url).toBeNull();
    expect(n.title).toBe("ConductorPaused");
  });
});
