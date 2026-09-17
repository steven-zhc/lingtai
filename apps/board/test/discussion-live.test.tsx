/**
 * The discussion box, while it is being answered.
 *
 * Two things, and the second is the one that costs money. The box has **one
 * height**, with the conversation scrolling inside it and the input box under
 * it — the moves sit below both panes, so a pane that grew with its content
 * pushed the button you were deciding with off the screen, a long conversation
 * costing you the decision it was meant to inform. And a turn with no answer
 * yet **follows the chat's own log** rather than saying nothing until the agent
 * exits: that is the defect
 * [0034](../../../doc/decisions/0034-the-run-log.md) opens with, solved for
 * runs and not for discussions, and *a discussion is attended and the person is
 * the loop* (0033 §4). A loop with no feedback is a person asking again and
 * paying twice (#132).
 *
 * **`Trace` is the subject of the second half, and it is the subject because it
 * is testable.** There is no DOM here and no `EventSource`, so a test of
 * `Thinking` could only ever assert its first frame — which is a static
 * paragraph, and asserting a static paragraph is how a live box gets replaced
 * by a dead one without a test noticing. `Trace` takes the tail as a value:
 * these are the three things a follower can be holding and the three sentences
 * a reader is handed for them, asserted directly.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscussionView } from "../src/lib/task.ts";
import { Discussion, Echoed, Trace, echoing, traceSays } from "../src/app/discussion.tsx";
import { againAfter, asksAgain, reported, type TailState } from "../src/app/run-log.tsx";

const waiting: DiscussionView = {
  chatId: "chat-1",
  attempt: 2,
  waiting: true,
  costUsd: null,
  held: null,
  turns: [
    {
      question: "why did attempt 2 not produce a branch?",
      by: "human:steven",
      at: "2026-09-10T10:00:00.000Z",
      reading: [],
      answer: null,
    },
  ],
};

const render = (discussions: DiscussionView[]) =>
  renderToStaticMarkup(
    <Discussion taskId="wi-lingtai-89" attempt={2} discussions={discussions} />,
  );

describe("the box while it is being answered", () => {
  it("puts the conversation in its own scroller, with the input box under it", () => {
    const html = render([waiting]);
    const scroller = html.indexOf('class="chatscroll"');
    const ask = html.indexOf('class="chatask"');
    expect(scroller).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(scroller);
    // The question is inside the scroller and not beside it: what grows is the
    // one part of the box that has somewhere to grow into.
    expect(html.indexOf("why did attempt 2 not produce a branch?")).toBeGreaterThan(scroller);
    expect(html.indexOf("why did attempt 2 not produce a branch?")).toBeLessThan(ask);
  });

  it("puts an unanswered turn's trace where the answer will be", () => {
    const html = render([waiting]);
    // The follower, not a sentence: `data-trace` is the state `useLogTail`
    // handed `Trace`, and a turn that rendered a static paragraph — what this
    // box was before #132 — has none. Its first frame is `off`, before a
    // connection has said anything.
    expect(html).toContain('data-trace="off"');
    // Nothing to show yet, and it says so rather than showing an empty frame
    // (0016 §4).
    expect(html).not.toContain('class="chattrace"');
  });

  it("follows the chat's trace from one turn only — the one being answered", () => {
    // A follow-up asked while the first question is still being answered. The
    // file is the chat's and holds the first turn's trace, so a second follower
    // would print it under the second question and call it live.
    const followUp = {
      ...waiting.turns[0]!,
      question: "and what about attempt 1?",
      at: "2026-09-10T10:00:30.000Z",
    };
    const html = render([{ ...waiting, turns: [waiting.turns[0]!, followUp] }]);
    expect(html.split("data-trace=").length - 1).toBe(2);
    expect(html.split('data-trace="off"').length - 1).toBe(1);
    expect(html).toContain('data-trace="behind"');
    // And in that order: the first question follows, the follow-up waits.
    expect(html.indexOf('data-trace="off"')).toBeLessThan(html.indexOf("and what about attempt 1?"));
    expect(html.indexOf('data-trace="behind"')).toBeGreaterThan(html.indexOf("and what about attempt 1?"));
  });

  it("follows nothing for a turn that has been answered", () => {
    const answered: DiscussionView = {
      ...waiting,
      waiting: false,
      turns: [
        {
          ...waiting.turns[0]!,
          answer: { text: "it did", failure: null, cannot: [], read: [], costUsd: 0.1, proposal: null },
        },
      ],
    };
    expect(render([answered])).not.toContain("data-trace");
  });
});

/**
 * **Turns, not a transcript** (#152): *"a discussion is attended and the person
 * is the loop"* (0033 §4), and a loop with no feedback is a person asking twice.
 */
describe("the conversation, as turns", () => {
  const answered: DiscussionView = {
    ...waiting,
    waiting: false,
    turns: [
      {
        ...waiting.turns[0]!,
        answer: { text: "it did", failure: null, cannot: [], read: [], costUsd: 0.1, proposal: null },
      },
    ],
  };

  it("gives every turn two bubbles, each with its author", () => {
    const html = render([answered]);
    expect(html.split('class="bubble asked"').length - 1).toBe(1);
    expect(html.split('class="bubble answer"').length - 1).toBe(1);
    expect(html.split('class="chatwho"').length - 1).toBe(2);
    expect(html.indexOf("human:steven")).toBeLessThan(html.indexOf("why did attempt 2"));
    expect(html.indexOf("assistant")).toBeLessThan(html.indexOf("it did"));
  });

  it("puts the turn still being answered in the assistant's bubble, where its answer will be", () => {
    const html = render([waiting]);
    const bubble = html.indexOf('class="bubble answer"');
    expect(bubble).toBeGreaterThan(-1);
    expect(html.indexOf('data-trace="off"')).toBeGreaterThan(bubble);
  });

  it("grows the answer under a caret while something is writing it, and only then", () => {
    expect(renderToStaticMarkup(<Trace lines={["12:00:01  think"]} state="reading" />)).toContain('class="caret"');
    expect(renderToStaticMarkup(<Trace lines={[]} state="reading" writing={true} />)).toContain('class="caret"');
    // A leftover nobody is writing, and a trace that ended, are not a cursor.
    expect(renderToStaticMarkup(<Trace lines={["x"]} state="reading" writing={false} />)).not.toContain("caret");
    expect(renderToStaticMarkup(<Trace lines={["x"]} state="removed" />)).not.toContain("caret");
    expect(renderToStaticMarkup(<Trace lines={[]} state="queued" />)).not.toContain("caret");
  });

  it("wears no brass when the item is running", () => {
    const quiet = renderToStaticMarkup(
      <Discussion taskId="wi-lingtai-89" attempt={2} discussions={[answered]} quiet />,
    );
    expect(quiet).not.toContain("btn pri");
    expect(render([answered])).toContain("btn pri");
  });
});

describe("asking again for a trace that is not there yet", () => {
  it("backs off rather than stopping", () => {
    expect(againAfter(0)).toBe(1_500);
    expect(againAfter(1)).toBe(3_000);
    // Capped, and still a number however long the tab has been open: a
    // question with no daemon running is queued, not dead, and a follower that
    // stopped asking would miss the trace when one starts.
    expect(againAfter(4)).toBe(15_000);
    expect(againAfter(1_000)).toBe(15_000);
  });

  it("says a missing file is not yet, then queued — and never gone", () => {
    expect(reported("gone", true, 0)).toBe("waiting");
    expect(reported("gone", true, 4)).toBe("waiting");
    expect(reported("gone", true, 5)).toBe("queued");
    expect(reported("gone", true, 10_000)).toBe("queued");
    // A run's log is not awaited: there, a 404 is a landed run's deleted file.
    expect(reported("gone", false, 0)).toBe("gone");
    expect(reported("reading", true, 7)).toBe("reading");
  });

  it("keeps following past a deleted trace, so a second daemon's answer is seen", () => {
    // Daemon A dies mid-answer and leaves its file; daemon B picks the question
    // up and removes that file before opening its own. The follower sees
    // `removed` — and must ask again, or B's whole answer is never shown.
    expect(asksAgain("removed", true)).toBe(true);
    expect(asksAgain("gone", true)).toBe(true);
    expect(asksAgain("reading", true)).toBe(false);
    expect(asksAgain("trouble", true)).toBe(false);
    // A run's log is not awaited: its deletion is the end, and nothing polls.
    expect(asksAgain("removed", false)).toBe(false);
    expect(asksAgain("gone", false)).toBe(false);
  });
});

describe("what a reader is handed for each state of the trace", () => {
  const show = (lines: string[], state: TailState) =>
    renderToStaticMarkup(<Trace lines={lines} state={state} />);

  it("says it is waiting while the file has not been opened yet", () => {
    // `waiting` is a 404 the follower is still asking about — the board
    // appended the question a moment ago and the daemon has not opened the
    // file. *Not yet*, and it must not read as *not coming*.
    expect(show([], "waiting")).toContain("waiting for the daemon to answer");
  });

  it("shows the lines as they arrive, verbatim and counted", () => {
    const html = show(["12:00:01  Read    doc/architecture.html", "12:00:04  think"], "reading");
    // The whole of what makes the box move: the count says something is
    // happening and the lines say what.
    expect(html).toContain("answering · 2 lines so far");
    expect(html).toContain('class="chattrace"');
    expect(html).toContain("doc/architecture.html");
    // A log, and never markdown or a paragraph (design §6).
    expect(html).toContain("<pre");
  });

  it("reads a deleted trace as neither a turn that died nor an answer that landed", () => {
    // `answerDiscussion` deletes the file in its `finally`, after the answer is
    // recorded — and also at the start of a turn, clearing what a daemon killed
    // mid-answer left behind. The first attempt at this said *ask again* on
    // every successful turn; the second said *answered* over a second daemon's
    // whole answer, with no `DiscussionAnswered` on the log.
    const html = show(["12:00:01  Read    doc/architecture.html"], "removed");
    expect(html).not.toContain("answered");
    expect(html).toContain("if a daemon starts this turn over its trace appears here instead");
    expect(html).not.toMatch(/ask again|no answer/);
    // What it produced stays on screen until the answer replaces it.
    expect(html).toContain("doc/architecture.html");
  });

  it("never says a trace is being answered when nothing is writing it", () => {
    // Daemon A wrote 40 lines and was killed before its `finally` removed the
    // file — or a `--no-conduct` daemon is beating and answers nothing. The
    // follower opens the leftover and reports `reading`, and the route reports
    // the file's writer has stopped touching it (`RUN_LOG_QUIET_MS`).
    const forty = Array.from({ length: 40 }, (_, i) => `12:00:${i}  think`);
    const dead = renderToStaticMarkup(<Trace lines={forty} state="reading" writing={false} />);
    expect(dead).not.toMatch(/answering ·|lines so far|has started on this/);
    expect(dead).toContain("nothing is writing this trace, so nothing is answering this now");
    expect(dead).toContain('data-trace="reading"');

    // A writer still touching it, or a route that has not said yet, is the ordinary sentence.
    expect(traceSays("reading", 40, true)).toBe("answering · 40 lines so far");
    expect(traceSays("reading", 40, null)).toBe("answering · 40 lines so far");
  });

  it("says a question nothing has picked up is queued, and that asking again costs", () => {
    const html = show([], "queued");
    expect(html).toContain("no daemon has started on this yet");
    expect(html).toContain("asking again would buy a second one");
  });

  it("never tells a reader to ask again, in any state", () => {
    const states: TailState[] = [
      "off", "reading", "waiting", "queued", "gone", "trouble", "landed", "did not land", "removed",
    ];
    for (const state of states) {
      for (const lines of [0, 3]) {
        const said = traceSays(state, lines);
        expect(said, state).not.toBe("");
        expect(said, state).not.toMatch(/or ask again|no answer has been recorded/);
      }
    }
  });
});

/**
 * **Each of these four has a sentence, and until #172 none had been seen**: the
 * task page never re-rendered between the click and a reload, so the pane went
 * from nothing to the answer. Now that it follows the log, these are what a
 * person reads while they wait — one test, all four, so a state that stops
 * rendering its own sentence is a failure here rather than a surprise there.
 */
describe("the four sentences between asking and the answer", () => {
  const says = (lines: string[], state: TailState, writing: boolean | null = null) => {
    const html = renderToStaticMarkup(<Trace lines={lines} state={state} writing={writing} />);
    return { html, said: traceSays(state, lines.length, writing) };
  };

  it("renders each of them, in the pane, under its own state", () => {
    const queued = says([], "queued");
    expect(queued.html).toContain('data-trace="queued"');
    expect(queued.html).toContain(
      "no daemon has started on this yet. The question is on the log and is answered when one runs",
    );

    const started = says([], "reading");
    expect(started.html).toContain('data-trace="reading"');
    expect(started.html).toContain("the daemon has started on this — nothing written yet");

    const answering = says(["12:00:01  think", "12:00:02  Read    a.ts", "12:00:03  think"], "reading", true);
    expect(answering.html).toContain("answering · 3 lines so far");

    const dead = says(["12:00:01  think"], "reading", false);
    expect(dead.html).toContain("nothing is writing this trace, so nothing is answering this now");

    // Four states, four different sentences: none of them falls through to another's.
    expect(new Set([queued.said, started.said, answering.said, dead.said]).size).toBe(4);
  });
});

/**
 * **The person sees their own words before the log does** (#172). The append is
 * a round trip and then a re-render away, and a button that shows nothing in
 * between is a button pressed twice.
 */
describe("the question, echoed until the fold has it", () => {
  it("shows the words while the fold has no more turns than when they were sent", () => {
    expect(echoing([], null)).toBeNull();
    expect(echoing([], { question: "why?", turns: 0 })).toBe("why?");
    // A follow-up to a chat with one turn: still one turn, still echoed.
    expect(echoing([waiting], { question: "and then?", turns: 1 })).toBe("and then?");
  });

  it("stops once the question has arrived in its place, whatever its text", () => {
    expect(echoing([waiting], { question: "why did attempt 2 not produce a branch?", turns: 0 })).toBeNull();
    // Counted, not matched: the same words asked twice are two turns, and the
    // second must not vanish because the first is already there.
    expect(
      echoing([waiting], { question: "why did attempt 2 not produce a branch?", turns: 1 }),
    ).toBe("why did attempt 2 not produce a branch?");
  });

  it("is the person's bubble, saying where the question is", () => {
    const asking = renderToStaticMarkup(<Echoed question="is requeue safe?" busy />);
    expect(asking).toContain('class="bubble asked"');
    expect(asking).toContain("is requeue safe?");
    expect(asking).toContain("asking…");
    const sent = renderToStaticMarkup(<Echoed question="is requeue safe?" busy={false} />);
    expect(sent).toContain("on the log");
    // Never a trace: nothing is being followed for a turn the fold does not hold.
    expect(sent).not.toContain("data-trace");
  });

  it("shows nothing before anything is asked", () => {
    expect(render([waiting])).not.toContain("data-echo");
  });
});
