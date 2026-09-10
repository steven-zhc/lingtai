import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskCard } from "@lingtai/projector/task-view";
import { LANE_CARDS, elapsed, money, readSnapshot, stamp, takeBoard } from "@/lib/snapshot";

/**
 * The board on the front page is the one thing on this site that is not read
 * from a file in the repository, so it is the one thing that could be made up.
 * These tests are about that: what the page may say when there is no snapshot,
 * that no figure is written down anywhere but the snapshot, and that the
 * snapshot's own reductions — which cards are named, which are drawn — never
 * make the board look better than it is.
 */

const OPEN = "steven-zhc/lingtai";
const SHUT = "someone/private";

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: "wi-1",
    project: OPEN,
    issue: "118",
    title: "the hero board, generated from the log at build time",
    kind: "feature",
    state: "landed",
    tier: "guarded",
    runId: null,
    turns: 7,
    costUsd: 1.5,
    gatesPassed: 0,
    gatesFailed: 0,
    gatesWaived: 0,
    gatesApproved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date("2026-09-09T00:00:00Z"),
    closedAt: null,
    attempts: 1,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    blocked: false,
    needs: null,
    diagnosis: null,
    repairPending: false,
    repairCostUsd: null,
    ...over,
  };
}

const AT = new Date("2026-09-09T12:00:00Z");

function take(tasks: TaskCard[], open: string[] = [OPEN]) {
  return takeBoard(tasks, { open: new Set(open), capturedAt: AT, commit: "de2bb44" });
}

describe("a build with no log", () => {
  it("has no snapshot rather than a plausible one", async () => {
    // The repository commits no `snapshot.json` — it is generated, and
    // `.gitignore` keeps it out — so this is what a fresh clone builds with.
    // `null` is the only honest answer and the page renders `NoSnapshot`.
    if (process.env.LINGTAI_SITE_HAS_SNAPSHOT === "1") return;
    expect(await readSnapshot()).toBeNull();
  });
});

describe("figures live in the snapshot and nowhere else", () => {
  it("has no money and no lane count written into the front page", async () => {
    const page = await readFile(path.resolve(process.cwd(), "src/app/page.tsx"), "utf8");
    // A dollar amount in the markup is a figure that no log produced, and it
    // would keep reading as true long after it stopped being. The board's
    // numbers arrive as data or not at all.
    //
    // The two tickets under "when it goes wrong" are the one exception and are
    // not one of these: they are amounts in `lib/tickets.ts`, rendered through
    // `money()`, and `test/tickets.test.ts` checks each against the document in
    // `doc/` that records it. History does not go stale; a lane count does.
    const inText = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(inText).not.toMatch(/\$\d/);
  });
});

describe("the four lanes", () => {
  it("puts every state on one of them, with gates under running", () => {
    // Five states, four lanes. That every state is covered is the type's job —
    // `LANE_OF` is a `Record<TaskState, Lane>` — so what is checked here is the
    // part a type cannot: that `gates` and `running` are one lane, which is the
    // fold #59 was missing when a task in `gates` appeared on no column at all.
    const board = take([
      task({ state: "queued" }),
      task({ state: "running" }),
      task({ state: "gates" }),
      task({ state: "waiting" }),
      task({ state: "landed" }),
    ]);
    expect(board.lanes.map((l) => [l.id, l.count])).toEqual([
      ["queued", 1],
      ["running", 2],
      ["waiting", 1],
      ["landed", 1],
    ]);
  });

  it("renders all four even when three of them are empty", () => {
    // A board showing only the lanes with something in it is a board that
    // hides "Waiting on you" on exactly the days it matters.
    const board = take([task({ state: "waiting", blocked: true })]);
    expect(board.lanes.map((l) => l.id)).toEqual(["queued", "running", "waiting", "landed"]);
  });
});

describe("a lane publishes a handful and counts all of it", () => {
  const many = (n: number, over: Partial<TaskCard>) =>
    Array.from({ length: n }, (_, i) =>
      task({
        ...over,
        issue: String(i),
        updatedAt: new Date(Date.UTC(2026, 8, 9, i)),
      }),
    );

  it("draws at most a handful", () => {
    const board = take(many(12, { state: "landed" }));
    const landed = board.lanes.find((l) => l.id === "landed");
    expect(landed?.cards).toHaveLength(LANE_CARDS);
  });

  it("counts the lane and not the handful", () => {
    // The header prints this. A lane reporting the size of its own excerpt
    // would say five where there are twelve, and every figure on this page
    // would then be a figure about the page.
    const board = take(many(12, { state: "landed" }));
    expect(board.lanes.find((l) => l.id === "landed")?.count).toBe(12);
  });

  it("totals the whole board and not what it drew", () => {
    const board = take(many(12, { state: "landed" }));
    expect(board.totals.cards).toBe(12);
    expect(board.totals.turns).toBe(12 * 7);
    expect(board.totals.costUsd).toBe(18);
  });

  it("shows the longest wait first in the lane that is stuck", () => {
    // "Waiting on you" is the lane the board exists for, and the oldest wait is
    // what to do next — so the excerpt keeps the oldest, which is also the card
    // least flattering to the system that left it there.
    const board = take(many(8, { state: "waiting" }));
    const waiting = board.lanes.find((l) => l.id === "waiting");
    expect(waiting?.cards.map((c) => c.ref)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("shows the most recent movement everywhere else", () => {
    const board = take(many(8, { state: "running" }));
    const running = board.lanes.find((l) => l.id === "running");
    expect(running?.cards.map((c) => c.ref)).toEqual(["7", "6", "5", "4", "3"]);
  });

  it("does not prefer a public card over a withheld one", () => {
    // Ordering by anything but the log would make the excerpt an argument.
    // Newest first here means the private card is drawn and the public one is
    // counted, which is the honest answer and the less pretty one.
    const board = take([
      task({ project: OPEN, issue: "1", updatedAt: new Date("2026-09-01T00:00:00Z") }),
      ...many(LANE_CARDS, { project: SHUT }),
    ]);
    const landed = board.lanes.find((l) => l.id === "landed");
    expect(landed?.count).toBe(LANE_CARDS + 1);
    expect(landed?.cards.every((c) => c.project === null)).toBe(true);
  });
});

describe("only an allowed project is named", () => {
  it("withholds everything that names a repository not on the list", () => {
    const board = take([task({ project: SHUT, note: "merged as abc1234" })]);
    const card = board.lanes.find((l) => l.id === "landed")?.cards[0];
    expect(card).toMatchObject({ project: null, ref: null, title: null, note: null });
    // What it keeps: the lane, the money, the turns, the kind. None of it names
    // anything, and dropping the card would change the totals the page argues
    // with.
    expect(card).toMatchObject({ lane: "landed", kind: "feature", costUsd: 1.5, turns: 7 });
    expect(board.withheld).toBe(1);
  });

  it("withholds by default, so a project nobody has considered is invisible", () => {
    // An allowlist and not a denylist: with no project named, a board of real
    // work publishes no titles at all. The failure mode of forgetting is a dull
    // board rather than a private repository's issues on the internet.
    const board = take([task(), task({ project: SHUT })], []);
    expect(board.withheld).toBe(2);
    expect(board.lanes.flatMap((l) => l.cards).every((c) => c.title === null)).toBe(true);
  });

  it("gives a published card what its issue link is built from", () => {
    // The card renders `https://github.com/${project}/issues/${ref}` — in its
    // own repository, which is not necessarily this one — so any figure on the
    // page can be checked against the issue it came from.
    const card = take([task()]).lanes.find((l) => l.id === "landed")?.cards[0];
    expect(card?.project).toBe(OPEN);
    expect(card?.ref).toBe("118");
  });
});

describe("how a figure reads", () => {
  it("says an age the way a person would", () => {
    expect(elapsed(0.4)).toBe("under an hour");
    expect(elapsed(20)).toBe("20 hours");
    expect(elapsed(72)).toBe("3 days");
    expect(elapsed(null)).toBeNull();
  });

  it("keeps the cents, because at these amounts the cents are the point", () => {
    expect(money(13.04)).toBe("$13.04");
    expect(money(1.9)).toBe("$1.90");
    expect(money(null)).toBeNull();
  });

  it("stamps a date in UTC, which is the only zone a static page can claim", () => {
    expect(stamp("2026-09-09T21:00:00.000Z")).toBe("2026-09-09");
  });

  it("ages a card at capture and not at render", () => {
    // Twelve hours before the capture, and it reads twelve hours however long
    // the page is then served for.
    const card = take([task({ updatedAt: new Date("2026-09-09T00:00:00Z") })]).lanes.find(
      (l) => l.id === "landed",
    )?.cards[0];
    expect(card?.hoursSinceUpdate).toBe(12);
  });

  it("carries the date it was taken", () => {
    expect(take([task()]).capturedAt).toBe(AT.toISOString());
  });
});
