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
import { Discussion, Trace } from "../src/app/discussion.tsx";

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
    // The turn renders the follower and not a sentence about it: this is the
    // first frame of `Trace`, before a connection has said anything.
    expect(html).toContain("waiting for the daemon to answer");
    // Nothing to show yet, and it says so rather than showing an empty frame
    // (0016 §4).
    expect(html).not.toContain('class="chattrace"');
  });
});

describe("what a reader is handed for each state of the trace", () => {
  const show = (lines: string[], state: Parameters<typeof Trace>[0]["state"]) =>
    renderToStaticMarkup(<Trace lines={lines} state={state} />);

  it("says it is waiting while the file has not been opened yet", () => {
    // `waiting` is a 404 the follower is still asking about — the board
    // appended the question a moment ago and the daemon has not opened the
    // file. *Not yet*, and it must not read as *not coming*.
    expect(show([], "waiting")).toContain("waiting for the daemon to answer");
    expect(show([], "waiting")).not.toContain("nothing is writing");
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

  it("says nothing is writing once the trace has ended with no answer", () => {
    // The turn is over — `answerDiscussion` deletes the file when it appends
    // the answer — so a `Thinking` still on screen is one whose
    // `DiscussionAnswered` never landed. *answering · 2 lines so far* under a
    // file nobody is writing is the sentence #132 is about, one layer down.
    const html = show(["12:00:01  Read    doc/architecture.html", "12:00:04  think"], "removed");
    expect(html).toContain("nothing is writing to this conversation");
    expect(html).not.toContain("answering ·");
    // What it did produce is still on screen: the account of a turn that died
    // is the only account there is.
    expect(html).toContain("doc/architecture.html");
  });

  it("says so too when the asking ran out and no file ever appeared", () => {
    const html = show([], "gone");
    expect(html).toContain("nothing is writing to this conversation");
    expect(html).not.toContain("waiting for the daemon to answer");
  });
});
