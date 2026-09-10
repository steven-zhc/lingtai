/**
 * What the bar carries, and what it stopped carrying.
 *
 * At 1440 it rendered eleven objects, nine of them boxed, and wrapped to a
 * second line. Every one of them had been argued for on its own — #81, #84,
 * #86, `0025 §2`, #64, #98 — and none of those arguments was about the row
 * ([the-bar.md](../../../doc/design/the-bar.md)).
 *
 * Two things are asserted here rather than in the page, because both are folds
 * and neither is a matter of taste. **The health dot is one indicator over two
 * independent facts**, and the thing a later edit can silently get wrong is the
 * order they are weighed in and whether the one that loses is still reachable.
 * **The spend that left the bar is a ledger now**, and a ledger that does not
 * add up is worse than the chip it replaced.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskCard } from "@lingtai/projector/task-view";
import { bearing, type CodeNews } from "../src/lib/bearing.ts";
import type { Health } from "../src/lib/health.ts";
import { spend, spendByProject, toCard, toColumns } from "../src/lib/board.ts";

const board = (over: Partial<Health> = {}): Health => ({
  lag: 0,
  daemon: "up",
  sinceBeatMs: 2_000,
  ...over,
});

/** A daemon holding code the repository has moved past — `#98`'s thirty-nine minutes. */
const behind: CodeNews = {
  wrong: "daemon 4 behind",
  action: "restart it to take them",
  said: "running d4fbd1a — 4 commit(s) behind origin/main, which has not taken effect in this process: 0c1a2b3 fix(end)",
};

/** Level with the base: something to say only on hover. */
const level: CodeNews = {
  wrong: null,
  action: null,
  said: "running d4fbd1a — level with origin/main",
};

/**
 * Every branch of the fold, once — the list the two properties below are
 * quantified over.
 *
 * Written out rather than generated, so adding a branch to `bearing()` without
 * adding it here is a visible omission in a diff. The two at the top are the
 * ones a fold loses first, because they are about the stream and the fold is
 * about the board: nothing in them mentions the daemon, and that is exactly why
 * they stopped carrying what it is running.
 */
const EVERY_STATE: [Parameters<typeof bearing>[0], Health | null][] = [
  ["trouble", board()],
  ["connecting", null],
  ["open", null],
  ["open", board({ error: "no such relation" })],
  ["open", board({ lag: null })],
  ["open", board({ lag: 3, daemon: "never", sinceBeatMs: null })],
  ["open", board({ lag: 7 })],
  ["open", board()],
];

describe("the health dot", () => {
  /**
   * The quiet version, which is the state the bar is in nearly all the time:
   * one dot, and no sentence at all. A box that is present and quiet in the
   * ordinary case is one nobody reads when it is not.
   */
  it("is green and silent when the board is current and the daemon is level", () => {
    const said = bearing("open", board(), level);

    expect(said.tone).toBe("pass");
    expect(said.why).toBeNull();
  });

  /**
   * `#64` and `#98` were two chips and are one dot. Folding them must not make
   * either unreachable, so whichever is not the headline is in the title —
   * which is the property that is easy to drop and impossible to see.
   */
  it("keeps the fact that is not the headline in the title", () => {
    expect(bearing("open", board(), level).title).toContain("level with origin/main");
    expect(bearing("open", board({ lag: 0 }), behind).title).toContain("task_view is at the head");
  });

  /**
   * Stale code is a fault: `current` and `not paused` were both true for
   * thirty-nine minutes in which the fix that had landed could not run.
   */
  it("carries the sentence and the action when the daemon holds old code", () => {
    const said = bearing("open", board(), behind);

    expect(said.tone).toBe("warn");
    expect(said.why).toContain("daemon 4 behind");
    expect(said.why).toContain("restart it");
  });

  /**
   * Worst first. A projection nobody is folding is the board lying about the
   * very thing the newer code would be doing, so it beats stale code — and it
   * still says how to fix it.
   */
  it("puts a projection nobody is advancing ahead of stale code, with both reachable", () => {
    const said = bearing("open", board({ lag: 12, daemon: "stale", sinceBeatMs: 400_000 }), behind);

    expect(said.tone).toBe("warn");
    expect(said.label).toContain("no daemon");
    expect(said.why).toContain("lingtai daemon --no-conduct");
    expect(said.title).toContain("4 commit(s) behind");
  });

  /**
   * Since 0022 a `lingtai run` holds a projector of its own, so lag with a
   * beating daemon is ordinary. It says so rather than raising an alarm.
   */
  it("does not call catching up a fault", () => {
    const said = bearing("open", board({ lag: 7 }), level);

    expect(said.tone).toBe("idle");
    expect(said.why).toBe("catching up");
  });

  /**
   * The stream is the reason the numbers under it are stale, so it is the
   * headline when it is down — nothing below it can be trusted. This is the
   * inversion of the morning `#64` is about: socket open, chip green, board
   * frozen.
   */
  it("lets a dead stream beat everything under it", () => {
    expect(bearing("trouble", board(), level).tone).toBe("warn");
    expect(bearing("trouble", board(), level).why).toContain("event stream is down");
  });

  /** Not yet an answer is not a green one. */
  it("says nothing green before the first health frame arrives", () => {
    expect(bearing("connecting", null, null).tone).toBe("idle");
    expect(bearing("open", null, null).tone).toBe("idle");
  });

  /**
   * Every state, including the two that are not about the board at all. A dead
   * stream and a board that has not answered yet are exactly when somebody
   * wants to know what the daemon is running, and they are the two the old
   * separate `Stale` chip still rendered in — a chip does not know what its
   * neighbour is doing, and a fold does.
   *
   * This is the property the fold can lose in silence: the title is on hover,
   * so nothing on screen changes when a branch stops carrying it.
   */
  it("keeps the daemon's code reachable in every state, not only the ones about it", () => {
    for (const [socket, health] of EVERY_STATE) {
      // Level and behind both, because `code.wrong` opens a branch of its own
      // and a branch is where the fact goes missing.
      expect(bearing(socket, health, level).title).toContain("running d4fbd1a");
      expect(bearing(socket, health, behind).title).toContain("4 commit(s) behind");
    }
  });

  /**
   * The dot has no branch that says nothing: a health indicator whose title is
   * empty is one that has quietly stopped being a health indicator.
   */
  it("always has something to say on hover", () => {
    for (const [socket, health] of EVERY_STATE) {
      expect(bearing(socket, health, level).title.length).toBeGreaterThan(0);
      expect(bearing(socket, health, null).title.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Amber, and the one thing allowed to wear it.
 *
 * Asserted against the stylesheet rather than against `bearing()`, because
 * `bearing()` cannot break this and never could: its `Tone` union has three
 * members and a test that checks the returned value is one of them is a test of
 * the type checker. **What can break it is a rule** — `.chip.sig` was one, it
 * held `$81.83 repair`, and the file stated the rule 23 lines above it.
 *
 * So the question this asks is the one #134 asked: how many things on the bar
 * are amber? The answer has to be one, and it has to be the headline.
 */
describe("the bar's amber", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8")
    // Comments first: this file argues in prose, and `var(--signal)` inside a
    // comment is a sentence about the rule and not a second wearer of it.
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * Every selector that paints with `--signal`, paired with the block that
   * does. `@media` nests, so the selector is the text between the last two
   * braces rather than the first thing in the piece.
   */
  const wearers = css
    .split("}")
    .map((piece) => piece.split("{"))
    .filter((parts) => parts.length > 1 && parts[parts.length - 1]!.includes("var(--signal"))
    .map((parts) => parts[parts.length - 2]!.trim().replace(/\s+/g, " "));

  /**
   * `#81` put a total on the bar, `#84` put a repair's share beside it, and the
   * second one arrived wearing the lane's colour. Two ambers is no amber: the
   * whole value of the rule is that one thing has it.
   *
   * `.chip` counts as the bar's even unscoped, because after #134 the bar is
   * the only place that wears one — `paused.tsx` and `draining.tsx`, and
   * nothing else. A `.chip.money` written without a `.bar ` in front of it is
   * still amber on the bar, and that is exactly the shape the deleted rule had.
   */
  it("is worn by exactly one thing on the bar, and it is the headline", () => {
    const onTheBar = wearers.filter((sel) => sel.includes(".bar") || sel.includes(".chip"));

    expect(onTheBar).toEqual([".bar .head.sig"]);
  });

  /**
   * The chip variant the money wore. Deleted rather than left unused, because a
   * style with no wearer is the style the next chip is quietly added under —
   * which is how eleven objects got onto a row nobody argued about.
   */
  it("is not still available as a chip for the next one to reach for", () => {
    expect(css).not.toMatch(/\.chip\.sig\b/);
  });

  /**
   * The dot is pass/fail, which have been separate from the accent since the
   * palette was written. Stated here as the class the dot actually wears, so it
   * is the rendered thing being checked and not the union's spelling.
   */
  it("is not what the health dot paints with, in any state", () => {
    const amber = wearers.map((sel) => sel.replace(/\s+/g, ""));
    for (const [socket, health] of EVERY_STATE) {
      expect(amber).not.toContain(`.bar.dot.${bearing(socket, health, level).tone}`);
    }
  });
});

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: `wi-${over.project ?? "lingtai"}-${over.issue ?? "1"}`,
    project: "lingtai",
    issue: "1",
    title: "a task",
    kind: "bug",
    state: "landed",
    tier: "guarded",
    runId: null,
    turns: null,
    costUsd: null,
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
    updatedAt: new Date("2026-09-10T04:27:22Z"),
    closedAt: null,
    attempts: 0,
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

describe("the spend the bar handed to a page", () => {
  /**
   * `$488.52` was one figure over two repositories, because a figure per
   * repository is a chip per repository. The page has room for the split, and
   * the split is the first thing anybody asks for after the total.
   */
  it("splits the same money by repository", () => {
    const columns = toColumns([
      toCard(task({ project: "lingtai", issue: "1", costUsd: 2.5, repairCostUsd: 0.75 })),
      toCard(task({ project: "lingtai", issue: "2", costUsd: 1.5 })),
      toCard(task({ project: "nextloom-ai-admin", issue: "3", costUsd: 4.0 })),
    ]);

    expect(spendByProject(columns)).toEqual([
      { project: "lingtai", work: 4.0, repair: 0.75, cards: 2 },
      { project: "nextloom-ai-admin", work: 4.0, repair: 0, cards: 1 },
    ]);
  });

  /**
   * `#84`'s point has to survive the move: a repair is default-on and spends an
   * agent without being asked again, so its money is its own column and never
   * added into the work's.
   */
  it("keeps a repair's spend out of the work's, per repository", () => {
    const rows = spendByProject(
      toColumns([toCard(task({ project: "lingtai", costUsd: 1.0, repairCostUsd: 9.0 }))]),
    );

    expect(rows[0]?.work).toBeCloseTo(1.0, 5);
    expect(rows[0]?.repair).toBeCloseTo(9.0, 5);
  });

  /**
   * A card can outlive the project that made it, which is why the rows are
   * built from the cards and not from the register. The register is not a
   * parameter here, so the way to assert that is arithmetic: the rows and the
   * footer are the same money read two ways, and a row that is missing shows up
   * as a footer that is larger than its column.
   *
   * `retired` is the case that matters — a repository nothing registers any
   * more, whose cards are still on the board.
   */
  it("adds up: every card is in exactly one row, and the rows are the total", () => {
    const columns = toColumns([
      toCard(task({ project: "lingtai", issue: "1", costUsd: 2.5, repairCostUsd: 0.75 })),
      toCard(task({ project: "retired", issue: "2", costUsd: 3.25 })),
      // Never claimed, so it cost nothing — still a card, and still counted.
      toCard(task({ project: "retired", issue: "3", costUsd: null })),
    ]);
    const rows = spendByProject(columns);
    const footer = spend(columns);

    expect(rows.map((r) => r.project)).toEqual(["lingtai", "retired"]);
    expect(rows.reduce((n, r) => n + r.cards, 0)).toBe(footer.cards);
    expect(rows.reduce((n, r) => n + r.work, 0)).toBeCloseTo(footer.work, 5);
    expect(rows.reduce((n, r) => n + r.repair, 0)).toBeCloseTo(footer.repair, 5);
  });

  /** And no row for a repository that has nothing on this board. */
  it("has nothing to say about a board with nothing on it", () => {
    expect(spendByProject(toColumns([]))).toEqual([]);
  });
});
