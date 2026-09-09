/**
 * Which projects the bar can be filtered to.
 *
 * The list is a union of two facts that come apart: what is registered, and
 * what the board has cards from. Filtering by the first alone strands a project
 * that was unregistered while its work was still on the board — the case the
 * page already knows about, since it decides whether to print a project name on
 * a card from the *cards* and not from `loadProjects`, "a card can outlive its
 * project" (#86). Filtering by the second alone loses a registered repository
 * whose only work is queued, because nothing of a project reaches `task_view`
 * until it has run.
 */
import { describe, expect, it } from "vitest";
import { filterOptions } from "../src/lib/board.ts";

describe("the projects the filter offers", () => {
  it("keeps a project whose cards outlived its registration", () => {
    expect(filterOptions(["lingtai"], ["esctest", "lingtai"])).toEqual(["lingtai", "esctest"]);
  });

  it("offers a registered project that has never run", () => {
    expect(filterOptions(["lingtai", "esctest"], [])).toEqual(["lingtai", "esctest"]);
  });

  it("names each project once, in the register's order", () => {
    expect(filterOptions(["lingtai", "esctest"], ["esctest", "lingtai"])).toEqual([
      "lingtai",
      "esctest",
    ]);
  });

  it("offers nothing when nothing is registered and nothing has run", () => {
    expect(filterOptions([], [])).toEqual([]);
  });
});
