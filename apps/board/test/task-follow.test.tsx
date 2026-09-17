/**
 * The task route is subscribed to the log.
 *
 * **Not that the component exists — that this route has it** (#172). `Live` had
 * existed since #64 and was mounted in `health.tsx` alone, which only `/`
 * renders; `/task/<id>` — the one page with a discussion on it — never
 * re-rendered on an append, so a question, the trace's sentence and the answer
 * each waited for a reload. Every comment about that pane said *every append
 * re-renders the board*, and it was true of the board.
 *
 * The route is called with a stubbed fold rather than rendered: `Follow` needs
 * Next's app router to render at all, and what is being asserted is which
 * elements the route returns, not what they paint.
 */
import { describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail } from "../src/lib/task.ts";

const stub = { taskId: "wi-lingtai-172" } as TaskDetail;

vi.mock("../src/lib/task.ts", async (original) => ({
  ...(await original<typeof import("../src/lib/task.ts")>()),
  loadTask: vi.fn(async () => stub),
}));

const { default: TaskPage, TaskBody } = await import("../src/app/task/[id]/page.tsx");
const { Follow, Following, Live, warning } = await import("../src/app/live.tsx");

describe("the task route", () => {
  it("mounts the subscription around the page it re-renders", async () => {
    const page = (await TaskPage({ params: Promise.resolve({ id: "wi-lingtai-172" }) })) as ReactElement<{
      children: ReactNode;
    }>;
    const mounted = Children.toArray(page.props.children).filter(isValidElement);

    const follow = mounted.find((el) => el.type === Follow) as ReactElement<{ children: ReactNode }>;
    expect(follow).toBeDefined();
    // The page it keeps current is the fold this request read, and it is inside
    // the subscription, so what the stream says reaches the bar and the pane.
    const inside = Children.toArray(follow.props.children).filter(isValidElement);
    const body = inside.find((el) => el.type === TaskBody) as ReactElement<{ task: TaskDetail }>;
    expect(body.props.task).toBe(stub);
    // The subscription without the board's dot: the dot is the board's (#64).
    expect(mounted.map((el) => el.type)).not.toContain(Live);
  });
});

/**
 * **A follow that fails is said on the task page too** (#64, and #172's review).
 * `Follow` without this was a subscription that swallowed its own failure, and
 * the page kept promising an answer only a reload would show.
 */
describe("the task page's bar, when the stream is not following", () => {
  it("warns when the stream is down, and is silent when it is fine", () => {
    expect(warning("trouble", null)?.why).toBe("the event stream is down — reload once it is back");
    expect(warning("connecting", null)).toBeNull();
    expect(warning("open", null)).toBeNull();
  });

  it("is nothing outside a subscription", () => {
    expect(renderToStaticMarkup(<Following />)).toBe("");
  });
});
