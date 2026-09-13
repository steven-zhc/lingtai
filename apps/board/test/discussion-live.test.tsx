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
import { Discussion, Trace, traceSays } from "../src/app/discussion.tsx";
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
