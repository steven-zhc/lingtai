/**
 * A discussion against the real store, for the two things a fake cannot show.
 *
 * **`chat-<id>` has to be a stream the store will accept.** `StreamId` is a
 * regex in `@lingtai/domain` and `agent:chat-<uuid>` has to satisfy `Actor`;
 * both are enforced on append and neither is visible to a fold test. A third
 * kind of agent that could not write anything down would fail on its first
 * real question and nowhere before it.
 *
 * **The ending has to reach the work item.** 0033 §6 promises the ticket's
 * history grows by two lines and no money is spent without a record, and that
 * is a claim about *two* streams — the conversation on its own, and one
 * `DiscussionHeld` on the item's — which is exactly the shape a single-stream
 * fake cannot check.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concludeDiscussion,
  holdDiscussion,
  readingFor,
  type Answered,
  type DiscussionEvidence,
  type IssueChannel,
} from "../src/discuss.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

let n = 0;

function id(prefix: "wi" | "chat"): string {
  n += 1;
  const stream = prefix === "chat" ? `chat-${crypto.randomUUID()}` : `wi-${PROJECT}-${n}`;
  created.add(stream);
  return stream;
}

/** The evidence `#89`'s second attempt actually had: main, and no branch. */
function evidence(workItemId: string): DiscussionEvidence {
  return {
    workItemId,
    attempt: 2,
    ticket: { ref: "89", title: "the run does not stop at the turn limit", body: "…" },
    ticketProblem: null,
    log: [`1  2026-09-08 04:12:00  ${workItemId}  WorkItemClaimed  conductor  {}`],
    reading: readingFor({ attempt: 2, base: "main", baseSha: "abc1234ff", head: null }),
    refs: [{ ref: "main", sha: "abc1234ff", paths: ["packages/agent/src/claude-code.ts"], truncated: false }],
  };
}

const answers = (text: string) => async (): Promise<Answered> => ({
  turns: 4,
  durationMs: 9_000,
  costUsd: 0.42,
  text,
  failure: null,
});

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    for (const stream of created) await c.query("delete from events where stream_id = $1", [stream]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("a discussion, on the log", () => {
  it("writes the exchange to its own stream, under its own actor", async () => {
    const workItemId = id("wi");
    const chatId = id("chat");

    await holdDiscussion(
      {
        store,
        serve: async () => null,
        ask: answers('{"answer":"the flag is never passed","cannot":["whether the binary accepts it"],"proposal":{"kind":"prompt","text":"pass --max-turns"}}'),
      },
      { chatId, evidence: evidence(workItemId), question: "why did attempt 2 produce nothing?", by: "human:steven" },
    );

    const chat = await store.read(chatId);
    expect(chat.map((e) => e.type)).toEqual(["DiscussionAsked", "DiscussionAnswered"]);
    // 0033's first consequence: a third actor appears on the log.
    expect(chat[1]?.actor).toBe(`agent:${chatId}`);
    // Lingtai's sentence, on the ask, before the assistant said anything.
    const asked = chat[0]?.data as { reading: string[] };
    expect(asked.reading.join(" ")).toContain("attempt 2 left no branch");

    // And nothing at all on the work item yet. The ticket's history grows when
    // the conversation ends, not turn by turn.
    expect(await store.read(workItemId)).toHaveLength(0);
  });

  it("adds one line to the work item when it ends, carrying what it cost", async () => {
    const workItemId = id("wi");
    const chatId = id("chat");

    await holdDiscussion(
      { store, serve: async () => null, ask: answers('{"answer":"x","cannot":[],"proposal":null}') },
      { chatId, evidence: evidence(workItemId), question: "why?", by: "human:steven" },
    );

    const result = await concludeDiscussion({
      store,
      workItemId,
      chatId,
      by: "human:steven",
      outcome: "prompt",
      text: "pass --max-turns to the runtime",
    });

    expect(result.ok).toBe(true);
    const own = await store.read(workItemId);
    // Two lines and not forty: the edit, and the pointer at the conversation.
    expect(own.map((e) => e.type)).toEqual(["PromptEdited", "DiscussionHeld"]);
    const held = own[1]?.data as { chatId: string; costUsd: number; outcome: string };
    expect(held.chatId).toBe(chatId);
    expect(held.costUsd).toBeCloseTo(0.42, 5);
    expect(held.outcome).toBe("prompt");
  });

  /**
   * The other carrier. It goes through `tellGitHub`, so a refusal is recorded
   * as `IssueUpdateFailed` and never thrown — and `DiscussionHeld` lands
   * either way, because the money was spent either way.
   */
  it("appends to the ticket body, and still records the spend when GitHub refuses", async () => {
    const workItemId = id("wi");
    const chatId = id("chat");
    await holdDiscussion(
      { store, serve: async () => null, ask: answers('{"answer":"x","cannot":[],"proposal":null}') },
      { chatId, evidence: evidence(workItemId), question: "why?", by: "human:steven" },
    );

    let written: string | null = null;
    const github: IssueChannel = {
      getIssue: async () => ({ labels: [] }),
      comment: async () => ({ id: 1 }),
      setLabels: async () => {},
      closeIssue: async () => {},
      updateBody: async (_issue, body) => {
        written = body;
      },
    };

    const ok = await concludeDiscussion({
      store,
      workItemId,
      chatId,
      by: "human:steven",
      outcome: "ticket",
      text: "The runtime must pass --max-turns.",
      ticket: { github, body: "The original ticket." },
      now: new Date("2026-09-09T10:00:00Z"),
    });

    expect(ok.ok).toBe(true);
    expect(written).toContain("The original ticket.");
    expect(written).toContain("The runtime must pass --max-turns.");
    expect((await store.read(workItemId)).map((e) => e.type)).toEqual([
      "IssueUpdated",
      "DiscussionHeld",
    ]);

    // And the refusal path, on a second conversation about the same item.
    const second = id("chat");
    await holdDiscussion(
      { store, serve: async () => null, ask: answers('{"answer":"x","cannot":[],"proposal":null}') },
      { chatId: second, evidence: evidence(workItemId), question: "again?", by: "human:steven" },
    );
    const refused = await concludeDiscussion({
      store,
      workItemId,
      chatId: second,
      by: "human:steven",
      outcome: "ticket",
      text: "Another sentence.",
      ticket: {
        github: {
          ...github,
          updateBody: async () => {
            throw new Error("422 unprocessable");
          },
        },
        body: "The original ticket.",
      },
    });

    expect(refused.ok).toBe(false);
    const own = (await store.read(workItemId)).map((e) => e.type);
    expect(own.slice(-2)).toEqual(["IssueUpdateFailed", "DiscussionHeld"]);
  });
});
