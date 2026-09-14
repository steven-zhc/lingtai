/**
 * Closing a ticket nobody is going to do (#151).
 *
 * The properties worth pinning are not that an event can be appended — every
 * event can — but the three claims the decision rests on: it is a **terminal**,
 * **nothing lifts it**, and the **queue stops offering it because the log says
 * so** rather than because GitHub stopped listing it.
 */
import { describe, expect, it } from "vitest";
import { applyWorkItem, reduceWorkItem, type Envelope } from "@lingtai/domain";

const at = (n: number) => new Date(Date.UTC(2026, 8, 14, 12, n)).toISOString();

/** The shape the store hands a reducer, with only what these tests read. */
const event = (n: number, type: string, data: object): Envelope =>
  ({ seq: n, streamId: "wi-lingtai-32", type, data, at: at(n), version: n, actor: "human:steven" }) as unknown as Envelope;

const closed = event(2, "WorkItemClosed", { by: "human:steven", reason: "over-built for the need" });

describe("a closed work item", () => {
  it("is a terminal that carries who and why", () => {
    const state = reduceWorkItem([
      event(1, "WorkItemBlocked", {
        question: "merge over the refusal?",
        needsFrom: "human",
        runId: "run-1",
        needs: "judgement",
        diagnosis: null,
      }),
      closed,
    ]);

    expect(state.lifecycle).toEqual({
      status: "closed",
      by: "human:steven",
      reason: "over-built for the need",
    });
  });

  /**
   * The whole of why the queue passes over it. `queue.ts` subtracts every row
   * the fold does not call `backlog`, so this one property is what makes a
   * closed item unclaimable — with no label, no GitHub round trip and no change
   * to the queue at all.
   */
  it("is not backlog, which is what the queue subtracts on", () => {
    const state = reduceWorkItem([closed]);

    expect(state.lifecycle.status).not.toBe("backlog");
    expect(state.lifecycle.status).toBe("closed");
  });

  /**
   * 0151's decision, and the one that had to be written down rather than left
   * to whoever read the code next: reopening the issue starts no work. A
   * `WorkItemUnblocked` after a close — which is what the board's Requeue and
   * `lingtai answer` both append — must not resurrect it, or the next attempt
   * inherits the findings and the spend of work done under an intent that is no
   * longer the intent.
   */
  it("is not lifted by an unblock arriving after it", () => {
    const state = applyWorkItem(
      reduceWorkItem([closed]),
      event(3, "WorkItemUnblocked", { by: "human:steven", note: "changed my mind" }),
    );

    expect(state.lifecycle.status).toBe("closed");
  });

  /** And a claim after it does not either: the ticket is over, not free. */
  it("is not lifted by a claim arriving after it", () => {
    const state = applyWorkItem(
      reduceWorkItem([closed]),
      event(4, "WorkItemClaimed", { runId: "run-2", worker: "daemon" }),
    );

    expect(state.lifecycle.status).toBe("closed");
  });
});
