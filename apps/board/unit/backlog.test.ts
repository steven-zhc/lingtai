/**
 * The backlog page's chip (`#137`): *nothing open* is only ever said about a
 * backlog that was brought to the head. A table nobody built, or a fold that
 * failed, reads as empty — and must not render as though it were.
 */
import { describe, expect, it } from "vitest";
import { backlogChip } from "../src/lib/backlog.ts";

describe("the backlog's currency", () => {
  it("is current only at the head", () => {
    expect(backlogChip({ lag: 0 })).toMatchObject({ current: true, label: "current" });
  });

  it("is not current when the fold failed, and names the repair", () => {
    const chip = backlogChip({ lag: null, error: "relation \"checkpoints\" does not exist" });
    expect(chip).toMatchObject({ current: false, tone: "warn" });
    expect(chip.title).toContain("lingtai projection rebuild finding_backlog");
    expect(backlogChip({ lag: 40, error: "shape drift" })).toMatchObject({ current: false, label: "behind 40" });
  });

  it("is not current when the lag could not be read, or is not zero", () => {
    expect(backlogChip({ lag: null }).current).toBe(false);
    expect(backlogChip({ lag: 3 })).toMatchObject({ current: false, label: "behind 3" });
  });
});
