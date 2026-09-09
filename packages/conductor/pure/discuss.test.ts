/**
 * The two things the discussion assistant must not pretend, and the two places
 * its conclusion can go.
 *
 * These are `#105`'s own bar, and they are here rather than in an integration
 * test because both of them are decisions about *what is said* rather than
 * about what is stored. `readingFor` is the sentence Lingtai writes before the
 * assistant speaks; `parseReply` is what refuses to present prose as an answer.
 *
 * Pure, under `vitest.pure.config.ts`: nothing here reads a database, and an
 * assistant whose containment needed one would be the wrong shape.
 */
import { describe, expect, it } from "vitest";
import {
  appendToBody,
  buildBrief,
  holdDiscussion,
  MAX_READ_ROUNDS,
  outstanding,
  parseReply,
  readingFor,
  spendOf,
  turnsOf,
  type Answered,
  type DiscussionEvidence,
} from "../src/discuss.ts";
import type { Envelope, ToAppend } from "@lingtai/domain";

const EVIDENCE: DiscussionEvidence = {
  workItemId: "wi-lingtai-89",
  attempt: 2,
  ticket: { ref: "89", title: "the run does not stop at the turn limit", body: "…" },
  ticketProblem: null,
  log: ["1  2026-09-08 04:12:00  wi-lingtai-89  WorkItemClaimed  conductor  {}"],
  reading: ["main: readable at abc1234"],
  refs: [{ ref: "main", sha: "abc1234", paths: ["packages/agent/src/claude-code.ts"], truncated: false }],
};

describe("what was readable, said by Lingtai", () => {
  /**
   * The blind spot that killed `#89`'s repair, and the reason this function
   * exists at all. `worktree.ts` runs `-B` on every run, so the *branch ref*
   * survives an attempt that committed nothing — a check on the ref would find
   * one, read `main` under another name, and report neither.
   */
  it("says an attempt left no branch, and that main is being read instead", () => {
    const lines = readingFor({ attempt: 2, base: "main", baseSha: "abc1234ff", head: null });

    expect(lines.join("\n")).toContain("attempt 2 left no branch; I am reading main");
    expect(lines.join("\n")).toContain("-B");
  });

  it("names the commit when the attempt did produce one", () => {
    const lines = readingFor({ attempt: 2, base: "main", baseSha: "abc1234ff", head: "9f8e7d6c5b" });

    expect(lines.join("\n")).toContain("attempt-2: readable at 9f8e7d6");
    expect(lines.join("\n")).not.toContain("left no branch");
  });

  it("says so when there is no mirror at all, rather than offering a ref", () => {
    const lines = readingFor({ attempt: null, base: "main", baseSha: null, head: null });
    expect(lines[0]).toContain("no file can be read");
  });
});

describe("the brief", () => {
  it("carries the reading sentences, so the assistant cannot be given the blind spot", () => {
    const brief = buildBrief({
      evidence: {
        ...EVIDENCE,
        reading: readingFor({ attempt: 2, base: "main", baseSha: "abc1234ff", head: null }),
      },
      history: [],
      question: "why did attempt 2 produce nothing?",
      served: [],
      roundsLeft: MAX_READ_ROUNDS,
    });

    expect(brief).toContain("attempt 2 left no branch; I am reading main");
  });

  /**
   * The inference that cost `#89` two attempts and $13.04. It is in the fixed
   * text of the brief rather than left to judgement for the reason the agent
   * gate's rubric is: it went wrong once, measurably, and a rule that depends
   * on the model remembering is not a rule.
   */
  it("forbids concluding a flag is absent from its absence in documentation", () => {
    const brief = buildBrief({
      evidence: EVIDENCE,
      history: [],
      question: "does the binary accept --max-turns?",
      served: [],
      roundsLeft: MAX_READ_ROUNDS,
    });

    expect(brief).toContain("no command execution");
    expect(brief).toContain("Absence from documentation is not absence from the program");
    expect(brief).toContain("say that it needs a command");
  });

  it("says when the reading is over, so a question cannot be asked forever", () => {
    const brief = buildBrief({
      evidence: EVIDENCE,
      history: [],
      question: "why?",
      served: [],
      roundsLeft: 0,
    });
    expect(brief).toContain("You have no reading left");
  });
});

describe("the reply", () => {
  it("reads a request for files", () => {
    const reply = parseReply('{"read":["main:packages/agent/src/claude-code.ts"]}');
    expect(reply).toEqual({ kind: "read", paths: ["main:packages/agent/src/claude-code.ts"] });
  });

  it("reads an answer, its caveats and its proposal", () => {
    const reply = parseReply(
      '```json\n{"answer":"the flag is not passed","cannot":["whether the binary accepts it"],' +
        '"proposal":{"kind":"prompt","text":"pass --max-turns"}}\n```',
    );
    expect(reply).toEqual({
      kind: "answer",
      text: "the flag is not passed",
      cannot: ["whether the binary accepts it"],
      proposal: { kind: "prompt", text: "pass --max-turns" },
    });
  });

  /**
   * There are two carriers and only two (0033 §2). A third is dropped rather
   * than guessed at: a discussion that could invent a place to put an
   * instruction would be the third carrier the decision refuses.
   */
  it("drops a proposal that names neither carrier", () => {
    const reply = parseReply('{"answer":"x","proposal":{"kind":"pull-request","text":"…"}}');
    expect(reply).toEqual({ kind: "answer", text: "x", cannot: [], proposal: null });
  });

  /**
   * The prose is kept and marked, never promoted. Treating a half-finished
   * thought as the answer is how a refusal gets presented as a conclusion.
   */
  it("refuses to read prose as an answer", () => {
    expect(parseReply("I think the problem is probably the flag.")).toEqual({
      kind: "unreadable",
      text: "I think the problem is probably the flag.",
    });
  });
});

describe("the ticket, appended to", () => {
  it("adds a dated, attributed block and keeps what was there", () => {
    const body = appendToBody("The original ticket.", "Pass --max-turns.", "human:steven", new Date("2026-09-09T10:00:00Z"));
    expect(body).toContain("The original ticket.");
    expect(body).toContain("## Added from a discussion, 2026-09-09, by human:steven");
    expect(body).toContain("Pass --max-turns.");
  });
});

describe("whether a request has been answered", () => {
  it("counts answers against asks rather than needing a consumed event", () => {
    const answers = [envelope("DiscussionAnswered", {})];
    expect(outstanding(1, answers)).toBe(false);
    expect(outstanding(2, answers)).toBe(true);
  });
});

describe("holding one question", () => {
  /**
   * The meter, and the whole of 0033 §4: there is no spend limit, so a turn
   * that cost money and then failed has to leave the money on the log. A
   * failure that appended nothing would be a meter that can miss a spend, which
   * is not a meter.
   */
  it("appends the ask before it runs anything, and records a failure's cost", async () => {
    const store = fakeStore();
    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async () => null,
        ask: async (): Promise<Answered> => ({
          turns: 3,
          durationMs: 120,
          costUsd: 0.42,
          text: null,
          failure: { kind: "timeout", detail: "no result within 300000ms" },
        }),
      },
      { chatId: "chat-1", evidence: EVIDENCE, question: "why?", by: "human:steven" },
    );

    expect(store.types()).toEqual(["DiscussionAsked", "DiscussionAnswered"]);
    expect(held).toEqual({ costUsd: 0.42, answered: false, proposal: null });
    const answer = store.appended[1]?.data as { costUsd: number; failure: string };
    expect(answer.costUsd).toBe(0.42);
    expect(answer.failure).toContain("timeout");
  });

  it("serves the files it is asked for, then answers with them", async () => {
    const store = fakeStore();
    const served: string[] = [];
    let round = 0;

    const held = await holdDiscussion(
      {
        store: store.store,
        serve: async (ref, path) => {
          served.push(`${ref}:${path}`);
          return "export const x = 1;";
        },
        ask: async (prompt): Promise<Answered> => {
          round += 1;
          if (round === 1) {
            return { turns: 1, durationMs: 1, costUsd: 0.1, text: '{"read":["main:a.ts"]}', failure: null };
          }
          expect(prompt).toContain("export const x = 1;");
          return {
            turns: 1,
            durationMs: 1,
            costUsd: 0.2,
            text: '{"answer":"it is a.ts","cannot":[],"proposal":null}',
            failure: null,
          };
        },
      },
      { chatId: "chat-1", evidence: EVIDENCE, question: "why?", by: "human:steven" },
    );

    expect(served).toEqual(["main:a.ts"]);
    expect(held.answered).toBe(true);
    // Both rounds, on one event. A person watching the meter is watching what
    // the question cost, not what one of its rounds did.
    expect(held.costUsd).toBeCloseTo(0.3);
    expect((store.appended[1]?.data as { read: string[] }).read).toEqual(["main:a.ts"]);
  });

  it("stops asking for files once the rounds run out, and says that is why", async () => {
    const store = fakeStore();
    await holdDiscussion(
      {
        store: store.store,
        serve: async () => "x",
        ask: async (): Promise<Answered> => ({
          turns: 1,
          durationMs: 1,
          costUsd: 0.01,
          text: '{"read":["main:a.ts"]}',
          failure: null,
        }),
      },
      { chatId: "chat-1", evidence: EVIDENCE, question: "why?", by: "human:steven" },
    );

    const answer = store.appended[1]?.data as { failure: string };
    expect(answer.failure).toContain(`${MAX_READ_ROUNDS} rounds`);
  });
});

describe("the conversation, read back", () => {
  it("pairs each ask with the answer that followed it and totals the spend", () => {
    const events = [
      envelope("DiscussionAsked", { question: "why?", by: "human:steven", reading: [] }),
      envelope("DiscussionAnswered", { text: "because", costUsd: 0.5 }),
      envelope("DiscussionAsked", { question: "and then?", by: "human:steven", reading: [] }),
    ];

    expect(turnsOf(events)).toEqual([
      { question: "why?", by: "human:steven", answer: "because" },
      { question: "and then?", by: "human:steven", answer: null },
    ]);
    expect(spendOf(events)).toBe(0.5);
  });

  /** Null and zero are different answers. A turn that reported no cost was not free. */
  it("reports no spend rather than zero when nothing said what it cost", () => {
    expect(spendOf([envelope("DiscussionAnswered", { text: "x", costUsd: null })])).toBeNull();
  });
});

// ---------------------------------------------------------------- fixtures --

function envelope(type: string, data: unknown): Envelope {
  return {
    seq: 1n,
    streamId: "chat-1",
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date("2026-09-09T10:00:00Z"),
  };
}

/** Enough of an `EventStore` for a fold that only reads and appends one stream. */
function fakeStore() {
  const appended: ToAppend[] = [];
  return {
    appended,
    types: () => appended.map((e) => e.type),
    store: {
      read: async () => appended.map((e) => envelope(e.type, e.data)),
      append: async (_stream: string, _at: number, events: ToAppend[]) => {
        appended.push(...events);
      },
    } as never,
  };
}
