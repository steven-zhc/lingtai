/**
 * Two things on the task page that must not happen under a reader (#152).
 *
 * **A pointer lands on something readable.** Every `#attempt-N` points into the
 * record's attempts row, which is closed on load, and not every browser opens a
 * closed ancestor on fragment navigation — none does when the hash is already
 * the one clicked. `openTo` opens the way there.
 *
 * **Rank 2's log does not unmount when its run ends.** The page re-renders on
 * every append, and the render that says the run stopped is the one that would
 * take the log away from the person reading its last lines. `heldRun` keeps it.
 *
 * There is no document in this suite, so each is asserted at the seam it has:
 * the walk over a structural `<details>`, and the choice of run as a function.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { openTo, type Disclosing } from "../src/app/latch.tsx";
import { FollowedLog, heldRun } from "../src/app/run-log.tsx";

/** A chain of elements, innermost first; `details` marks which are disclosures. */
function chain(...kinds: ("details" | "div")[]): { target: Disclosing; nodes: Disclosing[] } {
  const nodes: (Disclosing & { kind: string })[] = kinds.map((kind) => ({
    kind,
    open: kind === "details" ? false : undefined,
    parentElement: null,
  }));
  // `parentElement.closest` starts at the parent itself, as the DOM's does.
  nodes.forEach((node, i) => {
    const above = nodes.slice(i + 1);
    node.parentElement =
      above.length > 0 ? { closest: () => above.find((n) => n.kind === "details") ?? null } : null;
  });
  return { target: nodes[0]!, nodes };
}

describe("following a pointer into the record", () => {
  it("opens the closed row the attempt is in", () => {
    // attempt-2 <details> ← .ledger ← .rbody ← .rrow <details> ← .record
    const { target, nodes } = chain("details", "div", "div", "details", "div");
    expect(openTo(target)).toBe(1);
    expect(nodes[3]!.open).toBe(true);
    // The attempt itself is the target, and its summary is what is landed on.
    expect(nodes[0]!.open).toBe(false);
  });

  it("opens every closed disclosure on the way, and nothing already open is counted", () => {
    const { target, nodes } = chain("div", "details", "details", "div", "details");
    nodes[2]!.open = true;
    expect(openTo(target)).toBe(2);
    expect([nodes[1]!.open, nodes[2]!.open, nodes[4]!.open]).toEqual([true, true, true]);
    expect(openTo(target)).toBe(0);
  });
});

describe("rank 2's log, when its run ends", () => {
  const RUN = "run-52feebd1-0000-0000-0000-000000000000";
  const NEXT = "run-6a000000-0000-0000-0000-000000000000";

  it("keeps the run it was showing when nothing is running any more", () => {
    expect(heldRun(null, RUN)).toBe(RUN);
    expect(heldRun(RUN, null)).toBe(RUN);
  });

  it("moves to a different run that starts, and shows nothing it was never shown", () => {
    expect(heldRun(RUN, NEXT)).toBe(NEXT);
    expect(heldRun(null, null)).toBeNull();
  });

  it("renders nothing on a page loaded after the run, and the open follower while it runs", () => {
    expect(renderToStaticMarkup(<FollowedLog running={null} className="alog slog" />)).toBe("");
    expect(renderToStaticMarkup(<FollowedLog running={RUN} className="alog slog" />)).toContain(
      '<details class="alog slog" open=""',
    );
  });
});
