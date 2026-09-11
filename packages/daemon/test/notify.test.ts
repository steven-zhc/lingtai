/**
 * What gets through this channel.
 *
 * Pure — no database, no `osascript`. What is worth asserting here is that the
 * filter is right: a notification you cannot act on is noise, and noise is how
 * the useful ones stop being read. What a notification *says* is
 * `describeEvent`'s, and moved with it (#125).
 */
import type { Envelope } from "@lingtai/domain";
import { describe as describeTest, expect, it } from "vitest";
import {
  DEFAULT_SUBSCRIPTIONS,
  createNotifier,
  recordingChannel,
  subscribed,
} from "../src/index.ts";

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

const everything = [{ project: "*", types: [...DEFAULT_SUBSCRIPTIONS] }];

describeTest("what is worth interrupting somebody for", () => {
  it("passes the four that mean nothing moves until a person acts", () => {
    for (const type of DEFAULT_SUBSCRIPTIONS) {
      expect(subscribed(event(type, {}), everything), type).toBe(true);
    }
  });

  it("drops everything the conductor will handle by itself", () => {
    // A landed task is good news that needed nobody. Interrupting for it is how
    // the ones that do need somebody stop being read.
    for (const type of ["WorkItemLanded", "GatePassed", "RunFinished", "RunTouchedFile"]) {
      expect(subscribed(event(type, {}), everything), type).toBe(false);
    }
  });

  it("can be narrowed to one project", () => {
    const only = [{ project: "admin", types: ["WorkItemBlocked"] }];
    expect(subscribed(event("WorkItemBlocked", {}, "wi-admin-1"), only)).toBe(true);
    expect(subscribed(event("WorkItemBlocked", {}, "wi-press-1"), only)).toBe(false);
  });
});

// What a notification *says* is asserted in `packages/domain/test/describe.test.ts`,
// with the function: `describeEvent` moved there when a second channel started
// using it (#125), and a copy of its tests left behind here would be the half
// that stopped being run against the code that changed.

describeTest("the notifier", () => {
  it("sends only what is subscribed", async () => {
    const channel = recordingChannel();
    const notifier = createNotifier({ channel });

    await notifier.consider(event("WorkItemBlocked", { question: "?" }));
    await notifier.consider(event("WorkItemLanded", { mergeCommit: "abc" }));

    expect(channel.sent).toHaveLength(1);
  });

  /**
   * This runs on the daemon's own subscription. A notifier that could throw
   * would be a notifier that stops the log being followed — which would take
   * the board down to tell somebody about a merge.
   */
  it("swallows a channel that throws", async () => {
    const lines: string[] = [];
    const notifier = createNotifier({
      channel: {
        name: "broken",
        clickable: false,
        async send() {
          throw new Error("no notification centre here");
        },
      },
      log: (l) => void lines.push(l),
    });

    await expect(notifier.consider(event("WorkItemBlocked", { question: "?" }))).resolves.toBeUndefined();
    expect(lines[0]).toContain("notification failed");
  });
});
