/**
 * The discussion has a meter, and the ledger has a total.
 *
 * Two numbers, one argument. [0033](../../../doc/decisions/0033-the-third-kind-of-agent.md)
 * §4 gives the discussion assistant no spend limit **because the person is the
 * control loop** — and a person can only be the limit if the person can see the
 * number. The box carried the boundary (*it cannot run anything*) and no cost at
 * all, so the one agent on this page with no ceiling was the one with no reading
 * (#111 §4). The ledger had the opposite problem: two costs and no sum, leaving
 * `$13.04` — the figure `#89` is remembered by — as arithmetic every reader did
 * in their head (§5).
 *
 * Asserted on the markup for the reason `#101` established: these are facts
 * about what a reader is shown, not about the fold.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { totalsFact, totalsOf, type DiscussionView, type RunView } from "../src/lib/task.ts";
import { Discussion } from "../src/app/discussion.tsx";

function chat(over: Partial<DiscussionView> = {}): DiscussionView {
  return {
    chatId: "chat-1",
    attempt: 2,
    turns: [],
    costUsd: null,
    waiting: false,
    held: null,
    ...over,
  };
}

function turn(question: string, costUsd: number | null) {
  return {
    question,
    by: "human:steven",
    at: "2026-09-09T10:00:00.000Z",
    reading: [],
    answer: {
      text: "attempt 2 left no branch; I am reading main.",
      read: [],
      cannot: [],
      proposal: null,
      costUsd,
      failure: null,
    },
  };
}

const render = (discussions: DiscussionView[]) =>
  renderToStaticMarkup(
    <Discussion taskId="wi-lingtai-89" attempt={2} discussions={discussions} />,
  );

describe("the meter", () => {
  /**
   * The sentence 0033 §4 asks for, in the order a person checks it: what this
   * conversation has cost, how many exchanges bought it, and that nothing will
   * stop it. `no limit` is said rather than implied — an unstated limit reads as
   * a limit somebody else is keeping.
   */
  it("reads the running cost, the messages and the absence of a limit", () => {
    const html = render([
      chat({
        costUsd: 0.64,
        turns: [turn("why no branch?", 0.2), turn("and the flag?", 0.3), turn("so?", 0.14)],
      }),
    ]);

    expect(html).toContain("this conversation $0.64 · 3 messages · no limit");
  });

  it("says the boundary, and no figure, before the first question", () => {
    const html = render([]);

    expect(html).toContain("reads the log, the ticket and the code — it cannot run anything");
    expect(html).not.toContain("$0.00");
  });

  /**
   * `$0.00` would say a conversation has been shown to be free. A null cost is
   * *nobody said* — the same reading `RunFinished.costUsd` gets — so a question
   * still in flight says it was asked and waits for the number.
   */
  it("does not print a zero for a cost nobody has reported", () => {
    const html = render([chat({ costUsd: null, waiting: true, turns: [turn("why?", null)] })]);

    expect(html).toContain("this conversation asked · 1 message · no limit");
    expect(html).not.toContain("$0.00");
  });

  it("reports what closed conversations came to once none is open", () => {
    const html = render([chat({ held: "none", costUsd: 0.42, turns: [turn("why?", 0.42)] })]);

    expect(html).toContain("1 held · $0.42 · no limit");
  });
});

function run(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    attempt: 1,
    at: "2026-09-08T03:00:00.000Z",
    repair: false,
    baseSha: null,
    headSha: null,
    turns: 73,
    costUsd: 7.81,
    durationMs: 700_000,
    outcome: { state: "finished", detail: null },
    files: [],
    diff: null,
    prompt: null,
    awaitingSha: null,
    gates: [],
    points: [],
    ...over,
  };
}

describe("the ledger's total", () => {
  /**
   * `$13.04` is the number a person acts on, so it is the first thing on the
   * label. The split stays behind it because a repair is default-on and a
   * discussion has a meter rather than a limit (#84, 0033 §4) — stated, but not
   * the headline.
   */
  it("leads with the sum and keeps the split behind it", () => {
    const fact = totalsFact(
      totalsOf(
        [run(), run({ runId: "run-2", attempt: 2, repair: true, costUsd: 5.23, turns: 74 })],
        [chat({ held: "none", costUsd: 0.42 })],
      ),
    );

    expect(fact?.startsWith("$13.46 · ")).toBe(true);
    expect(fact).toContain("2 attempts + 1 discussion");
    expect(fact).toContain("147 turns");
    expect(fact).toContain("$7.81 work");
    expect(fact).toContain("$5.23 repair");
    expect(fact).toContain("$0.42 asking");
  });

  /**
   * One kind of money needs no split: `$7.81 · $7.81 work` is one fact printed
   * twice, which is the disagreement a second copy of an arithmetic invites.
   */
  it("drops the split when there is only one kind of money", () => {
    const fact = totalsFact(totalsOf([run()]));

    expect(fact?.startsWith("$7.81 · 1 attempt · 73 turns")).toBe(true);
    expect(fact).not.toContain("work");
  });

  it("names no figure at all for an item nothing has reported a cost on", () => {
    const fact = totalsFact(totalsOf([run({ costUsd: null })]));

    expect(fact).toBe("1 attempt · 73 turns · 11m40s");
  });
});
