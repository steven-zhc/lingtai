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
import type { TaskDetail } from "../src/lib/task.ts";

const stub = { taskId: "wi-lingtai-172" } as TaskDetail;

vi.mock("../src/lib/task.ts", async (original) => ({
  ...(await original<typeof import("../src/lib/task.ts")>()),
  loadTask: vi.fn(async () => stub),
}));

const { default: TaskPage, TaskBody } = await import("../src/app/task/[id]/page.tsx");
const { Follow, Live } = await import("../src/app/live.tsx");

describe("the task route", () => {
  it("mounts the subscription beside the page it re-renders", async () => {
    const page = (await TaskPage({ params: Promise.resolve({ id: "wi-lingtai-172" }) })) as ReactElement<{
      children: ReactNode;
    }>;
    const mounted = Children.toArray(page.props.children).filter(isValidElement);

    expect(mounted.map((el) => el.type)).toContain(Follow);
    // The page it keeps current is the fold this request read.
    const body = mounted.find((el) => el.type === TaskBody) as ReactElement<{ task: TaskDetail }>;
    expect(body.props.task).toBe(stub);
    // The subscription without the dot: the dot is the board's (#64), and the
    // task page has no bar for it.
    expect(mounted.map((el) => el.type)).not.toContain(Live);
  });
});
