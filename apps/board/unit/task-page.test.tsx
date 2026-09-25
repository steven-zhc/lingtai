/**
 * The task page, arranged: the answer on the first screen, the rest a record.
 *
 * **Judged by four questions** (#152) — *what* state and how long, *why* in the
 * words of whatever stopped it, *so what* in one sentence, *now what* as the
 * moves — and the page failed it while being complete: the answer was in there,
 * and the reader composed it out of four tickets' sentences.
 *
 * The two snapshots are the arrangement and not the markup: each rank, in the
 * order it is on the page, with the words it holds. **A later ticket that adds
 * a sentence has to say which rank it goes in**, because the snapshot will name
 * it — and a sentence that lands in rank 3 will not fit in one.
 *
 * What is not asserted, said rather than left to be discovered: the pixels.
 * *No scrolling at 1280×800* is a fact about the stylesheet this suite has no
 * browser to measure. What is asserted is the half the markup decides — the
 * moves come before anything that can grow.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import type { StepPlan } from "@lingtai/conductor/filter";
import {
  foldRun,
  standingOf,
  totalsOf,
  type Claim,
  type DiscussionView,
  type RunView,
  type TaskDetail,
  type TicketView,
} from "../src/lib/task.ts";
import type { OutgoingView } from "../src/lib/prompt.ts";
import { RECORD_ROWS, TaskBody } from "../src/app/task/[id]/page.tsx";

const NOW = new Date("2026-09-14T09:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

let seq = 0n;
function e(streamId: string, type: string, data: unknown, at = "2026-09-14T04:27:00Z"): Envelope {
  seq += 1n;
  return { seq, streamId, version: 1, type, schemaVer: 1, data, actor: "conductor", causation: null, at: new Date(at) };
}

const ITEM = "wi-lingtai-147";
const RUN = "run-52feebd1-0000-0000-0000-000000000000";
const BASE = "b".repeat(40);
const HEAD = "a4e9df9".padEnd(40, "0");
const claim: Claim = { runId: RUN, at: "2026-09-14T04:00:00.000Z", repair: false, released: null };

const TICKET: TicketView = {
  project: "lingtai",
  ref: "147",
  title: "the reviewer crashes on a reused session id",
  kind: "bug",
  labels: ["bug"],
  url: "https://github.com/example/lingtai/issues/147",
  body: "The reviewer crashed.",
  found: true,
  problem: null,
};

const CRASH = "the reviewer did not finish (crash): Error: Session ID 1d391e10 is already in use.";

const task = (own: Envelope[], runs: RunView[], rest: Partial<TaskDetail> = {}): TaskDetail => ({
  taskId: ITEM,
  standing: standingOf(own, runs),
  ticket: TICKET,
  runs,
  discussions: [],
  outgoing: null,
  queued: null,
  totals: totalsOf(runs),
  history: [],
  ...rest,
});

/** `wi-lingtai-147` on 2026-09-14, as the ticket quotes it. */
function blocked(): TaskDetail {
  const run = foldRun(claim, 1, [
    e(RUN, "RunStarted", { baseSha: BASE }),
    e(RUN, "RunProposedCompletion", { headSha: HEAD }),
    e(RUN, "GateFailed", { gate: "proposed", action: "review", onSha: HEAD, evidence: CRASH }),
    e(RUN, "RunFinished", { turns: 30, durationMs: 900_000, costUsd: 2.5, exitCode: 0 }),
  ]);
  const own = [
    e(ITEM, "WorkItemClaimed", { runId: RUN }, "2026-09-14T04:00:00Z"),
    e(ITEM, "WorkItemBlocked", {
      question: "review still refuses agent/147",
      needsFrom: "human",
      runId: RUN,
      needs: "judgement",
      diagnosis: {
        what: "`review` still refuses agent/147 at a4e9df9. This is a check that failed and stayed failed, not a judgement.",
        done:
          "2 round(s) of fix-and-recheck ran, and the action refused what they produced.\n\nNo further agent was bought: the fixing agent declined.",
        raw: CRASH,
        recommendation: {
          action: "requeue",
          why: "`review` is a check that stayed red rather than a judgement, and for one of those the work is still there. Starting over would throw away a branch whose remedy is mechanical (0039 §2).",
        },
      },
    }, "2026-09-14T04:27:00Z"),
  ];
  const outgoing: OutgoingView = {
    text: "#147 — the reviewer crashes on a reused session id\n\nThe reviewer crashed.\n",
    version: "ticket@1924",
    basedOn: "ticket@1924",
    attempt: 2,
    edit: null,
    delta: { added: 0, removed: 0 },
    problem: null,
  };
  const discussion: DiscussionView = {
    chatId: "chat-1",
    attempt: 1,
    waiting: true,
    costUsd: 0.12,
    held: null,
    turns: [
      {
        question: "did the reviewer run at all?",
        by: "human:steven",
        at: "2026-09-14T05:00:00.000Z",
        reading: [],
        answer: { text: "No — it crashed on start.", failure: null, cannot: [], read: [], costUsd: 0.12, proposal: null },
      },
      { question: "so is requeue safe?", by: "human:steven", at: "2026-09-14T05:01:00.000Z", reading: [], answer: null },
    ],
  };
  return task(own, [run], { outgoing, discussions: [discussion] });
}

function running(): TaskDetail {
  const run = foldRun(claim, 1, [e(RUN, "RunStarted", { baseSha: BASE })]);
  return task([e(ITEM, "WorkItemClaimed", { runId: RUN }, "2026-09-14T08:40:00Z")], [run]);
}

const page = (t: TaskDetail) => renderToStaticMarkup(<TaskBody task={t} />);

/**
 * Each rank, in page order, with the words in it. The record is its row names
 * only: the record is consulted, and what is in it is not the arrangement.
 */
function arrangement(html: string): string {
  const marks = [...html.matchAll(/data-rank="([a-z-]+)"/g)];
  return marks
    .map((mark, i) => {
      const next = marks[i + 1]?.index;
      // Up to the opening of the next rank's own element, not into it.
      const chunk = html.slice(mark.index, next === undefined ? html.length : html.lastIndexOf("<", next));
      if (mark[1] === "record") {
        return `record: ${[...chunk.matchAll(/class="rname">([^<]+)</g)].map((m) => m[1]).join(" · ")}`;
      }
      const text = chunk
        .slice(chunk.indexOf(">") + 1)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `${mark[1]}: ${text}`;
    })
    .join("\n");
}

/** Every class this palette paints brass. See `globals.css`'s `--signal`. */
const BRASS = /btn pri|standing onyou|class="rec"|pill sig|class="question"|class="note"|class="chat"[^>]*>[\s\S]*chatcannot/;

describe("a blocked task", () => {
  it("is arranged as the four questions, then the record", () => {
    expect(arrangement(page(blocked()))).toMatchSnapshot();
  });

  it("puts the ranks in order: coordinates, state, why, so what, moves, pair, record", () => {
    const html = page(blocked());
    const at = (rank: string) => html.indexOf(`data-rank="${rank}"`);
    const order = ["coords", "state", "why", "so-what", "moves", "pair", "record"].map(at);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("quotes the refusal at rank 2 and says what it means in one sentence at rank 3", () => {
    const html = page(blocked());
    const why = html.slice(html.indexOf('data-rank="why"'), html.indexOf('data-rank="so-what"'));
    expect(why).toContain("Session ID 1d391e10 is already in use");
    expect(why).toContain('<details class="sreason" open=""');
    // The round count and the decline are record now, not a paragraph under the quote.
    const first = html.slice(0, html.indexOf('data-rank="record"'));
    expect(first).not.toContain("fix-and-recheck");
    expect(html.slice(html.indexOf('data-rank="record"'))).toContain("fix-and-recheck");
  });

  it("prints each identifier once", () => {
    const read = page(blocked()).replace(/<[^>]*>/g, " ");
    const count = (needle: string) => read.split(needle).length - 1;
    expect(count(ITEM)).toBe(1);
    // Short or as the whole uuid, the run is printed once: the attempt row's.
    expect(count("run-52feebd1")).toBe(1);
  });
});

describe("a running task", () => {
  it("is arranged with the live log where a refusal would be", () => {
    expect(arrangement(page(running()))).toMatchSnapshot();
  });

  it("follows the run's log at rank 2, open, in the slot and the teal", () => {
    const html = page(running());
    const why = html.slice(html.indexOf('data-rank="why"'), html.indexOf('data-rank="so-what"'));
    expect(why).toContain('<details class="alog slog" open=""');
    expect(html).toContain('class="standing live"');
    // One follower for one file: the attempt row points up instead.
    expect(html.split('<details class="alog').length - 1).toBe(1);
    expect(html).toContain("being followed at the top of this page");
  });

  it("wears no brass anywhere, because nobody is waiting on you", () => {
    // An answered turn with everything in it the box paints amber on a blocked
    // page: `cannot` lines, and a proposal whose primary button is brass.
    const talk: DiscussionView = {
      chatId: "chat-2",
      attempt: 1,
      waiting: false,
      costUsd: 0.2,
      held: null,
      turns: [
        {
          question: "what would you change?",
          by: "human:steven",
          at: "2026-09-14T08:50:00.000Z",
          reading: [],
          answer: {
            text: "The session id.",
            failure: null,
            cannot: ["run the reviewer"],
            read: [],
            costUsd: 0.2,
            proposal: { kind: "prompt", text: "use a fresh session id" },
          },
        },
      ],
    };
    const quiet = page({ ...running(), discussions: [talk] });
    // Not vacuous: the turn rendered, with its cannot line and its buttons.
    expect(quiet).toContain('class="chatcannot"');
    expect(quiet).toContain("Use for the next run");
    expect(quiet).toContain('class="chat quiet"');
    expect(quiet).not.toMatch(BRASS);
    // The cannot rule's amber is the stylesheet's, so the override is read there.
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chat\.quiet \.chatcannot\s*\{[^}]*border-left-color:\s*var\(--rule-2\)/);

    // And the same turn on the blocked page is brass, which is what makes the
    // assertions above mean something.
    const loud = page({ ...blocked(), discussions: [talk] });
    expect(loud).toMatch(BRASS);
    expect(loud.replace(/btn pri/g, "")).toMatch(/class="chat"[^>]*>[\s\S]*chatcannot/);
  });
});

/**
 * The rail, on the page about the one run (#189).
 *
 * The card said which point a run was at, how long it had been there and what
 * bounded it; the page listed the five points off a fold with no `running` and
 * no `never-ran`, inside a closed row, and lit nothing. These assert the reading
 * is here, from the same `Rail`, and that the record's segments can say the one
 * state the old list could not.
 */
describe("the rail on the task page", () => {
  const PLAN: StepPlan = new Map([
    ["proposed", [{ name: "build", budgetMs: 20 * 60_000 }, { name: "review", budgetMs: null }]],
  ]) as unknown as StepPlan;

  const resolved = e(RUN, "GatesResolved", {
    points: [
      { gate: "prepared", actions: ["install"] },
      { gate: "admit", actions: [] },
      { gate: "proposed", actions: ["build", "review"] },
      { gate: "merge", actions: [] },
      { gate: "end", actions: [] },
    ],
  }, "2026-09-14T08:40:00Z");

  function building(plan?: StepPlan): TaskDetail {
    const run = foldRun(
      claim,
      1,
      [
        e(RUN, "RunStarted", { baseSha: BASE }, "2026-09-14T08:40:00Z"),
        resolved,
        e(RUN, "GatePassed", { gate: "prepared", action: "install" }, "2026-09-14T08:41:00Z"),
        e(RUN, "RunFinished", { turns: 9, durationMs: 600_000, costUsd: 1, exitCode: 0 }, "2026-09-14T08:50:00Z"),
        e(RUN, "GateStarted", { gate: "proposed", action: "build" }, "2026-09-14T08:57:26Z"),
      ],
      { plan },
    );
    return task([e(ITEM, "WorkItemClaimed", { runId: RUN }, "2026-09-14T08:40:00Z")], [run]);
  }

  const why = (html: string) =>
    html.slice(html.indexOf('data-rank="why"'), html.indexOf('data-rank="so-what"'));
  const record = (html: string) => html.slice(html.indexOf('data-rank="record"'));

  it("says which point, the action, the elapsed and the bound at rank 2, with nothing expanded", () => {
    const html = page(building(PLAN));
    const rank = why(html);
    // The rail is the card's own: the same classes, drawn by the same `Rail`.
    expect(rank).toContain('class="seq"');
    expect(rank).toMatch(/class="slab l-at">proposed</);
    expect(rank).toMatch(/class="snow"[^>]*>build 2m34s \/ 20m</);
    // At rank 2 and not inside a disclosure: nothing before it on the page is
    // a closed `<details>` it could be hiding in.
    const before = html.slice(0, html.indexOf('class="seq"'));
    expect(before).not.toMatch(/<details(?![^>]*open)/);
  });

  it("draws no denominator where nothing bounds the phase, and never a zero", () => {
    const rank = why(page(building()));
    expect(rank).toMatch(/class="snow"[^>]*>build 2m34s</);
    expect(rank).not.toContain(" / ");
  });

  it("draws proposed's build and review as two cells, half done", () => {
    const rank = why(page(building(PLAN)));
    const proposed = rank.match(/<li class="seg s-running"[^>]*><span class="sbar">((?:<span class="scell[^"]*"><\/span>)+)<\/span>/);
    expect(proposed?.[1]).toBe('<span class="scell t-run"></span><span class="scell t-pending"></span>');
  });

  it("is the board's own Rail, imported by both routes and defined in neither", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    for (const route of ["../src/app/page.tsx", "../src/app/task/[id]/page.tsx", "../src/app/standing.tsx"]) {
      expect(read(route)).not.toMatch(/function (Rail|Segs)\b/);
    }
    expect(read("../src/app/page.tsx")).toContain('from "./rail.tsx"');
    expect(read("../src/app/task/[id]/page.tsx")).toContain('from "../../rail.tsx"');
    expect(read("../src/app/rail.tsx")).toMatch(/export function Rail\b/);
  });

  it("is not drawn at rank 2 when the item is not running", () => {
    expect(why(page(blocked()))).not.toContain('class="seq"');
  });

  it("draws a configured point that never ran as never-ran on a landed item, apart from pending", () => {
    const events = [
      e(RUN, "RunStarted", { baseSha: BASE }),
      resolved,
      e(RUN, "GatePassed", { gate: "prepared", action: "install" }),
      e(RUN, "RunFinished", { turns: 12, durationMs: 600_000, costUsd: 1.5, exitCode: 0 }),
    ];
    const own = [
      e(ITEM, "WorkItemClaimed", { runId: RUN }, "2026-09-14T04:00:00Z"),
      e(ITEM, "WorkItemLanded", { mergeCommit: HEAD, base: "main" }, "2026-09-14T04:30:00Z"),
    ];
    // `over` is what `loadTask` passes for the attempt that landed.
    const landed = task(own, [foldRun(claim, 1, events, { over: true })]);
    expect(landed.standing.state).toBe("landed");
    const html = record(page(landed));
    expect(html).toContain('class="seg s-never-ran"');
    expect(html).toMatch(/<li class="seg s-never-ran"[^>]*title="proposed: build, review — configured and did not run/);
    expect(html).not.toMatch(/\d+ pending/);

    // And the same stream on an item that did not land is only not reached yet:
    // `over` is the whole of the difference.
    const midway = record(page(task(own.slice(0, 1), [foldRun(claim, 1, events)])));
    expect(midway).not.toContain("s-never-ran");
    expect(midway).toContain('class="seg s-pending"');
  });
});

describe("the record", () => {
  /** Always the same four, in the same order, whatever the state (#152). */
  it("is four collapsed rows in a fixed order, the same four in every state", () => {
    const run = foldRun(claim, 1, [
      e(RUN, "RunStarted", { baseSha: BASE }),
      e(RUN, "RunProposedCompletion", { headSha: HEAD }),
      e(RUN, "GatePassed", { gate: "proposed", action: "review", onSha: HEAD }),
      e(RUN, "RunFinished", { turns: 12, durationMs: 600_000, costUsd: 1.5, exitCode: 0 }),
    ]);
    const landed = task(
      [
        e(ITEM, "WorkItemClaimed", { runId: RUN }, "2026-09-14T04:00:00Z"),
        e(ITEM, "WorkItemLanded", { mergeCommit: HEAD, base: "main" }, "2026-09-14T04:30:00Z"),
      ],
      [run],
    );
    const queuedTask = task([], [], {
      queued: {
        position: 2,
        inLine: 5,
        notOffered: null,
        runnableAt: null,
        paused: false,
        dependenciesUnread: null,
        plan: null,
        problem: null,
      },
    });
    // Not vacuous: each is the state its name says.
    expect(landed.standing.state).toBe("landed");
    expect(queuedTask.standing.state).toBe("queued");
    expect(page(queuedTask)).toContain("offered by GitHub");
    for (const t of [blocked(), running(), landed, queuedTask]) {
      const html = page(t);
      const rows = [...html.matchAll(/<details class="rrow" id="record-([a-z]+)"( open="")?/g)];
      expect(rows.map((r) => r[1])).toEqual([...RECORD_ROWS]);
      expect(rows.every((r) => r[2] === undefined)).toBe(true);
    }
    // `ticket`, and it was `prompt`: the row opens with the ticket and only
    // then the document each attempt was handed, so it was labelled by the
    // second thing in it — and the one place holding *what was asked*
    // announced itself as the agent's input.
    expect([...RECORD_ROWS]).toEqual(["findings", "files", "attempts", "ticket"]);
  });
});
