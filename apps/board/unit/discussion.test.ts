/**
 * What the page says about a conversation, settled by envelopes.
 *
 * Two of these are `#105`'s own bar rather than ordinary fold tests. The meter
 * has to be a number a person can see, or *"the person is the limit"* is a
 * limit that cannot see what it is limiting
 * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §4); and the
 * sentence about a branch that was not there has to survive an answer that
 * forgot to mention it, which is why it is folded off the **ask** and not off
 * the answer.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "@lingtai/domain";
import { chatIdsFor, foldChat, totalsOf, type DiscussionView } from "../src/lib/task.ts";

let seq = 0n;

function e(streamId: string, type: string, data: unknown, at = "2026-09-09T10:00:00Z"): Envelope {
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

const ASKED = {
  workItemId: "wi-lingtai-89",
  attempt: 2,
  by: "human:steven",
  question: "why did attempt 2 produce nothing?",
  reading: [
    "main: readable at abc1234",
    "attempt 2 left no branch; I am reading main. worktree.ts resets the branch with -B on every run…",
  ],
};

describe("one conversation, folded", () => {
  it("pairs each question with its answer and totals the spend as it goes", () => {
    const chat = foldChat(
      "chat-1",
      [
        e("chat-1", "DiscussionAsked", ASKED),
        e("chat-1", "DiscussionAnswered", {
          text: "the flag is never passed to the binary",
          read: ["main:packages/agent/src/claude-code.ts"],
          cannot: ["whether the binary accepts --max-turns; that needs a command I do not have"],
          proposal: { kind: "prompt", text: "pass --max-turns" },
          turns: 4,
          durationMs: 9_000,
          costUsd: 0.42,
          failure: null,
        }),
        e("chat-1", "DiscussionAsked", { ...ASKED, question: "and attempt 1?" }, "2026-09-09T10:05:00Z"),
      ],
      null,
    );

    expect(chat.turns).toHaveLength(2);
    expect(chat.turns[0]?.answer?.proposal).toEqual({ kind: "prompt", text: "pass --max-turns" });
    expect(chat.costUsd).toBeCloseTo(0.42, 5);
    // The second question has no answer yet, so the page can say so rather than
    // rendering an empty turn that reads as an answer of nothing.
    expect(chat.waiting).toBe(true);
    expect(chat.attempt).toBe(2);
  });

  /**
   * The blind spot that killed `#89`'s repair. It is recorded on the ask,
   * before the assistant has said anything, so an answer that does not mention
   * it cannot make the page forget it either.
   */
  it("keeps Lingtai's own sentence about a branch that was not there", () => {
    const chat = foldChat("chat-1", [e("chat-1", "DiscussionAsked", ASKED)], null);
    expect(chat.turns[0]?.reading.join(" ")).toContain("attempt 2 left no branch");
  });

  /** A turn that failed still cost what it cost. A meter that can miss a spend is not one. */
  it("counts a failed turn's money", () => {
    const chat = foldChat(
      "chat-1",
      [
        e("chat-1", "DiscussionAsked", ASKED),
        e("chat-1", "DiscussionAnswered", {
          text: "",
          read: [],
          cannot: [],
          proposal: null,
          turns: 1,
          durationMs: 300_000,
          costUsd: 0.19,
          failure: "timeout: no result within 300000ms",
        }),
      ],
      null,
    );

    expect(chat.costUsd).toBeCloseTo(0.19, 5);
    expect(chat.turns[0]?.answer?.failure).toContain("timeout");
    expect(chat.waiting).toBe(false);
  });

  /** Null and zero are different answers, exactly as they are for a run. */
  it("reports no spend rather than zero when nothing said what it cost", () => {
    const chat = foldChat(
      "chat-1",
      [
        e("chat-1", "DiscussionAsked", ASKED),
        e("chat-1", "DiscussionAnswered", {
          text: "x",
          read: [],
          cannot: [],
          proposal: null,
          turns: 1,
          durationMs: 1,
          costUsd: null,
          failure: null,
        }),
      ],
      null,
    );
    expect(chat.costUsd).toBeNull();
  });
});

describe("which conversations an item has had", () => {
  /**
   * The join 0012 puts on the reader: the request is on `ctl-conductor` and the
   * ending is on the work item, and neither one alone lists them.
   */
  it("finds an open conversation from the control stream and a closed one from the item", () => {
    const chats = chatIdsFor(
      [
        { chatId: "chat-1", workItemId: "wi-lingtai-89" },
        { chatId: "chat-2", workItemId: "wi-lingtai-87" },
      ],
      [e("wi-lingtai-89", "DiscussionHeld", { chatId: "chat-1", costUsd: 0.42, outcome: "prompt" })],
      "wi-lingtai-89",
    );

    expect(chats).toEqual([{ chatId: "chat-1", held: "prompt" }]);
  });

  it("leaves an unconcluded conversation open rather than calling it closed", () => {
    const chats = chatIdsFor([{ chatId: "chat-1", workItemId: "wi-lingtai-89" }], [], "wi-lingtai-89");
    expect(chats).toEqual([{ chatId: "chat-1", held: null }]);
  });
});

describe("the ledger", () => {
  /**
   * `2 attempts + 3 discussions · $14.10`, as the design's example reads it.
   * Beside the attempts' money rather than inside it, for the reason `#84`
   * keeps a repair's spend apart: they come out of one budget, and folding two
   * figures into one misstates both.
   */
  it("counts discussions beside attempts and their money beside the work's", () => {
    const totals = totalsOf([], [chat(0.42), chat(1.1), chat(null)]);

    expect(totals.discussions).toBe(3);
    expect(totals.discussionUsd).toBeCloseTo(1.52, 5);
    expect(totals.costUsd).toBe(0);
  });
});

function chat(costUsd: number | null): DiscussionView {
  return { chatId: "chat-1", attempt: null, turns: [], costUsd, waiting: false, held: "none" };
}
