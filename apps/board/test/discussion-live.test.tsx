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
 * Rendered statically, so no effect runs and no `EventSource` is opened: what
 * is asserted here is the shape a reader is handed, which is the half `#101`
 * says a fold test could never have caught.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscussionView } from "../src/lib/task.ts";
import { Discussion } from "../src/app/discussion.tsx";

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

  it("says it is waiting, and has somewhere for the answer to arrive", () => {
    const html = render([waiting]);
    // Before the first line of the trace arrives there is nothing to show, and
    // this says so rather than showing an empty frame (0016 §4).
    expect(html).toContain("waiting for the daemon to answer");
    expect(html).not.toContain('class="chattrace"');
  });
});
